import { Hono } from "hono";
import {
  GITHUB_REVIEW_SUPERSEDE_PATH,
  githubReviewSupersedeRequestSchema,
  type GitHubReviewSupersedeResponse,
} from "@open-inspect/shared/types/session-api";
import { GitHubPrReviewStore } from "../db/github-pr-review-store";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { parseBody } from "./body";
import { type SessionRouteContext, dispatchSession } from "./session-route";
import { error, GITHUB_SERVICE_ROUTE, json, serviceAuthorized } from "./shared";

const logger = createLogger("router:github-review-supersession");

/**
 * Bound on one cancel of a displaced review. A stalled session must not hold the
 * webhook open: a timed-out cancel stays pending for the next review to retry.
 */
const REVIEW_CANCEL_TIMEOUT_MS = 10_000;

/**
 * Most cancels from earlier claims retried per claim, after the one this claim
 * displaced. Pending rows only accumulate while cancels keep failing, so this
 * caps the time one webhook spends on them.
 */
const MAX_CANCEL_RETRIES_PER_CLAIM = 3;

type CancelOutcome = "cancelled" | "failed";

/**
 * Ask a displaced review's session to stop. 404 (no such session) and 409 (it
 * already ended) leave nothing to cancel, so they count as done.
 */
async function cancelDisplacedReview(
  ctx: SessionRouteContext,
  sessionId: string
): Promise<CancelOutcome> {
  try {
    const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.cancel, {
      method: "POST",
      signal: AbortSignal.timeout(REVIEW_CANCEL_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok || response.status === 404 || response.status === 409) return "cancelled";
    logger.warn("review_supersession.cancel_failed", {
      session_id: sessionId,
      status: response.status,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
  } catch (cause) {
    logger.warn("review_supersession.cancel_failed", {
      session_id: sessionId,
      error: cause instanceof Error ? cause : new Error(String(cause)),
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
  }
  return "failed";
}

/**
 * Record a new GitHub-bot review as its pull request's current review, then
 * best-effort cancel the review it replaced and retry earlier failed cancels.
 *
 * The new review always proceeds: a failed cancel is not an error. The displaced
 * row keeps cancel_pending set so the next review of the pull request retries the
 * cancel by id; the github-bot's prompts to a displaced session are refused.
 */
export async function handleGitHubReviewSupersede(
  request: Request,
  _env: Env,
  _params: object,
  ctx: SessionRouteContext
): Promise<Response> {
  const principal = ctx.principal;
  // Actorless: whoever triggered the new review may not be allowed to stop a
  // session another sender started.
  if (principal?.kind !== "service" || principal.actor !== null) {
    return error("Actorless github-bot authentication required", 403);
  }

  const body = await parseBody(
    request,
    githubReviewSupersedeRequestSchema,
    "Invalid review supersession request"
  );
  if (body instanceof Response) return body;

  const store = new GitHubPrReviewStore(ctx.db);
  const { displacedSessionIds, retrySessionIds } = await store.claim(
    {
      sessionId: body.sessionId,
      repositoryId: body.repositoryId,
      pullNumber: body.pullNumber,
      now: Date.now(),
    },
    MAX_CANCEL_RETRIES_PER_CLAIM
  );

  // The review this claim displaced is the one most likely still running, so
  // it goes first; a slow retry of an older one must not delay it.
  const result: GitHubReviewSupersedeResponse = {
    cancelledSessionIds: [],
    cancelPendingSessionIds: [],
  };
  for (const sessionId of [...displacedSessionIds, ...retrySessionIds]) {
    if ((await cancelDisplacedReview(ctx, sessionId)) === "cancelled") {
      await store.markCancelled(sessionId, Date.now());
      result.cancelledSessionIds.push(sessionId);
    } else {
      result.cancelPendingSessionIds.push(sessionId);
    }
  }

  logger.info("review_supersession.claimed", {
    session_id: body.sessionId,
    repository_id: body.repositoryId,
    pull_number: body.pullNumber,
    displaced_count: displacedSessionIds.length,
    cancelled_count: result.cancelledSessionIds.length,
    cancel_pending_count: result.cancelPendingSessionIds.length,
    trace_id: ctx.trace_id,
    request_id: ctx.request_id,
  });

  return json(result);
}

export const githubReviewSupersessionRoutes = new Hono<ControlPlaneHonoEnv>();

githubReviewSupersessionRoutes.post(
  GITHUB_REVIEW_SUPERSEDE_PATH,
  admit({
    ...GITHUB_SERVICE_ROUTE,
    authorization: serviceAuthorized("github-bot"),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, handleGitHubReviewSupersede)
);
