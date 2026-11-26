/**
 * The hosted MCP server at `/mcp`.
 *
 * An MCP client connects with a personal access token as its bearer credential. The route itself
 * grants nothing: it checks the API policy's MCP switch, refuses browser origins it does not
 * know, and confirms the token is live, then serves the MCP exchange. Every tool call becomes a
 * request to the control plane's own router, made in-process and carrying the same token, so
 * the route the tool calls admits it, narrows it to its grant, and audits it exactly as it would
 * a direct API call. A tool can therefore do nothing the token could not do without MCP.
 *
 * Stateless: each request is served by a fresh MCP server instance, nothing is kept between
 * requests, and GET and DELETE (2025-era session operations) are answered `405`. One request is
 * one message: batches and `subscriptions/listen` are refused.
 */

import { Hono } from "hono";
import { SERVICE_SIGNATURE_HEADER } from "@open-inspect/shared/service-auth";
import { createMcpHandler, originValidationResponse } from "@modelcontextprotocol/server";
import { authenticate, isAuthError } from "../auth/authenticate";
import { readPersonalAccessToken } from "../auth/personal-access-token";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { error } from "../http/responses";
import { createLogger } from "../logger";
import { McpError } from "../mcp/errors";
import { readMcpBody } from "../mcp/relay";
import { ControlPlaneClient, type ControlPlaneFetch } from "../mcp-tools/client";
import { createHostedMcpServer } from "../mcp-tools/server";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { logPrincipal } from "../routing/request-lifecycle";
import { recordPersonalAccessTokenUse } from "../routing/route-admission";
import type { Env } from "../types";
import {
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  type RequestContext,
} from "./shared";

const logger = createLogger("hosted-mcp");

/** The path the hosted MCP server is served at. */
const HOSTED_MCP_PATH = "/mcp";

/**
 * Largest MCP request body accepted. A tool's arguments are a prompt (capped well below this) or
 * a handful of identifiers, so anything larger is refused before it is parsed.
 */
export const HOSTED_MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Hostnames a browser-originated request may come from: the deployment's own web app and control
 * plane. A request without an `Origin` header (every non-browser client) is not affected.
 */
function allowedOriginHostnames(env: Env): string[] {
  const hostnames: string[] = [];
  for (const value of [env.WEB_APP_URL, env.WORKER_URL]) {
    if (!value) continue;
    try {
      hostnames.push(new URL(value).hostname);
    } catch {
      // A malformed URL allows nothing; the setting is validated where it is used for links.
    }
  }
  return hostnames;
}

function unauthorized(message: string): Response {
  const response = error(message, 401);
  response.headers.set("WWW-Authenticate", 'Bearer realm="open-inspect"');
  return response;
}

/**
 * Serve tool calls through the control plane's own router, under the MCP request's trace so their
 * logs and audit events correlate with it. A tool only ever calls API paths, so a request back to
 * this route would mean a tool was given a path it should never build.
 */
function routerTransport(inProcessFetch: ControlPlaneFetch, traceId: string): ControlPlaneFetch {
  return (request) => {
    if (new URL(request.url).pathname === HOSTED_MCP_PATH) {
      return Promise.resolve(error("Not found", 404));
    }
    const traced = new Request(request);
    traced.headers.set("x-trace-id", traceId);
    return inProcessFetch(traced);
  };
}

/** A JSON-RPC error answered before the MCP server sees the request. */
function rpcError(code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The parsed body of an MCP POST, or the response refusing it. Read here, under the body cap,
 * rather than by the SDK, so the shape can be checked first:
 * - a JSON-RPC batch is refused (the 2025-06-18 revision removed batching), so one request is one
 *   message and cannot fan out into many tool calls;
 * - `subscriptions/listen` is refused: this server is stateless, has nothing to notify, and would
 *   otherwise hold a stream open.
 */
async function readMessage(request: Request): Promise<{ message: unknown } | Response> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readMcpBody(request, HOSTED_MCP_MAX_REQUEST_BODY_BYTES);
  } catch (cause) {
    if (cause instanceof McpError && cause.status === 413) {
      return rpcError(JSON_RPC_INVALID_REQUEST, "Request body too large", 413);
    }
    if (cause instanceof McpError && cause.status === 408) {
      return rpcError(JSON_RPC_INVALID_REQUEST, "Request body timed out", 408);
    }
    throw cause;
  }
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
  } catch {
    return rpcError(JSON_RPC_PARSE_ERROR, "Parse error", 400);
  }
  if (Array.isArray(message)) {
    return rpcError(JSON_RPC_INVALID_REQUEST, "Batch requests are not supported", 400);
  }
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { method?: unknown }).method === "subscriptions/listen"
  ) {
    return rpcError(
      JSON_RPC_METHOD_NOT_FOUND,
      "This server is stateless and sends no notifications",
      400
    );
  }
  return { message };
}

/** Per-request inputs the shared handler hands to the server factory. */
interface ExchangeContext {
  client: ControlPlaneClient;
}

/**
 * One handler for every request. The SDK's handler is stateless for this server's traffic; each
 * exchange still gets a fresh MCP server, built around that request's client, so nothing about
 * one caller reaches another.
 */
const mcpHandler = createMcpHandler(
  ({ authInfo }) => {
    const exchange = authInfo?.extra as ExchangeContext | undefined;
    if (!exchange) throw new Error("MCP exchange served without its request context");
    return createHostedMcpServer(exchange.client);
  },
  {
    legacy: "stateless",
    // No tool streams progress, so a 2026-07-28 exchange is one JSON body. (2025-era requests are
    // answered as a short event stream that ends with the result.)
    responseMode: "json",
    maxRequestBodySize: HOSTED_MCP_MAX_REQUEST_BODY_BYTES,
    onerror: (cause) => {
      // The message only: tool arguments can hold prompts and secrets, and are never logged.
      // Ordinary protocol refusals land here too, so this is not a warning.
      logger.info("MCP exchange failed", {
        event: "hosted_mcp.exchange_failed",
        error_message: cause.message,
      });
    },
  }
);

async function serveMcp(
  request: Request,
  env: Env,
  ctx: RequestContext,
  inProcessFetch: ControlPlaneFetch
): Promise<Response> {
  // Off answers as though the route did not exist, before anything about the caller is checked.
  const policy = await new PersonalAccessTokenPolicyStore(ctx.db).get();
  if (!policy.mcpEnabled) return error("Not found", 404);

  // Compares hostnames only, as the SDK's check does: scheme and port are not considered.
  const rejectedOrigin = originValidationResponse(request, allowedOriginHostnames(env));
  if (rejectedOrigin) return rejectedOrigin;

  // Only a personal access token: a service signature acts for a service, not for one person.
  const token = readPersonalAccessToken(request.headers);
  if (token === null || request.headers.has(SERVICE_SIGNATURE_HEADER)) {
    return unauthorized("A personal access token is required");
  }
  // Checked here as well as by every route a tool calls, so a revoked or expired token is told so
  // before the client lists tools it could not call.
  const auth = await authenticate(request, env, ctx);
  if (isAuthError(auth)) {
    return auth.status === 401 ? unauthorized(auth.reason) : error(auth.reason, auth.status);
  }
  logPrincipal(auth.principal, ctx, HOSTED_MCP_PATH);
  if (auth.principal.kind === "personal-access-token") {
    recordPersonalAccessTokenUse(ctx, auth.principal.tokenId);
  }

  let parsedBody: unknown;
  if (request.method === "POST") {
    const read = await readMessage(request);
    if (read instanceof Response) return read;
    parsedBody = read.message;
  }

  const exchange: ExchangeContext = {
    client: new ControlPlaneClient({
      baseUrl: new URL(request.url).origin,
      token,
      fetch: routerTransport(inProcessFetch, ctx.trace_id),
    }),
  };
  return mcpHandler.fetch(request, {
    authInfo: { token, clientId: "personal-access-token", scopes: [], extra: { ...exchange } },
    ...(parsedBody === undefined ? {} : { parsedBody }),
  });
}

/**
 * The route authenticates in its handler rather than in admission: it acts for no one itself, and
 * each tool call is admitted by the route it reaches.
 */
const HOSTED_MCP_ROUTE = {
  ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "no-store",
} as const;

export const hostedMcpRoutes = new Hono<ControlPlaneHonoEnv>();

for (const method of ["post", "get", "delete"] as const) {
  hostedMcpRoutes[method](HOSTED_MCP_PATH, admit(HOSTED_MCP_ROUTE), (c) =>
    dispatch(c, (request, env, _params, ctx) => serveMcp(request, env, ctx, c.var.inProcessFetch))
  );
}
