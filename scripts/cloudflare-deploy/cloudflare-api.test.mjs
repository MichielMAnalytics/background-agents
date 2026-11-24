import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareApiError, createCloudflareApi } from "./cloudflare-api.mjs";

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization });
    const path = String(url).replace("https://api.cloudflare.com/client/v4/accounts/acct", "");
    const handler = routes[path] ?? routes[path.split("?")[0]];
    if (!handler)
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }] }),
        { status: 404 }
      );
    const [status, body] = handler(path);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

const ok = (result, extra = {}) => [200, { success: true, result, ...extra }];

test("KV namespace lookup pages through every namespace", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, title: `other-${i}` }));
  const { fetchImpl, calls } = fakeFetch({
    "/storage/kv/namespaces?per_page=100&page=1": () =>
      ok(page1, { result_info: { total_pages: 2 } }),
    "/storage/kv/namespaces?per_page=100&page=2": () =>
      ok([{ id: "wanted-id", title: "wanted" }], { result_info: { total_pages: 2 } }),
  });
  const api = createCloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl });
  assert.deepEqual(await api.kvNamespaceIds(["wanted", "missing"]), { wanted: "wanted-id" });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
});

test("D1 lookup requires an exact name match", async () => {
  const { fetchImpl } = fakeFetch({
    "/d1/database": () =>
      ok([
        { name: "open-inspect-acme-old", uuid: "x" },
        { name: "open-inspect-acme", uuid: "db-uuid" },
      ]),
  });
  const api = createCloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl });
  assert.equal(await api.d1DatabaseId("open-inspect-acme"), "db-uuid");
  await assert.rejects(api.d1DatabaseId("nope"), /Run the Terraform apply/);
});

test("migration tag is read from the scripts list", async () => {
  const { fetchImpl } = fakeFetch({
    "/workers/scripts": () => ok([{ id: "cp", migration_tag: "v3" }, { id: "shell" }]),
  });
  const api = createCloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl });
  assert.equal(await api.migrationTag("cp"), "v3");
  assert.equal(await api.migrationTag("shell"), null);
  assert.equal(await api.migrationTag("absent"), null);
});

test("a never-deployed Worker has no secrets; other failures surface", async () => {
  const { fetchImpl } = fakeFetch({
    "/workers/scripts/live/secrets": () => ok([{ name: "A", type: "secret_text" }]),
    "/workers/scripts/broken/secrets": () => [
      500,
      { success: false, errors: [{ code: 1, message: "boom" }] },
    ],
  });
  const api = createCloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl });
  assert.deepEqual(await api.secretNames("live"), ["A"]);
  assert.deepEqual(await api.secretNames("fresh"), []);
  await assert.rejects(
    api.secretNames("broken"),
    (e) => e instanceof CloudflareApiError && /boom/.test(e.message) && !/tok/.test(e.message)
  );
});

test("latest deployment carries the versions it serves", async () => {
  const { fetchImpl } = fakeFetch({
    "/workers/scripts/cp/deployments": () =>
      ok({
        deployments: [
          { id: "d2", versions: [{ version_id: "v2", percentage: 100 }] },
          { id: "d1", versions: [{ version_id: "v1", percentage: 100 }] },
        ],
      }),
  });
  const api = createCloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl });
  assert.deepEqual(await api.latestDeployment("cp"), {
    id: "d2",
    versions: [{ version_id: "v2", percentage: 100 }],
  });
});
