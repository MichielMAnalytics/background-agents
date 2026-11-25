import {
  GITHUB_REVIEW_SUPERSEDE_PATH,
  githubReviewSupersedeResponseSchema,
  type GitHubReviewSupersedeRequest,
  type GitHubReviewSupersedeResponse,
} from "@open-inspect/shared/types/session-api";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

// Host `internal` is the control-plane service binding.
const REVIEW_SUPERSEDE_URL = `https://internal${GITHUB_REVIEW_SUPERSEDE_PATH}`;

/**
 * Record `sessionId` as its pull request's current review and have the control
 * plane cancel the review it replaced. Sent actorless: the sender of the new
 * review may not be allowed to stop a session another sender started.
 *
 * Throws when the control plane could not record the claim; a failed cancel is
 * not a failure here, it is reported in `cancelPendingSessionIds`.
 */
export async function supersedeInFlightReview(
  env: Env,
  traceId: string,
  request: GitHubReviewSupersedeRequest
): Promise<GitHubReviewSupersedeResponse> {
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: REVIEW_SUPERSEDE_URL,
    body: JSON.stringify(request),
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Review supersession failed: ${response.status} ${body}`);
  }
  const parsed = githubReviewSupersedeResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Review supersession failed: invalid response");
  }
  return parsed.data;
}
