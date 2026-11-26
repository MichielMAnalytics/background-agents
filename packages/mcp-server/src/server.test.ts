import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ControlPlaneClient } from "@open-inspect/control-plane/src/mcp-tools/client";
import { describeToolSurface } from "@open-inspect/control-plane/src/mcp-tools/tool-surface.test-support";
import { createServer } from "./index";

async function connectLocal(client: ControlPlaneClient): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0" });
  await Promise.all([
    createServer(client).connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return mcpClient;
}

describeToolSurface("local stdio", connectLocal);
