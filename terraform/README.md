# Terraform Infrastructure

This directory contains Infrastructure as Code (IaC) for provisioning the Open-Inspect system using
Terraform. Terraform provisions; it does not build or upload Worker code. Cloudflare Worker code and
configuration are deployed by [`scripts/cloudflare-deploy`](../scripts/cloudflare-deploy/deploy.mjs)
with Wrangler, as Cloudflare
[recommends for Workers with Durable Objects](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#considerations-with-durable-objects).

| Terraform (provisioning)                                                                                                                                                     | Cloudflare deploy (code)                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 database, KV namespaces, R2 bucket, Queues, Worker scripts (no code), Vercel projects, sandbox artifacts (Modal, Daytona, E2B, Boat, Vercel snapshots), generated secrets | Worker versions and deployments, bindings, vars and secrets, crons, queue consumers, Durable Object and D1 migrations, the Cloudflare web Worker and its custom domain, Boat base pruning |

## Architecture Overview

The infrastructure spans multiple cloud providers:

| Provider       | Resources                                            | Terraform Support                   |
| -------------- | ---------------------------------------------------- | ----------------------------------- |
| **Cloudflare** | Workers, KV Namespaces, Durable Objects, D1 Database | Native provider                     |
| **Vercel**     | Next.js Web App, optional sandbox sessions           | Native provider + Sandbox API calls |
| **Modal**      | Optional sandbox infrastructure                      | CLI wrapper (no provider exists)    |
| **Daytona**    | Optional sandbox snapshots                           | REST API wrapper                    |
| **Boat**       | Optional sandbox snapshots                           | REST API wrapper                    |

## Directory Structure

```
terraform/
├── d1/
│   └── migrations/              # D1 migrations (applied via d1-migrate.sh)
├── modules/                     # Reusable modules with input/output definitions
├── modules/
│   └── cloudflare-environment/  # One Cloudflare environment (split by concern)
├── environments/
│   ├── production/              # Cloudflare production root (state: production/terraform.tfstate)
│   ├── staging/                 # Cloudflare staging root (state: staging/terraform.tfstate)
│   ├── aws-staging/             # AWS staging root module
│   └── aws-production/          # AWS production root module
└── README.md                    # This file
```

Both Cloudflare roots call the shared
[cloudflare-environment module](modules/cloudflare-environment/), which is split across `.tf` files
loaded together. The roots only fix the state location, configure providers and pass their inputs
through, so their `variables.tf` files are identical to the module's (a contract test enforces
this). See [variables.tf](environments/production/variables.tf) for inputs,
[outputs.tf](environments/production/outputs.tf) for outputs,
[terraform.tfvars.example](environments/production/terraform.tfvars.example) for Terraform
configuration, and [deploy.env.example](../scripts/cloudflare-deploy/deploy.env.example) for Worker
configuration. For AWS deployment instructions, see [AWS staging](environments/aws-staging/) and
[AWS production](environments/aws-production/).

## Prerequisites

### 1. Required Tools

```bash
# Terraform >= 1.14.0 (see environments/production/versions.tf)
brew install terraform

# Modal CLI (for Modal deployments)
pip install modal

# Node.js >= 24 (for building and deploying workers). node@24 is keg-only, so put it on PATH
# (add the export to your shell profile to keep it across sessions).
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version  # must print v24 or newer
```

### 2. Cloudflare Setup

1. **Create API Token** at [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
   - Required account permissions:
     - Workers Scripts: **Edit**
     - Workers KV Storage: **Edit**
     - Workers R2 Storage: **Edit**
     - D1: **Edit**
     - Queues: **Edit** (required for durable image-build finalization)
   - If you manage Cloudflare routes/custom domains through Terraform, also add:
     - Workers Routes: **Edit**

2. **Create R2 Bucket** for Terraform state:
   - Bucket name: `open-inspect-terraform-state`
   - Generate R2 API token with read/write permissions

3. **Note your Account ID** (found in dashboard URL)

### 3. Vercel Setup

1. **Create API Token** at [Vercel Account Settings](https://vercel.com/account/tokens)
2. **Note your Team ID** (found in team settings URL)
3. If using `sandbox_provider = "vercel"`, also note the Project ID for the Vercel project that will
   own sandbox sessions.
4. Terraform builds an immutable Vercel base-runtime snapshot from the local checkout and passes a
   deterministic snapshot name into the control-plane Worker. `VERCEL_BASE_SNAPSHOT_ID` is only
   needed as a manual override.

### 4. Modal Setup

1. **Sign up** at [Modal](https://modal.com)
2. **Create API Token** at Modal Settings

### 5. Sign-In Providers and GitHub Repository Access

A GitHub App installation is always required for repository access in sandboxes. Create it at
https://github.com/settings/apps and convert its private key to PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
```

Choose at least one sign-in provider:

- **GitHub sign-in:** set the GitHub App client ID and client secret together, and configure
  `/api/auth/callback/github`.
- **Google sign-in:** set the Google OAuth client ID and client secret together, and configure
  `/api/auth/callback/google`.
- Configure both pairs to offer both providers. Google-only is supported, but the GitHub App
  repository credentials remain required.

Google sign-in requires provider-neutral admission through an exact email/domain allowlist, unless
the deployment explicitly opts into unsafe allow-all. GitHub-only admission may also use GitHub
usernames or organizations.

### 6. Slack App

Create at [Slack API](https://api.slack.com/apps) and note:

- Bot OAuth Token (`xoxb-...`)
- Signing Secret

The bot token requires `assistant:write`, `app_mentions:read`, `chat:write`, `channels:history`,
`channels:read`, `groups:history`, `groups:read`, `im:history`, `files:read`, `files:write`,
`reactions:write`, `users:read`, and `users:read.email`. Reinstall the app after changing scopes.
The complete app configuration is available in
[`packages/slack-bot/slack-app-manifest.yaml`](../packages/slack-bot/slack-app-manifest.yaml).

Before upgrading any deployment, add **Queues: Edit** to the Cloudflare API token before running
`terraform apply`; image-build finalization now provisions a Queue and dead-letter Queue. For Slack
deployments, also add `files:write` and `files:read`, reinstall the Slack app, and update the
deployed bot token if Slack issued a replacement before deploying this version.

## Quick Start

The commands below name the production root, `terraform/environments/production`. For staging, use
`terraform/environments/staging` in every command, including the `terraform output` ones.

### 1. Configure Variables

```bash
cd terraform/environments/production

# Copy example files and fill in values
cp terraform.tfvars.example terraform.tfvars
cp backend.tfvars.example backend.tfvars

# Edit with your values
vim terraform.tfvars
vim backend.tfvars
```

### 2. Initialize Terraform

```bash
# Initialize with R2 backend config file
terraform init -backend-config=backend.tfvars

# Or pass values directly:
terraform init \
  -backend-config="access_key=YOUR_R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=YOUR_R2_SECRET_ACCESS_KEY" \
  -backend-config='endpoints={s3="https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com"}'
```

### 3. Plan Changes

Terraform generates and persists a dedicated provider-account credential encryption key by default.
Existing local installations may set `provider_accounts_encryption_key` in `terraform.tfvars` to
retain their current key; Actions deployments use the `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` repository
or production-environment secret instead. Do not change this value after storing provider account
credentials unless every credential has first been re-encrypted and verified through the documented
old-key-to-new-key migration before the Worker binding is updated. Back up the remote Terraform
state because it is the recovery source for an automatically generated key.

```bash
terraform plan
```

### 4. Apply Changes

```bash
terraform apply
```

### 5. Deploy the Workers

Terraform created the Worker scripts without code. Fill in the Worker settings and deploy them:

```bash
cd ../../..   # repository root
cp scripts/cloudflare-deploy/deploy.env.example deploy.env   # gitignored; never commit it

# Copy the Terraform-generated secrets into deploy.env:
terraform -chdir=terraform/environments/production output -json generated_worker_secrets

export CLOUDFLARE_API_TOKEN=...
node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs --dry-run   # validate
node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs
```

On the very first deploy set `ENABLE_SERVICE_BINDINGS=false`, because the control plane and the bots
bind each other and a binding's target must already be deployed; then set it back to `true` and
deploy again. Durable Object migrations need no such step: Wrangler applies a migration and its
binding in one upload.

## CI/CD Pipeline

Production uses two workflows and staging one:

| Workflow                   | Trigger                                                                                                                                                             | Action                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `terraform-production.yml` | PR or push to `main` touching `terraform/**` (not D1 migrations) or the sandbox packages                                                                            | `terraform plan` with PR comment; `terraform apply` on `main` |
| `deploy-production.yml`    | Push to `main` touching the Worker, web or shared packages, D1 migrations or the deploy script; and after every completed Terraform run on `main`                   | `scripts/cloudflare-deploy/deploy.mjs`                        |
| `deploy-staging.yml`       | A pull request to `main` touching the same paths, or a manual run from `main`, once a reviewer approves the `staging` Environment (opt-in; see [Staging](#staging)) | staging `terraform apply`, then the same deploy               |

A push that Terraform will apply for is deployed after the apply finishes, so a new queue, KV
namespace or sandbox snapshot exists before the code that uses it: the deploy gate waits for the
Terraform run for that commit, and the deploy then runs when that run's apply succeeds. A Vercel
sandbox snapshot also hashes the control-plane and shared sources and `package-lock.json`, so those
trigger the Terraform workflow too, but they count as provisioning only when `SANDBOX_PROVIDER` is
`vercel` (read from the `production` GitHub Environment on pushes). For any other provider a
code-only push deploys immediately. If the Terraform run never starts (GitHub evaluates `paths`
filters for at most 300 changed files, and a forced push has no usable base), the gate deploys after
a short wait instead of leaving the commit undeployed. The path lists live in
[`scripts/cloudflare-deploy/changes.mjs`](../scripts/cloudflare-deploy/changes.mjs).

Before binding the control plane to a sandbox artifact (Daytona, E2B, Boat or a managed Vercel
snapshot), the deploy checks with the provider that the artifact Terraform builds for this commit
exists and is ready, and stops with "run Terraform first" otherwise.

Known limits: workflows are serialized per environment but not ordered. If a push that needs
provisioning is still applying when a later push merges, the later deploy may bind artifacts that
earlier apply has not finished (the artifact check stops it), and a Terraform completion for an
older commit can redeploy that commit over a newer one until the next push. A pending Terraform run
replaced by a newer one compares only against its own base commit. Run `workflow_dispatch` on
`terraform-<environment>` and then `deploy-<environment>` to reconcile.

Production applies and deploys in the `production` GitHub Environment, and PR plans use
repository-level settings, as before. Do not add required reviewers to `production`: Terraform and
the deploy are meant to run on merge, merging is the approval, and reviewers would hold every
production job (the change check, apply, deploy gate and deploy) for manual approval. Staging is not
deployed from pushes to `main`: a pull request deploys to it, after approval, so a change can be
tried there first (see [Staging](#staging)).

### One-time setup

Nothing has to be initialized or planned outside the workflows. Each one runs `terraform init`
against the R2 backend itself, and the first apply of a new environment creates its state. What must
exist first:

1. **State bucket and credentials.** The `open-inspect-terraform-state` R2 bucket (an existing
   deployment already has it) and the `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets.
   Production reads these at repository level: its secret check runs without the Environment, and a
   push whose secrets are missing skips the apply.
2. **The GitHub Environments.** `production` (no required reviewers) and, for staging, `staging`.
   The settings each one needs are listed below.
3. **Once per environment, locally, to copy the generated secrets.** The sync script reads
   `terraform output`, so the root must be initialized against that environment's backend (staging's
   state exists only after its first apply):

   ```bash
   cd terraform/environments/<environment>
   cp backend.tfvars.example backend.tfvars   # fill in the R2 credentials; never commit it
   terraform init -backend-config=backend.tfvars
   cd ../../..
   node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment <environment>
   ```

   This needs Terraform 1.14 or newer and `gh` authenticated with admin access to the repository.

4. **An existing production, before merging the split.** The first apply on merge is `-auto-approve`
   and performs the state handoff, so look at it first. The pull request's own plan job only helps
   when the repository-level settings are complete (it does not read the `production` Environment).
   Run a plan from your machine with production's real settings, after saving a copy of the state
   with `terraform state pull`:

   ```bash
   cd terraform/environments/production
   terraform state pull > production-state-backup.json
   terraform plan
   ```

   Expect resources "moved" into `module.environment`, Worker versions, deployments and crons "no
   longer managed by Terraform", and **0 to destroy**. Anything else is worth understanding before
   merging.

### GitHub Actions Secrets and Variables

The Terraform and deploy workflows read the same settings under the same names; the deploy reads the
Worker settings Terraform no longer takes (see
[deploy.env.example](../scripts/cloudflare-deploy/deploy.env.example)). Keep credentials in Actions
**Secrets**. Non-secret configuration (account/application IDs, provider settings, feature flags,
allowlists, and branding) can use Actions **Variables** instead. The workflows prefer a non-empty
variable, then the same-named secret, then the existing default where one exists. Existing
secret-only deployments continue to work; an empty variable falls back to the secret rather than
clearing it. `CLASSIFICATION_MODEL` and `CLASSIFICATION_REASONING_EFFORT` remain variable-only.

See [the CI/CD setup guide](../docs/GETTING_STARTED.md#set-up-cicd-optional) for the complete
variable list and bulk upload examples using `gh variable set` and `gh secret set`.

Add these settings to your repository, using **Variables** for non-secret configuration (including
`R2_MEDIA_BUCKET_NAME`) and **Secrets** for credentials:

```
# Deployment
DEPLOYMENT_NAME          # Unique name for your deployment (e.g., 'acme', 'johndoe')

# Cloudflare
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_WORKER_SUBDOMAIN
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_MEDIA_LOCATION # Optional; defaults to ENAM
R2_MEDIA_BUCKET_NAME # Optional; name of the Terraform-created media bucket (import an existing one first)
WEB_PLATFORM # Optional; defaults to vercel

# Vercel web app (only if WEB_PLATFORM=vercel)
VERCEL_API_TOKEN
VERCEL_TEAM_ID
VERCEL_PROJECT_ID

# Documentation site (packages/docs)
DOCS_SITE_ENABLED # Optional; defaults to false, which destroys a provisioned docs project
DOCS_CUSTOM_DOMAIN # Optional; empty serves the vercel.app URL only

# Modal
MODAL_TOKEN_ID
MODAL_TOKEN_SECRET
MODAL_WORKSPACE
MODAL_ENVIRONMENT # Optional; defaults to main
MODAL_ENVIRONMENT_WEB_SUFFIX # Optional; lowercase letters, digits, dashes; empty for workspace--... endpoints
MODAL_API_SECRET

# Sandbox provider
SANDBOX_PROVIDER
SANDBOX_INACTIVITY_TIMEOUT_MS # Optional; defaults to 600000
SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS # Optional; defaults to 120000, minimum 60000
SANDBOX_BOOT_TIMEOUT_MS       # Optional; defaults to 1800000, must exceed 240000

# Daytona (only if SANDBOX_PROVIDER=daytona)
DAYTONA_API_URL
DAYTONA_API_KEY
DAYTONA_BASE_SNAPSHOT            # Prefix for the Terraform-managed base snapshot
DAYTONA_BASE_SNAPSHOT_MEMORY_GIB # Optional; defaults to 2
DAYTONA_TARGET # Optional

# Vercel Sandboxes (only if SANDBOX_PROVIDER=vercel)
VERCEL_SANDBOX_TOKEN
VERCEL_SANDBOX_PROJECT_ID
VERCEL_SANDBOX_TEAM_ID # Optional
VERCEL_BASE_SNAPSHOT_ID # Optional manual fallback; skips Terraform-managed snapshot builds
VERCEL_SANDBOX_RUNTIME # Optional; defaults to node24
VERCEL_SNAPSHOT_EXPIRATION_MS # Optional; defaults to 0

# Boat (only if SANDBOX_PROVIDER=boat)
BOAT_API_KEY
BOAT_BASE_SNAPSHOT # Prefix for the Terraform-managed saved snapshot
BOAT_API_URL       # Optional; defaults to https://boat.dev/api/v1
BOAT_ORG           # Optional organization wallet
BOAT_SANDBOX_TYPE  # Optional; defaults to default
VERCEL_SANDBOX_API_BASE_URL # Optional advanced Vercel Sandbox API base URL override

# Optional GitHub sign-in pair (set both or neither)
GH_OAUTH_CLIENT_ID
GH_OAUTH_CLIENT_SECRET

# Optional Google sign-in pair (set both or neither)
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET

# GitHub App
GH_APP_ID
GH_APP_PRIVATE_KEY
GH_APP_INSTALLATION_ID

# Slack
ENABLE_SLACK_BOT # Optional; defaults to true
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET

# GitHub bot
ENABLE_GITHUB_BOT # Optional; defaults to false
GH_WEBHOOK_SECRET
GH_BOT_USERNAME

# Linear bot
ENABLE_LINEAR_BOT # Optional; defaults to false
LINEAR_CLIENT_ID
LINEAR_CLIENT_SECRET
LINEAR_WEBHOOK_SECRET
LINEAR_API_KEY # Optional; fallback comment posting

# API Keys
ANTHROPIC_API_KEY # Optional; injected into Modal sandboxes and used by an Anthropic classifier when CLASSIFICATION_ANTHROPIC_API_KEY is unset
CLASSIFICATION_ANTHROPIC_API_KEY # Optional; classifier-only Anthropic key that never reaches sandboxes
CLASSIFICATION_OPENAI_API_KEY # Required when classification_model is an OpenAI model and the Slack or Linear bot is enabled
CLASSIFICATION_BEDROCK_API_KEY # Required when classification_model is a Bedrock model and the Slack or Linear bot is enabled; see "Classify on Amazon Bedrock (Optional)" in docs/GETTING_STARTED.md

# Security Secrets
TOKEN_ENCRYPTION_KEY
REPO_SECRETS_ENCRYPTION_KEY
PROVIDER_ACCOUNTS_ENCRYPTION_KEY # Optional existing provider-account key override
NEXTAUTH_SECRET # Browser-auth secret; legacy Actions secret name

# Access control
ALLOWED_USERS
ALLOWED_EMAIL_DOMAINS
UNSAFE_ALLOW_ALL_USERS # Optional; defaults to false

# Terraform-generated secrets for the deploy (see "Generated secrets" below)
SERVICE_AUTH_SECRET_WEB
SERVICE_AUTH_SECRET_SLACK_BOT
SERVICE_AUTH_SECRET_GITHUB_BOT
SERVICE_AUTH_SECRET_LINEAR_BOT
IMAGE_CALLBACK_TOKEN_PEPPER

# First deploy only (see "Durable Objects" below)
ENABLE_SERVICE_BINDINGS # Optional; defaults to true

# Staging pull-request deploys (see "Staging")
CLOUDFLARE_STAGING_ENABLED # Repository variable; "true" enables deploy-staging.yml

# Branding
APP_NAME # Optional; defaults to Open-Inspect
APP_ICON_URL
```

### Sandbox Inactivity

Set `SANDBOX_INACTIVITY_TIMEOUT_MS` and `SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS` in the deploy
settings (`deploy.env` locally, Actions settings in CI). The deploy binds them to the control-plane
Worker under the same names. See
[the CI/CD setup guide](../docs/GETTING_STARTED.md#set-up-cicd-optional) for which sessions use each
timeout and what extends them.

### Co-locating the request path

For a Vercel web deployment, an API request travels from the browser to a Vercel edge, then to the
web project's functions, the control-plane Worker, and D1. The edge and function regions are
separate placements. Without Smart Placement, the Worker normally runs near its caller. Session
requests also reach a session Durable Object, which reads and writes D1. Browser WebSockets and
sandbox agent connections reach that object through the Worker; sandboxes run in their provider's
locations, independently of the web functions and session objects.

Two settings let you reduce distance along this path without changing the defaults:

| Setting                                                  | Actions repository variable | Default | Scope                                       |
| -------------------------------------------------------- | --------------------------- | ------- | ------------------------------------------- |
| Terraform input `web_serverless_region`                  | `WEB_SERVERLESS_REGION`     | `iad1`  | Vercel web project functions only, not docs |
| Deploy setting `SESSION_DO_LOCATION_HINT` (`deploy.env`) | `SESSION_DO_LOCATION_HINT`  | `""`    | New session Durable Objects                 |

Set these in `terraform.tfvars` and `deploy.env`, or use the Actions repository variables for CI
deployments. Choose a supported Vercel region near your users and D1's primary, balancing distance
to each. The web region must match `^[a-z]{3}[0-9]$`; it has no effect when
`web_platform = "cloudflare"`. Choose the session hint for D1's region: `wnam`, `enam`, `sam`,
`weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`, `afr`, or `me`. Prefer `apac` for general
Asia-Pacific placement; use `apac-ne` or `apac-se` for the northeast or southeast subregion. See
[Cloudflare's location hints](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint).
An empty hint preserves automatic placement. Terraform and the deploy reject invalid values; if an
invalid hint reaches the Worker outside Terraform, it logs a warning and ignores it rather than
failing the request. Consider the Worker's Smart Placement separately after measuring these changes;
neither input enables it.

Apply and measure one setting at a time. A web region change takes effect only after a web redeploy
following Terraform apply: Deploy Web pulls the updated project settings before building. A session
hint is best-effort and only affects objects first created after the change. It applies to all
session callers, including bots, automations, and sandboxes. Existing objects stay where they are,
so requests to older sessions may still cross regions. Objects near D1 may also be farther from some
sandboxes or third-party APIs; watch agent-event latency as well as web request latency.

Check actual placement rather than assuming the settings were honored:

- **Web functions:** inspect the function's location in **Function** details in
  [Vercel Runtime Logs](https://vercel.com/docs/logs/runtime#log-details), not the request's
  **Region** field (the edge location). In
  [log drains](https://vercel.com/docs/drains/reference/logs#logs-schema), use `proxy.lambdaRegion`
  for the function execution region; `executionRegion` describes request execution and
  `proxy.region` describes proxy processing.
- **Control-plane Worker:** inspect `$workers.event.request.cf.colo` on `cf-worker-event` in Workers
  telemetry, comparing the callers whose requests you want to improve.
- **Session Durable Objects:** query GraphQL `durableObjectsPeriodicGroups`, grouped by `coloCode`;
  filter by `objectId` to check a newly created session rather than an older one.

To roll back, unset the relevant Actions repository variable or remove the override, re-apply or
redeploy, and redeploy the web app if its region changed. This restores the default web region
and/or removes the hint for future objects. Objects created with a hint remain where they are. These
settings do not move D1, enable read replication, or select a sandbox-provider region.

## Module Reference

Browse [modules/](modules/) for the available modules. Each module's `variables.tf` defines its
inputs, types, defaults, and validation; `outputs.tf` defines its returned values.

Use the maintained deployment configurations as integration examples:

- [Cloudflare KV namespaces](modules/cloudflare-environment/kv.tf)
- [Worker scripts and queues](modules/cloudflare-environment/workers.tf); their bindings are in
  [scripts/cloudflare-deploy/config.mjs](../scripts/cloudflare-deploy/config.mjs)
- [Vercel web project](modules/cloudflare-environment/web-vercel.tf)
- [Modal deployment](modules/cloudflare-environment/modal.tf)

The other sandbox providers are wired in the same
[module directory](modules/cloudflare-environment/).

## Important Notes

### Durable Objects

The deploy applies Durable Object migrations with `wrangler deploy`, which uploads a migration and
the bindings it enables together and skips migrations whose tags are already applied. Fresh
deployments start at tag `v1`; a control plane still at `v2` retires `SchedulerDO` with `v3` on its
next deploy. `ENABLE_DURABLE_OBJECT_BINDINGS` and the `control_plane_migration_*` variables are no
longer used.

Service bindings still need a target that is already deployed, and the control plane and the Slack
and Linear bots bind each other. For the first deploy of a new environment set
`ENABLE_SERVICE_BINDINGS=false`, deploy, then set it to `true` and deploy again.

### Generated secrets

Terraform generates the per-service signing secrets, the image-callback pepper and (unless you
supply one) the provider-account encryption key, and keeps them in state; the Vercel web project
receives its signing secret from Terraform directly. The deploy reads them from the GitHub
Environment as `SERVICE_AUTH_SECRET_WEB`, `SERVICE_AUTH_SECRET_SLACK_BOT`,
`SERVICE_AUTH_SECRET_GITHUB_BOT`, `SERVICE_AUTH_SECRET_LINEAR_BOT`, `IMAGE_CALLBACK_TOKEN_PEPPER`
and `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`. Copy them once after an environment's first apply:

```bash
terraform -chdir=terraform/environments/production init -backend-config=backend.tfvars
node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment production
```

A Worker keeps the secrets already bound to it when a setting is empty, so an upgraded deployment
keeps working before you copy them; the deploy refuses to upload a Worker that would have none.

### State Management

- State is stored in Cloudflare R2 (S3-compatible)
- Use state locking in production (consider DynamoDB or similar)
- Never commit `terraform.tfvars` or state files

### Modal Limitations

Since Modal has no Terraform provider, the module uses `null_resource` with `local-exec`:

- Changes are detected via source file hashing
- Manual intervention may be needed for complex updates

Terraform replaces every Modal secret with its configured values whenever any secret changes, so do
not add keys to Terraform-managed Modal secrets by hand. A failed replacement fails the apply.

Clearing `anthropic_api_key` (for example, after moving the classifier to
`classification_anthropic_api_key`) keeps `ANTHROPIC_API_KEY=""` in Modal's `llm-api-keys` secret,
so the next apply overwrites the old value. New and restored sandboxes stop receiving the key, but
sandboxes that are already running keep it until they terminate. Rotate the key if it must be
revoked immediately.

## Verification

After deployment, verify with:

```bash
# Get verification commands from Terraform output (after the Cloudflare deploy)
terraform -chdir=terraform/environments/production output verification_commands

# Or manually:

# 1. Health check control plane
curl https://open-inspect-control-plane-prod.<subdomain>.workers.dev/health

# 2. Sandbox backend health check
# Modal exposes a health endpoint. Prefer the exact URL from terraform output verification_commands.
# Manual form: https://<workspace>[-<modal_environment_web_suffix>]--open-inspect-api-health.modal.run
MODAL_WORKSPACE_SLUG="<workspace>" # or "<workspace>-<modal_environment_web_suffix>"
curl https://${MODAL_WORKSPACE_SLUG}--open-inspect-api-health.modal.run
# Daytona, Vercel, E2B and Boat use their provider APIs directly, so there is no Open-Inspect shim health URL.

# 3. Verify the web deployment
curl -I "$(terraform -chdir=terraform/environments/production output -raw web_app_url)"

# 4. Test authenticated endpoint (should return 401)
curl https://open-inspect-control-plane-prod.<subdomain>.workers.dev/sessions
```

## Troubleshooting

### "Backend initialization required"

```bash
terraform init \
  -backend-config="access_key=$R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
```

### "Provider configuration not present"

Ensure all required variables are set either in `terraform.tfvars` or as `TF_VAR_*` environment
variables.

### Modal deployment fails

1. Check Modal CLI is installed: `modal --version`
2. Verify Modal credentials: `modal token show`
3. Check logs: `modal app logs open-inspect`

### Worker deployment fails

Workers are deployed by `scripts/cloudflare-deploy/deploy.mjs`, not Terraform.

1. Validate the settings without uploading:
   `node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs --dry-run`
2. "KV namespaces not found" or "D1 database ... was not found": run the environment's
   `terraform apply` first, with the same `DEPLOYMENT_NAME`.
3. "Terraform-generated secrets are not in the environment": see
   [Generated secrets](#generated-secrets).
4. Verify Cloudflare API token permissions:
   - `Workers Scripts: Edit`
   - `Workers KV Storage: Edit`
   - `Workers R2 Storage: Edit`
   - `D1: Edit`
   - `Queues: Edit`
   - `Workers Routes: Edit` if you manage routes/custom domains through Terraform

## Staging

[environments/staging](environments/staging/) is the same module with its own state
(`staging/terraform.tfstate`). Give it its own `deployment_name` (and `DEPLOYMENT_NAME` for the
deploy) so every resource name differs from production's, then initialize, apply and deploy it as in
the quick start, using `terraform/environments/staging` in place of the production root.

In CI, `deploy-staging.yml` deploys a pull request to staging when it is opened or pushed to, once a
reviewer approves the run, so a change can be tried on staging before it merges and reaches
production. It applies `terraform/environments/staging`, then runs the same Worker deploy as
production, from the pull request's head commit.

It can also be run by hand: **Actions → Deploy Staging → Run workflow**, branch `main`. That deploys
`main`, which is how to bring up a brand-new staging environment without a pull request, or put
staging back on `main` after trying a pull request. It waits for the same approval. A manual run
from any other branch is skipped, so the workflow that holds the staging secrets always comes from
`main`; to try a branch, open a pull request.

The approval is the `staging` GitHub Environment's: every run waits at its required reviewers, and
no staging secret is released until one approves. To enable it:

1. Create the `staging` GitHub Environment first, holding the staging values (see below), with
   **required reviewers**, and consider **Prevent self-review** so whoever pushed needs a second
   person to approve. This is mandatory, not optional: see the warning below. Do it before the next
   step, because GitHub creates a missing Environment with no protection rules, and the variable
   below starts runs immediately.
2. Set the repository variable `CLOUDFLARE_STAGING_ENABLED=true`. This also turns staging on for
   pull requests from forks.
3. If the staging environment enables Slack or Linear, set `ENABLE_SERVICE_BINDINGS=false` as a
   variable on the `staging` Environment for the first successful deploy, then `true` for the next:
   the control plane binds a bot that has no code yet. The workflow does not read a local
   `deploy.env`.
4. After the first run provisions the environment, copy its Terraform-generated secrets with
   `node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment staging`, then re-run
   the workflow (and approve it again). Until then the first deploy stops at "These
   Terraform-generated secrets are not in the environment".

Things to know:

- Pull requests from forks run too. The workflow uses `pull_request_target`, because a plain
  `pull_request` run from a fork gets no secrets even after approval. Drafts wait until they are
  marked ready for review. Only changes under the paths in `STAGING_PATHS`
  (`scripts/cloudflare-deploy/changes.mjs`) run it.
- The commit deployed is the pull request's head commit, pinned when the event fired, so a later
  push is a new run and needs a new approval.
- All pull requests share one staging environment. Runs are serialized, but there is no lock: the
  last approved run wins, and staging keeps the last deployed pull request after it merges until the
  next one is approved.
- The workflow file comes from `main`, so a pull request cannot edit it to skip the Environment; a
  change to `deploy-staging.yml` takes effect only after it merges.
- It runs with no npm or uv cache, because a `pull_request_target` run saves caches under `main`'s
  scope, where a fork could plant one that production's workflows would restore.
- Environment deployment-branch rules cannot restrict these runs, because their ref is the base
  branch, not the pull request.

> **The approval is the only gate.** After a reviewer approves, the pull request's code runs with
> the `staging` Environment's secrets: its Terraform files and external data sources, deploy
> scripts, `package.json` and lockfile (npm lifecycle scripts) and the Modal deploy. Without
> required reviewers on `staging`, any fork's code would run with those secrets as soon as a pull
> request opens. Approving means having read the whole diff, dependency changes included.
> Credentials `staging` inherits from repository-level settings (the Cloudflare token and Modal
> tokens, if you keep them there) are readable by that code, so give `staging` its own where you
> can. A Cloudflare token covers the whole account, so staging's token can still reach production's
> resources when both share an account; a separate Cloudflare account for staging removes that.

**In CI, anything the `staging` GitHub Environment does not set falls back to the repository-level
value, which is production's.** A staging Environment that misses `DEPLOYMENT_NAME` would plan,
apply and deploy onto production's Workers, KV namespaces and D1 database whenever both share a
Cloudflare account. Set at least these on the `staging` Environment, and give it its own credentials
wherever production's would be wrong for staging (OAuth apps and their callback URLs, GitHub App,
bot tokens, allowlists):

- `DEPLOYMENT_NAME` (every resource name derives from it) and `R2_MEDIA_BUCKET_NAME` if production
  sets one.
- With Modal: its own `MODAL_ENVIRONMENT` and `MODAL_ENVIRONMENT_WEB_SUFFIX`. Both environments
  deploy the same `open-inspect` app and `internal-api` secret into a Modal environment, so sharing
  one makes staging's apply replace the secret's `ALLOWED_CONTROL_PLANE_HOSTS` with only staging's
  control-plane host, and production's apply does not restore it.
- With Daytona, E2B or Boat: a unique `DAYTONA_BASE_SNAPSHOT`, `E2B_TEMPLATE_ID` or
  `BOAT_BASE_SNAPSHOT` prefix per deployment (Boat pruning deletes other bases under a shared
  prefix).

## Upgrading from a single Terraform apply

Earlier releases built and uploaded every Worker from one `terraform apply` of
`environments/production`. Upgrading keeps everything running:

- **State.** The production root keeps its state key (`production/terraform.tfstate`).
  [moved.tf](environments/production/moved.tf) maps every resource into `module.environment`, and
  `removed` blocks with `destroy = false` (in [removed.tf](environments/production/removed.tf) and
  [modules/cloudflare-worker](modules/cloudflare-worker/main.tf)) forget Worker versions,
  deployments, crons, queue consumers, the web custom domain and build steps without deleting
  anything. The first plan reports those as "will no longer be managed" and destroys nothing; the
  running Workers keep serving until the next deploy replaces their versions in place.
- **CI settings.** `terraform.yml` became `terraform-production.yml` plus `deploy-production.yml`.
  Both read the existing `production` GitHub Environment and repository settings under the same
  names, so no variable or secret needs renaming. Copy the Terraform-generated secrets once (see
  [Generated secrets](#generated-secrets)); until then the Workers keep the values they have.
- **Local `terraform.tfvars`.** Worker settings (sign-in providers, allowlists, bot credentials,
  classifier, encryption keys, timeouts, custom domain) are no longer Terraform variables. Leaving
  them in `terraform.tfvars` only produces "undeclared variable" warnings; move them to `deploy.env`
  under the names in [deploy.env.example](../scripts/cloudflare-deploy/deploy.env.example), and run
  the deploy after each apply.
- **Outputs.** `terraform output` names are unchanged. For `web_platform = "cloudflare"`,
  `web_app_url` reports the workers.dev URL; the deploy serves `CLOUDFLARE_CUSTOM_DOMAIN` when set.

## Security Considerations

- All sensitive variables are marked with `sensitive = true`
- Never commit `terraform.tfvars` files
- Use GitHub Secrets for CI/CD
- Rotate secrets regularly
- Review plan output before applying
