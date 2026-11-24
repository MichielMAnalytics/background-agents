// Worker configuration for the Cloudflare deploy.
//
// Terraform (terraform/modules/cloudflare-environment) provisions the Worker
// scripts and the resources their bindings point at. This module turns the
// deployment's settings -- the same GitHub Environment variables and secrets
// the Terraform workflow used to pass as TF_VAR_* -- into one Wrangler config
// and secret set per Worker. It is pure: Cloudflare lookups happen in
// cloudflare-api.mjs and the side effects in deploy.mjs.

import { createHash } from "node:crypto";

export class ConfigError extends Error {
  constructor(messages) {
    super(
      `Invalid Cloudflare deploy configuration:\n${messages.map((m) => `  - ${m}`).join("\n")}`
    );
    this.name = "ConfigError";
    this.messages = messages;
  }
}

// Defaults for settings Terraform no longer reads. Unset and empty values both
// take the default, as the old `vars.X || secrets.X || 'default'` expressions did.
export const DEFAULTS = Object.freeze({
  WEB_PLATFORM: "vercel",
  SANDBOX_PROVIDER: "modal",
  ENABLE_SLACK_BOT: "true",
  ENABLE_GITHUB_BOT: "false",
  ENABLE_LINEAR_BOT: "false",
  ENABLE_SERVICE_BINDINGS: "true",
  UNSAFE_ALLOW_ALL_USERS: "false",
  APP_NAME: "Open-Inspect",
  SLACK_BOT_DEFAULT_MODEL: "claude-haiku-4-5",
  GH_BOT_DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
  LINEAR_BOT_DEFAULT_MODEL: "claude-sonnet-4-6",
  CLASSIFICATION_MODEL: "claude-haiku-4-5",
  MODAL_ENVIRONMENT: "main",
  SANDBOX_INACTIVITY_TIMEOUT_MS: "600000",
  SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: "120000",
  SANDBOX_BOOT_TIMEOUT_MS: "1800000",
  TEAMS_ENFORCEMENT: "shadow",
  DAYTONA_BASE_SNAPSHOT_MEMORY_GIB: "2",
  DAYTONA_PREBUILDS_ENABLED: "false",
  VERCEL_SANDBOX_RUNTIME: "node24",
  VERCEL_SNAPSHOT_EXPIRATION_MS: "0",
  // Must match the e2b_* defaults in terraform/modules/cloudflare-environment,
  // which name the template Terraform builds.
  E2B_API_URL: "https://api.e2b.app",
  E2B_SANDBOX_TIMEOUT_SECONDS: "7200",
  E2B_AUTO_PAUSE: "true",
  E2B_TEMPLATE_CPU: "2",
  E2B_TEMPLATE_MEMORY_MB: "4096",
  BOAT_API_URL: "https://boat.dev/api/v1",
  BOAT_SANDBOX_TYPE: "default",
});

const SANDBOX_PROVIDERS = ["modal", "modal-vm", "daytona", "vercel", "e2b", "boat"];
const LOCATION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
];
const TEAMS_ENFORCEMENT_MODES = ["off", "shadow", "on"];
const BOAT_SANDBOX_TYPES = ["small", "default", "large", "xlarge"];
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const BOT_MODEL = /^(?:[^/\s]+\/[^/\s]+|(?:claude-|gpt-)[^/\s]+)$/;
const CONNECT_WATCHDOG_MS = 240000;
const MIN_UNATTENDED_TIMEOUT_MS = 60000;

// Mirrors MODEL_ID_PATTERNS in packages/shared/src/classification.ts, so the
// deploy rejects the classifier ids the bots reject.
export const CLASSIFIER_MODEL_PATTERNS = Object.freeze({
  anthropic: /^(?:anthropic\/(?<model>\s*\S.*)|claude-\s*\S.*)$/,
  openai: /^(?:openai\/(?<model>\s*\S.*)|gpt-\s*\S.*)$/,
  bedrock:
    /^bedrock\/(?<region>[a-z]{2}(?:-[a-z]+)+-[0-9]+)\/(?<model>(?:[a-z]+(?:-[a-z]+)?\.)?anthropic\.claude-[a-z0-9-]+(?::[0-9]+)?)$/,
});

// Durable Object migrations, oldest first. Fresh deployments start at v1 and
// never created SchedulerDO; deployments that did (v2) retire it with v3.
const MIGRATIONS_V1 = [{ tag: "v1", new_sqlite_classes: ["SessionDO"] }];
const MIGRATIONS_WITH_SCHEDULER_RETIREMENT = [
  ...MIGRATIONS_V1,
  { tag: "v2", new_sqlite_classes: ["SchedulerDO"] },
  { tag: "v3", deleted_classes: ["SchedulerDO"] },
];

// The image-build schedule must match IMAGE_BUILD_SCHEDULER_CRON in
// packages/control-plane/src/image-builds/scheduler.ts, and the draft sweep
// ABANDONED_DRAFT_SWEEP_CRON in abandoned-draft-sweep.ts (scheduled-jobs.test.ts
// checks both).
export const CONTROL_PLANE_CRONS = Object.freeze(["* * * * *", "7,37 * * * *", "23 * * * *"]);

const COMPATIBILITY_DATE = "2024-09-23";
const WEB_COMPATIBILITY_DATE = "2025-08-15";

// workers_dev and observability match what modules/cloudflare-worker sets on
// create, so Terraform and the deploy agree on the Worker's settings.
const WORKER_BASE = Object.freeze({
  main: "dist/index.js",
  no_bundle: true,
  compatibility_date: COMPATIBILITY_DATE,
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  observability: {
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
  },
});

function blank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function listCount(value) {
  return String(value ?? "")
    .split(",")
    .filter((item) => item.trim() !== "").length;
}

/**
 * Read and validate the deployment settings from an environment-like object.
 * Throws ConfigError listing every problem at once.
 */
export function readSettings(env) {
  const errors = [];
  const raw = (name) => (blank(env[name]) ? (DEFAULTS[name] ?? "") : String(env[name]));
  const str = (name) => raw(name);
  const trimmed = (name) => raw(name).trim();
  const bool = (name) => {
    const value = raw(name).trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    errors.push(`${name} must be "true" or "false", got ${JSON.stringify(raw(name))}.`);
    return false;
  };
  const int = (name) => {
    const value = raw(name).trim();
    if (!/^-?\d+$/.test(value)) {
      errors.push(`${name} must be a whole number, got ${JSON.stringify(raw(name))}.`);
      return Number.NaN;
    }
    return Number(value);
  };
  const required = (name) => {
    if (blank(env[name])) errors.push(`${name} must be set.`);
    return str(name);
  };

  const s = {
    deploymentName: required("DEPLOYMENT_NAME").trim(),
    accountId: required("CLOUDFLARE_ACCOUNT_ID").trim(),
    workerSubdomain: required("CLOUDFLARE_WORKER_SUBDOMAIN").trim(),
    zoneId: trimmed("CLOUDFLARE_ZONE_ID"),
    customDomain: trimmed("CLOUDFLARE_CUSTOM_DOMAIN"),
    r2MediaBucketName: trimmed("R2_MEDIA_BUCKET_NAME"),
    webPlatform: trimmed("WEB_PLATFORM"),
    sandboxProvider: trimmed("SANDBOX_PROVIDER"),
    appName: str("APP_NAME"),
    appIconUrl: str("APP_ICON_URL"),

    githubClientId: trimmed("GH_OAUTH_CLIENT_ID"),
    githubClientSecret: trimmed("GH_OAUTH_CLIENT_SECRET"),
    googleClientId: trimmed("GOOGLE_CLIENT_ID"),
    googleClientSecret: trimmed("GOOGLE_CLIENT_SECRET"),
    githubAppId: required("GH_APP_ID"),
    githubAppPrivateKey: required("GH_APP_PRIVATE_KEY"),
    githubAppInstallationId: required("GH_APP_INSTALLATION_ID"),
    // Optional second App whose token submits reviews, so PRs opened by the
    // main App can be approved. All four values are set together or not at all.
    githubReviewerAppId: trimmed("GH_REVIEWER_APP_ID"),
    githubReviewerAppPrivateKey: trimmed("GH_REVIEWER_APP_PRIVATE_KEY"),
    githubReviewerAppInstallationId: trimmed("GH_REVIEWER_APP_INSTALLATION_ID"),
    githubReviewerUsername: trimmed("GH_REVIEWER_USERNAME"),

    allowedUsers: str("ALLOWED_USERS"),
    allowedEmailDomains: str("ALLOWED_EMAIL_DOMAINS"),
    allowedEmails: str("ALLOWED_EMAILS"),
    allowedGithubOrgs: str("ALLOWED_GITHUB_ORGS"),
    unsafeAllowAllUsers: bool("UNSAFE_ALLOW_ALL_USERS"),

    enableSlackBot: bool("ENABLE_SLACK_BOT"),
    slackBotToken: str("SLACK_BOT_TOKEN"),
    slackSigningSecret: str("SLACK_SIGNING_SECRET"),
    slackBotDefaultModel: str("SLACK_BOT_DEFAULT_MODEL"),

    enableGithubBot: bool("ENABLE_GITHUB_BOT"),
    githubWebhookSecret: str("GH_WEBHOOK_SECRET"),
    githubBotUsername: str("GH_BOT_USERNAME"),
    githubBotDefaultModel: str("GH_BOT_DEFAULT_MODEL"),

    enableLinearBot: bool("ENABLE_LINEAR_BOT"),
    linearClientId: str("LINEAR_CLIENT_ID"),
    linearClientSecret: str("LINEAR_CLIENT_SECRET"),
    linearWebhookSecret: str("LINEAR_WEBHOOK_SECRET"),
    linearApiKey: str("LINEAR_API_KEY"),
    linearBotDefaultModel: str("LINEAR_BOT_DEFAULT_MODEL"),

    enableServiceBindings: bool("ENABLE_SERVICE_BINDINGS"),

    anthropicApiKey: str("ANTHROPIC_API_KEY"),
    classificationAnthropicApiKey: str("CLASSIFICATION_ANTHROPIC_API_KEY"),
    classificationOpenaiApiKey: str("CLASSIFICATION_OPENAI_API_KEY"),
    classificationBedrockApiKey: str("CLASSIFICATION_BEDROCK_API_KEY"),
    classificationModel: str("CLASSIFICATION_MODEL"),
    classificationReasoningEffort: str("CLASSIFICATION_REASONING_EFFORT"),

    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
    repoSecretsEncryptionKey: required("REPO_SECRETS_ENCRYPTION_KEY"),
    browserAuthSecret: required("NEXTAUTH_SECRET"),
    // Terraform-generated; may be absent when the Worker already holds them.
    providerAccountsEncryptionKey: trimmed("PROVIDER_ACCOUNTS_ENCRYPTION_KEY"),
    imageCallbackTokenPepper: str("IMAGE_CALLBACK_TOKEN_PEPPER"),
    serviceAuthSecretWeb: str("SERVICE_AUTH_SECRET_WEB"),
    serviceAuthSecretSlackBot: str("SERVICE_AUTH_SECRET_SLACK_BOT"),
    serviceAuthSecretGithubBot: str("SERVICE_AUTH_SECRET_GITHUB_BOT"),
    serviceAuthSecretLinearBot: str("SERVICE_AUTH_SECRET_LINEAR_BOT"),

    modalWorkspace: str("MODAL_WORKSPACE"),
    modalEnvironment: str("MODAL_ENVIRONMENT"),
    modalEnvironmentWebSuffix: str("MODAL_ENVIRONMENT_WEB_SUFFIX"),
    modalApiSecret: str("MODAL_API_SECRET"),

    daytonaApiUrl: str("DAYTONA_API_URL"),
    daytonaApiKey: str("DAYTONA_API_KEY"),
    daytonaBaseSnapshot: str("DAYTONA_BASE_SNAPSHOT"),
    daytonaBaseSnapshotMemoryGib: int("DAYTONA_BASE_SNAPSHOT_MEMORY_GIB"),
    daytonaTarget: str("DAYTONA_TARGET"),
    daytonaToolboxApiUrl: str("DAYTONA_TOOLBOX_API_URL"),
    daytonaPrebuildsEnabled: bool("DAYTONA_PREBUILDS_ENABLED"),

    vercelSandboxToken: str("VERCEL_SANDBOX_TOKEN"),
    vercelSandboxProjectId: str("VERCEL_SANDBOX_PROJECT_ID"),
    vercelSandboxTeamId: str("VERCEL_SANDBOX_TEAM_ID"),
    vercelSandboxApiBaseUrl: str("VERCEL_SANDBOX_API_BASE_URL"),
    vercelBaseSnapshotId: str("VERCEL_BASE_SNAPSHOT_ID"),
    vercelSandboxRuntime: str("VERCEL_SANDBOX_RUNTIME"),
    vercelSnapshotExpirationMs: int("VERCEL_SNAPSHOT_EXPIRATION_MS"),

    e2bApiKey: str("E2B_API_KEY"),
    e2bApiUrl: str("E2B_API_URL"),
    e2bTemplateId: str("E2B_TEMPLATE_ID"),
    e2bSandboxTimeoutSeconds: int("E2B_SANDBOX_TIMEOUT_SECONDS"),
    e2bAutoPause: bool("E2B_AUTO_PAUSE"),
    e2bTemplateCpu: int("E2B_TEMPLATE_CPU"),
    e2bTemplateMemoryMb: int("E2B_TEMPLATE_MEMORY_MB"),

    boatApiKey: str("BOAT_API_KEY"),
    boatApiUrl: str("BOAT_API_URL"),
    boatBaseSnapshot: str("BOAT_BASE_SNAPSHOT"),
    boatOrg: str("BOAT_ORG"),
    boatSandboxType: str("BOAT_SANDBOX_TYPE"),

    sessionDoLocationHint: trimmed("SESSION_DO_LOCATION_HINT"),
    sandboxInactivityTimeoutMs: int("SANDBOX_INACTIVITY_TIMEOUT_MS"),
    sandboxUnattendedInactivityTimeoutMs: int("SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS"),
    sandboxBootTimeoutMs: int("SANDBOX_BOOT_TIMEOUT_MS"),
    teamsEnforcement: trimmed("TEAMS_ENFORCEMENT"),
  };

  validate(s, errors);
  if (errors.length > 0) throw new ConfigError(errors);
  return Object.freeze({ ...s, ...derived(s) });
}

function derived(s) {
  const githubOAuthEnabled = s.githubClientId !== "" && s.githubClientSecret !== "";
  const googleEnabled = s.googleClientId !== "" && s.googleClientSecret !== "";
  const providerNeutralAdmission =
    listCount(s.allowedEmailDomains) > 0 || listCount(s.allowedEmails) > 0;
  const githubAdmission = listCount(s.allowedUsers) > 0 || listCount(s.allowedGithubOrgs) > 0;
  const admissionAllowlist = providerNeutralAdmission || githubAdmission;
  return {
    githubOAuthEnabled,
    googleEnabled,
    providerNeutralAdmission,
    githubAdmission,
    admissionAllowlist,
    unsafeAllowAllEffective: s.unsafeAllowAllUsers && !admissionAllowlist,
    classifierProvider: classifierProvider(s.classificationModel),
    customDomainEnabled: s.webPlatform === "cloudflare" && s.customDomain !== "" && s.zoneId !== "",
  };
}

export function classifierProvider(model) {
  const matches = Object.entries(CLASSIFIER_MODEL_PATTERNS).filter(([, pattern]) =>
    pattern.test(model)
  );
  return matches.length === 1 ? matches[0][0] : null;
}

function validate(s, errors) {
  const fail = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const d = derived(s);
  const isModal = s.sandboxProvider === "modal" || s.sandboxProvider === "modal-vm";

  fail(
    ["vercel", "cloudflare"].includes(s.webPlatform),
    "WEB_PLATFORM must be 'vercel' or 'cloudflare'."
  );
  fail(
    SANDBOX_PROVIDERS.includes(s.sandboxProvider),
    `SANDBOX_PROVIDER must be one of ${SANDBOX_PROVIDERS.join(", ")}.`
  );

  // Custom domain (was cloudflare_custom_domain's validation and the custom-domain gate)
  fail(
    s.customDomain === "" || HOSTNAME.test(s.customDomain),
    "CLOUDFLARE_CUSTOM_DOMAIN must be a bare hostname such as 'app.example.com' — no scheme, port, path, trailing dot, or whitespace."
  );
  fail(
    s.customDomain === "" || d.customDomainEnabled,
    'CLOUDFLARE_CUSTOM_DOMAIN is set but would be silently ignored: it requires WEB_PLATFORM = "cloudflare" and a non-empty CLOUDFLARE_ZONE_ID.'
  );

  // Sign-in providers and admission (were checks.tf gates)
  fail(
    (s.githubClientId === "") === (s.githubClientSecret === ""),
    "GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET must be set together with non-whitespace values, or both left empty."
  );
  fail(
    (s.googleClientId === "") === (s.googleClientSecret === ""),
    "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together with non-whitespace values, or both left empty."
  );
  fail(
    d.admissionAllowlist || s.unsafeAllowAllUsers,
    "At least one access control allowlist must be configured. Set ALLOWED_USERS, ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAILS, or ALLOWED_GITHUB_ORGS, or set UNSAFE_ALLOW_ALL_USERS = true to explicitly allow all authenticated users."
  );
  fail(
    d.githubOAuthEnabled || d.googleEnabled,
    "At least one complete OAuth sign-in provider pair must be configured."
  );
  fail(
    !d.githubOAuthEnabled ||
      d.githubAdmission ||
      d.providerNeutralAdmission ||
      d.unsafeAllowAllEffective,
    "GitHub sign-in requires a GitHub-specific or provider-neutral admission rule, or effective unsafe allow-all."
  );
  fail(
    !d.googleEnabled || d.providerNeutralAdmission || d.unsafeAllowAllEffective,
    "Google sign-in requires ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, or effective unsafe allow-all; GitHub-specific admission rules cannot admit Google identities."
  );

  // Reviewer App: the login decides whether a review may approve, the
  // credentials mint the token that submits it, and either alone breaks every review.
  const reviewerValues = [
    s.githubReviewerUsername,
    s.githubReviewerAppId,
    s.githubReviewerAppPrivateKey,
    s.githubReviewerAppInstallationId,
  ];
  fail(
    reviewerValues.every((value) => value !== "") || reviewerValues.every((value) => value === ""),
    "Set GH_REVIEWER_USERNAME and all three GH_REVIEWER_APP_* values together, or leave all four empty."
  );

  // Bots
  fail(
    !s.enableGithubBot || (s.githubWebhookSecret !== "" && s.githubBotUsername !== ""),
    "When ENABLE_GITHUB_BOT is true, GH_WEBHOOK_SECRET and GH_BOT_USERNAME must be non-empty."
  );
  fail(
    !s.enableSlackBot || (s.slackBotToken !== "" && s.slackSigningSecret !== ""),
    "When ENABLE_SLACK_BOT is true, SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET must be non-empty."
  );
  fail(
    !s.enableLinearBot ||
      (s.linearClientId !== "" && s.linearClientSecret !== "" && s.linearWebhookSecret !== ""),
    "When ENABLE_LINEAR_BOT is true, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, and LINEAR_WEBHOOK_SECRET must be non-empty."
  );
  for (const [name, value] of [
    ["GH_BOT_DEFAULT_MODEL", s.githubBotDefaultModel],
    ["SLACK_BOT_DEFAULT_MODEL", s.slackBotDefaultModel],
    ["LINEAR_BOT_DEFAULT_MODEL", s.linearBotDefaultModel],
  ]) {
    fail(
      BOT_MODEL.test(value),
      `${name} must be a canonical "provider/model" id such as "anthropic/claude-haiku-4-5", or a bare "claude-"/"gpt-" id, naming a model with no whitespace on each side of any slash.`
    );
  }

  // Classifier
  const classifierInUse = s.enableSlackBot || s.enableLinearBot;
  fail(
    d.classifierProvider !== null,
    'CLASSIFICATION_MODEL must be an Anthropic id ("anthropic/..." or "claude-...") or an OpenAI id ("openai/..." or "gpt-...") naming a model after the prefix, or a Bedrock id ("bedrock/<aws-region>/<inference-profile-id>", such as "bedrock/us-east-1/us.anthropic.claude-haiku-4-5-20251001-v1:0").'
  );
  fail(
    !classifierInUse ||
      d.classifierProvider !== "anthropic" ||
      !blank(s.classificationAnthropicApiKey) ||
      !blank(s.anthropicApiKey),
    "CLASSIFICATION_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY must be non-blank when the Slack or Linear bot is enabled and CLASSIFICATION_MODEL is an Anthropic model."
  );
  fail(
    !classifierInUse || d.classifierProvider !== "openai" || !blank(s.classificationOpenaiApiKey),
    "CLASSIFICATION_OPENAI_API_KEY must be non-blank when the Slack or Linear bot is enabled and CLASSIFICATION_MODEL is an OpenAI model."
  );
  fail(
    !classifierInUse || d.classifierProvider !== "bedrock" || !blank(s.classificationBedrockApiKey),
    "CLASSIFICATION_BEDROCK_API_KEY must be non-blank when the Slack or Linear bot is enabled and CLASSIFICATION_MODEL is a Bedrock model."
  );
  fail(
    s.classificationReasoningEffort === "" || d.classifierProvider === "openai",
    "CLASSIFICATION_REASONING_EFFORT applies only to an OpenAI CLASSIFICATION_MODEL. Leave it blank for an Anthropic or Bedrock model."
  );
  fail(
    s.classificationReasoningEffort === "" || /^[a-z]+$/.test(s.classificationReasoningEffort),
    'CLASSIFICATION_REASONING_EFFORT must be blank or a lowercase OpenAI reasoning effort such as "low", with no surrounding whitespace.'
  );

  // Security secrets
  fail(
    (s.browserAuthSecret.match(/\S/g) ?? []).length >= 32,
    "NEXTAUTH_SECRET must contain at least 32 non-whitespace characters."
  );
  fail(
    s.providerAccountsEncryptionKey === "" ||
      /^[A-Za-z0-9+/]{43}=$/.test(s.providerAccountsEncryptionKey),
    "PROVIDER_ACCOUNTS_ENCRYPTION_KEY must be blank or a Base64-encoded 32-byte key."
  );

  // Sandbox providers
  fail(
    !isModal || s.modalWorkspace !== "",
    "MODAL_WORKSPACE must be set when SANDBOX_PROVIDER is 'modal' or 'modal-vm'."
  );
  fail(
    !isModal || s.modalApiSecret !== "",
    "MODAL_API_SECRET must be set when SANDBOX_PROVIDER is 'modal' or 'modal-vm'."
  );
  fail(
    !isModal || (s.modalEnvironment.trim() !== "" && /^[^:/\\]+$/.test(s.modalEnvironment)),
    "MODAL_ENVIRONMENT must be set and must not contain colons, slashes, or backslashes when SANDBOX_PROVIDER is 'modal' or 'modal-vm'."
  );
  fail(
    !isModal || /^$|^[a-z0-9-]+$/.test(s.modalEnvironmentWebSuffix),
    "MODAL_ENVIRONMENT_WEB_SUFFIX must be empty or contain only lowercase letters, digits, and dashes when SANDBOX_PROVIDER is 'modal' or 'modal-vm'."
  );
  const daytona = s.sandboxProvider === "daytona";
  fail(
    !daytona || s.daytonaApiUrl !== "",
    "DAYTONA_API_URL must be set when SANDBOX_PROVIDER = 'daytona'."
  );
  fail(
    !daytona || s.daytonaApiKey !== "",
    "DAYTONA_API_KEY must be set when SANDBOX_PROVIDER = 'daytona'."
  );
  fail(
    !daytona || s.daytonaBaseSnapshot !== "",
    "DAYTONA_BASE_SNAPSHOT must be set when SANDBOX_PROVIDER = 'daytona'."
  );
  fail(
    blank(s.daytonaApiKey) || !blank(s.daytonaApiUrl),
    "DAYTONA_API_URL must be set whenever DAYTONA_API_KEY is set, so the control plane can still reclaim existing Daytona sandboxes after switching SANDBOX_PROVIDER."
  );
  fail(
    Number.isNaN(s.daytonaBaseSnapshotMemoryGib) || s.daytonaBaseSnapshotMemoryGib >= 1,
    "DAYTONA_BASE_SNAPSHOT_MEMORY_GIB must be a positive integer."
  );
  const vercel = s.sandboxProvider === "vercel";
  fail(
    !vercel || s.vercelSandboxToken !== "",
    "VERCEL_SANDBOX_TOKEN must be set when SANDBOX_PROVIDER = 'vercel'."
  );
  fail(
    !vercel || s.vercelSandboxProjectId !== "",
    "VERCEL_SANDBOX_PROJECT_ID must be set when SANDBOX_PROVIDER = 'vercel'."
  );
  const e2b = s.sandboxProvider === "e2b";
  fail(!e2b || s.e2bApiKey !== "", "E2B_API_KEY must be set when SANDBOX_PROVIDER = 'e2b'.");
  fail(
    !e2b || s.e2bTemplateId !== "",
    "E2B_TEMPLATE_ID must be set when SANDBOX_PROVIDER = 'e2b'."
  );
  const boat = s.sandboxProvider === "boat";
  fail(!boat || s.boatApiKey !== "", "BOAT_API_KEY must be set when SANDBOX_PROVIDER = 'boat'.");
  fail(
    !boat ||
      (/^[a-z0-9][a-z0-9-]{0,45}$/.test(s.boatBaseSnapshot) &&
        s.boatBaseSnapshot !== "oi-img" &&
        !s.boatBaseSnapshot.startsWith("oi-img-")),
    "BOAT_BASE_SNAPSHOT must be 1-46 lowercase letters, digits or dashes, starting with a letter or digit, when SANDBOX_PROVIDER = 'boat'. It must not be 'oi-img' or start with 'oi-img-', which is reserved for control-plane prebuilt snapshots."
  );
  fail(
    !boat || BOAT_SANDBOX_TYPES.includes(s.boatSandboxType),
    "BOAT_SANDBOX_TYPE must be 'small', 'default', 'large', or 'xlarge' when SANDBOX_PROVIDER = 'boat'."
  );

  // Control-plane runtime settings
  fail(
    s.sessionDoLocationHint === "" || LOCATION_HINTS.includes(s.sessionDoLocationHint),
    `SESSION_DO_LOCATION_HINT must be empty or one of ${LOCATION_HINTS.join(", ")}.`
  );
  fail(
    Number.isNaN(s.sandboxUnattendedInactivityTimeoutMs) ||
      (s.sandboxUnattendedInactivityTimeoutMs >= MIN_UNATTENDED_TIMEOUT_MS &&
        Number.isSafeInteger(s.sandboxUnattendedInactivityTimeoutMs)),
    `SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS must be a whole number between ${MIN_UNATTENDED_TIMEOUT_MS} and ${Number.MAX_SAFE_INTEGER} ms, matching the control plane's safe-integer range.`
  );
  fail(
    Number.isNaN(s.sandboxBootTimeoutMs) || s.sandboxBootTimeoutMs > CONNECT_WATCHDOG_MS,
    `SANDBOX_BOOT_TIMEOUT_MS must exceed the ${CONNECT_WATCHDOG_MS} ms connect watchdog.`
  );
  fail(
    TEAMS_ENFORCEMENT_MODES.includes(s.teamsEnforcement),
    "TEAMS_ENFORCEMENT must be 'off', 'shadow', or 'on'."
  );
}

// =============================================================================
// Names shared with Terraform (terraform/modules/cloudflare-environment)
// =============================================================================

export function resourceNames(s) {
  const suffix = s.deploymentName;
  return {
    controlPlane: `open-inspect-control-plane-${suffix}`,
    slackBot: `open-inspect-slack-bot-${suffix}`,
    githubBot: `open-inspect-github-bot-${suffix}`,
    linearBot: `open-inspect-linear-bot-${suffix}`,
    web: `open-inspect-web-${suffix}`,
    d1Database: `open-inspect-${suffix}`,
    mediaBucket: s.r2MediaBucketName !== "" ? s.r2MediaBucketName : `open-inspect-media-${suffix}`,
    kv: {
      sessionIndex: `open-inspect-session-index-${suffix}`,
      slack: `open-inspect-slack-kv-${suffix}`,
      github: `open-inspect-github-kv-${suffix}`,
      linear: `open-inspect-linear-kv-${suffix}`,
    },
    queues: {
      imageBuildFinalization: `open-inspect-image-build-finalization-${suffix}`,
      imageBuildFinalizationDlq: `open-inspect-image-build-finalization-dlq-${suffix}`,
      slackCompletion: `open-inspect-slack-completion-${suffix}`,
      slackCompletionDlq: `open-inspect-slack-completion-dlq-${suffix}`,
      githubAutofix: `open-inspect-github-autofix-${suffix}`,
      githubAutofixDlq: `open-inspect-github-autofix-dlq-${suffix}`,
    },
  };
}

/** KV namespace titles the enabled Workers bind. */
export function requiredKvTitles(s) {
  const { kv } = resourceNames(s);
  return [
    kv.sessionIndex,
    ...(s.enableSlackBot ? [kv.slack] : []),
    ...(s.enableGithubBot ? [kv.github] : []),
    ...(s.enableLinearBot ? [kv.linear] : []),
  ];
}

/** Sandbox providers whose Terraform-built artifact name the deploy derives from a source hash. */
export function sandboxHashProvider(s) {
  if (
    s.sandboxProvider === "daytona" ||
    s.sandboxProvider === "e2b" ||
    s.sandboxProvider === "boat"
  ) {
    return s.sandboxProvider;
  }
  if (s.sandboxProvider === "vercel" && s.vercelBaseSnapshotId === "") return "vercel";
  return null;
}

/**
 * The artifact the control plane boots fresh sandboxes from, named exactly as
 * the Terraform module that built it names it.
 */
export function sandboxArtifactName(s, hash) {
  const short = hash.slice(0, 16);
  switch (sandboxHashProvider(s)) {
    case "daytona":
      return `${s.daytonaBaseSnapshot}-m${s.daytonaBaseSnapshotMemoryGib}-${short}`;
    case "vercel":
      return `openinspect-base-${short}`;
    case "boat":
      return `${s.boatBaseSnapshot}-${short}`;
    case "e2b": {
      const digest = createHash("sha256")
        .update(`${hash}:${s.e2bTemplateCpu}:${s.e2bTemplateMemoryMb}`)
        .digest("hex");
      return `${s.e2bTemplateId}-${digest.slice(0, 16)}`;
    }
    default:
      return null;
  }
}

/** Durable Object migrations for a control plane currently at `currentTag`. */
export function controlPlaneMigrations(currentTag) {
  if (currentTag === "v2" || currentTag === "v3") return MIGRATIONS_WITH_SCHEDULER_RETIREMENT;
  if (currentTag === null || currentTag === undefined || currentTag === "" || currentTag === "v1") {
    return MIGRATIONS_V1;
  }
  throw new Error(
    `The control plane Worker is at unknown Durable Object migration tag ${JSON.stringify(currentTag)}; refusing to deploy.`
  );
}

export function urls(s) {
  const names = resourceNames(s);
  const controlPlaneHost = `${names.controlPlane}.${s.workerSubdomain}.workers.dev`;
  const webCloudflareHost = s.customDomainEnabled
    ? s.customDomain
    : `${names.web}.${s.workerSubdomain}.workers.dev`;
  return {
    controlPlaneUrl: `https://${controlPlaneHost}`,
    wsUrl: `wss://${controlPlaneHost}`,
    webAppUrl:
      s.webPlatform === "cloudflare"
        ? `https://${webCloudflareHost}`
        : `https://open-inspect-${s.deploymentName}.vercel.app`,
    linearBotUrl: `https://${names.linearBot}.${s.workerSubdomain}.workers.dev`,
  };
}

// =============================================================================
// Per-Worker plans
// =============================================================================

/**
 * A secret the deploy uploads. `value` is uploaded when non-empty. Otherwise:
 * - kind "preserve": Terraform generated it and the Worker already holds it;
 *   the deploy checks it exists and leaves it alone.
 * - kind "config": it is unconfigured, so a stale copy is deleted.
 */
function secret(value, kind = "config") {
  return { value: blank(value) ? "" : String(value), kind };
}

function classifierSecrets(s) {
  const anthropicKey = blank(s.classificationAnthropicApiKey)
    ? s.anthropicApiKey
    : s.classificationAnthropicApiKey;
  return {
    ANTHROPIC_API_KEY: secret(s.classifierProvider === "anthropic" ? anthropicKey : ""),
    OPENAI_API_KEY: secret(s.classifierProvider === "openai" ? s.classificationOpenaiApiKey : ""),
    BEDROCK_API_KEY: secret(
      s.classifierProvider === "bedrock" ? s.classificationBedrockApiKey : ""
    ),
  };
}

function classifierVars(s) {
  return {
    CLASSIFICATION_MODEL: s.classificationModel,
    ...(s.classificationReasoningEffort !== ""
      ? { CLASSIFICATION_REASONING_EFFORT: s.classificationReasoningEffort }
      : {}),
  };
}

function controlPlaneVars(s, artifact) {
  const u = urls(s);
  const hasDaytonaKey = !blank(s.daytonaApiKey);
  const hasVercelProject = !blank(s.vercelSandboxProjectId);
  const hasBoatKey = !blank(s.boatApiKey);
  const provider = s.sandboxProvider;
  return {
    WEB_APP_URL: u.webAppUrl,
    ALLOWED_USERS: s.allowedUsers,
    ALLOWED_EMAIL_DOMAINS: s.allowedEmailDomains,
    ALLOWED_EMAILS: s.allowedEmails,
    ALLOWED_GITHUB_ORGS: s.allowedGithubOrgs,
    UNSAFE_ALLOW_ALL_USERS: String(s.unsafeAllowAllUsers),
    WORKER_URL: u.controlPlaneUrl,
    DEPLOYMENT_NAME: s.deploymentName,
    APP_NAME: s.appName,
    GITHUB_BOT_USERNAME: s.githubBotUsername,
    SANDBOX_PROVIDER: provider,
    SANDBOX_INACTIVITY_TIMEOUT_MS: String(s.sandboxInactivityTimeoutMs),
    SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: String(s.sandboxUnattendedInactivityTimeoutMs),
    SANDBOX_BOOT_TIMEOUT_MS: String(s.sandboxBootTimeoutMs),
    TEAMS_ENFORCEMENT: s.teamsEnforcement,
    ...(s.sessionDoLocationHint !== ""
      ? { SESSION_DO_LOCATION_HINT: s.sessionDoLocationHint }
      : {}),
    ...(s.githubOAuthEnabled ? { GITHUB_CLIENT_ID: s.githubClientId } : {}),
    ...(s.googleEnabled ? { GOOGLE_CLIENT_ID: s.googleClientId } : {}),
    ...(!blank(s.modalWorkspace)
      ? {
          MODAL_WORKSPACE: s.modalWorkspace,
          MODAL_ENVIRONMENT: s.modalEnvironment,
          MODAL_ENVIRONMENT_WEB_SUFFIX: s.modalEnvironmentWebSuffix,
        }
      : {}),
    // Bound whenever Daytona credentials exist, not only while it is the
    // active backend: a deployment that has switched providers still has
    // Daytona sources and snapshots to finalize and reclaim.
    ...(hasDaytonaKey ? { DAYTONA_API_URL: s.daytonaApiUrl } : {}),
    ...(hasDaytonaKey && s.daytonaTarget !== "" ? { DAYTONA_TARGET: s.daytonaTarget } : {}),
    ...(hasDaytonaKey && s.daytonaToolboxApiUrl !== ""
      ? { DAYTONA_TOOLBOX_API_URL: s.daytonaToolboxApiUrl }
      : {}),
    ...(provider === "daytona"
      ? {
          DAYTONA_BASE_SNAPSHOT: artifact,
          DAYTONA_PREBUILDS_ENABLED: String(s.daytonaPrebuildsEnabled),
        }
      : {}),
    ...(hasVercelProject
      ? {
          VERCEL_PROJECT_ID: s.vercelSandboxProjectId,
          VERCEL_RUNTIME: s.vercelSandboxRuntime,
          VERCEL_SNAPSHOT_EXPIRATION_MS: String(s.vercelSnapshotExpirationMs),
        }
      : {}),
    ...(s.vercelSandboxTeamId !== "" ? { VERCEL_TEAM_ID: s.vercelSandboxTeamId } : {}),
    ...(s.vercelSandboxApiBaseUrl !== ""
      ? { VERCEL_SANDBOX_API_BASE_URL: s.vercelSandboxApiBaseUrl }
      : {}),
    ...(provider === "vercel" && s.vercelBaseSnapshotId !== ""
      ? { VERCEL_BASE_SNAPSHOT_ID: s.vercelBaseSnapshotId }
      : {}),
    ...(provider === "vercel" && s.vercelBaseSnapshotId === ""
      ? { VERCEL_BASE_SNAPSHOT_NAME: artifact }
      : {}),
    ...(provider === "e2b"
      ? {
          E2B_API_URL: s.e2bApiUrl,
          E2B_TEMPLATE_ID: artifact,
          E2B_SANDBOX_TIMEOUT_SECONDS: String(s.e2bSandboxTimeoutSeconds),
          E2B_AUTO_PAUSE: String(s.e2bAutoPause),
        }
      : {}),
    // Boat credentials stay bound while the key is configured, as Daytona's
    // do, so image builds recorded against Boat can finalize or be reclaimed
    // after a provider switch; only creating sandboxes needs the base snapshot.
    ...(hasBoatKey ? { BOAT_API_URL: s.boatApiUrl } : {}),
    ...(hasBoatKey && !blank(s.boatOrg) ? { BOAT_ORG: s.boatOrg } : {}),
    ...(provider === "boat"
      ? { BOAT_BASE_SNAPSHOT: artifact, BOAT_SANDBOX_TYPE: s.boatSandboxType }
      : {}),
  };
}

function controlPlaneSecrets(s) {
  return {
    // The existing operator-managed auth secret signs Better Auth state and
    // cookies in the control plane; the input keeps its legacy name.
    BROWSER_AUTH_SECRET: secret(s.browserAuthSecret),
    TOKEN_ENCRYPTION_KEY: secret(s.tokenEncryptionKey),
    REPO_SECRETS_ENCRYPTION_KEY: secret(s.repoSecretsEncryptionKey),
    PROVIDER_ACCOUNTS_ENCRYPTION_KEY: secret(s.providerAccountsEncryptionKey, "preserve"),
    IMAGE_CALLBACK_TOKEN_PEPPER: secret(s.imageCallbackTokenPepper, "preserve"),
    SERVICE_AUTH_SECRET_WEB: secret(s.serviceAuthSecretWeb, "preserve"),
    SERVICE_AUTH_SECRET_SLACK_BOT: secret(s.serviceAuthSecretSlackBot, "preserve"),
    SERVICE_AUTH_SECRET_GITHUB_BOT: secret(s.serviceAuthSecretGithubBot, "preserve"),
    SERVICE_AUTH_SECRET_LINEAR_BOT: secret(s.serviceAuthSecretLinearBot, "preserve"),
    GITHUB_APP_ID: secret(s.githubAppId),
    GITHUB_APP_PRIVATE_KEY: secret(s.githubAppPrivateKey),
    GITHUB_APP_INSTALLATION_ID: secret(s.githubAppInstallationId),
    // The reviewer App token is brokered only to authenticated sandboxes; the
    // validation above requires all three credentials together.
    GITHUB_REVIEWER_APP_ID: secret(s.githubReviewerAppId),
    GITHUB_REVIEWER_APP_PRIVATE_KEY: secret(s.githubReviewerAppPrivateKey),
    GITHUB_REVIEWER_APP_INSTALLATION_ID: secret(s.githubReviewerAppInstallationId),
    GITHUB_CLIENT_SECRET: secret(s.githubOAuthEnabled ? s.githubClientSecret : ""),
    GOOGLE_CLIENT_SECRET: secret(s.googleEnabled ? s.googleClientSecret : ""),
    MODAL_API_SECRET: secret(!blank(s.modalWorkspace) ? s.modalApiSecret : ""),
    DAYTONA_API_KEY: secret(s.daytonaApiKey),
    VERCEL_TOKEN: secret(!blank(s.vercelSandboxProjectId) ? s.vercelSandboxToken : ""),
    E2B_API_KEY: secret(s.sandboxProvider === "e2b" ? s.e2bApiKey : ""),
    BOAT_API_KEY: secret(s.boatApiKey),
    // Authorizes the agent-initiated `slack-notify` endpoint.
    SLACK_BOT_TOKEN: secret(s.slackBotToken),
  };
}

function kvBinding(binding, title, kvIds) {
  const id = kvIds[title];
  if (!id) {
    throw new Error(
      `KV namespace ${title} was not found. Run the Terraform apply for this environment first.`
    );
  }
  return { binding, id };
}

function serviceBinding(s, binding, service) {
  return s.enableServiceBindings ? [{ binding, service }] : [];
}

/**
 * Build the Wrangler config and secrets for each Worker the deployment runs.
 *
 * @param s settings from readSettings()
 * @param resources {{ kvIds: Record<string,string>, d1DatabaseId: string,
 *   controlPlaneMigrationTag: string|null, sandboxHash: string|null }}
 */
export function planWorkers(s, resources) {
  const n = resourceNames(s);
  const u = urls(s);
  const { kvIds } = resources;
  const hashProvider = sandboxHashProvider(s);
  if (hashProvider !== null && !resources.sandboxHash) {
    throw new Error(`A ${hashProvider} source hash is required to name the sandbox artifact.`);
  }
  const artifact = hashProvider === null ? null : sandboxArtifactName(s, resources.sandboxHash);
  const workers = [];

  workers.push({
    key: "control-plane",
    packageDir: "packages/control-plane",
    wrangler: {
      name: n.controlPlane,
      ...WORKER_BASE,
      kv_namespaces: [kvBinding("REPOS_CACHE", n.kv.sessionIndex, kvIds)],
      d1_databases: [
        { binding: "DB", database_id: resources.d1DatabaseId, database_name: n.d1Database },
      ],
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: n.mediaBucket }],
      queues: {
        producers: [
          { binding: "IMAGE_BUILD_FINALIZATION_QUEUE", queue: n.queues.imageBuildFinalization },
          // The autofix bindings also feed the operator health check its
          // read-only queue metrics; production stays with the GitHub bot.
          ...(s.enableGithubBot
            ? [
                { binding: "AUTOFIX_QUEUE", queue: n.queues.githubAutofix },
                { binding: "AUTOFIX_DLQ", queue: n.queues.githubAutofixDlq },
              ]
            : []),
        ],
        consumers: [
          {
            queue: n.queues.imageBuildFinalization,
            dead_letter_queue: n.queues.imageBuildFinalizationDlq,
            max_batch_size: 1,
            max_batch_timeout: 1,
            max_concurrency: 5,
            max_retries: 12,
            retry_delay: 15,
          },
          ...(s.enableGithubBot
            ? [
                {
                  queue: n.queues.githubAutofix,
                  dead_letter_queue: n.queues.githubAutofixDlq,
                  max_batch_size: 1,
                  max_batch_timeout: 1,
                  max_concurrency: 5,
                  max_retries: 4,
                  retry_delay: 30,
                },
              ]
            : []),
        ],
      },
      services: [
        ...(s.enableSlackBot ? serviceBinding(s, "SLACK_BOT", n.slackBot) : []),
        ...(s.enableLinearBot ? serviceBinding(s, "LINEAR_BOT", n.linearBot) : []),
      ],
      durable_objects: { bindings: [{ name: "SESSION", class_name: "SessionDO" }] },
      migrations: controlPlaneMigrations(resources.controlPlaneMigrationTag),
      triggers: { crons: [...CONTROL_PLANE_CRONS] },
      vars: controlPlaneVars(s, artifact),
    },
    secrets: controlPlaneSecrets(s),
  });

  if (s.enableSlackBot) {
    workers.push({
      key: "slack-bot",
      packageDir: "packages/slack-bot",
      wrangler: {
        name: n.slackBot,
        ...WORKER_BASE,
        kv_namespaces: [kvBinding("SLACK_KV", n.kv.slack, kvIds)],
        services: serviceBinding(s, "CONTROL_PLANE", n.controlPlane),
        queues: {
          producers: [{ binding: "SLACK_COMPLETION_QUEUE", queue: n.queues.slackCompletion }],
          consumers: [
            {
              queue: n.queues.slackCompletion,
              dead_letter_queue: n.queues.slackCompletionDlq,
              max_batch_size: 1,
              max_batch_timeout: 1,
              max_concurrency: 5,
              max_retries: 1,
              retry_delay: 15,
            },
          ],
        },
        vars: {
          CONTROL_PLANE_URL: u.controlPlaneUrl,
          WEB_APP_URL: u.webAppUrl,
          DEPLOYMENT_NAME: s.deploymentName,
          APP_NAME: s.appName,
          DEFAULT_MODEL: s.slackBotDefaultModel,
          ...classifierVars(s),
        },
      },
      secrets: {
        SLACK_BOT_TOKEN: secret(s.slackBotToken),
        SLACK_SIGNING_SECRET: secret(s.slackSigningSecret),
        SERVICE_AUTH_SECRET: secret(s.serviceAuthSecretSlackBot, "preserve"),
        ...classifierSecrets(s),
      },
    });
  }

  if (s.enableGithubBot) {
    workers.push({
      key: "github-bot",
      packageDir: "packages/github-bot",
      wrangler: {
        name: n.githubBot,
        ...WORKER_BASE,
        kv_namespaces: [kvBinding("GITHUB_KV", n.kv.github, kvIds)],
        services: serviceBinding(s, "CONTROL_PLANE", n.controlPlane),
        queues: { producers: [{ binding: "AUTOFIX_QUEUE", queue: n.queues.githubAutofix }] },
        vars: {
          DEPLOYMENT_NAME: s.deploymentName,
          APP_NAME: s.appName,
          DEFAULT_MODEL: s.githubBotDefaultModel,
          GITHUB_BOT_USERNAME: s.githubBotUsername,
          GITHUB_REVIEWER_USERNAME: s.githubReviewerUsername,
        },
      },
      secrets: {
        GITHUB_APP_ID: secret(s.githubAppId),
        GITHUB_APP_PRIVATE_KEY: secret(s.githubAppPrivateKey),
        GITHUB_APP_INSTALLATION_ID: secret(s.githubAppInstallationId),
        GITHUB_WEBHOOK_SECRET: secret(s.githubWebhookSecret),
        SERVICE_AUTH_SECRET: secret(s.serviceAuthSecretGithubBot, "preserve"),
      },
    });
  }

  if (s.enableLinearBot) {
    workers.push({
      key: "linear-bot",
      packageDir: "packages/linear-bot",
      wrangler: {
        name: n.linearBot,
        ...WORKER_BASE,
        kv_namespaces: [kvBinding("LINEAR_KV", n.kv.linear, kvIds)],
        services: serviceBinding(s, "CONTROL_PLANE", n.controlPlane),
        vars: {
          CONTROL_PLANE_URL: u.controlPlaneUrl,
          WEB_APP_URL: u.webAppUrl,
          DEPLOYMENT_NAME: s.deploymentName,
          APP_NAME: s.appName,
          DEFAULT_MODEL: s.linearBotDefaultModel,
          LINEAR_CLIENT_ID: s.linearClientId,
          WORKER_URL: u.linearBotUrl,
          ...classifierVars(s),
        },
      },
      secrets: {
        LINEAR_WEBHOOK_SECRET: secret(s.linearWebhookSecret),
        LINEAR_CLIENT_SECRET: secret(s.linearClientSecret),
        SERVICE_AUTH_SECRET: secret(s.serviceAuthSecretLinearBot, "preserve"),
        LINEAR_API_KEY: secret(s.linearApiKey),
        ...classifierSecrets(s),
      },
    });
  }

  return { workers, sandboxArtifact: artifact };
}

/** Build-time environment for the OpenNext web build (NEXT_PUBLIC_* is inlined). */
export function webBuildEnv(s) {
  return {
    NEXT_PUBLIC_WS_URL: urls(s).wsUrl,
    NEXT_PUBLIC_SANDBOX_PROVIDER: s.sandboxProvider,
    NEXT_PUBLIC_APP_NAME: s.appName,
    NEXT_PUBLIC_APP_ICON_URL: s.appIconUrl,
  };
}

/** The Cloudflare web Worker, or null when the web app is on Vercel. */
export function planWeb(s) {
  if (s.webPlatform !== "cloudflare") return null;
  const n = resourceNames(s);
  const u = urls(s);
  return {
    key: "web",
    packageDir: "packages/web",
    wrangler: {
      name: n.web,
      main: ".open-next/worker.js",
      compatibility_date: WEB_COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      // Keep-names makes esbuild emit __name() calls, which leak into
      // next-themes' inline script and throw in the browser.
      keep_names: false,
      // A custom-domain deployment has one canonical browser origin.
      workers_dev: !s.customDomainEnabled,
      ...(s.customDomainEnabled
        ? { routes: [{ pattern: s.customDomain, zone_id: s.zoneId, custom_domain: true }] }
        : {}),
      vars: {
        CONTROL_PLANE_URL: u.controlPlaneUrl,
        ...webBuildEnv(s),
      },
      assets: { directory: ".open-next/assets", binding: "ASSETS" },
      services: [{ binding: "CONTROL_PLANE_WORKER", service: n.controlPlane }],
    },
    secrets: {
      SERVICE_AUTH_SECRET: secret(s.serviceAuthSecretWeb, "preserve"),
    },
    // Earlier web-auth secrets, removed whenever present.
    retiredSecrets: ["GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET", "NEXTAUTH_SECRET"],
  };
}

/**
 * Split a Worker's secrets into what to upload, what must already exist on
 * the Worker, and what to delete if present.
 */
export function secretActions(worker) {
  const upload = {};
  const mustExist = [];
  const remove = [...(worker.retiredSecrets ?? [])];
  for (const [name, { value, kind }] of Object.entries(worker.secrets)) {
    if (value !== "") upload[name] = value;
    else if (kind === "preserve") mustExist.push(name);
    else remove.push(name);
  }
  return { upload, mustExist, remove };
}
