import type { SqlDatabase } from "./sql-database";

export interface GitHubPrReviewClaim {
  sessionId: string;
  repositoryId: number;
  pullNumber: number;
  now: number;
}

export interface GitHubPrReviewClaimResult {
  /** The review this claim replaced, if any. Its cancel should be attempted first. */
  displacedSessionIds: string[];
  /** Reviews displaced by earlier claims whose cancel has not succeeded yet, newest first. */
  retrySessionIds: string[];
}

interface SessionIdRow {
  session_id: string;
}

function sessionIds(rows: SessionIdRow[]): string[] {
  return rows.map((row) => {
    if (typeof row.session_id !== "string" || row.session_id.length === 0) {
      throw new Error("GitHub PR review store returned an invalid session id");
    }
    return row.session_id;
  });
}

/**
 * Which GitHub-bot review is current for each pull request, and which displaced
 * reviews still need cancelling. See migration 0104 for the row lifecycle.
 */
export class GitHubPrReviewStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Make `sessionId` its pull request's current review in one batch: displace
   * the current row, insert this one, and read back the displaced reviews still
   * awaiting a cancel. A session that already has a row (current, displaced, or
   * displaced and cancelled; rows are never deleted) claims nothing, so a
   * repeated or replayed claim is a no-op and a displaced review can never take
   * its pull request back.
   */
  async claim(input: GitHubPrReviewClaim, retryLimit: number): Promise<GitHubPrReviewClaimResult> {
    const [displaced, , pending] = await this.db.batch<SessionIdRow>([
      this.db
        .prepare(
          `UPDATE github_pr_review_sessions
           SET superseded_by = ?, cancel_pending = 1, updated_at = ?
           WHERE repository_id = ? AND pull_number = ?
             AND superseded_by IS NULL
             AND session_id != ?
             AND NOT EXISTS (
               SELECT 1 FROM github_pr_review_sessions WHERE session_id = ?
             )
           RETURNING session_id`
        )
        .bind(
          input.sessionId,
          input.now,
          input.repositoryId,
          input.pullNumber,
          input.sessionId,
          input.sessionId
        ),
      this.db
        .prepare(
          `INSERT INTO github_pr_review_sessions (
             session_id, repository_id, pull_number, superseded_by, created_at, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?)
           ON CONFLICT (session_id) DO NOTHING`
        )
        .bind(input.sessionId, input.repositoryId, input.pullNumber, input.now, input.now),
      this.db
        .prepare(
          `SELECT session_id FROM github_pr_review_sessions
           WHERE repository_id = ? AND pull_number = ?
             AND cancel_pending = 1
           ORDER BY updated_at DESC, session_id
           LIMIT ?`
        )
        // One extra row so the displaced review never crowds out a retry.
        .bind(input.repositoryId, input.pullNumber, retryLimit + 1),
    ]);
    const displacedSessionIds = sessionIds(displaced.results);
    const displacedSet = new Set(displacedSessionIds);
    const retrySessionIds = sessionIds(pending.results)
      .filter((id) => !displacedSet.has(id))
      .slice(0, retryLimit);
    return { displacedSessionIds, retrySessionIds };
  }

  /**
   * Stop retrying a displaced review's cancel once it has succeeded or the session
   * had already ended. The row stays, so a replayed claim for it is still refused.
   */
  async markCancelled(sessionId: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_pr_review_sessions
         SET cancel_pending = 0, updated_at = ?
         WHERE session_id = ? AND cancel_pending = 1`
      )
      .bind(now, sessionId)
      .run();
  }

  /** True once a newer review of the same pull request has displaced this session. */
  async isSuperseded(sessionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS superseded FROM github_pr_review_sessions
         WHERE session_id = ? AND superseded_by IS NOT NULL`
      )
      .bind(sessionId)
      .first<{ superseded: number }>();
    return row !== null;
  }
}
