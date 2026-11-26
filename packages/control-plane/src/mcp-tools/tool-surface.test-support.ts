/**
 * The tool surface as a client sees it, checked over a real MCP transport.
 *
 * Both servers that register the tools (the hosted `/mcp` route and the local stdio server) run
 * this suite against their own registration, so the tool list, write hints, schemas, argument
 * validation, and descriptions cannot drift between them.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "./client";
import { TOOLS } from "./tools";

/** A control-plane client whose requests are recorded and answered by the handlers given. */
export function fakeToolClient(handlers: {
  get?: (path: string, query?: unknown) => unknown;
  post?: (path: string, body?: unknown, options?: unknown) => unknown;
}) {
  const get = vi.fn(async (path: string, query?: unknown) => handlers.get?.(path, query));
  const post = vi.fn(async (path: string, body?: unknown, options?: unknown) =>
    handlers.post?.(path, body, options)
  );
  const client = { get, post, withSignal: () => client } as unknown as ControlPlaneClient;
  return { client, get, post };
}

/** Connects an MCP client to a server whose tools act through `client`. */
export type ConnectToolServer = (client: ControlPlaneClient) => Promise<Client>;

/** Register the tool-surface suite for one server's registration. */
export function describeToolSurface(server: string, connect: ConnectToolServer): void {
  describe(`tool surface (${server})`, () => {
    it("lists every tool over a real transport, schemas converted and hints set", async () => {
      // tools/list is where a zod shape the SDK cannot convert to JSON Schema
      // actually fails, and where a client reads the write hints. Exercising the
      // real path catches both; constructing the server alone catches neither.
      const mcpClient = await connect(fakeToolClient({}).client);

      const { tools } = await mcpClient.listTools();
      expect(tools.map((entry) => entry.name).sort()).toEqual(
        TOOLS.map((entry) => entry.name).sort()
      );

      const writes = tools.filter((entry) => entry.annotations?.readOnlyHint === false);
      expect(writes.map((entry) => entry.name).sort()).toEqual([
        "create_automation",
        "create_session",
        "import_skill_from_git",
        "send_prompt",
        "trigger_automation",
        "update_skill_from_git",
      ]);
      expect(tools).toHaveLength(16);
      // Re-import moves the skill's current revision, which is what later
      // sessions load; a client reads this to decide how hard to prompt.
      const hints = Object.fromEntries(
        tools.map((entry) => [entry.name, entry.annotations?.destructiveHint])
      );
      expect(hints.update_skill_from_git).toBe(true);
      expect(hints.import_skill_from_git).toBe(false);
      expect(hints.list_skills).toBe(false);
      // Starting or steering a session adds work; it replaces nothing a later reader acts on.
      expect(hints.create_session).toBe(false);
      expect(hints.send_prompt).toBe(false);

      // The nested unions are the shapes most likely to fail: the import tool's
      // assignments, and the shared trigger-condition union that create_automation
      // reuses rather than restating.
      const importTool = tools.find((entry) => entry.name === "import_skill_from_git");
      expect(importTool?.inputSchema.properties).toHaveProperty("assignments");
      const createTool = tools.find((entry) => entry.name === "create_automation");
      expect(createTool?.inputSchema.properties).toHaveProperty("trigger_config");
      expect(createTool?.inputSchema.required).toEqual(["name", "instructions"]);
      await mcpClient.close();
    });

    it("validates and forwards a call over a real transport, and refuses invalid arguments", async () => {
      // The SDK validates arguments with these schemas, which may be built on a different zod
      // than the SDK resolves; this is the runtime half of the type bridge at registration.
      const { client, get } = fakeToolClient({ get: () => ({ sessions: [] }) });
      const mcpClient = await connect(client);

      const ok = await mcpClient.callTool({
        name: "list_sessions",
        arguments: { status: "active", limit: 5 },
      });
      expect(ok.isError).toBeFalsy();
      expect(get).toHaveBeenCalledWith("/sessions", {
        status: "active",
        limit: 5,
        offset: undefined,
      });

      const invalid = await mcpClient.callTool({
        name: "list_sessions",
        arguments: { status: "running" },
      });
      expect(invalid.isError).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
      await mcpClient.close();
    });

    it("states the grant every tool needs in the description the model reads", async () => {
      const mcpClient = await connect(fakeToolClient({}).client);

      const { tools } = await mcpClient.listTools();
      for (const definition of TOOLS) {
        const listed = tools.find((entry) => entry.name === definition.name);
        expect(listed?.description).toContain(`Requires a token granted ${definition.requires}.`);
      }
      await mcpClient.close();
    });
  });
}
