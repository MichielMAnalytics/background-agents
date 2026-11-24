// Minimal Cloudflare REST client for the deploy: it looks up resources
// Terraform created (by the names both sides derive from DEPLOYMENT_NAME) and
// reads Worker state. Uploads go through Wrangler.

const API_BASE = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;

export class CloudflareApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
  }
}

export function createCloudflareApi({ accountId, apiToken, fetchImpl = fetch }) {
  const account = `${API_BASE}/accounts/${encodeURIComponent(accountId)}`;

  async function request(path, { method = "GET" } = {}) {
    const response = await fetchImpl(`${account}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || body?.success !== true) {
      // Never echo the request headers; the API's own messages carry no secrets.
      const detail =
        body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
      throw new CloudflareApiError(
        `Cloudflare API ${method} ${path} failed (${response.status}): ${detail}`,
        response.status
      );
    }
    return body;
  }

  async function listAll(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const body = await request(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      items.push(...body.result);
      const totalPages = body.result_info?.total_pages;
      if (body.result.length < PAGE_SIZE || (totalPages !== undefined && page >= totalPages))
        return items;
    }
  }

  return {
    /** title => id for the requested KV namespaces; missing titles are omitted. */
    async kvNamespaceIds(titles) {
      const wanted = new Set(titles);
      const ids = {};
      for (const namespace of await listAll("/storage/kv/namespaces")) {
        if (wanted.has(namespace.title)) ids[namespace.title] = namespace.id;
      }
      return ids;
    },

    async d1DatabaseId(name) {
      const databases = await listAll(`/d1/database?name=${encodeURIComponent(name)}`);
      const match = databases.find((database) => database.name === name);
      if (!match) {
        throw new Error(
          `D1 database ${name} was not found. Run the Terraform apply for this environment first.`
        );
      }
      return match.uuid;
    },

    /** The Worker's applied Durable Object migration tag, or null when it has none. */
    async migrationTag(scriptName) {
      const body = await request("/workers/scripts");
      const script = body.result.find((entry) => entry.id === scriptName);
      return script?.migration_tag || null;
    },

    /** Secret names bound to the Worker's latest version; [] when it has never been deployed. */
    async secretNames(scriptName) {
      try {
        const body = await request(`/workers/scripts/${encodeURIComponent(scriptName)}/secrets`);
        return body.result.map((entry) => entry.name);
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) return [];
        throw error;
      }
    },

    async deleteSecret(scriptName, secretName) {
      await request(
        `/workers/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(secretName)}`,
        { method: "DELETE" }
      );
    },

    /** The Worker's active (most recent) deployment: its id and the versions it serves. */
    async latestDeployment(scriptName) {
      const body = await request(`/workers/scripts/${encodeURIComponent(scriptName)}/deployments`);
      const [latest] = body.result.deployments;
      if (!latest) throw new Error(`Worker ${scriptName} has no deployment.`);
      return { id: latest.id, versions: latest.versions ?? [] };
    },
  };
}
