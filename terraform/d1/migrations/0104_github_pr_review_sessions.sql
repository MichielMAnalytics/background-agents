-- The GitHub bot's review sessions for a pull request (review requests and
-- auto-reviews; mentions are never rows here). One row per review session,
-- kept after the session ends so a replayed claim for it is recognized.
--
-- superseded_by is NULL on the pull request's current review. A newer review
-- sets it on the one it replaces, together with cancel_pending, and then
-- cancels that session. cancel_pending is cleared once the cancel succeeds;
-- while it is set, the next review of the same pull request retries the
-- cancel by session id. The control plane refuses the github-bot's prompts to
-- any session with superseded_by set.
CREATE TABLE github_pr_review_sessions (
  session_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  pull_number INTEGER NOT NULL,
  superseded_by TEXT,
  cancel_pending INTEGER NOT NULL DEFAULT 0 CHECK (cancel_pending IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_github_pr_review_sessions_current
  ON github_pr_review_sessions (repository_id, pull_number)
  WHERE superseded_by IS NULL;

CREATE INDEX idx_github_pr_review_sessions_cancel_pending
  ON github_pr_review_sessions (repository_id, pull_number)
  WHERE cancel_pending = 1;
