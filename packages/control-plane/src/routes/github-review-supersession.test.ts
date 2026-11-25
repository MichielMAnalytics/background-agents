import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubPrReviewStore } from "../db/github-pr-review-store";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import type { SqlDatabase } from "../db/sql-database";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRouteContext } from "./session-route";
import { handleGitHubReviewSupersede } from "./github-review-supersession";

const migration = readFileSync(
  fileURLToPath(
    new NodeURL(
      "../../../../terraform/d1/migrations/0104_github_pr_review_sessions.sql",
      import.meta.url
    )
  ),
  "utf8"
);

const REPOSITORY_ID = 99;
const PULL_NUMBER = 42;

function claimRequest(sessionId: string, pullNumber = PULL_NUMBER): Request {
  return new Request("https://internal/github/reviews/supersede", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, repositoryId: REPOSITORY_ID, pullNumber }),
  });
}

describe("handleGitHubReviewSupersede", () => {
  let sqlite: DatabaseSync;
  let db: SqlDatabase;
  let cancelCalls: string[];
  let cancelResult: (sessionId: string) => Response | Promise<Response>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(migration);
    db = createNodeSqlDatabase(sqlite);
    cancelCalls = [];
    cancelResult = () => Response.json({ status: "cancelled" });
  });

  afterEach(() => sqlite.close());

  function context(actor: string | null = null): SessionRouteContext {
    return {
      db,
      principal: { kind: "service", service: "github-bot", actor },
      trace_id: "trace",
      request_id: "request",
      sessionRuntime: {
        fetch: async (sessionId: string, path: string) => {
          expect(path).toBe(SessionInternalPaths.cancel);
          cancelCalls.push(sessionId);
          return cancelResult(sessionId);
        },
      },
    } as unknown as SessionRouteContext;
  }

  async function claim(sessionId: string, pullNumber = PULL_NUMBER) {
    const response = await handleGitHubReviewSupersede(
      claimRequest(sessionId, pullNumber),
      {} as never,
      {},
      context()
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  type Row = { session_id: string; superseded_by: string | null; cancel_pending: number };

  function rows(): Row[] {
    return sqlite
      .prepare(
        `SELECT session_id, superseded_by, cancel_pending FROM github_pr_review_sessions
         ORDER BY session_id`
      )
      .all() as Row[];
  }

  it("cancels the review it replaces and stops retrying it once cancelled", async () => {
    await expect(claim("review-a")).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: [],
    });
    await expect(claim("review-b")).resolves.toEqual({
      cancelledSessionIds: ["review-a"],
      cancelPendingSessionIds: [],
    });

    expect(cancelCalls).toEqual(["review-a"]);
    expect(rows()).toEqual([
      { session_id: "review-a", superseded_by: "review-b", cancel_pending: 0 },
      { session_id: "review-b", superseded_by: null, cancel_pending: 0 },
    ]);
  });

  it("refuses a replayed claim for a review that was already displaced and cancelled", async () => {
    await claim("review-a");
    await claim("review-b");
    cancelCalls = [];

    await expect(claim("review-a")).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: [],
    });
    expect(cancelCalls).toEqual([]);
    expect(rows()).toEqual([
      { session_id: "review-a", superseded_by: "review-b", cancel_pending: 0 },
      { session_id: "review-b", superseded_by: null, cancel_pending: 0 },
    ]);
  });

  it("treats a session that is gone or already ended as cancelled", async () => {
    await claim("review-a");
    cancelResult = () => Response.json({ error: "Session already completed" }, { status: 409 });
    await expect(claim("review-b")).resolves.toMatchObject({ cancelledSessionIds: ["review-a"] });

    cancelResult = () => Response.json({ error: "Session not found" }, { status: 404 });
    await expect(claim("review-c")).resolves.toMatchObject({ cancelledSessionIds: ["review-b"] });
    expect(rows().filter((row) => row.cancel_pending === 1)).toEqual([]);
  });

  it("keeps the new review current when the cancel fails, and retries it on the next claim", async () => {
    await claim("review-a");
    cancelResult = () => new Response("unavailable", { status: 503 });

    await expect(claim("review-b")).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: ["review-a"],
    });
    expect(rows()).toEqual([
      { session_id: "review-a", superseded_by: "review-b", cancel_pending: 1 },
      { session_id: "review-b", superseded_by: null, cancel_pending: 0 },
    ]);
    await expect(new GitHubPrReviewStore(db).isSuperseded("review-a")).resolves.toBe(true);
    await expect(new GitHubPrReviewStore(db).isSuperseded("review-b")).resolves.toBe(false);

    cancelCalls = [];
    cancelResult = () => Response.json({ status: "cancelled" });
    await expect(claim("review-c")).resolves.toEqual({
      cancelledSessionIds: ["review-b", "review-a"],
      cancelPendingSessionIds: [],
    });
    // The review this claim displaced goes before the older retry.
    expect(cancelCalls).toEqual(["review-b", "review-a"]);
    expect(rows().filter((row) => row.cancel_pending === 1)).toEqual([]);
  });

  it("treats a thrown or timed-out cancel as a failure to retry", async () => {
    await claim("review-a");
    cancelResult = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    await expect(claim("review-b")).resolves.toMatchObject({
      cancelPendingSessionIds: ["review-a"],
    });
  });

  it("is a no-op for a session that already claimed, even after it was displaced", async () => {
    await claim("review-a");
    await expect(claim("review-a")).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: [],
    });

    cancelResult = () => new Response("unavailable", { status: 503 });
    await claim("review-b");
    cancelCalls = [];
    // A displaced review re-claiming must not take its pull request back.
    await claim("review-a");
    expect(rows()).toEqual([
      { session_id: "review-a", superseded_by: "review-b", cancel_pending: 1 },
      { session_id: "review-b", superseded_by: null, cancel_pending: 0 },
    ]);
    expect(cancelCalls).toEqual(["review-a"]);
  });

  it("leaves reviews of other pull requests alone", async () => {
    await claim("review-a");
    await expect(claim("review-other", PULL_NUMBER + 1)).resolves.toEqual({
      cancelledSessionIds: [],
      cancelPendingSessionIds: [],
    });
    expect(cancelCalls).toEqual([]);
  });

  it("bounds how many earlier failed cancels one claim retries", async () => {
    cancelResult = () => new Response("unavailable", { status: 503 });
    for (const id of ["review-1", "review-2", "review-3", "review-4", "review-5", "review-6"]) {
      await claim(id);
    }
    cancelCalls = [];
    await claim("review-7");
    // review-6 is the one this claim displaced; three older failures are retried after it.
    expect(cancelCalls).toHaveLength(4);
    expect(cancelCalls[0]).toBe("review-6");
  });

  it("refuses a request carrying an actor", async () => {
    const response = await handleGitHubReviewSupersede(
      claimRequest("review-a"),
      {} as never,
      {},
      context("github:101")
    );
    expect(response.status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it("rejects an invalid body", async () => {
    const response = await handleGitHubReviewSupersede(
      new Request("https://internal/github/reviews/supersede", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "", repositoryId: 0, pullNumber: 1 }),
      }),
      {} as never,
      {},
      context()
    );
    expect(response.status).toBe(400);
  });
});
