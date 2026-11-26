import { describe, expect, it, vi } from "vitest";
import { MAX_AUTOMATION_NAME_LENGTH } from "@open-inspect/shared/types/automations";
import { z } from "zod";
import { ControlPlaneError, type ControlPlaneClient } from "./client";
import { TOOLS, type ToolDefinition } from "./tools";
import { fakeToolClient as fakeClient } from "./tool-surface.test-support";

function tool(name: string): ToolDefinition {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

const SOURCE_SHA256 = "5".repeat(64);
const REVISION_SHA256 = "d".repeat(64);

/** A preview as the control plane returns it, including the content the tools never report. */
function preview(overrides: Record<string, unknown> = {}) {
  return {
    name: "deploy-service",
    description: "How to deploy",
    body: "# Deploy\n",
    license: null,
    compatibility: null,
    metadata: {},
    nameAvailable: true,
    revisionSha256: REVISION_SHA256,
    totalBytes: 512,
    source: {
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: "main",
      resolvedRef: "main",
      commitSha: "c".repeat(40),
      subdirectory: "skills/deploy",
      sourceSha256: SOURCE_SHA256,
    },
    warnings: [{ code: "name-derived", message: "Name taken from frontmatter" }],
    files: [{ path: "SKILL.md", content: "# Deploy\n", sizeBytes: 10, executable: false }],
    ...overrides,
  };
}

/** A skill as the control plane returns it, with its body, files, and recorded provenance. */
function storedSkill(overrides: Record<string, unknown> = {}) {
  return {
    skill: {
      id: "skill_1",
      name: "deploy-service",
      description: "How to deploy",
      enabled: true,
      currentRevisionId: "skillrev_2",
      revisionNumber: 2,
      source: {
        provider: "github",
        repoOwner: "acme",
        repoName: "skills",
        requestedRef: "main",
        resolvedRef: "main",
        commitSha: "a".repeat(40),
        subdirectory: "skills/deploy",
        sourceSha256: SOURCE_SHA256,
        importedAt: 1,
        revisionId: "skillrev_2",
      },
      body: "# Deploy\n",
      files: [{ path: "SKILL.md", content: "# Deploy\n" }],
      ...overrides,
    },
  };
}

describe("tool arguments", () => {
  it("are parsed by the tool's own schema before its handler runs, whoever calls it", async () => {
    const { client, get } = fakeClient({ get: () => ({ sessions: [] }) });

    await expect(tool("list_sessions").run(client, { status: "running" })).rejects.toThrow();
    await expect(tool("get_session_events").run(client, {})).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();

    // The schema's own transforms apply too.
    await tool("list_automations").run(client, { search: "  nightly " });
    expect(get).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ search: "nightly" })
    );
  });
});

describe("session diffs", () => {
  it("reads one file's patch with the ids the manifest lists", async () => {
    const getText = vi.fn(async () => "@@");
    const client = { getText } as unknown as ControlPlaneClient;

    await tool("get_session_diff_file").run(client, {
      session_id: "session/1",
      revision_id: "rev 1",
      file_id: "file/../2",
    });

    expect(getText).toHaveBeenCalledWith("/sessions/session%2F1/diff/rev%201/files/file%2F..%2F2");
  });
});

describe("get_session", () => {
  it("reads the snapshot without the timeline that get_session_events pages through", async () => {
    const { client, get } = fakeClient({
      get: () => ({
        session: { id: "sess_1", status: "active", branchName: "open-inspect/fix" },
        artifacts: [{ type: "pr", url: "https://github.com/acme/web/pull/1" }],
        timeline: { events: [{ eventId: "e1" }], hasMore: true, cursor: null },
        promptQueue: [],
      }),
    });

    const result = await tool("get_session").run(client, { session_id: "sess/1" });

    expect(get).toHaveBeenCalledWith("/sessions/sess%2F1");
    expect(result).toEqual({
      session: { id: "sess_1", status: "active", branchName: "open-inspect/fix" },
      artifacts: [{ type: "pr", url: "https://github.com/acme/web/pull/1" }],
      promptQueue: [],
    });
  });
});

describe("create_session", () => {
  it("creates the session from the pushed branch, then sends its first prompt", async () => {
    const { client, post } = fakeClient({
      post: (path) =>
        path === "/sessions"
          ? { sessionId: "sess_1", status: "created" }
          : { messageId: "msg_1", status: "queued" },
    });

    const result = await tool("create_session").run(client, {
      prompt: "continue: finish the retry logic",
      repo_owner: "acme/platform",
      repo_name: "web",
      branch: "my-wip",
      team_id: "team_1",
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(post).toHaveBeenNthCalledWith(1, "/sessions", {
      repoOwner: "acme/platform",
      repoName: "web",
      branch: "my-wip",
      teamId: "team_1",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(post).toHaveBeenNthCalledWith(2, "/sessions/sess_1/prompt", {
      content: "continue: finish the retry logic",
    });
    expect(result).toEqual({
      sessionId: "sess_1",
      prompt: { messageId: "msg_1", status: "queued" },
    });
  });

  it("sends no identity, and leaves omitted fields out of the body", async () => {
    const { client, post } = fakeClient({
      post: (path) =>
        path === "/sessions" ? { sessionId: "sess_1", status: "created" } : { messageId: "m" },
    });

    await tool("create_session").run(client, { prompt: "Investigate", environment_id: "env_1" });

    const [, body] = post.mock.calls[0];
    expect(JSON.parse(JSON.stringify(body))).toEqual({ environmentId: "env_1" });
  });

  /** A create that succeeds, then a first prompt that fails with `failure`. */
  function createThenPromptFails(failure: Error) {
    return fakeClient({
      post: (path) => {
        if (path === "/sessions") return { sessionId: "sess_1", status: "created" };
        throw failure;
      },
    });
  }

  it("names the created session when its first prompt is refused, so it is not created twice", async () => {
    const { client, post } = createThenPromptFails(
      new ControlPlaneError("POST /sessions/sess_1/prompt returned 403: permission_required", 403)
    );

    await expect(tool("create_session").run(client, { prompt: "Investigate" })).rejects.toThrow(
      /Session sess_1 was created, but its first prompt was not sent: .*403.*send_prompt/
    );
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a timeout", new ControlPlaneError("POST /sessions/sess_1/prompt failed: timed out", null)],
    ["a dropped connection", new TypeError("fetch failed")],
  ])(
    "does not call the first prompt unsent after %s, since it may already be queued",
    async (_case, failure) => {
      const { client } = createThenPromptFails(failure);

      const outcome = tool("create_session").run(client, { prompt: "Investigate" });

      await expect(outcome).rejects.toThrow(/Session sess_1 was created/);
      await expect(outcome).rejects.toThrow(/may already be queued.*get_session/);
      await expect(outcome).rejects.not.toThrow(/was not sent/);
    }
  );

  it("refuses a creation response it does not recognize rather than prompting nothing", async () => {
    const { client, post } = fakeClient({ post: () => ({ status: "created" }) });

    await expect(tool("create_session").run(client, { prompt: "Investigate" })).rejects.toThrow(
      /unrecognized session creation response/
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("refuses a blank prompt before creating anything", async () => {
    const { client, post } = fakeClient({});

    await expect(tool("create_session").run(client, { prompt: "  \n " })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("send_prompt", () => {
  it("posts the prompt to the session, camel-casing its options", async () => {
    const { client, post } = fakeClient({ post: () => ({ messageId: "msg_2", status: "queued" }) });

    const result = await tool("send_prompt").run(client, {
      session_id: "sess/1",
      content: "  also handle the timeout case  ",
      reasoning_effort: "high",
    });

    expect(post).toHaveBeenCalledWith("/sessions/sess%2F1/prompt", {
      content: "  also handle the timeout case  ",
      reasoningEffort: "high",
    });
    expect(result).toEqual({ messageId: "msg_2", status: "queued" });
  });
});

describe("automation invocations and runs", () => {
  it("lists invocations, then reads each child run by its own id", async () => {
    const invocations = {
      invocations: [
        { id: "inv_2", runs: [{ id: "run_b" }, { id: "run_c" }] },
        { id: "inv_1", runs: [] },
      ],
      total: 2,
    };
    const { client, get } = fakeClient({
      get: (path) =>
        path.endsWith("/invocations") ? invocations : { run: { id: path.split("/").at(-1) } },
    });

    const listed = (await tool("list_automation_invocations").run(client, {
      automation_id: "auto_1",
      limit: 10,
    })) as typeof invocations;
    expect(get).toHaveBeenCalledWith("/automations/auto_1/invocations", { limit: 10 });

    const childIds = listed.invocations.flatMap((invocation) =>
      invocation.runs.map((run) => run.id)
    );
    expect(childIds).toEqual(["run_b", "run_c"]);
    for (const runId of childIds) {
      await expect(
        tool("get_automation_run").run(client, { automation_id: "auto_1", run_id: runId })
      ).resolves.toEqual({ run: { id: runId } });
    }
    expect(get).toHaveBeenCalledWith("/automations/auto_1/runs/run_b");
    expect(get).toHaveBeenCalledWith("/automations/auto_1/runs/run_c");
  });
});

describe("list_skills", () => {
  it("pages through the catalog with the caller's cursor", async () => {
    const { client, get } = fakeClient({ get: () => ({ skills: [], hasMore: false }) });

    await tool("list_skills").run(client, { limit: 25, cursor: "deploy-service" });

    expect(get).toHaveBeenCalledWith("/skills", { limit: 25, cursor: "deploy-service" });
  });
});

describe("list_automations", () => {
  it("camel-cases the filters and passes the caller's cursor through", async () => {
    const { client, get } = fakeClient({
      get: () => ({ automations: [], hasMore: false, nextCursor: null }),
    });

    await tool("list_automations").run(client, {
      search: "nightly",
      repo_owner: "group/subgroup",
      repo_name: "api",
      limit: 50,
      cursor: "opaque",
    });

    expect(get).toHaveBeenCalledWith("/automations", {
      search: "nightly",
      repoOwner: "group/subgroup",
      repoName: "api",
      limit: 50,
      cursor: "opaque",
    });
  });

  it("refuses a blank or over-long search rather than letting the route answer", () => {
    // The route trims search and drops the filter when nothing survives, so a
    // blank one would answer with every automation; past its own cap it answers
    // 400, which the tool should not have let the model reach.
    const schema = z.object(tool("list_automations").inputSchema);

    expect(schema.safeParse({ search: "   " }).success).toBe(false);
    expect(schema.safeParse({ search: "x".repeat(MAX_AUTOMATION_NAME_LENGTH + 1) }).success).toBe(
      false
    );
    expect(schema.parse({ search: " nightly " }).search).toBe("nightly");
  });

  it("sends no filters of its own, leaving the control plane's page size", async () => {
    // Every value here is undefined, which the client drops from the query
    // string — a limit invented locally would override the server default and
    // then have to be kept in step with it.
    const { client, get } = fakeClient({
      get: () => ({ automations: [], hasMore: false, nextCursor: null }),
    });

    await tool("list_automations").run(client, {});

    expect(get).toHaveBeenCalledWith("/automations", {
      search: undefined,
      repoOwner: undefined,
      repoName: undefined,
      limit: undefined,
      cursor: undefined,
    });
  });
});

describe("create_automation", () => {
  it("camel-cases the body and defaults a schedule's timezone", async () => {
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      name: "Nightly sync",
      instructions: "Run the tests",
      schedule_cron: "0 9 * * *",
      repositories: [{ repo_owner: "acme", repo_name: "web-app", base_branch: "develop" }],
    });

    expect(post).toHaveBeenCalledWith("/automations", {
      teamId: undefined,
      name: "Nightly sync",
      instructions: "Run the tests",
      triggerType: undefined,
      scheduleCron: "0 9 * * *",
      scheduleTz: "UTC",
      eventType: undefined,
      triggerConfig: undefined,
      repositories: [{ repoOwner: "acme", repoName: "web-app", baseBranch: "develop" }],
      environmentIds: undefined,
      harness: undefined,
      model: undefined,
      reasoningEffort: undefined,
    });
  });

  it("forwards the owning team, which a workspace may require on creation", async () => {
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      team_id: "team_platform",
      name: "Nightly sync",
      instructions: "Run the tests",
      schedule_cron: "0 9 * * *",
    });

    expect(post).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ teamId: "team_platform" })
    );
    await expect(
      tool("create_automation").run(client, {
        team_id: "platform",
        name: "Nightly sync",
        instructions: "Run the tests",
      })
    ).rejects.toThrow();
  });

  it("forwards the concurrent run limit and refuses one outside its range", async () => {
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      name: "Implement tickets",
      instructions: "Pick the next ticket",
      schedule_cron: "*/5 * * * *",
      max_concurrent_runs: 10,
    });

    expect(post).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ maxConcurrentRuns: 10 })
    );
    await expect(
      tool("create_automation").run(client, {
        name: "Implement tickets",
        instructions: "Pick the next ticket",
        max_concurrent_runs: 11,
      })
    ).rejects.toThrow();
  });

  it("keeps the caller's timezone rather than the default", async () => {
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      name: "Nightly sync",
      instructions: "Run the tests",
      schedule_cron: "0 9 * * *",
      schedule_tz: "Europe/Berlin",
    });

    expect(post).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ scheduleTz: "Europe/Berlin" })
    );
  });

  it("sends no timezone on an event trigger, which the control plane refuses one on", async () => {
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      name: "Review PRs",
      instructions: "Review the diff",
      trigger_type: "github_event",
      event_type: "pull_request.opened",
      repositories: [{ repo_owner: "acme", repo_name: "web-app" }],
    });

    expect(post).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({
        triggerType: "github_event",
        eventType: "pull_request.opened",
        scheduleCron: undefined,
        scheduleTz: undefined,
        // Omitted, not null: the control plane reads an omitted base branch as
        // "the repository's own default" and a null one the same way, but only
        // the list entry itself carries that null.
        repositories: [{ repoOwner: "acme", repoName: "web-app", baseBranch: null }],
      })
    );
  });

  it("forwards the Sentry client secret, without which a sentry trigger is refused", async () => {
    // The control plane 400s every sentry create that carries no secret, so a
    // tool that could not send one advertised a trigger it could never use.
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      name: "Triage Sentry issues",
      instructions: "Investigate the issue",
      trigger_type: "sentry",
      sentry_client_secret: "sntrys_abc123",
    });

    expect(post).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ triggerType: "sentry", sentryClientSecret: "sntrys_abc123" })
    );
  });

  it("omits the Sentry secret entirely when none was given", async () => {
    const { client, post } = fakeClient({ post: () => ({ automation: { id: "auto_1" } }) });

    await tool("create_automation").run(client, {
      name: "Nightly sync",
      instructions: "Run the tests",
      schedule_cron: "0 9 * * *",
    });

    expect(post).toHaveBeenCalledWith(
      "/automations",
      expect.objectContaining({ sentryClientSecret: undefined })
    );
  });

  it("returns what the control plane reported, including a one-time webhook key", async () => {
    // The key is shown once at creation and never again, so narrowing the
    // response would make a webhook automation uncallable.
    const created = {
      automation: { id: "auto_1", name: "On push" },
      webhookApiKey: "whk_secret",
      webhookUrl: "https://cp.test/webhooks/automation/auto_1",
      warning: "Next scheduled run is more than 31 days away",
    };
    const { client } = fakeClient({ post: () => created });

    await expect(
      tool("create_automation").run(client, {
        name: "On push",
        instructions: "Do the thing",
        trigger_type: "webhook",
      })
    ).resolves.toEqual(created);
  });
});

describe("trigger_automation", () => {
  it("posts to the automation's trigger route", async () => {
    const { client, post } = fakeClient({
      post: () => ({ invocationId: "inv_1", runs: [{ id: "run_1" }] }),
    });

    const result = await tool("trigger_automation").run(client, { automation_id: "auto_1" });

    expect(post).toHaveBeenCalledWith("/automations/auto_1/trigger", {});
    expect(result).toEqual({ invocationId: "inv_1", runs: [{ id: "run_1" }] });
  });

  it("escapes the automation id into the path", async () => {
    const { client, post } = fakeClient({ post: () => ({ invocationId: "inv_1", runs: [] }) });

    await tool("trigger_automation").run(client, { automation_id: "auto/../1" });

    expect(post).toHaveBeenCalledWith("/automations/auto%2F..%2F1/trigger", {});
  });
});

describe("import_skill_from_git", () => {
  it("confirms the import against the digests the preview returned", async () => {
    const { client, post } = fakeClient({
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await tool("import_skill_from_git").run(client, {
      repo_owner: "acme",
      repo_name: "skills",
      ref: "main",
      subdirectory: "skills/deploy",
    });

    // Unconfirmed, the control plane would store whatever the source says at
    // apply time rather than what the preview showed.
    expect(post).toHaveBeenLastCalledWith("/skills/import", {
      source: {
        repository: { repoOwner: "acme", repoName: "skills" },
        ref: "main",
        subdirectory: "skills/deploy",
      },
      name: null,
      assignments: [],
      expectedCommitSha: "c".repeat(40),
      expectedSourceSha256: SOURCE_SHA256,
      expectedRevisionSha256: REVISION_SHA256,
    });
  });

  it("passes assignments through, since an unassigned skill loads nowhere", async () => {
    const { client, post } = fakeClient({
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await tool("import_skill_from_git").run(client, {
      repo_owner: "acme",
      repo_name: "skills",
      assignments: [{ type: "global" }],
    });

    expect(post).toHaveBeenLastCalledWith(
      "/skills/import",
      expect.objectContaining({ assignments: [{ type: "global" }] })
    );
  });

  it("names the tool that takes over when the skill already exists", async () => {
    const { client, post } = fakeClient({
      post: (path) =>
        path.endsWith("/preview") ? preview({ nameAvailable: false }) : storedSkill(),
    });

    await expect(
      tool("import_skill_from_git").run(client, { repo_owner: "acme", repo_name: "skills" })
    ).rejects.toThrow(/update_skill_from_git/);

    // Refused before the write, not after a 409 from the control plane.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reports file paths rather than file contents", async () => {
    const { client } = fakeClient({
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    const report = (await tool("import_skill_from_git").run(client, {
      repo_owner: "acme",
      repo_name: "skills",
    })) as { files: string[]; skill: Record<string, unknown>; warnings: unknown[] };

    expect(report.files).toEqual(["SKILL.md"]);
    expect(report.skill).not.toHaveProperty("body");
    expect(report.skill).not.toHaveProperty("files");
    expect(report.warnings).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("# Deploy");
  });
});

describe("update_skill_from_git", () => {
  it("pins the re-import to the revision it read, so a concurrent edit loses", async () => {
    const { client, post } = fakeClient({
      get: () => storedSkill({ currentRevisionId: "skillrev_1", revisionNumber: 1 }),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { ...storedSkill(), revisionCreated: true },
    });

    await tool("update_skill_from_git").run(client, { skill_id: "skill_1", ref: "v2" });

    expect(post).toHaveBeenLastCalledWith(
      "/skills/skill_1/reimport",
      {
        ref: "v2",
        expectedCommitSha: "c".repeat(40),
        expectedSourceSha256: SOURCE_SHA256,
        expectedRevisionSha256: REVISION_SHA256,
      },
      { headers: { "If-Match": '"skillrev_1"' } }
    );
  });

  it("defaults the ref to the one the skill recorded", async () => {
    const { client, post } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { ...storedSkill(), revisionCreated: true },
    });

    await tool("update_skill_from_git").run(client, { skill_id: "skill_1" });

    expect(post).toHaveBeenCalledWith("/skills/skill_1/reimport/preview", { ref: null });
  });

  it("surfaces an unchanged source rather than reporting a revision that was not added", async () => {
    const { client } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { ...storedSkill(), revisionCreated: false },
    });

    const report = (await tool("update_skill_from_git").run(client, { skill_id: "skill_1" })) as {
      revisionCreated: boolean;
      previousRevisionId: string;
    };

    expect(report.revisionCreated).toBe(false);
    expect(report.previousRevisionId).toBe("skillrev_2");
  });

  it("reports the provenance that was stored, not the one that was previewed", async () => {
    // A ref that advanced without changing the generated bytes keeps the old
    // revision and the commit it was recorded at. Reporting the previewed
    // commit would tell the model the skill moved when it did not.
    const { client } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview")
          ? preview({ source: { ...preview().source, commitSha: "b".repeat(40) } })
          : { ...storedSkill(), revisionCreated: false },
    });

    const report = (await tool("update_skill_from_git").run(client, { skill_id: "skill_1" })) as {
      source: { commitSha: string };
      revisionCreated: boolean;
    };

    expect(report.source.commitSha).toBe("a".repeat(40));
    expect(report.revisionCreated).toBe(false);
  });

  it("refuses a re-import result it does not recognize rather than inventing one", async () => {
    // The route always reports whether a revision was added; a result without it is not one this
    // build can describe, and guessing would report a storage fact nobody stated.
    const { client } = fakeClient({
      get: () => storedSkill(),
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await expect(
      tool("update_skill_from_git").run(client, { skill_id: "skill_1" })
    ).rejects.toThrow(/unrecognized re-import result/);
  });

  it("tolerates fields a newer control plane adds", async () => {
    const { client } = fakeClient({
      get: () => storedSkill({ pinned: true }),
      post: (path) =>
        path.endsWith("/preview")
          ? preview({ provenanceNote: "new", warnings: [{ code: "future-code", message: "m" }] })
          : { ...storedSkill(), revisionCreated: true, auditId: "a1" },
    });

    await expect(
      tool("update_skill_from_git").run(client, { skill_id: "skill_1" })
    ).resolves.toMatchObject({ revisionCreated: true, warnings: [{ code: "future-code" }] });
  });

  it("escapes the skill id into the path", async () => {
    const { client, get } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { ...storedSkill(), revisionCreated: true },
    });

    await tool("update_skill_from_git").run(client, { skill_id: "skill/../1" });

    expect(get).toHaveBeenCalledWith("/skills/skill%2F..%2F1");
  });
});
