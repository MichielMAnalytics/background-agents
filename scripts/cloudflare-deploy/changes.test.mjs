import assert from "node:assert/strict";
import test from "node:test";

import { classify, matchesPaths, STAGING_PATHS, TERRAFORM_PATHS } from "./changes.mjs";

test("D1 migrations deploy without running Terraform", () => {
  assert.equal(matchesPaths("terraform/d1/migrations/0100_x.sql", TERRAFORM_PATHS), false);
  assert.deepEqual(classify(["terraform/d1/migrations/0100_x.sql"], "modal"), {
    terraform: false,
    deploy: true,
    terraformTriggered: false,
  });
});

test("a bot change deploys without running Terraform", () => {
  assert.deepEqual(classify(["packages/slack-bot/src/index.ts"], "modal"), {
    terraform: false,
    deploy: true,
    terraformTriggered: false,
  });
});

test("an infrastructure change runs Terraform and the deploy waits for it", () => {
  const result = classify(
    ["terraform/modules/cloudflare-environment/kv.tf", "packages/slack-bot/src/index.ts"],
    "modal"
  );
  assert.equal(result.terraform, true);
  assert.equal(result.terraformTriggered, true);
});

test("control-plane sources rebuild the Vercel snapshot only for Vercel or an unknown provider", () => {
  const files = ["packages/control-plane/src/router.ts"];
  assert.equal(classify(files, "vercel").terraform, true);
  assert.equal(classify(files, "").terraform, true);
  assert.equal(classify(files, "modal").terraform, false);
  // Either way the Terraform workflow is triggered, so the deploy follows it.
  assert.equal(classify(files, "modal").terraformTriggered, true);
  assert.equal(classify(files, "modal").deploy, true);
});

test("sandbox runtime changes run Terraform for every provider", () => {
  assert.equal(
    classify(["packages/sandbox-runtime/src/sandbox_runtime/bridge.py"], "modal").terraform,
    true
  );
});

test("unknown history means everything", () => {
  assert.deepEqual(classify(null), { terraform: true, deploy: true, terraformTriggered: true });
});

test("staging deploys pull requests that change anything either production workflow reacts to", () => {
  for (const file of [
    "terraform/modules/cloudflare-environment/kv.tf",
    "terraform/d1/migrations/0100_x.sql",
    "packages/slack-bot/src/index.ts",
    "packages/modal-infra/src/web_api.py",
    "scripts/cloudflare-deploy/deploy.mjs",
    ".github/workflows/deploy-staging.yml",
  ]) {
    assert.equal(matchesPaths(file, STAGING_PATHS), true, file);
  }
  for (const file of [
    "docs/GETTING_STARTED.md",
    "terraform/d1/other.sql",
    ".github/workflows/terraform-production.yml",
    ".github/workflows/deploy-production.yml",
  ]) {
    assert.equal(matchesPaths(file, STAGING_PATHS), false, file);
  }
});
