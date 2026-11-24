import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactMissingError, verifySandboxArtifact } from "./sandbox-artifacts.mjs";

function recorder(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    for (const [prefix, answer] of routes) {
      if (String(url).startsWith(prefix)) {
        const [status, body] = typeof answer === "function" ? answer(String(url)) : answer;
        return new Response(JSON.stringify(body), { status });
      }
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}

const missing = (promise) =>
  assert.rejects(promise, (error) => error instanceof ArtifactMissingError);

test("providers that build no artifact need no check", async () => {
  const { fetchImpl, calls } = recorder([]);
  await verifySandboxArtifact({ sandboxProvider: "modal" }, null, fetchImpl);
  await verifySandboxArtifact({ sandboxProvider: "vercel" }, null, fetchImpl);
  assert.equal(calls.length, 0);
});

test("Daytona requires an active snapshot, found across pages", async () => {
  const settings = {
    sandboxProvider: "daytona",
    daytonaApiUrl: "https://d.example/api/",
    daytonaApiKey: "k",
  };
  const page = (n) => [
    200,
    {
      page: n,
      totalPages: 2,
      items: n === 1 ? [{ name: "other", state: "active" }] : [{ name: "snap", state: "active" }],
    },
  ];
  const found = recorder([
    ["https://d.example/api/snapshots?page=", (url) => page(Number(/page=(\d+)/.exec(url)[1]))],
  ]);
  await verifySandboxArtifact(settings, "snap", found.fetchImpl);
  assert.equal(found.calls.length, 2);
  assert.equal(found.calls[0].headers.Authorization, "Bearer k");

  const building = recorder([
    [
      "https://d.example/api/snapshots",
      [200, { page: 1, totalPages: 1, items: [{ name: "snap", state: "building" }] }],
    ],
  ]);
  await missing(verifySandboxArtifact(settings, "snap", building.fetchImpl));
  const absent = recorder([
    ["https://d.example/api/snapshots", [200, { page: 1, totalPages: 1, items: [] }]],
  ]);
  await missing(verifySandboxArtifact(settings, "snap", absent.fetchImpl));
});

test("E2B looks the template alias up with the API key", async () => {
  const settings = {
    sandboxProvider: "e2b",
    e2bApiUrl: "https://api.e2b.app",
    e2bApiKey: "e2b-key",
  };
  const ok = recorder([
    ["https://api.e2b.app/templates/aliases/tpl-1", [200, { templateID: "t" }]],
  ]);
  await verifySandboxArtifact(settings, "tpl-1", ok.fetchImpl);
  assert.equal(ok.calls[0].headers["X-API-Key"], "e2b-key");
  await missing(verifySandboxArtifact(settings, "tpl-2", ok.fetchImpl));
});

test("Boat requires a ready saved snapshot, scoped to the organization", async () => {
  const settings = {
    sandboxProvider: "boat",
    boatApiUrl: "https://boat.dev/api/v1",
    boatApiKey: "b",
    boatOrg: "acme",
  };
  const ready = recorder([
    [
      "https://boat.dev/api/v1/saved-snapshots/s-1",
      [200, { snapshot: { name: "s-1", status: "ready" } }],
    ],
  ]);
  await verifySandboxArtifact(settings, "s-1", ready.fetchImpl);
  assert.equal(ready.calls[0].headers["X-Boat-Org"], "acme");
  const saving = recorder([
    ["https://boat.dev/api/v1/saved-snapshots/s-1", [200, { snapshot: { status: "saving" } }]],
  ]);
  await missing(verifySandboxArtifact(settings, "s-1", saving.fetchImpl));
  await missing(verifySandboxArtifact(settings, "s-9", ready.fetchImpl));
});

test("Vercel requires a created snapshot with the base name in the project", async () => {
  const settings = {
    sandboxProvider: "vercel",
    vercelSandboxToken: "v",
    vercelSandboxProjectId: "prj_1",
    vercelSandboxTeamId: "team_1",
    vercelSandboxApiBaseUrl: "",
  };
  const ok = recorder([
    [
      "https://vercel.com/api/v2/sandboxes/snapshots?",
      [200, { snapshots: [{ id: "x", status: "created" }] }],
    ],
  ]);
  await verifySandboxArtifact(settings, "openinspect-base-abc", ok.fetchImpl);
  const url = new URL(ok.calls[0].url);
  assert.equal(url.searchParams.get("project"), "prj_1");
  assert.equal(url.searchParams.get("name"), "openinspect-base-abc");
  assert.equal(url.searchParams.get("teamId"), "team_1");
  const pending = recorder([
    [
      "https://vercel.com/api/v2/sandboxes/snapshots?",
      [200, { snapshots: [{ status: "creating" }] }],
    ],
  ]);
  await missing(verifySandboxArtifact(settings, "openinspect-base-abc", pending.fetchImpl));
});

test("an unexpected provider answer is an error, not a missing artifact", async () => {
  const settings = { sandboxProvider: "e2b", e2bApiUrl: "https://api.e2b.app", e2bApiKey: "k" };
  const broken = recorder([["https://api.e2b.app", [500, {}]]]);
  await assert.rejects(
    verifySandboxArtifact(settings, "t", broken.fetchImpl),
    (error) => !(error instanceof ArtifactMissingError) && /answered 500/.test(error.message)
  );
});
