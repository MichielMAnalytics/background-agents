// Check that the sandbox artifact the control plane is about to be bound to
// exists on its provider.
//
// The deploy derives the artifact's name (config.mjs sandboxArtifactName) from
// its own checkout, exactly as the Terraform module that builds it does. That
// agrees only when the Terraform apply for this commit has run. Before the
// control plane is deployed the artifact must be there, ready: otherwise every
// sandbox create would fail. Each lookup uses the same endpoint the control
// plane itself resolves the artifact with at runtime.

const REQUEST_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export class ArtifactMissingError extends Error {
  constructor(provider, name, detail) {
    super(
      `The ${provider} sandbox artifact ${name} ${detail}. The Terraform apply for this commit builds it; run that first (or wait for it to finish), then deploy again.`
    );
    this.name = "ArtifactMissingError";
  }
}

async function getJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Sandbox artifact lookup failed: GET ${new URL(url).pathname} answered ${response.status}`
    );
  }
  return response.json();
}

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

async function daytona(s, name, fetchImpl) {
  const headers = { Authorization: `Bearer ${s.daytonaApiKey}` };
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await getJson(
      fetchImpl,
      `${trimSlash(s.daytonaApiUrl)}/snapshots?page=${page}&limit=${PAGE_SIZE}&sort=createdAt&order=asc`,
      headers
    );
    const match = body?.items?.find((item) => item.name === name);
    if (match) return match.state === "active" ? null : `is ${match.state}, not active`;
    if (!body || page >= body.totalPages) break;
  }
  return "was not found";
}

async function e2b(s, name, fetchImpl) {
  const body = await getJson(
    fetchImpl,
    `${trimSlash(s.e2bApiUrl)}/templates/aliases/${encodeURIComponent(name)}`,
    { "X-API-Key": s.e2bApiKey }
  );
  return body ? null : "was not found";
}

async function boat(s, name, fetchImpl) {
  const headers = {
    Authorization: `Bearer ${s.boatApiKey}`,
    ...(s.boatOrg ? { "X-Boat-Org": s.boatOrg } : {}),
  };
  const body = await getJson(
    fetchImpl,
    `${trimSlash(s.boatApiUrl)}/saved-snapshots/${encodeURIComponent(name)}`,
    headers
  );
  if (!body) return "was not found";
  return body.snapshot?.status === "ready" ? null : `is ${body.snapshot?.status}, not ready`;
}

async function vercel(s, name, fetchImpl) {
  const base = trimSlash(s.vercelSandboxApiBaseUrl || "https://vercel.com/api");
  const query = new URLSearchParams({
    project: s.vercelSandboxProjectId,
    name,
    limit: "20",
    sortOrder: "desc",
  });
  if (s.vercelSandboxTeamId) query.set("teamId", s.vercelSandboxTeamId);
  const body = await getJson(fetchImpl, `${base}/v2/sandboxes/snapshots?${query}`, {
    Authorization: `Bearer ${s.vercelSandboxToken}`,
  });
  return body?.snapshots?.some((snapshot) => snapshot.status === "created")
    ? null
    : "was not found";
}

const CHECKS = { daytona, e2b, boat, vercel };

/**
 * Throws ArtifactMissingError unless `name` exists and is ready for the
 * deployment's sandbox provider. Providers that build no artifact need none.
 */
export async function verifySandboxArtifact(settings, name, fetchImpl = fetch) {
  const provider = settings.sandboxProvider;
  const check = CHECKS[provider];
  if (!check || !name) return;
  const problem = await check(settings, name, fetchImpl);
  if (problem) throw new ArtifactMissingError(provider, name, problem);
}
