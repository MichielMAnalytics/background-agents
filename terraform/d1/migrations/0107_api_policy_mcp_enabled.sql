-- Whether the hosted MCP server at /mcp serves requests. Part of the API
-- policy (workspace_personal_access_token_policy), edited by holders of
-- workspace.personal_access_tokens.manage under the same revision and audit
-- event as the rest of the policy. On by default; off answers /mcp with 404
-- while personal access tokens keep working against the API directly.
ALTER TABLE workspace_personal_access_token_policy
  ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mcp_enabled IN (0, 1));
