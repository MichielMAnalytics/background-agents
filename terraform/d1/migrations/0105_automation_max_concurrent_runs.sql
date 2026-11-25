-- Let a schedule automation hold more than one firing in flight at a time.
--
-- Until now a schedule or manual firing was admitted only when the automation
-- had no active run. The column turns that boolean into a bound: the
-- scheduler admits a firing while fewer than max_concurrent_runs of the
-- automation's invocations have an active run. It counts invocations, not
-- runs, so a fan-out firing with one run per target holds a single slot.
--
-- The default of 1 reproduces the previous behaviour, so every existing
-- automation keeps it. The upper bound is MAX_AUTOMATION_CONCURRENT_RUNS in
-- @open-inspect/shared.
--
-- No index: the bound is checked by counting the automation's active runs,
-- which idx_runs_active_lookup (automation_id, created_at DESC) WHERE status
-- IN ACTIVE_RUN_STATUSES_SQL already serves.
ALTER TABLE automations ADD COLUMN max_concurrent_runs INTEGER NOT NULL DEFAULT 1
  CHECK (max_concurrent_runs BETWEEN 1 AND 10);
