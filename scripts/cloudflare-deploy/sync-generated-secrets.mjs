#!/usr/bin/env node
// Copy the Worker secrets Terraform generates (service-auth secrets, the image
// callback pepper and the provider-account encryption key) from Terraform
// state into a GitHub Environment, where the Cloudflare deploy reads them.
//
// Run once per environment after its first Terraform apply, from a checkout
// whose Terraform root is initialized against that environment's state:
//
//   node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment production
//
// Secrets already present in the GitHub Environment are left alone unless
// --force is given. Existing Workers keep the values bound to them, so an
// upgraded deployment keeps working before this runs; a new Worker cannot
// deploy until it has.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

const { values } = parseArgs({
  options: {
    environment: { type: "string" },
    chdir: { type: "string" },
    repo: { type: "string" },
    force: { type: "boolean" },
    "dry-run": { type: "boolean" },
  },
});

if (!values.environment || !/^[A-Za-z0-9_.-]+$/.test(values.environment)) {
  console.error(
    "Usage: sync-generated-secrets.mjs --environment <github-environment> [--chdir <terraform root>] [--repo owner/name] [--force] [--dry-run]"
  );
  process.exit(2);
}

const chdir = values.chdir ?? `terraform/environments/${values.environment}`;
const repoArgs = values.repo ? ["--repo", values.repo] : [];
const generated = JSON.parse(
  capture("terraform", [`-chdir=${chdir}`, "output", "-json", "generated_worker_secrets"])
);
const existing = new Set(
  JSON.parse(
    capture("gh", ["secret", "list", "--env", values.environment, "--json", "name", ...repoArgs])
  ).map((entry) => entry.name)
);

for (const [name, value] of Object.entries(generated)) {
  if (existing.has(name) && !values.force) {
    console.log(`${name}: already set in ${values.environment}, skipping`);
    continue;
  }
  if (values["dry-run"]) {
    console.log(`${name}: would set in ${values.environment}`);
    continue;
  }
  // The value travels on stdin, never argv.
  const result = spawnSync(
    "gh",
    ["secret", "set", name, "--env", values.environment, ...repoArgs],
    {
      cwd: ROOT,
      input: value,
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`${name}: set in ${values.environment}`);
}
