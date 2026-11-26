/**
 * The hosted MCP server: the tool set registered on an MCP SDK v2 server.
 *
 * A fresh server is built for every HTTP request, bound to a client that carries that request's
 * personal access token, so nothing about one caller outlives its request.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ControlPlaneClient } from "./client";
import { callTool, MCP_SERVER_INFO, toolAnnotations, toolDescription } from "./registration";
import { TOOLS } from "./tools";

/** Build a server whose tools act through `client`. */
export function createHostedMcpServer(client: ControlPlaneClient): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: toolDescription(tool),
        inputSchema: z.object(tool.inputSchema),
        annotations: toolAnnotations(tool),
      },
      // Bind every HTTP step of the call to its cancellation, without affecting other calls.
      (args, ctx) => callTool(tool, client.withSignal(ctx.mcpReq.signal), args)
    );
  }
  return server;
}
