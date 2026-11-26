import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach } from "vitest";
import type { ControlPlaneClient } from "./client";
import { createHostedMcpServer } from "./server";
import { describeToolSurface } from "./tool-surface.test-support";

const handlers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
});

/**
 * Serve the hosted server the way the `/mcp` route does, and connect a 2025-era Streamable HTTP
 * client to it, which is the protocol today's hosted clients speak.
 */
async function connectHosted(client: ControlPlaneClient): Promise<Client> {
  const handler = createMcpHandler(() => createHostedMcpServer(client), {
    legacy: "stateless",
    responseMode: "json",
  });
  handlers.push(handler);
  const transport = new StreamableHTTPClientTransport(new URL("https://control-plane.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const mcpClient = new Client({ name: "test", version: "0" });
  await mcpClient.connect(transport);
  return mcpClient;
}

describeToolSurface("hosted", connectHosted);
