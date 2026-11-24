---
name: onboarding
description:
  Deploy your own Open-Inspect instance. Use when the user wants to set up, deploy, or onboard to
  Open-Inspect. Guides through repository setup, credential collection, Terraform provisioning, the
  Cloudflare Worker deploy, and verification with user handoffs.
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, TodoWrite
---

# Open-Inspect Deployment Guide

You are guiding the user through deploying their own instance of Open-Inspect. This is a multi-phase
process requiring user interaction for credential collection and external service configuration.

## Before Starting

Use TodoWrite to create a checklist tracking these phases:

1. Initial setup questions
2. Repository setup
3. Credential collection (Cloudflare, Vercel if selected, Modal, Anthropic)
4. GitHub App creation (+ Google OAuth if enabled)
5. Slack App creation (if enabled)
6. Security secrets generation
7. Terraform configuration
8. Terraform provisioning and Cloudflare deploy
9. Post-deployment Slack setup (if enabled)
10. Post-deployment GitHub Bot setup (if enabled)
11. Web app deployment
12. Workspace Owner bootstrap
13. Verification
14. CI/CD setup (optional)

## Phase 1: Initial Questions

First, generate a random suffix suggestion for the user:

```bash
echo "Suggested deployment name: $(openssl rand -hex 3)"
```

Use AskUserQuestion to gather:

1. **Directory location** - Where to create the project (default: current directory or
   ~/workplace/open-inspect-{suffix})
2. **GitHub account** - Which account/org hosts the private repo
3. **Deployment name** - A unique identifier for deployment URLs (e.g., their GitHub username,
   company name, or the random suffix generated above); Vercel project URLs must be globally unique.
4. **Web platform** - Vercel (default) or Cloudflare Workers. If Cloudflare, ask whether to use a
   custom domain; if so, collect the hostname and Cloudflare zone ID. Derive one canonical web app
   URL from this choice and the deployment name using Step 3 of `docs/GETTING_STARTED.md`; use it
   for both OAuth callbacks and the GitHub App homepage.
5. **Slack integration** - Yes or No
6. **GitHub bot integration** - Yes or No (automated PR reviews and comment-triggered actions)
7. **Sign-in providers** - GitHub, Google, or both. At least one is required.
8. **Admission mode** - Restricted (collect the allowed GitHub usernames, exact verified emails,
   email domains, and/or GitHub orgs) or explicitly open to any authenticated user (no allowlists).
   Validate the chosen providers and admission mode against the compatibility table and allowlist
   rules in Step 5 of `docs/GETTING_STARTED.md` before proceeding.
9. **Prerequisites confirmation** - Confirm they have Cloudflare, Modal, Anthropic, and GitHub
   accounts, plus Vercel only if selected above. Check the tools too, and install what is missing:

```bash
node --version       # must match .nvmrc (24 or newer): the deploy uses `node --env-file`
terraform version    # 1.14.0 or newer
uv --version         # Python tooling for the Modal and sandbox steps
gh auth status       # creates the repository and, later, Actions secrets
wrangler --version   # used below to create the Terraform state bucket
```

This guide deploys one environment, production. The repository also contains
`terraform/environments/staging` and `.github/workflows/deploy-staging.yml`; ignore them. Staging
stays inert unless the repository variable `CLOUDFLARE_STAGING_ENABLED` is set to `true`.

## Phase 2: Repository Setup

Execute these commands (substitute values from Phase 1):

```bash
mkdir -p {directory_path}
gh repo create {github_account}/open-inspect-{name} --private --description "Open-Inspect deployment"
cd {directory_path}
git clone git@github.com:open-inspect/background-agents.git .
git remote rename origin upstream
git remote add origin git@github.com:{github_account}/open-inspect-{name}.git
git push -u origin main
npm install
npm run build -w @open-inspect/shared
```

## Phase 3: Credential Collection

Hand off to user for each service. Use AskUserQuestion to collect credentials.

### Cloudflare

Tell the user:

- **Account ID**: Found in dashboard URL or account overview
- **Workers Subdomain**: Workers & Pages → Overview, **bottom-right** panel shows
  `*.YOUR-SUBDOMAIN.workers.dev`
- **API Token**: Create at https://dash.cloudflare.com/profile/api-tokens with template "Edit
  Cloudflare Workers" + permissions for Workers KV Storage (Edit), Workers R2 Storage (Edit), D1
  (Edit), Queues (Edit). For a Cloudflare web app with a custom domain, also grant zone-level
  Workers Routes (Edit).

### R2 Bucket

Check wrangler login status, then create bucket:

```bash
wrangler whoami
wrangler r2 bucket create open-inspect-terraform-state
```

Tell user to create R2 API Token at R2 → Overview → Manage R2 API Tokens with "Object Read & Write"
permission.

### Vercel (Only If Selected In Phase 1)

- **API Token**: https://vercel.com/account/tokens
- **Team/Account ID**: Settings → "Your ID" (even personal accounts have one, usually starts with
  `team_`)

### Modal

- **Token ID and Secret**: https://modal.com/settings or `modal token new`
- **Workspace name**: Visible in Modal dashboard URL

Then set the token:

```bash
modal token set --token-id {token_id} --token-secret {token_secret}
modal profile current
```

### Anthropic

- **API Key**: https://console.anthropic.com (starts with `sk-ant-`)

## Phase 4: GitHub App Setup

Guide the user through creating a GitHub App. Its App ID, private key, and installation ID are
always required for repository access. Its client ID and secret enable GitHub sign-in only when the
user selected GitHub:

1. Go to https://github.com/settings/apps → "New GitHub App"
2. **Name**: `Open-Inspect-{YourName}` (globally unique)
3. **Homepage URL**: The canonical web app URL from Phase 1
4. **Webhook**: Uncheck "Active"
5. If GitHub sign-in is selected, set the **Callback URL** (under "Identifying and authorizing
   users"): `{canonical-web-app-url}/api/auth/callback/github`
   - **CRITICAL**: The origin must exactly match the Homepage URL selected above.
6. **Repository permissions**: Contents (Read & Write), Pull requests (Read & Write), Metadata
   (Read-only). If the GitHub bot is enabled, also grant Actions (Read-only), Checks (Read-only),
   and Issues (Read & Write). Pull requests permission also authorizes creating and applying labels
   to session-created pull requests; labeling does not require Issues permission.
7. If GitHub organizations are allowlisted, set **Organization permissions**: Members (Read-only).
   Existing Apps need the permission change approved on their installations.
8. If GitHub sign-in is enabled, set **Account permissions**: Email addresses (Read-only). Every
   GitHub sign-in requires a verified email, regardless of admission mode. Existing Apps need the
   permission change approved on their installations.
9. Create app, note **App ID**
10. If GitHub sign-in is selected, generate a **Client Secret** and note the **Client ID** and
    **Client Secret**. Otherwise leave both deploy values empty.
11. Generate **Private Key** (downloads .pem file)
12. Install app on account, note **Installation ID** from URL

After receiving the .pem path, convert to PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in {pem_path} -out /tmp/github-app-key-pkcs8.pem
cat /tmp/github-app-key-pkcs8.pem
```

## Phase 4b: Google OAuth Setup (If Enabled)

Only if the user selected Google sign-in. Skip for GitHub-only deployments and leave
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty.

Guide user:

1. https://console.cloud.google.com/apis/credentials → "Create Credentials" → "OAuth client ID"
2. **Application type**: Web application
3. **Authorized redirect URI**: `{canonical-web-app-url}/api/auth/callback/google`
   - **CRITICAL**: Must match the web URL from Phase 1 exactly!
4. OAuth consent screen: request only `openid`, `email`, `profile` scopes (non-sensitive — no Google
   verification review required)
5. Note **Client ID** and **Client Secret**

Then in `deploy.env`:

- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (both required together; leave both empty to
  disable)
- If Google is the only sign-in provider, leave `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET`
  empty. Keep the GitHub App ID, private key, and installation ID configured for repository access.

The next request to `/login` shows Google after both credentials are deployed; no separate web flag
or rebuild is required. Google users get the same flat access; their PRs fall back to the App bot
unless the same verified email is also a linked GitHub identity.

## Phase 5: Slack App Setup (If Enabled)

Guide user:

1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. OAuth & Permissions → Add scopes: `assistant:write`, `app_mentions:read`, `chat:write`,
   `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `files:read`,
   `files:write`, `reactions:write`, `users:read`, `users:read.email`
3. Install to Workspace, note **Bot Token** (`xoxb-...`)
4. Basic Information → note **Signing Secret**
5. **App Home and Event Subscriptions configured AFTER deployment** (worker must be running for URL
   verification)

`files:read` forwards user-attached images into sessions; `files:write` posts generated media back
to Slack. Reinstall the app whenever either scope is added to an existing installation.

## Phase 6: Generate Security Secrets

```bash
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)"         # deploy.env
echo "REPO_SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)"  # deploy.env
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"              # deploy.env
echo "MODAL_API_SECRET=$(openssl rand -hex 32)"  # deploy.env and modal_api_secret in terraform.tfvars
echo "GH_WEBHOOK_SECRET=$(openssl rand -hex 32)" # deploy.env, only if GitHub bot enabled
```

## Phase 7: Terraform and Deploy Configuration

Terraform provisions infrastructure only; the Cloudflare deploy script
(`scripts/cloudflare-deploy/deploy.mjs`) uploads the Workers and owns every Worker setting.
Infrastructure values go in `terraform.tfvars`; deploy-only values (GitHub App and OAuth
credentials, bot tokens and secrets, classifier settings, encryption keys, allowlists,
`TEAMS_ENFORCEMENT`, custom domain) go in `deploy.env` at the repository root, created from
`scripts/cloudflare-deploy/deploy.env.example`. Shared values (deployment name, Cloudflare account
and subdomain, web platform, sandbox provider and its credentials, Modal settings,
`MODAL_API_SECRET`, `ENABLE_*_BOT`) go in both. See Step 5 of `docs/GETTING_STARTED.md`.

Start both files from their examples (`terraform/environments/production/terraform.tfvars.example`
and `scripts/cloudflare-deploy/deploy.env.example`) and fill in the collected answers. Never commit
or paste `deploy.env`: it is gitignored and holds every secret in the deployment.

These values appear in both files and must be identical, because the deploy names the sandbox
artifact Terraform builds from them: `deployment_name`/`DEPLOYMENT_NAME`,
`cloudflare_account_id`/`CLOUDFLARE_ACCOUNT_ID`,
`cloudflare_worker_subdomain`/`CLOUDFLARE_WORKER_SUBDOMAIN`, `web_platform`/`WEB_PLATFORM`,
`sandbox_provider`/`SANDBOX_PROVIDER`, the Modal settings and `MODAL_API_SECRET`, the
`enable_*_bot`/`ENABLE_*_BOT` flags, and the provider-specific names and sizes for Daytona, E2B and
Boat.

Create `terraform/environments/production/backend.tfvars`. The bucket is already fixed as
`open-inspect-terraform-state` in `backend.tf`; do not override it here:

```hcl
access_key = "{r2_access_key}"
secret_key = "{r2_secret_key}"
endpoints = {
  s3 = "https://{cloudflare_account_id}.r2.cloudflarestorage.com"
}
```

Create `terraform/environments/production/terraform.tfvars` with the infrastructure values and
`web_platform = "{vercel_or_cloudflare_from_phase_1}"`. If Vercel was not selected, leave
`vercel_api_token` and `vercel_team_id` unset (not empty strings).

Create `deploy.env` with the deploy values and `ENABLE_SERVICE_BINDINGS=false` for the first deploy.

If Phase 1 selected a Cloudflare custom domain, set `CLOUDFLARE_CUSTOM_DOMAIN` and
`CLOUDFLARE_ZONE_ID` in `deploy.env` to the collected hostname and zone ID. Leave both unset
otherwise.

Set `enable_slack_bot = false` (tfvars) and `ENABLE_SLACK_BOT=false` (deploy.env) if Slack was
declined in Phase 1; both default to `true`. If Slack was selected, set both to `true` and set
`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in `deploy.env`.

Write the restricted-mode comma-separated Phase 1 answers to `ALLOWED_USERS`,
`ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`, and `ALLOWED_GITHUB_ORGS` in `deploy.env`; leave unused
ones empty and set `UNSAFE_ALLOW_ALL_USERS=false`. For explicitly open mode, leave all four lists
empty and set `UNSAFE_ALLOW_ALL_USERS=true`. Use Step 5 of `docs/GETTING_STARTED.md` for the
admission contract.

If GitHub bot is enabled, set `enable_github_bot = true` in tfvars and in `deploy.env`:

```bash
ENABLE_GITHUB_BOT=true
GH_WEBHOOK_SECRET={generated_value}
GH_BOT_USERNAME="{app-slug}[bot]"
```

## Phase 8: Provision and Deploy

Check `deploy.env` before provisioning anything. A dry run validates every setting and builds the
Wrangler configs without contacting Cloudflare:

```bash
npm install
node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs --dry-run
```

Fix every problem it lists, then provision infrastructure:

```bash
cd terraform/environments/production
terraform init -backend-config=backend.tfvars
terraform apply
cd ../../..
```

Add the Terraform-generated secrets
(`terraform -chdir=terraform/environments/production output -json generated_worker_secrets`) to
`deploy.env` as `SERVICE_AUTH_SECRET_WEB`, `SERVICE_AUTH_SECRET_SLACK_BOT`,
`SERVICE_AUTH_SECRET_GITHUB_BOT`, `SERVICE_AUTH_SECRET_LINEAR_BOT`, `IMAGE_CALLBACK_TOKEN_PEPPER`,
and `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`. Then deploy the Workers (D1 and Durable Object migrations
are applied automatically):

```bash
npm install
CLOUDFLARE_API_TOKEN={cloudflare_api_token} node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs
```

After the first deploy succeeds, set `ENABLE_SERVICE_BINDINGS=true` in `deploy.env` and run the
deploy again (bots and control plane bind each other).

## Phase 9: Complete Slack Setup (If Enabled)

After the Cloudflare deploy, guide user:

The user can apply `packages/slack-bot/slack-app-manifest.yaml` instead of configuring the following
settings individually. Replace `SLACK_EVENTS_URL` with the worker's `/events` URL and
`SLACK_INTERACTIONS_URL` with its `/interactions` URL first. The template includes
`message.channels` and `message.groups` for channel-message automations; remove them if the
deployment will not use that feature.

OAuth scopes, app installation, the bot token, and the signing secret must be configured before the
Cloudflare deploy. Apply the URL-dependent manifest after deployment.

### Enable Agents

1. Agents → Enable the agent feature
2. Set the agent description to `AI coding assistant for your codebase`

### Enable App Home

1. App Home → Show Tabs → Enable **"Home Tab"**
2. Enable **"Messages Tab"** and allow users to send messages
3. Save Changes

The App Home provides settings for users' preferred model, reasoning effort, and branch. The
writable Messages tab lets users start direct-message sessions.

### Configure Event Subscriptions

1. Event Subscriptions → Enable → Request URL from `terraform output -raw slack_bot_events_url`
2. Wait for "Verified" checkmark
3. Subscribe to bot events: `app_home_opened`, `app_mention`, `message.channels`, `message.groups`,
   `message.im`

### Configure Interactivity

4. Interactivity → Enable → Request URL from `terraform output -raw slack_bot_interactions_url`
5. Select Menus → Use the same URL for **Options Load URL**. This is required for searchable Slack
   repository pickers that use external data sources.

### Invite Bot to Channels

6. Invite bot to channels: `/invite @BotName`

## Phase 10: Complete GitHub Bot Setup (If Enabled)

After the Cloudflare deploy, guide user:

### Configure Webhook on GitHub App

1. Go to GitHub App settings → your app
2. Under **Webhook**: check **"Active"**
3. **Webhook URL**:
   `https://open-inspect-github-bot-{deployment_name}.{subdomain}.workers.dev/webhooks/github`
4. **Webhook secret**: Enter the `GH_WEBHOOK_SECRET` value
5. Under **Subscribe to events**, check: **Pull requests**, **Issues**, **Issue comments**, **Pull
   request reviews**, **Pull request review comments**, **Check suites**, **Workflow runs**
6. Save changes

### Find Bot Username

The bot username is the App's slug with `[bot]` appended. E.g., if the app is `My-Inspect-App`, the
bot username is `my-inspect-app[bot]`. Confirm this matches `GH_BOT_USERNAME` in `deploy.env`.

### Usage

- **Code Review**: Assign the bot as a PR reviewer
- **Comment Actions**: @mention the bot in a PR comment with instructions

## Phase 11: Web App Deployment

For the Cloudflare choice from Phase 1, the Cloudflare deploy in Phase 8 deploys the web app; no
manual step is needed. For Vercel, deploy from the repository root:

```bash
npx vercel link --project open-inspect-{deployment_name}
npx vercel --prod
```

## Phase 12: Bootstrap the Workspace Owner

After the web app is deployed, guide the intended Owner through Step 9 of `docs/GETTING_STARTED.md`.
Obtain their canonical user ID after sign-in; run `npm run rbac:bootstrap-owner` from the repository
root as a dry run, execute only if ready, and verify by rerunning the dry run. Follow Step 9 for
commands and refusal/no-op handling.

## Phase 13: Verification

From the repository root:

```bash
curl https://open-inspect-control-plane-{deployment_name}.{subdomain}.workers.dev/health
curl "$(terraform -chdir=terraform/environments/production output -raw modal_health_url)"
curl -I "$(terraform -chdir=terraform/environments/production output -raw web_app_url)"
```

If Phase 1 chose a Cloudflare custom domain, `web_app_url` still prints the workers.dev address,
which is disabled for the web Worker in that case. Check `https://{CLOUDFLARE_CUSTOM_DOMAIN}`
instead:

```bash
curl -I https://{custom_domain}
```

Present a deployment summary table. Instruct the user to test: visit the web app, sign in with each
configured provider, create a session, and send a prompt.

## Phase 14: CI/CD Setup (Optional)

Ask if user wants GitHub Actions CI/CD. If yes, follow the "Set Up CI/CD (Optional)" section of
`docs/GETTING_STARTED.md` for the required variables and secrets, including the Phase 1 admission
mode and allowlists. CI uses the same `open-inspect-terraform-state` R2 bucket as local Terraform.

Two workflows then run on pushes to `main`: `terraform-production.yml` provisions, and
`deploy-production.yml` uploads the Workers. Both read the same setting names as `deploy.env` and
`terraform.tfvars`, from the `production` GitHub Environment or repository-level variables and
secrets (`SANDBOX_PROVIDER` may live on the Environment). Nothing uploads `deploy.env` for the user:
walk through entering each value in GitHub, as the Variables/Secrets split in
`docs/GETTING_STARTED.md` describes.

Create the `production` GitHub Environment first (repo Settings → Environments):
`gh secret set --env` fails while it does not exist. Do not add required reviewers to it: Terraform
and the deploy run on every merge, and reviewers would hold each of those jobs for approval. Then
copy the Terraform-generated secrets into it once, from the repository root:

```bash
node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment production
```

## Error Handling

- **"redirect_uri is not associated"**: Callback URL mismatch - update GitHub App settings
- **Service binding errors on first deploy**: Deploy with `ENABLE_SERVICE_BINDINGS=false`, then
  `true`
- **"At least one access control allowlist must be configured"**: Set an appropriate `ALLOWED_*`
  deploy value or the explicit Phase 1 open-access choice; check Step 5 of `docs/GETTING_STARTED.md`
  and the corresponding CI variables/secrets.
- **"KV namespaces not found" or "D1 database ... was not found"**: Terraform has not provisioned
  this deployment yet, or `DEPLOYMENT_NAME` differs from `deployment_name`. Run `terraform apply`
  first and make the two match.
- **"Terraform-generated secrets are not in the environment"**: add the values from
  `terraform -chdir=terraform/environments/production output -json generated_worker_secrets` to
  `deploy.env` (or run the sync script for CI).
- **"The ... sandbox artifact ... was not found"**: the Terraform apply that builds it has not
  finished or failed; rerun `terraform apply`, and check the shared values in Phase 7 match.
- **Queue creation or binding permission errors**: Grant Account | Queues | Edit to the Cloudflare
  API token and rerun `terraform apply`.
- **Slack bot not responding**: Check Event Subscriptions URL verified, bot invited to channel,
  reinstall if scopes changed
- **GitHub bot not responding**: Check webhook URL, secret, `ENABLE_GITHUB_BOT=true`, and
  `GH_BOT_USERNAME` matches the App's bot login

- **Vercel build fails**: Terraform configures the monorepo build commands automatically
- **Worker deployment fails**: Rerun the deploy with `--dry-run` to check its settings; with
  `--skip-build`, build `@open-inspect/shared` and the Worker packages first

## Important Notes

- Track all collected credentials securely throughout the process
- Never log sensitive values, and never commit `deploy.env`
- The callback URL MUST match the actual deployed web app URL
- The first Cloudflare deploy uses `ENABLE_SERVICE_BINDINGS=false`, then `true`, because the bots
  and control plane bind each other
