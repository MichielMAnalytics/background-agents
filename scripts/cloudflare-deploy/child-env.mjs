// The environment child processes of the deploy inherit.
//
// The deploy's own environment holds every credential in the deployment (GitHub
// App key, bot tokens, encryption keys, model API keys). Package builds, the
// OpenNext web build, `uv sync` and Wrangler run third-party code, so none of
// that reaches them: they get a small allowlist of process plumbing, plus
// exactly what each step passes. Worker secrets travel to Wrangler in a
// mode-0600 secrets file, never through the environment.

const NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

// npm, uv, Wrangler and the runner configure caches and telemetry this way.
const PREFIXES = ["LC_", "NPM_CONFIG_", "npm_config_", "UV_", "XDG_", "WRANGLER_", "RUNNER_"];

export function allowlistedEnv(source, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (NAMES.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix)))
    ) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}
