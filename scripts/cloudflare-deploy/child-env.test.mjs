import assert from "node:assert/strict";
import test from "node:test";

import { allowlistedEnv } from "./child-env.mjs";

test("deployment credentials never reach child processes", () => {
  const env = allowlistedEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    LC_ALL: "C",
    UV_CACHE_DIR: "/cache",
    npm_config_cache: "/npm",
    GH_APP_PRIVATE_KEY: "key",
    SLACK_BOT_TOKEN: "xoxb",
    ANTHROPIC_API_KEY: "sk",
    TOKEN_ENCRYPTION_KEY: "k",
    NEXTAUTH_SECRET: "s",
    CLOUDFLARE_API_TOKEN: "cf",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    LC_ALL: "C",
    UV_CACHE_DIR: "/cache",
    npm_config_cache: "/npm",
  });
});

test("a step's own environment is added on top", () => {
  assert.deepEqual(
    allowlistedEnv({ PATH: "/bin", GH_APP_ID: "1" }, { CLOUDFLARE_API_TOKEN: "cf" }),
    {
      PATH: "/bin",
      CLOUDFLARE_API_TOKEN: "cf",
    }
  );
});
