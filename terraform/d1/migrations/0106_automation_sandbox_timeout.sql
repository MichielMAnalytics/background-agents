-- Let one automation override the time budget its runs inherit.
--
-- A run's budget is its session's sandbox timeout, resolved from the target
-- repository's or environment's sandbox settings, then the deployment's
-- EXECUTION_TIMEOUT_MS, then the provider default. Changing it for one
-- automation meant changing it for every session on that repository.
--
-- When set, this value replaces the inherited sandbox timeout for this
-- automation's runs only, in either direction. NULL inherits, which is why it
-- is the default and why every existing automation keeps it.
--
-- The bounds are MIN/MAX_AUTOMATION_SANDBOX_TIMEOUT_MS in @open-inspect/shared.
ALTER TABLE automations ADD COLUMN sandbox_timeout_ms INTEGER
  CHECK (sandbox_timeout_ms IS NULL OR sandbox_timeout_ms BETWEEN 900000 AND 86400000);
