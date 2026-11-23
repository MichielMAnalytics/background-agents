/**
 * The routes that accept personal access tokens, through the deployed Worker against real D1 and
 * the session Durable Object: each reads or writes as the token's owner, within the token's grant,
 * and the neighbouring routes that do not accept tokens refuse them.
 */

import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { AutomationStore } from "../../src/db/automation-store";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamStore } from "../../src/db/teams";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { SessionMemorySelectionStore } from "../../src/db/session-memory-selections";
import { cleanD1Tables } from "./cleanup";
import {
  initSession,
  queryDO,
  routeRequest,
  seedActiveUser,
  seedEvents,
  serviceFetch,
} from "./helpers";
import { runInSessionDO } from "./session-do-access";
import { fetchRuns } from "./run-helpers";
import { seedEnvironment } from "./ownership-test-helpers";

const BASE = "https://cp.test";
const OWNER = "77777777777777777777777777777777";
const OTHER = "88888888888888888888888888888888";
const ADMIN = "99999999999999999999999999999999";

async function issueToken(userId: string, permissions: PermissionId[]): Promise<string> {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId,
    name: "integration",
    permissions,
    expiresAt: Date.now() + 60 * 60 * 1000,
    now: Date.now(),
    requestId: "integration",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token.token;
}

function withToken(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** `withToken`, against a Worker running with the given teams enforcement mode. */
async function withTokenIn(
  mode: "off" | "shadow" | "on",
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  return routeRequest(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { ...env, TEAMS_ENFORCEMENT: mode },
    createExecutionContext()
  );
}

const SUBSCRIPTION_ACCOUNT_ID = "a".repeat(32);

/** An Anthropic subscription account as the installation default, with API keys for automated use. */
async function seedSubscriptionDefaultWithApiKeyForAutomation() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO model_provider_accounts
         (id, provider, display_name, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, 'anthropic', 'Team plan', 'active', ?, ?, 1, 1)`
    ).bind(SUBSCRIPTION_ACCOUNT_ID, ADMIN, ADMIN),
    env.DB.prepare(
      `INSERT INTO model_provider_account_defaults
         (provider, provider_account_id, unattended_mode, created_by, updated_by, created_at, updated_at)
       VALUES ('anthropic', ?, 'api_key', ?, ?, 1, 1)`
    ).bind(SUBSCRIPTION_ACCOUNT_ID, ADMIN, ADMIN),
  ]);
}

async function saveAutomation(id: string, userId: string) {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, name, instructions, schedule_cron, model, created_by, user_id, created_at, updated_at)
     VALUES (?, ?, 'Run tests', '0 9 * * *', 'anthropic/claude-sonnet-4-6', ?, ?, 1, 1)`
  )
    .bind(id, id, userId, userId)
    .run();
}

async function invocationActorKinds(automationId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT actor_kind FROM automation_invocations WHERE automation_id = ? ORDER BY created_at"
  )
    .bind(automationId)
    .all<{ actor_kind: string }>();
  return results.map((row) => row.actor_kind);
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code });
}

beforeEach(async () => {
  await cleanD1Tables();
  // Members by the default role assignment; ADMIN is promoted.
  for (const userId of [OWNER, OTHER, ADMIN]) await seedActiveUser(userId);
  await env.DB.prepare(
    "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
  )
    .bind(ADMIN)
    .run();
});
afterEach(cleanD1Tables);

describe("reading sessions with a token", () => {
  it("lists, reads events and messages, and needs sessions.read to do so", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    await seedEvents(stub, [
      { id: "event-1", type: "token", data: JSON.stringify({ text: "hi" }), createdAt: 1 },
    ]);
    const reader = await issueToken(OWNER, ["sessions.read"]);

    const list = await withToken(reader, "/sessions");
    expect(list.status).toBe(200);
    const { sessions } = await list.json<{ sessions: { id: string }[] }>();
    expect(sessions.map((session) => session.id)).toContain(sessionName);

    const events = await withToken(reader, `/sessions/${sessionName}/events`);
    expect(events.status).toBe(200);
    expect(JSON.stringify(await events.json())).toContain("event-1");
    expect((await withToken(reader, `/sessions/${sessionName}/messages`)).status).toBe(200);

    const unrelated = await issueToken(OWNER, ["automations.read"]);
    await expectRefusal(await withToken(unrelated, "/sessions"), 403, "permission_required");
    await expectRefusal(
      await withToken(unrelated, `/sessions/${sessionName}/events`),
      403,
      "permission_required"
    );
  });

  it("is refused the session routes that do not accept tokens", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, [
      "sessions.read",
      "sessions.create",
      "sessions.sandbox_access",
      "sessions.lifecycle",
    ]);
    for (const [method, path] of [
      ["GET", `/sessions/${sessionName}/tunnel-urls`],
      ["GET", `/sessions/${sessionName}/sandbox-access`],
      ["POST", `/sessions/${sessionName}/archive`],
      ["POST", `/sessions/${sessionName}/stop`],
      ["POST", `/sessions/${sessionName}/pr`],
    ] as const) {
      await expectRefusal(
        await withToken(token, path, { method, body: method === "POST" ? {} : undefined }),
        403,
        "personal_access_token_not_accepted"
      );
    }
  });
});

/** Every snapshot field that locates the sandbox, as `redactSessionSnapshotSandboxAccess` removes them. */
const SANDBOX_URL_FIELDS = [
  "codeServerUrl",
  "vncUrl",
  "ttydUrl",
  "tunnelUrls",
  "sandboxDashboardUrl",
] as const;

/** Give a session's sandbox every URL a running sandbox reports, and the object its dashboard links to. */
async function seedSandboxUrls(stub: DurableObjectStub) {
  await runInSessionDO(stub, (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE sandbox SET code_server_url = ?, vnc_url = ?, ttyd_url = ?, tunnel_urls = ?,
         modal_object_id = ?`,
      "https://editor.test",
      "https://vnc.test",
      "https://terminal.test",
      JSON.stringify({ "3000": "https://tunnel.test" }),
      "sb-dashboard-object"
    );
  });
}

describe("reading one session with a token", () => {
  it("reads the snapshot with sessions.read, and is refused without it", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const reader = await issueToken(OWNER, ["sessions.read"]);

    const snapshot = await withToken(reader, `/sessions/${sessionName}`);
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      session: { id: sessionName, ownerUserId: OWNER, branchName: null },
      artifacts: [],
    });

    const unrelated = await issueToken(OWNER, ["automations.read"]);
    await expectRefusal(
      await withToken(unrelated, `/sessions/${sessionName}`),
      403,
      "permission_required"
    );
  });

  it("never returns sandbox URLs to a token, even one granted sessions.sandbox_access", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    await seedSandboxUrls(stub);

    // The owner's browser session sees them, so the token is what withholds them.
    const browser = await serviceFetch(`${BASE}/sessions/${sessionName}`, {
      as: { userId: OWNER, role: "member" },
    });
    expect(browser.status).toBe(200);
    await expect(browser.json()).resolves.toMatchObject({
      session: {
        codeServerUrl: "https://editor.test",
        vncUrl: "https://vnc.test",
        ttydUrl: "https://terminal.test",
        tunnelUrls: { "3000": "https://tunnel.test" },
        sandboxDashboardUrl: expect.stringContaining("sb-dashboard-object"),
      },
    });

    const token = await issueToken(OWNER, ["sessions.read", "sessions.sandbox_access"]);
    const response = await withToken(token, `/sessions/${sessionName}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    // Every field the browser received above is populated, so each absence here is a redaction.
    for (const field of SANDBOX_URL_FIELDS) {
      expect(body).not.toHaveProperty(`session.${field}`);
    }
  });

  it("reports only the capabilities a token can use, whatever it was granted", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, [
      "sessions.read",
      "sessions.collaborate",
      "sessions.lifecycle",
      "sessions.sandbox_access",
      "sessions.delete",
    ]);

    const response = await withToken(token, `/sessions/${sessionName}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: {
        capabilities: {
          canRead: true,
          canCollaborate: true,
          canManageLifecycle: false,
          canDelete: false,
          canSandbox: false,
          canManageCollaborators: false,
          canChangeVisibility: false,
        },
      },
    });
  });

  it("reaches only sessions its owner can see", async () => {
    const { sessionName } = await initSession({ userId: OTHER });
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(sessionName)
      .run();
    const token = await issueToken(OWNER, ["sessions.read"]);

    // A private session its owner cannot see is not found, as it is for a browser session.
    expect((await withToken(token, `/sessions/${sessionName}`)).status).toBe(404);
  });
});

describe("creating a session with a token", () => {
  it("creates a session owned by the token's owner, audited to the token", async () => {
    const token = await issueToken(OWNER, ["sessions.create"]);

    const response = await withToken(token, "/sessions", {
      method: "POST",
      body: { title: "From a token" },
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
      userId: OWNER,
      spawnSource: "user",
      title: "From a token",
    });

    const audit = await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, metadata_json FROM authorization_audit_events
        WHERE action = 'authorization.request_allowed' AND resource_id = '/sessions'`
    ).first<{ principal_kind: string; actor_user_id_snapshot: string; metadata_json: string }>();
    expect(audit).toMatchObject({
      principal_kind: "personal-access-token",
      actor_user_id_snapshot: OWNER,
    });
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      admission: "personal-access-token",
      personalAccessTokenId: expect.any(String),
    });
  });

  it("includes the owner's personal memory only when the token was granted memories.manage_own", async () => {
    await new MemoryRecordStore(env.DB).create(
      {
        partition: { type: "personal", userId: OWNER },
        scope: { type: "personal" },
        content: {
          memoryType: "fact",
          title: "Deploy notes",
          description: "How I deploy",
          content: "Use the blue cluster",
        },
      },
      { kind: "user", userId: OWNER, requestId: "seed" }
    );
    const selectionFor = async (grant: PermissionId[]) => {
      const response = await withToken(await issueToken(OWNER, grant), "/sessions", {
        method: "POST",
        body: { title: "Memory", includePersonalMemories: true },
      });
      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      return (await new SessionMemorySelectionStore(env.DB).loadSelection(sessionId))!.selection;
    };

    // The owner's role holds memories.manage_own either way; only the grant differs.
    expect((await selectionFor(["sessions.create"])).personalOwnerUserId).toBeNull();
    expect(
      (await selectionFor(["sessions.create", "memories.manage_own"])).personalOwnerUserId
    ).toBe(OWNER);
  });

  it("follows the workspace's provider policy for automated use", async () => {
    await seedSubscriptionDefaultWithApiKeyForAutomation();
    const token = await issueToken(OWNER, ["sessions.create"]);

    const response = await withToken(token, "/sessions", {
      method: "POST",
      body: { title: "Automated", harness: "claude", model: "anthropic/claude-sonnet-4-6" },
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    // A token does not show that a person is present, so the subscription account is not used.
    expect(
      await env.DB.prepare(
        `SELECT auth_mode, selection_source FROM session_model_provider_auth
          WHERE session_id = ? AND provider = 'anthropic'`
      )
        .bind(sessionId)
        .first()
    ).toEqual({ auth_mode: "api_key", selection_source: "unattended_policy" });
  });

  it("refuses an explicit provider selection, which would bypass that policy", async () => {
    await seedSubscriptionDefaultWithApiKeyForAutomation();
    const token = await issueToken(OWNER, ["sessions.create"]);

    const response = await withToken(token, "/sessions", {
      method: "POST",
      body: {
        title: "Pinned account",
        harness: "claude",
        model: "anthropic/claude-sonnet-4-6",
        providerSelections: {
          anthropic: { mode: "provider_account", accountId: SUBSCRIPTION_ACCOUNT_ID },
        },
      },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provider selections are not accepted from personal access tokens",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("needs sessions.create, though its owner holds it", async () => {
    const token = await issueToken(OWNER, ["sessions.read", "sessions.collaborate"]);
    await expectRefusal(
      await withToken(token, "/sessions", { method: "POST", body: { title: "Refused" } }),
      403,
      "permission_required"
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("narrows target checks to the grant: the owner may use the environment, the token may not", async () => {
    await seedEnvironment("env_token_session_target", null);
    const token = await issueToken(OWNER, ["sessions.create"]);

    const refused = await withToken(token, "/sessions", {
      method: "POST",
      body: { environmentId: "env_token_session_target" },
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "environments.use",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("creates a team-owned session only in a team its owner belongs to", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "token-team",
      name: "Token team",
      joinPolicy: "invite_only",
    });
    const token = await issueToken(OWNER, ["sessions.create"]);
    const body = { title: "Team work", teamId: team.id };

    await expectRefusal(
      await withToken(token, "/sessions", { method: "POST", body }),
      403,
      "not_member"
    );

    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    const created = await withToken(token, "/sessions", { method: "POST", body });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json<{ sessionId: string }>();
    expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
      userId: OWNER,
      ownerTeamId: team.id,
    });
  });

  it("refuses caller-asserted identity, as it does for a browser session", async () => {
    const token = await issueToken(OWNER, ["sessions.create"]);
    const response = await withToken(token, "/sessions", {
      method: "POST",
      body: { title: "Impersonation", userId: OTHER },
    });
    expect(response.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });
});

describe("prompting a session with a token", () => {
  it("queues a prompt authored by the token's owner, without the owner's personal MCP servers", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, ["sessions.read", "sessions.collaborate"]);

    const response = await withToken(token, `/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: { content: "Also handle the timeout case" },
    });
    expect(response.status).toBe(200);
    const { messageId } = await response.json<{ messageId: string }>();
    expect(
      await queryDO<{ user_id: string; content: string }>(
        stub,
        `SELECT p.user_id, m.content FROM messages m
         JOIN participants p ON p.id = m.author_id WHERE m.id = ?`,
        messageId
      )
    ).toEqual([{ user_id: OWNER, content: "Also handle the timeout case" }]);
    // Personal MCP connections follow a browser user's prompts, not a token's.
    expect(
      await queryDO<{ mcp_eligible: number }>(
        stub,
        "SELECT mcp_eligible FROM messages WHERE id = ?",
        messageId
      )
    ).toEqual([{ mcp_eligible: 0 }]);
  });

  it("loses sessions.collaborate without sessions.read, which every session's admission needs", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    // Issued straight into storage: issuance refuses this grant, but a grant can outlive a rule.
    const token = await issueToken(OWNER, ["sessions.collaborate"]);

    await expectRefusal(
      await withToken(token, `/sessions/${sessionName}/prompt`, {
        method: "POST",
        body: { content: "Refused" },
      }),
      403,
      "permission_required"
    );
    expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
  });

  it.each(["shadow", "on"] as const)(
    "starts and prompts a team-owned session with the documented grant (teams %s)",
    async (mode) => {
      const team = await new TeamStore(env.DB).create({
        slug: `token-team-${mode}`,
        name: "Token team",
        joinPolicy: "invite_only",
      });
      await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      const token = await issueToken(OWNER, [
        "sessions.create",
        "sessions.read",
        "sessions.collaborate",
      ]);

      const created = await withTokenIn(mode, token, "/sessions", {
        method: "POST",
        body: { title: "Team hand-off", teamId: team.id, visibility: "team" },
      });
      expect(created.status).toBe(201);
      const { sessionId } = await created.json<{ sessionId: string }>();

      const prompted = await withTokenIn(mode, token, `/sessions/${sessionId}/prompt`, {
        method: "POST",
        body: { content: "Start here" },
      });
      expect(prompted.status).toBe(200);
      expect((await withTokenIn(mode, token, `/sessions/${sessionId}`)).status).toBe(200);
    }
  );

  it("refuses attachment references, which a token has no route to upload", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, ["sessions.read", "sessions.collaborate"]);
    // An upload recorded on the session, as a browser upload would be, so the reference is one
    // the prompt route would otherwise accept.
    const attachmentId = "someone-elses-upload";
    const recorded = await stub.fetch("http://internal/internal/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "record",
        attachmentId,
        mimeType: "image/png",
        sizeBytes: 1024,
      }),
    });
    expect(recorded.status).toBe(200);

    const response = await withToken(token, `/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: { content: "See attached", attachments: [{ attachmentId, name: "screenshot.png" }] },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Attachments are not accepted from personal access tokens",
    });
    expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
  });

  it("needs sessions.collaborate: sessions.read alone cannot prompt", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    const reader = await issueToken(OWNER, ["sessions.read"]);

    const response = await withToken(reader, `/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: { content: "Refused" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.collaborate",
    });
    expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
  });

  it("prompts only sessions its owner can collaborate on", async () => {
    const { stub, sessionName } = await initSession({ userId: OTHER });
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(sessionName)
      .run();
    const token = await issueToken(OWNER, ["sessions.read", "sessions.collaborate"]);

    const response = await withToken(token, `/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: { content: "Not my session" },
    });
    expect(response.status).toBe(404);
    expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
  });

  it("refuses a caller-asserted author", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, ["sessions.read", "sessions.collaborate"]);

    const response = await withToken(token, `/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: { content: "Spoofed", authorId: OTHER },
    });
    expect(response.status).toBe(400);
    expect(await queryDO(stub, "SELECT id FROM messages")).toEqual([]);
  });
});

describe("automations with a token", () => {
  it("reads automations and their runs with automations.read", async () => {
    await saveAutomation("auto-read", OWNER);
    const token = await issueToken(OWNER, ["automations.read"]);

    const list = await withToken(token, "/automations");
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain("auto-read");
    expect((await withToken(token, "/automations/auto-read")).status).toBe(200);
    expect((await withToken(token, "/automations/auto-read/invocations")).status).toBe(200);
  });

  it("creates an automation as its owner, attributed and audited to the token", async () => {
    const token = await issueToken(OWNER, ["automations.create", "sessions.create"]);
    const response = await withToken(token, "/automations", {
      method: "POST",
      body: {
        name: "Nightly triage",
        instructions: "Triage new issues",
        scheduleCron: "0 9 * * *",
        scheduleTz: "UTC",
      },
    });
    expect(response.status).toBe(201);
    const { automation } = await response.json<{ automation: { id: string } }>();
    expect(await new AutomationStore(env.DB).getById(automation.id)).toMatchObject({
      created_by: OWNER,
      user_id: OWNER,
    });

    const audit = await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, metadata_json FROM authorization_audit_events
        WHERE action = 'authorization.request_allowed' AND resource_id = '/automations'`
    ).first<{ principal_kind: string; actor_user_id_snapshot: string; metadata_json: string }>();
    expect(audit).toMatchObject({
      principal_kind: "personal-access-token",
      actor_user_id_snapshot: OWNER,
    });
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      admission: "personal-access-token",
      personalAccessTokenId: expect.any(String),
    });
  });

  it("narrows target checks to the grant: the owner may use the environment, the token may not", async () => {
    await seedEnvironment("env_token_target", null);
    const body = {
      name: "Environment run",
      instructions: "Run tests",
      scheduleCron: "0 9 * * *",
      scheduleTz: "UTC",
      environmentIds: ["env_token_target"],
    };
    const withoutUse = await issueToken(OWNER, ["automations.create", "sessions.create"]);
    const refused = await withToken(withoutUse, "/automations", { method: "POST", body });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "environments.use",
    });

    const withUse = await issueToken(OWNER, [
      "automations.create",
      "sessions.create",
      "environments.use",
    ]);
    expect((await withToken(withUse, "/automations", { method: "POST", body })).status).toBe(201);
  });

  it("triggers its owner's automation and launches the run as the owner, but no one else's", async () => {
    await saveAutomation("auto-own", OWNER);
    await saveAutomation("auto-other", OTHER);
    const token = await issueToken(OWNER, [
      "automations.read",
      "automations.trigger.own",
      "sessions.create",
    ]);

    const triggered = await withToken(token, "/automations/auto-own/trigger", { method: "POST" });
    expect(triggered.status).toBe(201);
    const [run] = await fetchRuns("auto-own");
    expect(run?.session_id).toEqual(expect.any(String));
    expect(await new SessionIndexStore(env.DB).get(run!.session_id!)).toMatchObject({
      userId: OWNER,
      spawnSource: "automation",
    });
    // The owner's authority ran it, but a token does not establish that a person fired it.
    expect(await invocationActorKinds("auto-own")).toEqual(["unknown"]);

    const foreign = await withToken(token, "/automations/auto-other/trigger", { method: "POST" });
    expect(foreign.status).toBe(403);
    expect(await fetchRuns("auto-other")).toEqual([]);
  });

  it.each([
    ["sessions.create", ["automations.trigger.own"], null],
    [
      "environments.use",
      ["automations.trigger.own", "sessions.create"],
      "env_token_trigger_target",
    ],
  ] as const)(
    "launches nothing when the token lacks %s, though its owner holds it",
    async (_withheld, grant, environmentId) => {
      await saveAutomation("auto-own", OWNER);
      if (environmentId) {
        await seedEnvironment(environmentId, null);
        await env.DB.prepare(
          "INSERT INTO automation_environments (automation_id, environment_id, created_at, updated_at) VALUES (?, ?, 1, 1)"
        )
          .bind("auto-own", environmentId)
          .run();
      }
      const token = await issueToken(OWNER, [...grant]);

      const refused = await withToken(token, "/automations/auto-own/trigger", { method: "POST" });
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({
        reason_code: "execution_authorization_denied",
      });
      expect(await fetchRuns("auto-own")).toEqual([]);
      expect(await invocationActorKinds("auto-own")).toEqual([]);
    }
  );

  it.each([
    ["PUT", "/automations/auto-own", { name: "Renamed" }],
    ["DELETE", "/automations/auto-own", undefined],
    ["POST", "/automations/auto-own/pause", undefined],
    ["POST", "/automations/auto-own/resume", undefined],
    ["POST", "/automations/auto-own/regenerate-key", undefined],
  ] as const)(
    "never rewrites, removes, or pauses an automation: %s %s",
    async (method, path, body) => {
      await saveAutomation("auto-own", OWNER);
      const token = await issueToken(OWNER, [
        "automations.read",
        "automations.manage.own",
        "automations.trigger.own",
      ]);
      await expectRefusal(
        await withToken(token, path, { method, body }),
        403,
        "personal_access_token_not_accepted"
      );
      expect(await new AutomationStore(env.DB).getById("auto-own")).toMatchObject({
        name: "auto-own",
        enabled: 1,
        deleted_at: null,
      });
    }
  );
});

describe("skills with a token", () => {
  it("reads the catalog with skills.read", async () => {
    const token = await issueToken(OWNER, ["skills.read"]);
    expect((await withToken(token, "/skills")).status).toBe(200);
  });

  it("reaches skill import only when granted skills.manage, and never bulk import or deletion", async () => {
    const reader = await issueToken(ADMIN, ["skills.read"]);
    await expectRefusal(
      await withToken(reader, "/skills/import/preview", { method: "POST", body: {} }),
      403,
      "permission_required"
    );

    const manager = await issueToken(ADMIN, ["skills.read", "skills.manage"]);
    // Admitted: the handler answers for the empty body rather than admission refusing it.
    expect(
      (await withToken(manager, "/skills/import/preview", { method: "POST", body: {} })).status
    ).toBe(400);
    await expectRefusal(
      await withToken(manager, "/skills/import/bulk", { method: "POST", body: {} }),
      403,
      "personal_access_token_not_accepted"
    );
    await expectRefusal(
      await withToken(manager, "/skills/skill-1", { method: "DELETE" }),
      403,
      "personal_access_token_not_accepted"
    );
  });

  it("never reads skill or repository content through import without skills.read", async () => {
    // Issued straight into storage: the route refuses this grant, but a grant can outlive a rule.
    const manager = await issueToken(ADMIN, ["skills.manage"]);
    for (const path of [
      "/skills/import/preview",
      "/skills/import",
      "/skills/skill-1/reimport/preview",
    ]) {
      await expectRefusal(
        await withToken(manager, path, { method: "POST", body: {} }),
        403,
        "permission_required"
      );
    }
  });

  it("loses skills.manage with its owner's role", async () => {
    const manager = await issueToken(ADMIN, ["skills.read", "skills.manage"]);
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = ?"
    )
      .bind(ADMIN)
      .run();
    await expectRefusal(
      await withToken(manager, "/skills/import/preview", { method: "POST", body: {} }),
      403,
      "permission_required"
    );
  });
});
