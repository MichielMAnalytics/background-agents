import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ConfigError,
  CONTROL_PLANE_CRONS,
  controlPlaneMigrations,
  planWeb,
  planWorkers,
  readSettings,
  requiredKvTitles,
  sandboxArtifactName,
  secretActions,
} from "./config.mjs";

const BASE = Object.freeze({
  DEPLOYMENT_NAME: "acme",
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_WORKER_SUBDOMAIN: "acct",
  GH_APP_ID: "1",
  GH_APP_PRIVATE_KEY: "private-key",
  GH_APP_INSTALLATION_ID: "2",
  GH_OAUTH_CLIENT_ID: "github-id",
  GH_OAUTH_CLIENT_SECRET: "github-secret",
  ALLOWED_USERS: "octocat",
  TOKEN_ENCRYPTION_KEY: "token-key",
  REPO_SECRETS_ENCRYPTION_KEY: "repo-key",
  NEXTAUTH_SECRET: "test-browser-auth-secret-with-32-characters",
  MODAL_WORKSPACE: "workspace",
  MODAL_API_SECRET: "modal-secret",
  SLACK_BOT_TOKEN: "xoxb-token",
  SLACK_SIGNING_SECRET: "signing",
  ANTHROPIC_API_KEY: "anthropic-key",
});

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function settings(overrides = {}) {
  return readSettings({ ...BASE, ...overrides });
}

function resources(s, extra = {}) {
  return {
    kvIds: Object.fromEntries(requiredKvTitles(s).map((title) => [title, `id-${title}`])),
    d1DatabaseId: "d1-id",
    controlPlaneMigrationTag: null,
    sandboxHash: HASH,
    ...extra,
  };
}

function plan(overrides = {}, extra = {}) {
  const s = settings(overrides);
  return planWorkers(s, resources(s, extra));
}

function worker(p, key) {
  return p.workers.find((w) => w.key === key);
}

function rejects(overrides, pattern) {
  assert.throws(
    () => settings(overrides),
    (error) => error instanceof ConfigError && error.messages.some((m) => pattern.test(m)),
    `expected a configuration error matching ${pattern}`
  );
}

// ---------------------------------------------------------------------------
// Names shared with Terraform
// ---------------------------------------------------------------------------

test("Worker and resource names match the Terraform module", () => {
  const p = plan({
    ENABLE_GITHUB_BOT: "true",
    GH_WEBHOOK_SECRET: "w",
    GH_BOT_USERNAME: "bot[bot]",
  });
  const cp = worker(p, "control-plane").wrangler;
  assert.equal(cp.name, "open-inspect-control-plane-acme");
  assert.deepEqual(cp.d1_databases, [
    { binding: "DB", database_id: "d1-id", database_name: "open-inspect-acme" },
  ]);
  assert.deepEqual(cp.kv_namespaces, [
    { binding: "REPOS_CACHE", id: "id-open-inspect-session-index-acme" },
  ]);
  assert.deepEqual(cp.r2_buckets, [
    { binding: "MEDIA_BUCKET", bucket_name: "open-inspect-media-acme" },
  ]);
  assert.deepEqual(
    cp.queues.consumers.map((c) => [c.queue, c.dead_letter_queue, c.max_retries, c.retry_delay]),
    [
      [
        "open-inspect-image-build-finalization-acme",
        "open-inspect-image-build-finalization-dlq-acme",
        12,
        15,
      ],
      ["open-inspect-github-autofix-acme", "open-inspect-github-autofix-dlq-acme", 4, 30],
    ]
  );
  assert.equal(worker(p, "github-bot").wrangler.name, "open-inspect-github-bot-acme");
});

test("an imported media bucket name is honoured", () => {
  const cp = worker(plan({ R2_MEDIA_BUCKET_NAME: "legacy-media" }), "control-plane").wrangler;
  assert.equal(cp.r2_buckets[0].bucket_name, "legacy-media");
});

test("a missing KV namespace points at the Terraform apply", () => {
  const s = settings();
  assert.throws(() => planWorkers(s, resources(s, { kvIds: {} })), /Run the Terraform apply/);
});

test("Workers keep the settings Terraform gives the script", () => {
  const cp = worker(plan(), "control-plane").wrangler;
  assert.equal(cp.workers_dev, true);
  assert.equal(cp.no_bundle, true);
  assert.equal(cp.main, "dist/index.js");
  assert.deepEqual(cp.observability.logs, {
    enabled: true,
    head_sampling_rate: 1,
    invocation_logs: true,
  });
  assert.deepEqual(cp.triggers.crons, [...CONTROL_PLANE_CRONS]);
});

// ---------------------------------------------------------------------------
// Durable Object migrations
// ---------------------------------------------------------------------------

test("fresh and v1 control planes get only the SessionDO migration", () => {
  for (const tag of [null, "", "v1"]) {
    assert.deepEqual(controlPlaneMigrations(tag), [
      { tag: "v1", new_sqlite_classes: ["SessionDO"] },
    ]);
  }
});

test("a v2 control plane retires SchedulerDO and a v3 one stays put", () => {
  for (const tag of ["v2", "v3"]) {
    const migrations = controlPlaneMigrations(tag);
    assert.deepEqual(
      migrations.map((m) => m.tag),
      ["v1", "v2", "v3"]
    );
    assert.deepEqual(migrations.at(-1), { tag: "v3", deleted_classes: ["SchedulerDO"] });
  }
});

test("an unknown migration tag refuses to deploy", () => {
  assert.throws(() => controlPlaneMigrations("v9"), /unknown Durable Object migration tag/);
});

test("the SESSION binding ships with its migration", () => {
  const cp = worker(plan({}, { controlPlaneMigrationTag: null }), "control-plane").wrangler;
  assert.deepEqual(cp.durable_objects.bindings, [{ name: "SESSION", class_name: "SessionDO" }]);
});

// ---------------------------------------------------------------------------
// Access control and sign-in (were terraform checks.tf)
// ---------------------------------------------------------------------------

test("no allowlist and no unsafe opt-in is rejected", () => {
  rejects({ ALLOWED_USERS: "" }, /At least one access control allowlist/);
});

test("no complete sign-in provider is rejected", () => {
  rejects(
    { GH_OAUTH_CLIENT_ID: "", GH_OAUTH_CLIENT_SECRET: "" },
    /complete OAuth sign-in provider/
  );
});

test("a partial OAuth pair is rejected", () => {
  rejects({ GH_OAUTH_CLIENT_SECRET: "" }, /GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET/);
  rejects({ GOOGLE_CLIENT_ID: "google" }, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
});

test("Google sign-in needs a provider-neutral rule", () => {
  rejects({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" }, /Google sign-in requires/);
  assert.ok(
    settings({
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "gs",
      ALLOWED_EMAIL_DOMAINS: "example.com",
    })
  );
});

test("only the enabled OAuth pairs reach the control plane", () => {
  const google = worker(
    plan({
      GH_OAUTH_CLIENT_ID: "",
      GH_OAUTH_CLIENT_SECRET: "",
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "gs",
      ALLOWED_EMAILS: "a@example.com",
    }),
    "control-plane"
  );
  assert.equal(google.wrangler.vars.GOOGLE_CLIENT_ID, "g");
  assert.equal(google.wrangler.vars.GITHUB_CLIENT_ID, undefined);
  const actions = secretActions(google);
  assert.equal(actions.upload.GOOGLE_CLIENT_SECRET, "gs");
  assert.ok(
    actions.remove.includes("GITHUB_CLIENT_SECRET"),
    "a disabled pair's stale secret is removed"
  );
});

test("a custom domain needs the Cloudflare web platform and a zone", () => {
  rejects({ CLOUDFLARE_CUSTOM_DOMAIN: "app.example.com" }, /would be silently ignored/);
  rejects(
    {
      CLOUDFLARE_CUSTOM_DOMAIN: "https://app.example.com",
      WEB_PLATFORM: "cloudflare",
      CLOUDFLARE_ZONE_ID: "z",
    },
    /bare hostname/
  );
});

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

test("bot default models keep their previous defaults", () => {
  const p = plan({
    ENABLE_GITHUB_BOT: "true",
    GH_WEBHOOK_SECRET: "w",
    GH_BOT_USERNAME: "bot[bot]",
    ENABLE_LINEAR_BOT: "true",
    LINEAR_CLIENT_ID: "l",
    LINEAR_CLIENT_SECRET: "l",
    LINEAR_WEBHOOK_SECRET: "l",
  });
  assert.equal(worker(p, "github-bot").wrangler.vars.DEFAULT_MODEL, "anthropic/claude-haiku-4-5");
  assert.equal(worker(p, "slack-bot").wrangler.vars.DEFAULT_MODEL, "claude-haiku-4-5");
  assert.equal(worker(p, "linear-bot").wrangler.vars.DEFAULT_MODEL, "claude-sonnet-4-6");
  assert.equal(
    worker(p, "linear-bot").wrangler.vars.WORKER_URL,
    "https://open-inspect-linear-bot-acme.acct.workers.dev"
  );
});

for (const bad of [
  "anthropic/",
  "claude-",
  "/x",
  "anthropic/ claude-haiku-4-5",
  "claude-haiku-4-5 ",
  "a/b/c",
  "haiku",
]) {
  test(`bot default model ${JSON.stringify(bad)} is rejected`, () => {
    rejects({ SLACK_BOT_DEFAULT_MODEL: bad }, /SLACK_BOT_DEFAULT_MODEL must be/);
  });
}

test("enabled bots require their credentials", () => {
  rejects({ SLACK_BOT_TOKEN: "" }, /ENABLE_SLACK_BOT/);
  rejects({ ENABLE_GITHUB_BOT: "true" }, /ENABLE_GITHUB_BOT/);
  rejects({ ENABLE_LINEAR_BOT: "true" }, /ENABLE_LINEAR_BOT/);
});

test("disabled bots are not deployed or bound", () => {
  const p = plan({ ENABLE_SLACK_BOT: "false", SLACK_BOT_TOKEN: "" });
  assert.deepEqual(
    p.workers.map((w) => w.key),
    ["control-plane"]
  );
  assert.deepEqual(worker(p, "control-plane").wrangler.services, []);
});

test("service bindings can be held back for a first deploy", () => {
  const p = plan({ ENABLE_SERVICE_BINDINGS: "false" });
  assert.deepEqual(worker(p, "control-plane").wrangler.services, []);
  assert.deepEqual(worker(p, "slack-bot").wrangler.services, []);
});

test("booleans must be true or false", () => {
  rejects({ ENABLE_SLACK_BOT: "yes" }, /ENABLE_SLACK_BOT must be "true" or "false"/);
});

// ---------------------------------------------------------------------------
// Reviewer App
// ---------------------------------------------------------------------------

const REVIEWER = {
  GH_REVIEWER_USERNAME: "my-reviewer[bot]",
  GH_REVIEWER_APP_ID: "2",
  GH_REVIEWER_APP_PRIVATE_KEY: "reviewer-private-key",
  GH_REVIEWER_APP_INSTALLATION_ID: "22",
};
const GITHUB_BOT = {
  ENABLE_GITHUB_BOT: "true",
  GH_WEBHOOK_SECRET: "w",
  GH_BOT_USERNAME: "my-app[bot]",
};

test("the reviewer App is disabled by default and binds no empty secrets", () => {
  const cp = secretActions(worker(plan(), "control-plane"));
  for (const name of [
    "GITHUB_REVIEWER_APP_ID",
    "GITHUB_REVIEWER_APP_PRIVATE_KEY",
    "GITHUB_REVIEWER_APP_INSTALLATION_ID",
  ]) {
    assert.equal(cp.upload[name], undefined);
    assert.ok(cp.remove.includes(name), `${name} is removed when unconfigured`);
  }
});

test("the reviewer App coexists with the main App and the bot needs only the login", () => {
  const p = plan({ ...GITHUB_BOT, ...REVIEWER });
  const cp = secretActions(worker(p, "control-plane"));
  assert.equal(cp.upload.GITHUB_REVIEWER_APP_PRIVATE_KEY, "reviewer-private-key");
  assert.equal(cp.upload.GITHUB_REVIEWER_APP_ID, "2");
  assert.equal(cp.upload.GITHUB_REVIEWER_APP_INSTALLATION_ID, "22");
  assert.equal(cp.upload.GITHUB_APP_PRIVATE_KEY, "private-key");
  const bot = worker(p, "github-bot");
  assert.equal(bot.wrangler.vars.GITHUB_REVIEWER_USERNAME, "my-reviewer[bot]");
  assert.equal(secretActions(bot).upload.GITHUB_REVIEWER_APP_PRIVATE_KEY, undefined);
});

test("the reviewer login and credentials must be set together", () => {
  rejects({ GH_REVIEWER_USERNAME: "my-reviewer[bot]" }, /GH_REVIEWER_USERNAME and all three/);
  const without = (name) =>
    Object.fromEntries(Object.entries(REVIEWER).filter(([key]) => key !== name));
  rejects(without("GH_REVIEWER_USERNAME"), /GH_REVIEWER_USERNAME and all three/);
  rejects(without("GH_REVIEWER_APP_PRIVATE_KEY"), /GH_REVIEWER_USERNAME and all three/);
});

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

test("an Anthropic classifier binds the dedicated key, falling back to ANTHROPIC_API_KEY", () => {
  const fallback = secretActions(worker(plan(), "slack-bot"));
  assert.equal(fallback.upload.ANTHROPIC_API_KEY, "anthropic-key");
  const dedicated = secretActions(
    worker(plan({ CLASSIFICATION_ANTHROPIC_API_KEY: "classifier" }), "slack-bot")
  );
  assert.equal(dedicated.upload.ANTHROPIC_API_KEY, "classifier");
  assert.ok(dedicated.remove.includes("OPENAI_API_KEY"));
});

test("an Anthropic classifier requires a key", () => {
  rejects({ ANTHROPIC_API_KEY: "" }, /CLASSIFICATION_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY/);
});

test("an OpenAI classifier binds only the OpenAI key and its reasoning effort", () => {
  const slack = worker(
    plan({
      ANTHROPIC_API_KEY: "",
      CLASSIFICATION_MODEL: "openai/gpt-5.4",
      CLASSIFICATION_OPENAI_API_KEY: "openai-key",
      CLASSIFICATION_REASONING_EFFORT: "low",
    }),
    "slack-bot"
  );
  const actions = secretActions(slack);
  assert.equal(actions.upload.OPENAI_API_KEY, "openai-key");
  assert.equal(actions.upload.ANTHROPIC_API_KEY, undefined);
  assert.equal(slack.wrangler.vars.CLASSIFICATION_REASONING_EFFORT, "low");
});

test("a Bedrock classifier needs no Anthropic key", () => {
  const actions = secretActions(
    worker(
      plan({
        ANTHROPIC_API_KEY: "",
        CLASSIFICATION_MODEL: "bedrock/us-east-1/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        CLASSIFICATION_BEDROCK_API_KEY: "bedrock-key",
      }),
      "slack-bot"
    )
  );
  assert.equal(actions.upload.BEDROCK_API_KEY, "bedrock-key");
});

test("classifier settings are validated", () => {
  rejects({ CLASSIFICATION_MODEL: "mistral-large" }, /CLASSIFICATION_MODEL must be/);
  rejects({ CLASSIFICATION_MODEL: "gpt-5" }, /CLASSIFICATION_OPENAI_API_KEY must be non-blank/);
  rejects({ CLASSIFICATION_REASONING_EFFORT: "low" }, /applies only to an OpenAI/);
  rejects(
    {
      CLASSIFICATION_MODEL: "gpt-5",
      CLASSIFICATION_OPENAI_API_KEY: "k",
      CLASSIFICATION_REASONING_EFFORT: " low",
    },
    /lowercase OpenAI reasoning effort/
  );
});

test("no classifier key is required when no classifier bot runs", () => {
  assert.ok(settings({ ENABLE_SLACK_BOT: "false", SLACK_BOT_TOKEN: "", ANTHROPIC_API_KEY: "" }));
});

// ---------------------------------------------------------------------------
// Control-plane runtime settings
// ---------------------------------------------------------------------------

test("sandbox timeouts reach the control plane with their defaults", () => {
  const vars = worker(plan(), "control-plane").wrangler.vars;
  assert.equal(vars.SANDBOX_INACTIVITY_TIMEOUT_MS, "600000");
  assert.equal(vars.SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS, "120000");
  assert.equal(vars.SANDBOX_BOOT_TIMEOUT_MS, "1800000");
  assert.equal(vars.TEAMS_ENFORCEMENT, "shadow");
});

test("timeouts are validated", () => {
  rejects(
    { SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: "59999" },
    /SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS/
  );
  rejects({ SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: "60000.5" }, /whole number/);
  rejects(
    { SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: "9007199254740993" },
    /SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS/
  );
  rejects({ SANDBOX_BOOT_TIMEOUT_MS: "240000" }, /connect watchdog/);
});

test("the session location hint is opt-in and validated", () => {
  assert.equal(worker(plan(), "control-plane").wrangler.vars.SESSION_DO_LOCATION_HINT, undefined);
  assert.equal(
    worker(plan({ SESSION_DO_LOCATION_HINT: "apac-se" }), "control-plane").wrangler.vars
      .SESSION_DO_LOCATION_HINT,
    "apac-se"
  );
  rejects({ SESSION_DO_LOCATION_HINT: "mars" }, /SESSION_DO_LOCATION_HINT/);
});

test("security secrets are validated", () => {
  rejects({ NEXTAUTH_SECRET: "short" }, /NEXTAUTH_SECRET/);
  rejects({ TOKEN_ENCRYPTION_KEY: "" }, /TOKEN_ENCRYPTION_KEY must be set/);
  rejects({ PROVIDER_ACCOUNTS_ENCRYPTION_KEY: "not-base64" }, /PROVIDER_ACCOUNTS_ENCRYPTION_KEY/);
});

// ---------------------------------------------------------------------------
// Sandbox artifacts (named exactly as the Terraform modules name them)
// ---------------------------------------------------------------------------

test("Daytona binds the Terraform-built snapshot and keeps retained credentials", () => {
  const vars = worker(
    plan({
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_URL: "https://app.daytona.io/api",
      DAYTONA_API_KEY: "k",
      DAYTONA_BASE_SNAPSHOT: "openinspect-base",
    }),
    "control-plane"
  ).wrangler.vars;
  assert.equal(vars.DAYTONA_BASE_SNAPSHOT, "openinspect-base-m2-0123456789abcdef");
  const retained = worker(plan({ DAYTONA_API_URL: "u", DAYTONA_API_KEY: "k" }), "control-plane");
  assert.equal(retained.wrangler.vars.DAYTONA_API_URL, "u");
  assert.equal(retained.wrangler.vars.DAYTONA_BASE_SNAPSHOT, undefined);
  assert.equal(secretActions(retained).upload.DAYTONA_API_KEY, "k");
  rejects({ DAYTONA_API_KEY: "k" }, /DAYTONA_API_URL must be set whenever/);
});

test("Boat binds the snapshot named by boat-infra", () => {
  const s = settings({
    SANDBOX_PROVIDER: "boat",
    BOAT_API_KEY: "b",
    BOAT_BASE_SNAPSHOT: "open-inspect",
  });
  assert.equal(sandboxArtifactName(s, HASH), "open-inspect-0123456789abcdef");
  rejects(
    { SANDBOX_PROVIDER: "boat", BOAT_API_KEY: "b", BOAT_BASE_SNAPSHOT: "oi-img-x" },
    /BOAT_BASE_SNAPSHOT/
  );
  rejects(
    {
      SANDBOX_PROVIDER: "boat",
      BOAT_API_KEY: "b",
      BOAT_BASE_SNAPSHOT: "x",
      BOAT_SANDBOX_TYPE: "huge",
    },
    /BOAT_SANDBOX_TYPE/
  );
});

test("E2B binds the template alias Terraform builds", () => {
  const s = settings({
    SANDBOX_PROVIDER: "e2b",
    E2B_API_KEY: "e",
    E2B_TEMPLATE_ID: "open-inspect-sandbox",
  });
  const expected = createHash("sha256").update(`${HASH}:2:4096`).digest("hex").slice(0, 16);
  assert.equal(sandboxArtifactName(s, HASH), `open-inspect-sandbox-${expected}`);
});

test("Vercel binds the managed snapshot name or the manual override", () => {
  const managed = worker(
    plan({
      SANDBOX_PROVIDER: "vercel",
      VERCEL_SANDBOX_TOKEN: "t",
      VERCEL_SANDBOX_PROJECT_ID: "prj",
    }),
    "control-plane"
  ).wrangler.vars;
  assert.equal(managed.VERCEL_BASE_SNAPSHOT_NAME, "openinspect-base-0123456789abcdef");
  const manual = worker(
    plan(
      {
        SANDBOX_PROVIDER: "vercel",
        VERCEL_SANDBOX_TOKEN: "t",
        VERCEL_SANDBOX_PROJECT_ID: "prj",
        VERCEL_BASE_SNAPSHOT_ID: "snap",
      },
      { sandboxHash: null }
    ),
    "control-plane"
  ).wrangler.vars;
  assert.equal(manual.VERCEL_BASE_SNAPSHOT_ID, "snap");
  assert.equal(manual.VERCEL_BASE_SNAPSHOT_NAME, undefined);
});

test("Modal requires its runtime credentials", () => {
  rejects({ MODAL_API_SECRET: "" }, /MODAL_API_SECRET must be set/);
});

// ---------------------------------------------------------------------------
// Generated secrets and the web Worker
// ---------------------------------------------------------------------------

test("Terraform-generated secrets are preserved on the Worker when not supplied", () => {
  const actions = secretActions(worker(plan(), "control-plane"));
  assert.deepEqual(actions.mustExist.sort(), [
    "IMAGE_CALLBACK_TOKEN_PEPPER",
    "PROVIDER_ACCOUNTS_ENCRYPTION_KEY",
    "SERVICE_AUTH_SECRET_GITHUB_BOT",
    "SERVICE_AUTH_SECRET_LINEAR_BOT",
    "SERVICE_AUTH_SECRET_SLACK_BOT",
    "SERVICE_AUTH_SECRET_WEB",
  ]);
  for (const name of actions.mustExist) assert.ok(!actions.remove.includes(name));
});

test("supplied generated secrets are uploaded under each Worker's binding name", () => {
  const p = plan({
    SERVICE_AUTH_SECRET_SLACK_BOT: "slack-sig",
    IMAGE_CALLBACK_TOKEN_PEPPER: "pepper",
  });
  assert.equal(secretActions(worker(p, "slack-bot")).upload.SERVICE_AUTH_SECRET, "slack-sig");
  const cp = secretActions(worker(p, "control-plane"));
  assert.equal(cp.upload.SERVICE_AUTH_SECRET_SLACK_BOT, "slack-sig");
  assert.equal(cp.upload.IMAGE_CALLBACK_TOKEN_PEPPER, "pepper");
});

test("the web Worker is planned only for the Cloudflare platform", () => {
  assert.equal(planWeb(settings()), null);
  const web = planWeb(
    settings({
      WEB_PLATFORM: "cloudflare",
      CLOUDFLARE_CUSTOM_DOMAIN: "app.example.com",
      CLOUDFLARE_ZONE_ID: "zone",
    })
  );
  assert.equal(web.wrangler.name, "open-inspect-web-acme");
  assert.equal(web.wrangler.workers_dev, false);
  assert.deepEqual(web.wrangler.routes, [
    { pattern: "app.example.com", zone_id: "zone", custom_domain: true },
  ]);
  assert.deepEqual(web.wrangler.services, [
    { binding: "CONTROL_PLANE_WORKER", service: "open-inspect-control-plane-acme" },
  ]);
  assert.equal(
    web.wrangler.vars.NEXT_PUBLIC_WS_URL,
    "wss://open-inspect-control-plane-acme.acct.workers.dev"
  );
  const actions = secretActions(web);
  assert.deepEqual(actions.mustExist, ["SERVICE_AUTH_SECRET"]);
  assert.ok(actions.remove.includes("NEXTAUTH_SECRET"));
});

test("Cloudflare web URLs reach the control plane", () => {
  const vars = worker(plan({ WEB_PLATFORM: "cloudflare" }), "control-plane").wrangler.vars;
  assert.equal(vars.WEB_APP_URL, "https://open-inspect-web-acme.acct.workers.dev");
});

test("every problem is reported at once", () => {
  try {
    readSettings({});
    assert.fail("expected a ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.messages.length > 5);
    assert.ok(error.messages.includes("DEPLOYMENT_NAME must be set."));
  }
});

test("deploy.env.example documents every setting", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(new URL("./config.mjs", import.meta.url), "utf8");
  const example = await readFile(new URL("./deploy.env.example", import.meta.url), "utf8");
  const body = config.slice(config.indexOf("const s = {"), config.indexOf("validate(s, errors);"));
  const names = [...body.matchAll(/(?:str|trimmed|bool|int|required)\("([A-Z0-9_]+)"\)/g)].map(
    (m) => m[1]
  );
  const documented = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  assert.deepEqual(
    names.filter((name) => !documented.has(name)),
    []
  );
});
