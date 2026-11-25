import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPrReviewStore } from "../../src/db/github-pr-review-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserStore } from "../../src/db/user-store";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";
import { initSession, serviceFetch, sqlDatabase } from "./helpers";

const BASE = "https://test.local";
const SUPERSEDE_URL = `${BASE}/github/reviews/supersede`;
const REPOSITORY_ID = 99;
const PULL_NUMBER = 42;

function claim(sessionId: string, pullNumber = PULL_NUMBER) {
  return serviceFetch(SUPERSEDE_URL, {
    service: "github-bot",
    method: "POST",
    body: JSON.stringify({ sessionId, repositoryId: REPOSITORY_ID, pullNumber }),
  });
}

const BOT_ACTOR = "github:1001";

/** A review session created through the bot's own session API, as production creates it. */
async function createReviewSession(): Promise<string> {
  vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess").mockResolvedValue({
    repoId: 12345,
    repoOwner: "acme",
    repoName: "web-app",
    defaultBranch: "main",
  });
  const created = await serviceFetch(`${BASE}/sessions`, {
    service: "github-bot",
    method: "POST",
    actor: BOT_ACTOR,
    body: JSON.stringify({
      title: "GitHub: PR #42",
      model: "anthropic/claude-haiku-4-5",
      repoOwner: "acme",
      repoName: "web-app",
      githubReview: true,
    }),
  });
  expect(created.status).toBe(201);
  return (await created.json<{ sessionId: string }>()).sessionId;
}

/** The github-bot's review prompt, sent as its trigger's GitHub actor. */
function botPrompt(sessionId: string) {
  return serviceFetch(`${BASE}/sessions/${sessionId}/prompt`, {
    service: "github-bot",
    method: "POST",
    actor: BOT_ACTOR,
    body: JSON.stringify({ content: "review the pull request", source: "github" }),
  });
}

async function cancelPending(sessionId: string) {
  const row = await env.DB.prepare(
    "SELECT cancel_pending FROM github_pr_review_sessions WHERE session_id = ?"
  )
    .bind(sessionId)
    .first<{ cancel_pending: number }>();
  return row?.cancel_pending;
}

async function sessionStatus(sessionId: string) {
  return (await new SessionIndexStore(env.DB).get(sessionId))?.status;
}

describe("POST /github/reviews/supersede", () => {
  beforeEach(() => cleanD1Tables());
  afterEach(() => vi.restoreAllMocks());

  it("cancels the review it replaces through the session runtime", async () => {
    const first = { sessionName: await createReviewSession() };
    const second = { sessionName: await createReviewSession() };

    const initial = await claim(first.sessionName);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(initial.json()).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: [],
    });

    const replaced = await claim(second.sessionName);
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toEqual({
      cancelledSessionIds: [first.sessionName],
      cancelPendingSessionIds: [],
    });

    expect(await sessionStatus(first.sessionName)).toBe("cancelled");
    expect(await sessionStatus(second.sessionName)).toBe("created");
    const store = new GitHubPrReviewStore(sqlDatabase(env.DB));
    await expect(store.isSuperseded(first.sessionName)).resolves.toBe(true);
    await expect(store.isSuperseded(second.sessionName)).resolves.toBe(false);
    expect(await cancelPending(first.sessionName)).toBe(0);

    // The displaced session refuses the github-bot's late prompt; the new one takes it.
    const late = await botPrompt(first.sessionName);
    expect(late.status).toBe(409);
    await expect(late.json()).resolves.toMatchObject({ code: "review_superseded" });
    expect((await botPrompt(second.sessionName)).status).toBe(200);
  });

  it("does not touch the review of another pull request", async () => {
    const first = await initSession({ sessionName: "review-a" });
    const other = await initSession({ sessionName: "review-other" });

    await claim(first.sessionName);
    const separate = await claim(other.sessionName, PULL_NUMBER + 1);
    await expect(separate.json()).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: [],
    });
    expect(await sessionStatus(first.sessionName)).toBe("created");
  });

  it("refuses the github-bot's prompt to a displaced review whose cancel is still pending", async () => {
    const pending = { sessionName: await createReviewSession() };
    // The state a failed cancel leaves behind: displaced, with its cancel still pending.
    await env.DB.prepare(
      `INSERT INTO github_pr_review_sessions
         (session_id, repository_id, pull_number, superseded_by, cancel_pending, created_at, updated_at)
       VALUES (?, ?, ?, 'review-newer', 1, 1, 1)`
    )
      .bind(pending.sessionName, REPOSITORY_ID, PULL_NUMBER)
      .run();

    const prompt = await botPrompt(pending.sessionName);
    expect(prompt.status).toBe(409);
    await expect(prompt.json()).resolves.toMatchObject({ code: "review_superseded" });
    expect(await sessionStatus(pending.sessionName)).toBe("created");

    // Only the github-bot is fenced: a workspace owner can still prompt the session from the web.
    const web = await serviceFetch(`${BASE}/sessions/${pending.sessionName}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: "continue anyway" }),
    });
    expect(web.status).toBe(200);
  });

  it("retries a pending cancel by session id on the next claim of the pull request", async () => {
    const pending = await initSession({ sessionName: "review-pending" });
    const next = await initSession({ sessionName: "review-next" });
    await env.DB.prepare(
      `INSERT INTO github_pr_review_sessions
         (session_id, repository_id, pull_number, superseded_by, cancel_pending, created_at, updated_at)
       VALUES (?, ?, ?, 'review-gone', 1, 1, 1)`
    )
      .bind(pending.sessionName, REPOSITORY_ID, PULL_NUMBER)
      .run();

    const response = await claim(next.sessionName);
    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["review-pending"],
      cancelPendingSessionIds: [],
    });
    expect(await sessionStatus(pending.sessionName)).toBe("cancelled");
    expect(await cancelPending(pending.sessionName)).toBe(0);
  });

  it("rejects an actor and every caller other than the github bot", async () => {
    const body = JSON.stringify({
      sessionId: "review-a",
      repositoryId: REPOSITORY_ID,
      pullNumber: PULL_NUMBER,
    });
    const actor = await serviceFetch(SUPERSEDE_URL, {
      service: "github-bot",
      method: "POST",
      actor: "github:101",
      body,
    });
    expect(actor.status).toBe(403);
    expect(await new UserStore(env.DB).getIdentity("github", "101")).toBeNull();

    const slack = await serviceFetch(SUPERSEDE_URL, {
      service: "slack-bot",
      method: "POST",
      body,
    });
    expect(slack.status).toBe(403);

    const anonymous = await SELF.fetch(SUPERSEDE_URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    expect(anonymous.status).toBe(401);

    const invalid = await serviceFetch(SUPERSEDE_URL, {
      service: "github-bot",
      method: "POST",
      body: JSON.stringify({ sessionId: "", repositoryId: 0, pullNumber: 1 }),
    });
    expect(invalid.status).toBe(400);
  });
});
