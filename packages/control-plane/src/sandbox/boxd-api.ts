/**
 * The boxd calls the sandbox provider makes, behind a small port so the
 * provider can be tested against a fake.
 *
 * The adapter uses the fetch-only entry of the boxd SDK (`@boxd-sh/sdk/web`,
 * gRPC-web over `fetch`), so it runs unchanged in the Workers bundle and on
 * the Node host. Every SDK error is translated into a BoxdApiError here; the
 * provider never sees an SDK type.
 */

import { SandboxProviderError } from "./provider";
import {
  APIConnectionError,
  AuthenticationError,
  Boxd,
  BoxdError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@boxd-sh/sdk/web";

/** Machine states as boxd reports them. */
export type BoxdMachineStatus =
  | "pending"
  | "starting"
  | "running"
  | "suspended"
  | "hibernated"
  | "stopped"
  | "failed"
  | "destroyed"
  | "migrating"
  | (string & {});

export interface BoxdMachine {
  id: string;
  name: string;
  status: BoxdMachineStatus;
  labels: Record<string, string>;
}

export interface BoxdCreateMachineRequest {
  name: string;
  fromSnapshot: string;
  labels: Record<string, string>;
  /** Named HTTPS routes into the machine, created with it. */
  proxies: Array<{ name: string; port: number }>;
}

export type BoxdApiErrorKind =
  | "not_found"
  | "conflict"
  | "authentication"
  | "permission"
  | "rate_limited"
  | "connection"
  | "server"
  | "request";

export class BoxdApiError extends Error {
  constructor(
    message: string,
    readonly kind: BoxdApiErrorKind,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BoxdApiError";
  }

  /**
   * Transient failures are worth retrying; the rest count toward the circuit
   * breaker. A conflict is a machine in the middle of a state change (a
   * hibernate still settling, a start in flight), which passes by itself.
   */
  get isRetryable(): boolean {
    return (
      this.kind === "rate_limited" ||
      this.kind === "connection" ||
      this.kind === "server" ||
      this.kind === "conflict"
    );
  }
}

export interface BoxdSandboxApi {
  createMachine(request: BoxdCreateMachineRequest): Promise<BoxdMachine>;
  /** Looks a machine up by id or name; throws a `not_found` BoxdApiError when it is gone. */
  getMachine(idOrName: string): Promise<BoxdMachine>;
  /** Resolves once the machine runs and answers an exec round trip. */
  waitUntilReady(machineId: string, timeoutMs: number): Promise<BoxdMachine>;
  writeFile(machineId: string, path: string, content: string, mode: number): Promise<void>;
  exec(
    machineId: string,
    command: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  hibernate(machineId: string): Promise<void>;
  wake(machineId: string): Promise<void>;
  resume(machineId: string): Promise<void>;
  start(machineId: string): Promise<void>;
  deleteMachine(machineId: string): Promise<void>;
  /** Public HTTPS domain of each named proxy on the machine, keyed by proxy name. */
  proxyDomains(machineId: string): Promise<Record<string, string>>;
}

export interface BoxdApiOptions {
  apiKey: string;
  /** API endpoint; the SDK's production default when unset. */
  baseUrl?: string;
  /** Region machines are created and looked up in; the key's default when unset. */
  region?: string;
  /** Org (name or id) machines are created in; the key's own org when unset. */
  org?: string;
}

const GRPC_INTERNAL = 13;
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;

/** Translate whatever the SDK threw into a BoxdApiError, keeping its message. */
export function toBoxdApiError(error: unknown): BoxdApiError {
  if (error instanceof BoxdApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NotFoundError) return new BoxdApiError(message, "not_found", error);
  if (error instanceof ConflictError) return new BoxdApiError(message, "conflict", error);
  if (error instanceof AuthenticationError) {
    return new BoxdApiError(message, "authentication", error);
  }
  if (error instanceof PermissionDeniedError) return new BoxdApiError(message, "permission", error);
  if (error instanceof RateLimitError) return new BoxdApiError(message, "rate_limited", error);
  if (error instanceof APIConnectionError) return new BoxdApiError(message, "connection", error);
  if (error instanceof BoxdError) {
    const transient =
      error.grpcCode === GRPC_UNAVAILABLE ||
      error.grpcCode === GRPC_INTERNAL ||
      error.grpcCode === GRPC_DEADLINE_EXCEEDED ||
      (error.httpStatus !== undefined && error.httpStatus >= 500);
    return new BoxdApiError(message, transient ? "server" : "request", error);
  }
  // Not from the SDK: a network failure below it is transient, anything else
  // is a bug and counts.
  return new BoxdApiError(
    message,
    SandboxProviderError.isTransientNetworkError(error) ? "connection" : "request",
    error
  );
}

/**
 * `waitUntilReady` reports a machine that is slow to come up, or that stopped
 * or failed while it waited, with a plain SDK error and no status code. None
 * of those says the request was wrong, so they are transient.
 */
function toReadinessError(error: unknown): BoxdApiError {
  if (
    error instanceof BoxdError &&
    !(error instanceof BoxdApiError) &&
    error.grpcCode === undefined
  ) {
    return new BoxdApiError(error.message, "server", error);
  }
  return toBoxdApiError(error);
}

async function translated<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toBoxdApiError(error);
  }
}

function toMachine(machine: {
  id: string;
  name: string;
  status: string;
  labels?: Record<string, string>;
}): BoxdMachine {
  return {
    id: machine.id,
    name: machine.name,
    status: machine.status,
    labels: machine.labels ?? {},
  };
}

export function createBoxdSandboxApi(options: BoxdApiOptions): BoxdSandboxApi {
  const client = new Boxd({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.region ? { region: options.region } : {}),
  });
  const machines = client.machines;

  return {
    createMachine: (request) =>
      translated(async () =>
        toMachine(
          await machines.create({
            name: request.name,
            fromSnapshot: request.fromSnapshot,
            ...(options.org ? { org: options.org } : {}),
            // Sessions run untrusted code: no default network, no in-machine
            // credentials, nothing of the org's reachable from inside.
            isolated: true,
            labels: request.labels,
            config: {
              // The control plane decides when an idle session stops. Outbound
              // traffic (the runtime's bridge) counts as activity, whatever the
              // org's default, so boxd's own idle hibernate only reaches a
              // machine nothing talks to any more.
              autoSuspendTimeout: 0,
              idleIgnoreOutbound: false,
              ...(request.proxies.length > 0 ? { proxies: request.proxies } : {}),
            },
          })
        )
      ),
    getMachine: (idOrName) => translated(async () => toMachine(await machines.get(idOrName))),
    waitUntilReady: async (machineId, timeoutMs) => {
      try {
        return toMachine(await machines.waitUntilReady(machineId, { timeout: timeoutMs }));
      } catch (error) {
        throw toReadinessError(error);
      }
    },
    writeFile: (machineId, path, content, mode) =>
      translated(async () => {
        await machines.fs.write(machineId, path, content, { mode });
      }),
    exec: (machineId, command, timeoutMs) =>
      translated(async () => {
        const result = await machines.exec(machineId, { command, timeout: timeoutMs });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }),
    hibernate: (machineId) => translated(() => machines.hibernate(machineId)),
    wake: (machineId) => translated(() => machines.wake(machineId)),
    resume: (machineId) => translated(async () => void (await machines.resume(machineId))),
    start: (machineId) => translated(() => machines.start(machineId)),
    deleteMachine: (machineId) => translated(() => machines.delete(machineId)),
    proxyDomains: (machineId) =>
      translated(async () => {
        const domains: Record<string, string> = {};
        for (const proxy of await machines.proxies.list(machineId)) {
          if (proxy.name) domains[proxy.name] = proxy.domain;
        }
        return domains;
      }),
  };
}
