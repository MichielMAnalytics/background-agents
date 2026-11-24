import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEPLOY_PATHS, STAGING_PATHS, TERRAFORM_PATHS } from "./cloudflare-deploy/changes.mjs";
import { DEFAULTS } from "./cloudflare-deploy/config.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const terraformWorkflow = await read(".github/workflows/terraform-cloudflare.yml");
const deployWorkflow = await read(".github/workflows/deploy-cloudflare.yml");

function assertInPlanAndApply(assignment, label) {
  const planStart = terraformWorkflow.indexOf("\n  plan:\n");
  const applyStart = terraformWorkflow.indexOf("\n  apply:\n");

  assert.notEqual(planStart, -1, "expected the Terraform plan job");
  assert.notEqual(applyStart, -1, "expected the Terraform apply job");

  const jobs = {
    plan: terraformWorkflow.slice(planStart, applyStart),
    apply: terraformWorkflow.slice(applyStart),
  };

  for (const [name, job] of Object.entries(jobs)) {
    const occurrences = job.split(assignment).length - 1;
    assert.equal(occurrences, 1, `expected one ${label} input in the ${name} job`);
  }
}

test("Daytona base snapshot memory reaches Terraform plan and apply", () => {
  assertInPlanAndApply(
    "TF_VAR_daytona_base_snapshot_memory_gib: \"${{ vars.DAYTONA_BASE_SNAPSHOT_MEMORY_GIB || '2' }}\"",
    "Daytona memory"
  );
});

test("web function region reaches Terraform plan and apply with the default", () => {
  assertInPlanAndApply(
    "TF_VAR_web_serverless_region: \"${{ vars.WEB_SERVERLESS_REGION || 'iad1' }}\"",
    "web function region"
  );
});

// project_root is a path inside the checkout.
const NOT_FROM_ENVIRONMENT = new Set(["project_root"]);

for (const root of ["production"]) {
  test(`Every ${root} Terraform variable reaches plan and apply`, async () => {
    const variables = await read(`terraform/environments/${root}/variables.tf`);
    const declared = [...variables.matchAll(/^variable "([a-z0-9_]+)"/gm)].map((match) => match[1]);
    assert.ok(declared.length > 0, "expected variables in variables.tf");

    const missing = declared.filter((name) => {
      if (NOT_FROM_ENVIRONMENT.has(name)) return false;
      try {
        assertInPlanAndApply(`TF_VAR_${name}:`, name);
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(missing, [], "each variable needs exactly one TF_VAR_ input per job");
  });
}

test("the environment roots and the shared module declare identical variables", async () => {
  const module = await read("terraform/modules/cloudflare-environment/variables.tf");
  assert.equal(await read("terraform/environments/production/variables.tf"), module);
  assert.equal(await read("terraform/environments/staging/variables.tf"), module);
});

test("production keeps its existing Terraform state key", async () => {
  assert.match(
    await read("terraform/environments/production/backend.tf"),
    /key\s+= "production\/terraform\.tfstate"/
  );
  assert.match(
    await read("terraform/environments/staging/backend.tf"),
    /key\s+= "staging\/terraform\.tfstate"/
  );
});

test("production applies in the existing GitHub Environment and plans on repository settings", async () => {
  const caller = await read(".github/workflows/terraform-production.yml");
  assert.match(caller, /^name: Terraform Production$/m);
  assert.match(caller, /environment: production\n/);
  assert.match(caller, /working-directory: terraform\/environments\/production\n/);
  assert.match(caller, /plan-environment: ""\n/);
});

test("Terraform no longer builds or uploads Worker code", () => {
  assert.doesNotMatch(
    terraformWorkflow,
    /npm run build -w @open-inspect\/(control-plane|slack-bot|github-bot|linear-bot)/
  );
  assert.doesNotMatch(terraformWorkflow, /SchedulerDO/);
});

function triggerPaths(workflow, event) {
  const lines = workflow
    .split(`\n  ${event}:\n`)[1]
    .split(/\n {4}paths:\n/)[1]
    .split("\n");
  const entries = [];
  for (const line of lines) {
    const match = /^ {6}- "([^"]+)"$/.exec(line);
    if (!match) break;
    entries.push(match[1]);
  }
  return entries;
}

for (const env of ["production"]) {
  test(`terraform-${env} triggers on exactly TERRAFORM_PATHS`, async () => {
    const workflow = await read(`.github/workflows/terraform-${env}.yml`);
    assert.deepEqual(triggerPaths(workflow, "push"), [...TERRAFORM_PATHS]);
    assert.deepEqual(triggerPaths(workflow, "pull_request"), [...TERRAFORM_PATHS]);
  });

  test(`deploy-${env} triggers on DEPLOY_PATHS and after Terraform ${env}`, async () => {
    const workflow = await read(`.github/workflows/deploy-${env}.yml`);
    assert.deepEqual(triggerPaths(workflow, "push"), [...DEPLOY_PATHS]);
    const title = `Terraform ${env[0].toUpperCase()}${env.slice(1)}`;
    assert.match(
      await read(`.github/workflows/terraform-${env}.yml`),
      new RegExp(`^name: ${title}$`, "m")
    );
    assert.match(workflow, new RegExp(`workflows: \\["${title}"\\]`));
    assert.match(workflow, new RegExp(`environment: ${env}\\n`));
  });
}

test("deploys follow only successful Terraform runs from main pushes", () => {
  assert.match(deployWorkflow, /\[ "\$RUN_CONCLUSION" = "success" \]/);
  assert.match(
    deployWorkflow,
    /\[ "\$RUN_EVENT" = "push" \] \|\| \[ "\$RUN_EVENT" = "workflow_dispatch" \]/
  );
  assert.match(
    deployWorkflow,
    /if: needs\.gate\.outputs\.deploy == 'true' && github\.ref == 'refs\/heads\/main'/
  );
});

test("every deploy setting reaches the deploy step", async () => {
  const config = await read("scripts/cloudflare-deploy/config.mjs");
  const body = config.slice(config.indexOf("const s = {"), config.indexOf("validate(s, errors);"));
  const names = [...body.matchAll(/(?:str|trimmed|bool|int|required)\("([A-Z0-9_]+)"\)/g)].map(
    (m) => m[1]
  );
  assert.ok(names.length > 50);
  const step = deployWorkflow.slice(deployWorkflow.indexOf("- name: Deploy Workers"));
  const missing = names.filter((name) => step.split(`\n          ${name}: `).length - 1 !== 1);
  assert.deepEqual(
    missing,
    [],
    "each setting needs exactly one env entry in the Deploy Workers step"
  );
});

// A setting both workflows read must resolve to the same value in each. The
// Terraform workflow builds sandbox artifacts from some of them and the deploy
// binds the control plane to artifact names derived from the same inputs, so a
// setting read from different sources (`vars` only vs `vars || secrets`) or with
// a different fallback names an artifact that was never built. The deploy
// workflow carries no fallbacks: config.mjs DEFAULTS apply, so each Terraform
// fallback is held equal to the matching default instead.
function expressions(text, pattern) {
  const found = new Map();
  for (const match of text.matchAll(pattern)) {
    const expression = match[2];
    const refs = [...expression.matchAll(/\b(?:vars|secrets)\.([A-Z0-9_]+)/g)].map((ref) => ref[0]);
    const fallback = /\|\|\s*'([^']*)'/.exec(expression)?.[1] ?? null;
    for (const ref of refs) {
      const name = ref.split(".")[1];
      if (!found.has(name)) found.set(name, { refs, fallback });
    }
  }
  return found;
}

test("settings shared by the Terraform and deploy workflows resolve identically", () => {
  const terraform = expressions(terraformWorkflow, /^ {10}TF_VAR_([a-z0-9_]+): (.*)$/gm);
  const deployStep = deployWorkflow.slice(deployWorkflow.indexOf("- name: Deploy Workers"));
  const deploy = expressions(deployStep, /^ {10}([A-Z0-9_]+): (.*)$/gm);
  const shared = [...terraform.keys()].filter((name) => deploy.has(name));
  assert.ok(shared.length > 15, "expected many settings shared by both workflows");
  const mismatched = shared.filter((name) => {
    const a = terraform.get(name);
    const b = deploy.get(name);
    return a.refs.join(",") !== b.refs.join(",");
  });
  assert.deepEqual(
    mismatched.map((name) => ({ name, terraform: terraform.get(name), deploy: deploy.get(name) })),
    []
  );

  const differingDefaults = shared.filter((name) => {
    const fallback = terraform.get(name).fallback;
    return fallback !== null && fallback !== (DEFAULTS[name] ?? null);
  });
  assert.deepEqual(
    differingDefaults,
    [],
    "Terraform workflow fallbacks must equal config.mjs DEFAULTS"
  );
});

test("the deploy gate waits only for an applying Terraform run, and deploys anyway if none starts", () => {
  assert.match(deployWorkflow, /--sandbox-provider "\$SANDBOX_PROVIDER"/);
  assert.match(deployWorkflow, /sed -n 's\/\^terraform=\/\/p'/);
  assert.match(
    deployWorkflow,
    /workflows\/terraform-\$ENVIRONMENT\.yml\/runs\?head_sha=\$GITHUB_SHA/
  );
  assert.match(
    deployWorkflow,
    /No Terraform run started for this commit; deploying without waiting/
  );
  assert.match(deployWorkflow, /endswith\("Apply"\)/);
  assert.match(deployWorkflow, /\[ "\$apply" = "success" \]/);
});

test("pushes classify with the apply Environment, pull requests with the plan Environment", () => {
  assert.match(
    terraformWorkflow,
    /environment: \$\{\{ github\.event_name == 'pull_request' && inputs\.plan-environment \|\| \(github\.event_name != 'pull_request' && inputs\.environment\) \|\| '' \}\}/
  );
  assert.match(
    deployWorkflow,
    /environment: \$\{\{ github\.event_name == 'push' && inputs\.environment \|\| '' \}\}/
  );
});

// ---------------------------------------------------------------------------
// Staging: pull requests, approved through the staging Environment
// ---------------------------------------------------------------------------

const stagingWorkflow = await read(".github/workflows/deploy-staging.yml");

function stepEnv(workflow, stepName, endMarker) {
  const start = workflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `expected the ${stepName} step`);
  const body = workflow.slice(start);
  const envStart = body.indexOf("        env:\n") + "        env:\n".length;
  const end = body.indexOf(endMarker, envStart);
  return body.slice(envStart, end === -1 ? undefined : end).trimEnd();
}

test("staging deploys pull requests that touch deployable paths", () => {
  assert.match(
    stagingWorkflow,
    /^on:\n {2}pull_request_target:\n {4}branches: \[main\]\n {4}types: \[opened, synchronize, reopened, ready_for_review\]\n/m
  );
  assert.deepEqual(triggerPaths(stagingWorkflow, "pull_request_target"), [...STAGING_PATHS]);
  assert.doesNotMatch(stagingWorkflow, /^ {2}(push|issue_comment|pull_request|workflow_run):/m);
});

test("staging waits for the staging Environment and runs only where secrets exist", () => {
  assert.match(stagingWorkflow, /environment: staging\n {4}steps:/);
  assert.match(stagingWorkflow, /vars\.CLOUDFLARE_STAGING_ENABLED == 'true'/);
  assert.match(stagingWorkflow, /!github\.event\.pull_request\.draft/);
  assert.doesNotMatch(
    stagingWorkflow,
    /CLOUDFLARE_STAGING_ALLOW_FORKS|full_name == github\.repository/
  );
  assert.match(stagingWorkflow, /^permissions:\n {2}contents: read\n/m);
  assert.match(stagingWorkflow, /persist-credentials: false/);
});

test("staging runs Terraform then the deploy in one serialized job, never interrupted", () => {
  assert.match(stagingWorkflow, /working-directory: terraform\/environments\/staging/);
  assert.match(stagingWorkflow, /run: terraform apply -auto-approve/);
  assert.match(stagingWorkflow, /run: node scripts\/cloudflare-deploy\/deploy\.mjs\n/);
  assert.match(stagingWorkflow, /group: deploy-staging\n {2}cancel-in-progress: false/);
  assert.doesNotMatch(stagingWorkflow, /github\/branch-deploy/);
});

test("staging gets the same Terraform and deploy settings as production", () => {
  assert.equal(
    stepEnv(stagingWorkflow, "Terraform Apply", "\n\n      - name"),
    stepEnv(terraformWorkflow, "Terraform Apply", "\n\n      - name")
  );
  assert.equal(
    stepEnv(stagingWorkflow, "Deploy Workers", "\n\n      - name"),
    stepEnv(deployWorkflow, "Deploy Workers", "\n\n      - name")
  );
});

test("every staging Terraform variable reaches its apply", async () => {
  const variables = await read("terraform/environments/staging/variables.tf");
  const declared = [...variables.matchAll(/^variable "([a-z0-9_]+)"/gm)].map((match) => match[1]);
  const missing = declared.filter(
    (name) =>
      !NOT_FROM_ENVIRONMENT.has(name) && stagingWorkflow.split(`TF_VAR_${name}:`).length - 1 !== 1
  );
  assert.deepEqual(missing, []);
});

test("staging checks out the head commit the event named, from a fork if need be", () => {
  assert.match(
    stagingWorkflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}\n\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/
  );
  assert.doesNotMatch(stagingWorkflow, /github\.head_ref|refs\/pull|merge_commit_sha/);
});

test("staging, which runs fork code with secrets, writes no caches that main could restore", () => {
  assert.doesNotMatch(stagingWorkflow, /^\s+cache: /m);
  assert.match(stagingWorkflow, /uses: astral-sh\/setup-uv@v\d+\n\s+with:\n\s+enable-cache: false/);
  assert.doesNotMatch(stagingWorkflow, /actions\/cache/);
});

test("staging can be run by hand, but only from main, so the secrets workflow always comes from main", () => {
  assert.match(stagingWorkflow, /^ {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(stagingWorkflow, /workflow_dispatch:\n\s+inputs:/);
  assert.match(
    stagingWorkflow,
    /\(github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'\)/
  );
  assert.match(stagingWorkflow, /environment: staging\n {4}steps:/);
});
