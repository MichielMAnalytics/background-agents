/**
 * Local stdio MCP server over the Open-Inspect control plane.
 *
 * Deprecated: the control plane serves the same tools at `/mcp`, which clients reach without
 * installing anything. This server remains until the hosted one covers everything it does.
 *
 * Runs locally over stdio and authenticates with a personal access token, so every request is
 * attributable to the user who issued it and bounded by the permissions the token was granted.
 * The control plane enforces that bound; this server only presents the tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
// The tools and client live in the control plane, which serves the same set at `/mcp`.
import { ControlPlaneClient } from "@open-inspect/control-plane/src/mcp-tools/client";
import {
  callTool,
  MCP_SERVER_INFO,
  toolAnnotations,
  toolDescription,
} from "@open-inspect/control-plane/src/mcp-tools/registration";
import { TOOLS } from "@open-inspect/control-plane/src/mcp-tools/tools";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // stderr, not stdout: stdout is the MCP transport and any stray byte there corrupts it.
    console.error(`open-inspect-mcp: ${name} is required`);
    process.exit(1);
  }
  return value;
}

export function createServer(client: ControlPlaneClient): McpServer {
  const server = new McpServer({ ...MCP_SERVER_INFO });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: toolDescription(tool),
        // The SDK types its schemas with the workspace's hoisted zod, which a test dependency pins
        // below the zod these schemas and shared's are built with. Both are zod 4, converted and
        // validated through the schema objects' own methods, so only the declared types differ;
        // the tests list and call every tool over a real transport to keep that true.
        inputSchema: tool.inputSchema as unknown as ZodRawShapeCompat,
        annotations: toolAnnotations(tool),
      },
      (args: Record<string, unknown>, extra) =>
        callTool(tool, client.withSignal(extra.signal), args)
    );
  }

  return server;
}

async function main(): Promise<void> {
  let client: ControlPlaneClient;
  try {
    client = new ControlPlaneClient({
      baseUrl: requireEnv("OPEN_INSPECT_CONTROL_PLANE_URL"),
      token: requireEnv("OPEN_INSPECT_TOKEN"),
    });
  } catch (error) {
    console.error(`open-inspect-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  await createServer(client).connect(new StdioServerTransport());
}

// Imported for createServer alone by the tests, which set VITEST.
if (!process.env.VITEST) {
  main().catch((error: unknown) => {
    console.error("open-inspect-mcp: fatal:", error);
    process.exit(1);
  });
}
