# Getting Started with Open-Inspect

This guide walks you through deploying your own instance of Open-Inspect using Terraform.

> Looking for local development setup (without full infra deployment)? Start with
> [SETUP_GUIDE.md](./SETUP_GUIDE.md).

> **Important**: This system is designed for **single-tenant deployment only**. All users share the
> deployment's GitHub App installation and workspace catalog. GitHub sandbox credentials reach only
> the session's repositories, further restricted by current grants for team-owned sessions. See the
> [Security Model](../README.md#security-model-single-tenant-only) for details.

### Sandbox Repository Access

GitHub credentials issued to a sandbox cover its primary repository and session members, including
the repository snapshot copied from an environment at creation. Workspace-owned sessions are scoped
the same way. For team-owned sessions, repositories no longer covered by the team's current grants
are removed from the next credential scope. An installation grant retains all session members but
does not grant the sandbox access to other repositories in the installation.

Private submodules, repository-backed private dependencies, and setup scripts that clone sibling
repositories now fail unless those repositories are included in the session's environment. Team
sessions also need grants for those members. Add the dependencies to the environment before creating
the session; editing an environment does not expand an existing session's repository snapshot.

Sessions with no repositories, no remaining granted members, or unresolved repository IDs receive no
token. Scopes with more than 500 unique IDs are refused. Repository image builds use that repository
alone, while environment image builds use their member repositories and the environment owner's
current grants. Metadata and catalog calls retain installation-wide credentials. GitLab deployments
still use one deployment-wide PAT and cannot provide this credential boundary.

Removing a grant does not revoke a credential already issued to a sandbox. Installation tokens
remain valid until expiry, and credential helpers refresh shortly before expiry. Legacy session or
environment rows without numeric repository IDs require an identity-matching cached repository
catalog; loading the repository list populates that cache. Credentials fail closed if an ID cannot
be resolved from it.

---

## Teams Enforcement

On Cloudflare, the deploy setting `TEAMS_ENFORCEMENT` sets the control-plane value. Accepted values
are `off`, `shadow`, and `on`, with **`shadow` as the default**. For a fresh deployment, explicitly
set `TEAMS_ENFORCEMENT=on` in `deploy.env` (as in Step 5) so the control plane runs with
`TEAMS_ENFORCEMENT=on` and enforces non-private Team-visibility reads. AWS production is separate
and defaults to `shadow`: add `TEAMS_ENFORCEMENT = "on"` to its `config` map in
`terraform/environments/aws-production/terraform.tfvars` to opt in, then apply Terraform and restart
the service as described in [AWS Bring-Up](AWS_BRING_UP.md). Do not assume a deployed instance has
full team read isolation simply because it includes Teams.

For an existing deployment, review its production `shadow_denied:*` authorization audit entries
before opting into `on`. Resolve unexpected would-deny decisions and verify membership, repository
grants, and bot bindings before changing the deployed value. A default flip remains gated on that
production audit review; this guide does not establish that the gate has passed. Runtime and
Terraform defaults remain `shadow`, independently of the fresh-deployment opt-in shown here.

Private-session access and current owning-team membership for non-read session actions remain
enforced in every mode. Environment/automation ownership, repository grants, and team-secret checks
also remain enforced. See [Enforcement and Access Paths](AUTH.md#enforcement-and-access-paths).

Separately, administrators can enable `requireTeamOnCreate` in **Settings > Teams**. It defaults off
and requires a team for new sessions, environments, and automation definitions, including teamless
bot session creation requests. It does not migrate existing workspace resources or prevent existing
workspace automations from running when their runtime authorization checks pass. New teams start
without repository grants; configure named or installation-wide grants before selecting
repositories.

## Overview

Open-Inspect uses Terraform to automate deployment across multiple cloud providers:

| Provider                                                             | Purpose                          | What Terraform Creates                                                                                  |
| -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Cloudflare**                                                       | Control plane, session state     | Workers, KV namespaces, Durable Objects, D1 Database                                                    |
| **Vercel** _or_ **Cloudflare Workers**                               | Web application                  | Project + env vars (Vercel) _or_ Worker via OpenNext (Cloudflare)                                       |
| **Modal**, **Daytona**, **Vercel Sandboxes**, **E2B**, _or_ **Boat** | Sandbox execution infrastructure | Modal app deployment, Daytona/Vercel API config, E2B template/API config, _or_ Boat snapshot/API config |

> **Web platform choice**: Set `web_platform` in your `terraform.tfvars` to `"vercel"` (default) or
> `"cloudflare"`. The Cloudflare option deploys the Next.js app as a Cloudflare Worker using
> [OpenNext](https://opennext.js.org/cloudflare), so you don't need a Vercel account.

**Your job**: Create accounts, gather credentials, and configure two files (`terraform.tfvars` for
infrastructure and `deploy.env` for Worker settings). **Terraform's job**: Create all infrastructure
and configure services.

**How this guide is organized**: Steps 1–10 are the minimal deploy path: one web platform, the
default Modal sandbox provider, a GitHub App for repository access and sign-in, and the Slack,
Linear, and GitHub bots turned off. The [Optional Sections](#optional-sections) after Step 10 cover
alternative sandbox providers, Google login, Slack, Linear, the GitHub bot, a custom domain, CI/CD,
branding, updating, and troubleshooting.

---

## Prerequisites

### Required Accounts

Create accounts on these services before continuing. Rows marked _(optional)_ are only needed for
the matching optional section:

| Service                                                 | Purpose                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| [Cloudflare](https://dash.cloudflare.com)               | Control plane hosting (+ web app if using Cloudflare platform)  |
| [Vercel](https://vercel.com) _(optional)_               | Web application hosting (only if `web_platform = "vercel"`)     |
| [Modal](https://modal.com)                              | Sandbox infrastructure (default `sandbox_provider = "modal"`)   |
| [GitHub](https://github.com/settings/developers)        | OAuth + repository access                                       |
| [Anthropic](https://console.anthropic.com) _(optional)_ | Claude API (the Slack/Linear bot classifier's default provider) |
| [Bedrock](https://aws.amazon.com/bedrock) _(optional)_  | Alternative Claude host for the Slack/Linear bot classifier     |
| [Daytona](https://app.daytona.io) _(optional)_          | Sandbox infrastructure when `sandbox_provider = "daytona"`      |
| [Vercel Sandboxes](https://vercel.com) _(optional)_     | Sandbox infrastructure when `sandbox_provider = "vercel"`       |
| [E2B](https://e2b.dev) _(optional)_                     | Sandbox infrastructure when `sandbox_provider = "e2b"`          |
| [Boat](https://boat.dev) _(optional)_                   | Sandbox infrastructure when `sandbox_provider = "boat"`         |
| [Slack](https://api.slack.com/apps) _(optional)_        | Slack bot integration                                           |
| [Linear](https://linear.app) _(optional)_               | Linear Agent integration                                        |
| GitHub App Webhooks _(optional)_                        | GitHub bot (PR reviews)                                         |

### Required Tools

```bash
# Terraform (1.14.0+; see terraform/environments/production/versions.tf)
brew install terraform

# Node.js (24+). node@24 is keg-only, so put it on PATH (add the export to
# your shell profile to keep it across sessions).
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version  # must print v24 or newer

# Python 3.12+ and uv (Modal CLI is installed via uv sync below)
brew install python@3.12 uv

# Wrangler CLI (for initial R2 bucket setup)
npm install -g wrangler
```

---

## Step 1: Fork the Repository

Fork [open-inspect/background-agents](https://github.com/open-inspect/background-agents) to your
GitHub account or organization.

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/background-agents.git
cd background-agents
npm install

# Build the shared package (required before Terraform deployment)
npm run build -w @open-inspect/shared

# Install Python dependencies for Modal deployment (includes sandbox-runtime)
cd packages/modal-infra && uv sync --frozen && cd -

# Create your Terraform config files (edited in Step 5; never commit them)
cp terraform/environments/production/terraform.tfvars.example terraform/environments/production/terraform.tfvars
cp terraform/environments/production/backend.tfvars.example terraform/environments/production/backend.tfvars
```

---

> **Tip**: Keep `terraform/environments/production/terraform.tfvars` open. As you collect
> credentials in the following steps, paste them directly into this file.

---

## Step 2: Create Cloud Provider Credentials

### Cloudflare

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Note your Account ID** (visible in the dashboard URL or account overview)
3. **Note your Workers subdomain**: Go to Workers & Pages → Overview, look in the **bottom-right**
   of the panel for `*.YOUR-SUBDOMAIN.workers.dev`
4. **Create API Token** at [API Tokens](https://dash.cloudflare.com/profile/api-tokens):
   - Use template: "Edit Cloudflare Workers"
   - Verify it has these permissions:
     - Account | Workers KV Storage | Edit (should be included with template)
     - Account | Workers R2 Storage | Edit (should be included with template)
     - Account | D1 | Edit
     - Account | Queues | Edit (required for durable image-build finalization)
   - Set "Account Resources" to include your account
   - Set "Zone Resources" to include all zones from your account
   - Click "Continue to summary" and "Update token"
5. **Enable R2**: Must add payment info, but first 10 GB/month is free

### Cloudflare R2 (Terraform State Backend)

Terraform needs a place to store its state. We use Cloudflare R2.

```bash
# Login to Cloudflare
wrangler login


# Create the state bucket
wrangler r2 bucket create open-inspect-terraform-state
```

Create an R2 API Token:

1. Go to R2 → Overview → Manage R2 API Tokens
2. Create token with **Object Read & Write** permission
3. Note the **Access Key ID** and **Secret Access Key**

### Vercel (only if `web_platform = "vercel"`)

> Skip this section if you're deploying the web app to Cloudflare Workers. **Important**: Do not set
> `vercel_api_token` or `vercel_team_id` to empty strings in your `terraform.tfvars` — leave them
> unset so the dummy defaults are used. The Vercel Terraform provider validates the token on init
> even when no Vercel resources are created.

1. Go to [Vercel Account Settings → Tokens](https://vercel.com/account/tokens)
2. Create a new token with full access
3. **Note your Team/Account ID**:
   - Go to **Settings** (Account Settings or Team Settings)
   - Look for **"Your ID"** or find it in the URL: `vercel.com/{YOUR_TEAM_ID}/...`
   - Even personal accounts have an ID (usually starts with `team_`)

### Modal

> Only required when `sandbox_provider = "modal"` (the default, used by the core path) or
> `"modal-vm"`. Select `modal-vm` for Docker-capable VMs; see [Modal VM setup](MODAL_DOCKER.md). To
> use Daytona, Vercel Sandboxes, E2B, or Boat instead, skip this section and follow
> [Alternative Sandbox Providers](#alternative-sandbox-providers-optional).

1. Go to [Modal Settings](https://modal.com/settings)
2. **Create a new API token**: Settings -> API Tokens -> New Token
3. Note the **Token ID** and **Token Secret**
4. Note your **Workspace** and **Environment name** (visible in your Modal dashboard URL,
   https://modal.com/apps/<modal_workspace>/<modal_environment>)
5. Note the environment's **Web suffix** from Modal's environment settings. Use the normalized
   lowercase suffix made of letters, digits, and dashes. Leave it empty for the environment whose
   endpoints use `https://<workspace>--...modal.run`.

### Anthropic (Optional)

Optional for the core path, which sets `enable_slack_bot = false` and `enable_linear_bot = false` in
Step 5. The default enables the Slack bot, and its classifier runs on Claude, so the deploy fails
without this key unless both bots are disabled or `CLASSIFICATION_MODEL` points at an OpenAI or
Bedrock model. If you enable Slack or Linear later, set either `CLASSIFICATION_ANTHROPIC_API_KEY` or
`ANTHROPIC_API_KEY` then; prefer the classifier-only key unless you also want a deployment-wide
sandbox key, because it is never injected into sandboxes. Coding sessions themselves need no key
here — those model credentials can be added as secrets in the web app after deploying. With Modal, a
key set in `anthropic_api_key` is also injected into session sandboxes as a deployment-wide default.

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Create an API key
3. Note the **API Key** (starts with `sk-ant-`)

#### Classify on Amazon Bedrock (Optional)

The Slack and Linear classifiers can call Claude in Amazon Bedrock instead of the Claude API. This
setting affects only the classifiers, not coding sessions. The classifiers send Messages API
requests to the Amazon Bedrock runtime endpoint, `bedrock-runtime.<region>.amazonaws.com`, in the
Region you choose.

1. Choose any AWS Region where the Claude model is available in Amazon Bedrock. Open the model's
   card in the Amazon Bedrock console and copy its inference profile ID, such as
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
2. Enable the model for the AWS account once. With an identity that has `aws-marketplace:Subscribe`,
   `aws-marketplace:Unsubscribe`, and `aws-marketplace:ViewSubscriptions`, open the model in the
   Amazon Bedrock console model catalog and submit Anthropic's first-time use form. Until AWS
   finishes setting up access, requests return `AccessDeniedException`, and every classification
   falls back to asking the user.
3. In the AWS console, create a long-term Amazon Bedrock API key. Its IAM identity needs
   `bedrock:InvokeModel` and `bedrock:GetInferenceProfile` on the inference profile,
   `bedrock:InvokeModel` on the models it routes to, and `bedrock:CallWithBearerToken`.
4. Record the key's expiry date. AWS recommends long-term keys for exploration only, and each key
   expires on the date set when you create it. Rotate `CLASSIFICATION_BEDROCK_API_KEY` before that
   date. Do not use a short-term key. It expires within 12 hours, and after that every
   classification falls back to asking the user.
5. Set the model and key in `deploy.env`. The model ID is `bedrock/<aws-region>/` followed by the
   inference profile ID:

   ```bash
   CLASSIFICATION_MODEL=bedrock/us-east-1/us.anthropic.claude-haiku-4-5-20251001-v1:0
   CLASSIFICATION_BEDROCK_API_KEY=<long-term Amazon Bedrock API key>
   ```

   The classifiers then need no Anthropic key. The deploy checks only the ID's format. Use the
   inference profile ID. Bedrock rejects the plain ID `anthropic.claude-haiku-4-5` as an invalid
   identifier, and rejects on-demand requests to some in-Region model IDs, such as
   `anthropic.claude-haiku-4-5-20251001-v1:0`.

> **Want to use your OpenAI ChatGPT subscription?** See [Using OpenAI Models](OPENAI_MODELS.md) for
> setup instructions (can be configured after deployment).
>
> **Want to use your xAI SuperGrok subscription?** See
> [Using Grok with a SuperGrok Subscription](GROK_MODELS.md). Grok is opt-in and can also be
> configured after deployment.

---

## Step 3: Create GitHub App

Every deployment needs **one GitHub App** for repository access. The same App can also provide
GitHub OAuth sign-in, but its client pair is optional when Google is the only sign-in provider.

1. Go to [GitHub Apps](https://github.com/settings/apps)
2. Click **"New GitHub App"**
3. Fill in the basics:
   - **Name**: `Open-Inspect-YourName` (must be globally unique)
   - **Homepage URL**: Your web app URL (see below)
   - **Webhook**: Leave "Active" unchecked for now. [GitHub Bot (Optional)](#github-bot-optional)
     enables it when `enable_github_bot = true` for GitHub automations or bot commands.
4. If enabling GitHub sign-in, configure **Identifying and authorizing users** (OAuth):
   - **Callback URL**: `{your-web-app-url}/api/auth/callback/github`

   Your web app URL depends on `web_platform`:
   - **Vercel**: `https://open-inspect-{deployment_name}.vercel.app`
   - **Cloudflare**: `https://open-inspect-web-{deployment_name}.{your-subdomain}.workers.dev`
   - **Cloudflare with `CLOUDFLARE_CUSTOM_DOMAIN` set**: `https://{your-custom-domain}`

   > **Important**: The callback URL must match your deployed web app URL exactly. The
   > `{deployment_name}` is the unique value you set in `terraform.tfvars` (e.g., your GitHub
   > username or company name).

   > **Keep "User-to-server token expiration" active** (GitHub App → **Optional Features**; it is
   > the default for newly created Apps, but activate it if yours predates that default). Expiring
   > user tokens are what make GitHub return a **refresh token** at sign-in, and Open-Inspect stores
   > that per-user credential for attributed GitHub operations such as pull-request creation. Clone,
   > fetch, and push authentication still use the shared GitHub App installation. With expiration
   > deactivated — or on an **OAuth App**, which never issues a refresh token — no per-user
   > credential is captured, so supported attributed operations fall back to the shared GitHub App
   > **bot** identity.

5. Set **Repository permissions**:
   - Contents: **Read & Write**
   - Pull requests: **Read & Write** _(also authorizes creating and applying labels to
     session-created pull requests)_
   - Metadata: **Read-only**
   - If enabling the GitHub bot, also grant Actions: **Read-only** _(workflow-run automations)_,
     Checks: **Read-only** _(check-suite automations)_, and Issues: **Read & Write**.
6. If using `ALLOWED_GITHUB_ORGS`, set **Organization permissions**:
   - Members: **Read-only**
   - For existing GitHub Apps, republish the permission change and request/approve installation
     updates before testing org membership sign-in.
7. If enabling GitHub sign-in, set **Account permissions**:
   - Email addresses: **Read-only** _(every GitHub sign-in requires a verified email, including
     username-only, org-only, and intentionally open deployments)_
   - For existing GitHub Apps, republish the permission change and request/approve installation
     updates, otherwise the added permission does not apply to current installs.
8. Click **"Create GitHub App"**
9. Note the **App ID** (top of page). If enabling GitHub sign-in, also note the **Client ID**.
10. If enabling GitHub sign-in, under **"Client secrets"**, click **"Generate a new client secret"**
    and note the **Client Secret**.
11. Scroll down to **"Private keys"** and click **"Generate a private key"** (downloads a .pem file)
12. **Convert the key to PKCS#8 format** (required for Cloudflare Workers):
    ```bash
    openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
      -in ~/Downloads/your-app-name.*.private-key.pem \
      -out private-key-pkcs8.pem
    ```
13. **Install the app** on your account/organization:
    - Click "Install App" in the sidebar
    - Select the repositories you want Open-Inspect to access
14. Note the **Installation ID** from the URL after installing:
    ```
    https://github.com/settings/installations/INSTALLATION_ID
    ```

You should now always have:

- **App ID** (e.g., `123456`)
- **Private Key** (PKCS#8 format, starts with `-----BEGIN PRIVATE KEY-----`)
- **Installation ID** (e.g., `12345678`)

For GitHub sign-in, you should also have:

- **Client ID** (e.g., `Iv1.abc123...`)
- **Client Secret** (e.g., `abc123...`)

The App private key belongs in the control plane, not in a Modal `github-app` secret or a session
secret. Fresh and restored sandboxes obtain scoped Git credentials from the control plane on demand.
The optional GitHub bot Worker still needs its own App credential bindings; Terraform supplies them
when enabled. Modal's `llm-api-keys` and `internal-api` secrets remain required and are provisioned
by Terraform.

---

## Step 4: Generate Security Secrets

Generate these random secrets (you'll need them for `terraform.tfvars` and `deploy.env`):

```bash
# Token encryption key (deploy.env)
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)"

# Repo secrets encryption key (deploy.env)
echo "REPO_SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)"

# Modal API secret, hex (terraform.tfvars modal_api_secret and deploy.env MODAL_API_SECRET)
echo "MODAL_API_SECRET=$(openssl rand -hex 32)"

# Browser authentication secret (legacy name, deploy.env)
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"

# GitHub webhook secret (only if enabling GitHub bot, deploy.env)
echo "GH_WEBHOOK_SECRET=$(openssl rand -hex 32)"
```

Save these values somewhere secure—you'll need them in the next step.

---

## Step 5: Configure Terraform

Edit the `backend.tfvars` and `terraform.tfvars` files you created in Step 1, in
`terraform/environments/production`.

### Configure `backend.tfvars`

Fill in your R2 credentials:

```hcl
access_key = "your-r2-access-key-id"
secret_key = "your-r2-secret-access-key"
endpoints = {
  s3 = "https://YOUR_CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"
}
```

### Configure `terraform.tfvars`

Fill in all the values you gathered. Here's the structure:

```hcl
# Provider Authentication
cloudflare_api_token        = "your-cloudflare-api-token"
cloudflare_account_id       = "your-account-id"
cloudflare_worker_subdomain = "your-subdomain"  # e.g., "twilight-unit-b2cf" (without .workers.dev)

# Web platform: "vercel" (default) or "cloudflare" (OpenNext)
web_platform                = "vercel"

# Vercel (only required when web_platform = "vercel")
# If using Cloudflare, do NOT set these — leave them out so the dummy defaults are used.
vercel_api_token            = "your-vercel-token"
vercel_team_id              = "team_xxxxx"       # Your Vercel ID (even personal accounts have one)
modal_token_id              = "your-modal-token-id"
modal_token_secret          = "your-modal-token-secret"
modal_workspace             = "your-modal-workspace"
modal_environment           = "your-modal-environment"
modal_environment_web_suffix = "your-modal-web-suffix" # Lowercase letters, digits, dashes; empty for https://workspace--... endpoints

# Sandbox provider: "modal" (default), "modal-vm", "daytona", "vercel", "e2b", or "boat"
# sandbox_provider          = "modal"

# Daytona (only required when sandbox_provider = "daytona")
# daytona_api_url           = "https://app.daytona.io/api"
# daytona_api_key           = "your-daytona-api-key"
# daytona_base_snapshot     = "your-snapshot-name"
# daytona_base_snapshot_memory_gib = 2

# Vercel Sandboxes (only required when sandbox_provider = "vercel")
# vercel_sandbox_token      = "your-vercel-token"
# vercel_sandbox_project_id = "prj_xxxxx"
# vercel_sandbox_team_id    = "team_xxxxx" # Optional
# vercel_base_snapshot_id   = "snapshot_xxxxx" # Optional manual override; skips managed snapshot builds
# vercel_sandbox_runtime    = "node24"

# E2B (only required when sandbox_provider = "e2b")
# e2b_api_key               = "your-e2b-api-key"        # runtime REST API key (also auths the build)
# e2b_template_id           = "open-inspect-sandbox"

# Boat (only required when sandbox_provider = "boat")
# boat_api_key              = "boat_..."               # runtime REST API key (also auths the build)
# boat_base_snapshot        = "open-inspect"           # prefix of the Terraform-managed saved snapshot

# Bots: enable_* controls which bot Worker scripts Terraform provisions. Keep these in
# sync with ENABLE_*_BOT in deploy.env. enable_slack_bot defaults to true.
enable_slack_bot  = false
enable_github_bot = false
enable_linear_bot = false

# API Keys. Optional: leave blank to add model credentials as secrets in the web
# app instead. Required only when the Slack/Linear classifier runs on Anthropic.
anthropic_api_key = ""

# provider_accounts_encryption_key = "existing-key" # Optional override; Terraform generates one
modal_api_secret = "your-generated-value"

# Configuration
# IMPORTANT: deployment_name must be globally unique for Vercel URLs
# Use your GitHub username, company name, or a random string
deployment_name = "your-unique-name"  # e.g., "acme", "johndoe", "mycompany"
project_root    = "../../../"

# Branding (optional — defaults shown)
# Display name shown in the web UI tab title, sign-in page, landing hero, bot
# messages (Slack/Linear), PR body footer, and outbound HTTP User-Agent.
# app_name = "Open-Inspect"
# Short brand label shown only in the sidebar header.
# Optional URL (absolute or root-relative) to a custom logo/favicon override.
# Leave empty to keep the built-in favicon and default in-app icon.
# app_icon_url = ""
```

### Configure `deploy.env`

Terraform no longer deploys Worker code. The Cloudflare deploy script
(`scripts/cloudflare-deploy/deploy.mjs`) deploys the Workers with Wrangler and reads its settings
from environment variables named like the GitHub Actions variables and secrets in
[CI/CD](#setting-up-cicd-optional). Copy the template and fill it in (keep it out of source
control):

```bash
cp scripts/cloudflare-deploy/deploy.env.example deploy.env
```

Repeat the shared values (`DEPLOYMENT_NAME`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_SUBDOMAIN`,
`WEB_PLATFORM`, `SANDBOX_PROVIDER`, the `MODAL_*` names, `MODAL_API_SECRET`, `ENABLE_*_BOT`, ...)
and add the Worker-only settings:

```bash
# GitHub App repository access (required in every deployment)
GH_APP_ID=123456
GH_APP_INSTALLATION_ID=12345678
GH_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
... paste your PKCS#8 key here ...
-----END PRIVATE KEY-----"

# GitHub OAuth sign-in (optional pair; leave both empty for Google-only)
GH_OAUTH_CLIENT_ID=Iv1.abc123...
GH_OAUTH_CLIENT_SECRET=your-client-secret
# Google OAuth sign-in (optional pair; may be used alone or with GitHub)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Optional custom domain for the web app (only when WEB_PLATFORM=cloudflare)
# CLOUDFLARE_ZONE_ID=your-zone-id
# CLOUDFLARE_CUSTOM_DOMAIN=app.example.com

# Bots (see the optional bot sections)
# SLACK_BOT_TOKEN= / SLACK_SIGNING_SECRET=
# GH_WEBHOOK_SECRET= / GH_BOT_USERNAME=          # e.g. my-app[bot]
# LINEAR_CLIENT_ID= / LINEAR_CLIENT_SECRET= / LINEAR_WEBHOOK_SECRET=

# Slack/Linear classifier, chosen by CLASSIFICATION_MODEL. An OpenAI model requires
# CLASSIFICATION_OPENAI_API_KEY; a Bedrock model ("bedrock/<aws-region>/<inference-profile-id>")
# requires CLASSIFICATION_BEDROCK_API_KEY; an Anthropic model uses
# CLASSIFICATION_ANTHROPIC_API_KEY, falling back to ANTHROPIC_API_KEY.
# CLASSIFICATION_MODEL=claude-haiku-4-5
# CLASSIFICATION_REASONING_EFFORT=low

# Security secrets (from Step 4)
TOKEN_ENCRYPTION_KEY=your-generated-value
REPO_SECRETS_ENCRYPTION_KEY=your-generated-value
NEXTAUTH_SECRET=your-generated-value

# First deployment: false (see Step 6), then true
ENABLE_SERVICE_BINDINGS=false

# Access control (set at least one allowlist). A user is admitted if they match ANY list.
ALLOWED_USERS=your-github-username
ALLOWED_EMAIL_DOMAINS=
ALLOWED_EMAILS=
ALLOWED_GITHUB_ORGS=
# Open access when every allowlist is empty; only if you mean it.
UNSAFE_ALLOW_ALL_USERS=false

# Fresh deployment opt-in: sets control-plane TEAMS_ENFORCEMENT=on (the default remains shadow).
TEAMS_ENFORCEMENT=on
```

Validation and defaults live in `scripts/cloudflare-deploy/config.mjs`. The rest of this guide names
settings by their Terraform variable (lowercase, for `terraform.tfvars`) or deploy setting
(uppercase, for `deploy.env`).

> **Core path bot settings**: The snippets above deploy with all three bots disabled. Keep
> `enable_slack_bot = false` explicit: Terraform defaults it to `true`, which requires Slack
> credentials and an Anthropic (or OpenAI or Bedrock classifier) key. With all three bots off,
> `anthropic_api_key` is optional. Turn bots on later with the [Slack](#slack-bot-optional),
> [Linear](#linear-agent-optional), and [GitHub bot](#github-bot-optional) sections.

### Choose Sign-In Providers

Complete credential pairs are the enablement policy. The deploy rejects partial pairs and rejects a
deployment with no sign-in provider.

| Configuration     | GitHub client pair | Google client pair | Compatible admission                                  |
| ----------------- | ------------------ | ------------------ | ----------------------------------------------------- |
| GitHub-only       | Set                | Empty              | GitHub username/org, verified email/domain, or unsafe |
| Google-only       | Empty              | Set                | Verified email/domain, or explicit unsafe allow-all   |
| GitHub and Google | Set                | Set                | Verified email/domain, or explicit unsafe allow-all   |

The GitHub App ID, PKCS#8 private key, and installation ID remain required in all three
configurations because they authorize repository operations; they do not enable GitHub sign-in. The
`/login` page reads the enabled provider set from the control plane on every request.

The core path uses GitHub sign-in. To add or switch to Google, see
[Enable Google Login (Optional)](#enable-google-login-optional).

> **Note**: Review `ALLOWED_USERS`, `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`, and
> `ALLOWED_GITHUB_ORGS` carefully — these control who can sign in. The deploy fails if all are empty
> unless you explicitly set `UNSAFE_ALLOW_ALL_USERS=true`. **Allowlists use OR semantics**: matching
> any configured username, email domain, exact email, or active GitHub org membership grants access.
> Use `ALLOWED_EMAILS` for individual users on shared domains (e.g. a specific `person@gmail.com`)
> where `ALLOWED_EMAIL_DOMAINS` would admit too many. `ALLOWED_GITHUB_ORGS` checks membership at
> sign-in only with the signing-in user's OAuth token; existing sessions last until session expiry.
> Org rules request no new OAuth scopes or `read:org`; GitHub Apps using org rules need Organization
> permissions: Members read-only. After deployment, Owners and Administrators can add rules under
> **Settings > Workspace access > Who can sign in**; those rules add to these lists and cannot
> remove anything from them. See [Sign-In Allowlist](AUTH.md#sign-in-allowlist). The same rules
> decide whether the Slack and Linear bots may create an account for someone new, and they can match
> only exact-email and domain rules, or unsafe allow-all when every list is empty (the bot still
> needs an attested email); the GitHub bot acts only for people already known, unless unsafe
> allow-all is in effect. Where people are admitted by GitHub username or organization alone, they
> sign in on the web first; see [Bot enrollment](AUTH.md#bot-enrollment).

---

## Step 6: Provision with Terraform, then deploy the Workers

Terraform provisions the Cloudflare resources (D1, KV, R2, Queues, empty Worker scripts), the Vercel
projects, and the sandbox backend, and generates internal secrets. The deploy script then uploads
the Worker code.

### Provision infrastructure

```bash
cd terraform/environments/production
terraform init -backend-config=backend.tfvars
terraform apply
cd ../../..
```

### Deploy the Workers

The deploy needs the secrets Terraform generated (service-auth secrets, image callback pepper,
provider accounts key) as `SERVICE_AUTH_SECRET_WEB`, `SERVICE_AUTH_SECRET_SLACK_BOT`,
`SERVICE_AUTH_SECRET_GITHUB_BOT`, `SERVICE_AUTH_SECRET_LINEAR_BOT`, `IMAGE_CALLBACK_TOKEN_PEPPER`,
and `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`. Add the values from
`terraform -chdir=terraform/environments/production output -json generated_worker_secrets` to
`deploy.env`. If you will use the GitHub Actions deploy, copy them once into the `production` GitHub
Environment:

```bash
node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment production
```

Then deploy from the repository root with `CLOUDFLARE_API_TOKEN` set:

```bash
npm install
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token \
  node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs   # add --dry-run to preview
```

The deploy builds and deploys the control plane, the enabled bots, and (with
`WEB_PLATFORM=cloudflare`) the web Worker. It applies D1 migrations before the control plane and
applies Durable Object migrations automatically.

On the first deploy keep `ENABLE_SERVICE_BINDINGS=false`, because the bots and control plane bind
each other. After it succeeds, set `ENABLE_SERVICE_BINDINGS=true` and run the deploy again.

---

## Step 7: Deploy the Web App

### If using Cloudflare (`web_platform = "cloudflare"`)

The Cloudflare deploy from Step 6 builds the web app with OpenNext and deploys it as a Cloudflare
Worker. No manual step needed.

To serve the web app on your own hostname, see
[Custom Domain for the Web App (Optional)](#custom-domain-for-the-web-app-optional).

### If using Vercel (`web_platform = "vercel"`)

Terraform creates the Vercel project and configures environment variables, but does **not** deploy
the code. You have two options:

#### Option A: Deploy via CLI (Recommended for First Deploy)

```bash
# From the repository root (replace {deployment_name} with your value from terraform.tfvars)
npx vercel link --project open-inspect-{deployment_name}
npx vercel --prod
```

> **Note**: The Vercel project is configured with custom build commands for the monorepo structure.
> Terraform sets these automatically:
>
> - Install: `cd ../.. && npm install && npm run build -w @open-inspect/shared`
> - Build: `npm run build` (also generates the isolated Mermaid renderer)

#### Option B: Link Git Repository (For Automatic Deployments)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Find the `open-inspect-{deployment_name}` project
3. Go to **Settings → Git**
4. Click **"Connect Git Repository"** and select your fork
5. Vercel will automatically deploy on push to main

> **Note**: If you link Git, ensure the build settings match those configured by Terraform (Settings
> → General → Build & Development Settings).

---

## Step 8: Verify Deployment

After deployment completes, verify each component from the repository root:

```bash
# Get the verification commands from Terraform
terraform -chdir=terraform/environments/production output verification_commands
```

Or manually:

```bash
# 1. Control Plane health check (replace {deployment_name} and YOUR-SUBDOMAIN)
curl https://open-inspect-control-plane-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/health

# 2. Sandbox backend health check
# Modal exposes a health endpoint. Prefer the exact URL from terraform output verification_commands.
# Manual form: https://<workspace>[-<modal_environment_web_suffix>]--open-inspect-api-health.modal.run
MODAL_WORKSPACE_SLUG="YOUR-WORKSPACE" # or "YOUR-WORKSPACE-YOUR-MODAL-WEB-SUFFIX"
curl https://${MODAL_WORKSPACE_SLUG}--open-inspect-api-health.modal.run
# Daytona, Vercel, and E2B use their provider APIs directly, so there is no
# Open-Inspect shim health URL.

# 3. Web app (should return 200)
curl -I "$(terraform -chdir=terraform/environments/production output -raw web_app_url)"
```

Visit your web app URL and sign in with each configured provider. New users get the Member role,
which cannot manage secrets, so the end-to-end session test comes after Owner and team setup in
Steps 9 and 10.

---

## Step 9: Bootstrap the Workspace Owner

Owner assignment is an explicit operator action. After the web app is deployed and verified:

1. Have the intended Owner sign in to the deployed web application once. This creates their
   canonical user and default role assignment.
2. While signed in, open `/api/auth/get-session` on the web application origin and record the
   32-character lowercase hexadecimal `user.id`. The bootstrap command accepts this canonical ID,
   never an email address.
3. Obtain the D1 database name with `terraform output -raw d1_database_name` from
   `terraform/environments/production`.
4. From the repository root, run the remote dry run (the default):

```bash
npm run rbac:bootstrap-owner -- \
  --database "$(terraform -chdir=terraform/environments/production output -raw d1_database_name)" \
  --user "<canonical-user-id>"
```

5. If the preflight is `ready`, confirm the target and execute the same command with `--execute`:

```bash
npm run rbac:bootstrap-owner -- \
  --database "$(terraform -chdir=terraform/environments/production output -raw d1_database_name)" \
  --user "<canonical-user-id>" \
  --execute
```

If the preflight is `no-op`, the target is already the current unsuspended Owner; skip execution. If
it is `refused`, stop and resolve the reported reason before retrying.

The command uses Wrangler credentials (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or
`wrangler login`) and targets remote D1. It refuses a suspended/missing user, a missing or ambiguous
assignment, or another unsuspended Owner. There is no force option. Execution is one atomic Wrangler
`--command` batch: it writes one redacted `workspace.owner_bootstrapped` service audit event,
replaces the target's assignment, and returns the exact audit-bound postcondition from that same
transaction. A no-op writes nothing. A lost batch response can leave the outcome uncertain; the
command does not automatically retry writes or claim success without the postcondition.

A successful execution prints the postcondition row as JSON with `"status":"executed"`.

6. Rerun the dry run from step 4 and expect `no-op` for the selected unsuspended Owner:

```bash
npm run rbac:bootstrap-owner -- \
  --database "$(terraform -chdir=terraform/environments/production output -raw d1_database_name)" \
  --user "<canonical-user-id>"
```

The preflight row should report `"status":"no-op"` with the detail
`selected user is already the current unsuspended Owner`. If it reports `refused` instead, the
command exits non-zero and the `detail` field gives the reason. The control-plane `/health` endpoint
reports service liveness, not Owner status.

## Step 10: Create the First Team and Test a Session

1. As the bootstrapped Owner, open **Settings > Teams > Create team**, enter a name and slug, and
   create your first team. The creator becomes its first **Lead** automatically; Owner bootstrap
   alone does not create a team or membership.
2. Open the team's settings. Choose **Join policy**: **Invite only** (the creation default) or
   **Open** for workspace users to join themselves. Choose **Default visibility** for new sessions:
   **Team**, **Workspace**, or **Private**. Use Team for team-readable work, and confirm the
   deployed control plane has `TEAMS_ENFORCEMENT=on` before relying on that read boundary.
3. In **Teams > your team > Repositories**, grant the repositories the team needs. New teams have no
   grants. Prefer named repositories; use **All installation repositories** only when that broad
   access is intended. Include every repository required by a multi-repository environment.
4. Have the other operators sign in once, then add them in the team's member list. For an open team,
   they can instead use **Join team** from Teams. Assign Lead to operators who need team-management
   duties. Workspace Owner/Administrator status is not a substitute for joining the team to perform
   non-read actions on its sessions.
5. Add a model credential in the team's **Secrets** tab, or use **Settings > Secrets** for a global
   or repository key (e.g. `ANTHROPIC_API_KEY` for Claude). Skip this if a suitable deployment-wide
   credential is already configured. See [Secrets Management](SECRETS.md).
6. Create a session with this team selected, a granted repository, the intended visibility, and a
   model whose credential is configured. Send a prompt and verify sandbox startup, repository
   checkout, and streamed results. Have another team member verify the intended collaboration.
7. If new sessions, environments, and automation definitions must be team-owned, enable **Require a
   team for new sessions** in **Settings > Teams** after membership and grants are ready. This
   separate `requireTeamOnCreate` policy also covers new environments and automation definitions; it
   does not migrate existing workspace resources.

---

## Optional Sections

Your core deployment is complete. Everything below is optional; follow only the sections you need.

- [Alternative Sandbox Providers](#alternative-sandbox-providers-optional): Daytona, Vercel
  Sandboxes, E2B, or Boat instead of Modal
- [Enable Google Login](#enable-google-login-optional)
- [Slack Bot](#slack-bot-optional)
- [Linear Agent](#linear-agent-optional)
- [GitHub Bot](#github-bot-optional)
- [Custom Domain for the Web App](#custom-domain-for-the-web-app-optional)
- [Set Up CI/CD](#set-up-cicd-optional)
- [Customizing the App Name and Icon](#customizing-the-app-name-and-icon-optional)
- [Updating Your Deployment](#updating-your-deployment)
- [Troubleshooting](#troubleshooting)

---

## Alternative Sandbox Providers (Optional)

The core path uses Modal, the default `sandbox_provider`. To run sessions on another provider, set
`sandbox_provider` in `terraform.tfvars` and follow the matching section below instead of the
[Modal](#modal) credentials in Step 2. Terraform accepts `modal`, `modal-vm`, `daytona`, `vercel`,
`e2b`, or `boat`. The `modal-vm` backend uses the same Modal credentials; see
[Modal VM backend](MODAL_DOCKER.md).

The Cloudflare deploy also needs the provider settings: set `SANDBOX_PROVIDER` and the same values
under their uppercase names (for example `DAYTONA_API_KEY`, `E2B_TEMPLATE_ID`, `BOAT_API_KEY`) in
`deploy.env`.

### Daytona

> Only required when `sandbox_provider = "daytona"`.

1. Create a [Daytona](https://app.daytona.io) account and generate an **API key** with the following
   permissions:
   - **Sandboxes**: Read, Write (runtime sandbox management and preview URLs)
   - **Snapshots**: Read, Write, Delete (automated snapshot builds via Terraform)
2. Note the **API URL** (e.g., `https://app.daytona.io/api`) and optional **target**
3. Terraform builds and verifies a new base snapshot before switching the Worker to it. See the
   [sandbox image workflow](../packages/sandbox-images/README.md) for dependency updates and manual
   builds.
4. Set `sandbox_provider = "daytona"` in `terraform.tfvars`
5. Set `daytona_api_url`, `daytona_api_key`, and `daytona_base_snapshot` in `terraform.tfvars`.
   `daytona_base_snapshot_memory_gib` controls the memory inherited by sandboxes created from the
   snapshot and defaults to `2`.

The control plane calls the Daytona REST API directly — no shim service to deploy.

Two optional settings:

- `DAYTONA_TOOLBOX_API_URL` (deploy setting) overrides the per-sandbox toolbox proxy. Leave it empty
  on a deployment whose sandboxes report their own.
- `DAYTONA_PREBUILDS_ENABLED` (deploy setting) admits new Daytona prebuilt-image builds and lets
  fresh sessions boot from one. It defaults to `false`; see
  [Daytona prebuilds](IMAGE_PREBUILD.md#daytona-prebuilds) for the gates an operator should clear
  against their own organization and target before turning it on.

> **Important**: the Daytona provider has no fleet-wide key of its own. Add the key for the models
> you plan to use — `ANTHROPIC_API_KEY` for Claude — as a **global secret** in Settings > Secrets
> after deploying. See [Secrets Management](SECRETS.md) for details.

### Vercel Sandboxes

> Only required when `sandbox_provider = "vercel"`.

1. Create a [Vercel API token](https://vercel.com/account/tokens) that can access your sandbox
   project.
2. Note the **Project ID** for the project that will own sandbox sessions.
3. Note the **Team/Account ID** if you use a Vercel team. Leave it unset for personal accounts where
   the token can access the project directly.
4. Set `sandbox_provider = "vercel"` in `terraform.tfvars`.
5. Set `vercel_sandbox_token`, `vercel_sandbox_project_id`, and optionally `vercel_sandbox_team_id`
   in `terraform.tfvars`.

The control plane calls the Vercel Sandbox API directly from Cloudflare Workers. No Modal-style shim
service is deployed. Vercel supports filesystem snapshots and prebuilt images; if you have a
reusable base snapshot, set `vercel_base_snapshot_id` to use it instead of Terraform's managed base
snapshot build.

When Terraform runs with `sandbox_provider = "vercel"`, it builds a managed immutable Vercel
base-runtime snapshot from the checked-out sandbox runtime and Vercel bootstrap source, then passes
a deterministic snapshot name into the Worker deployment. The control plane resolves that name to
the latest created Vercel snapshot at sandbox creation time. The `vercel_base_snapshot_id` setting
is still available as a manual override. See [Vercel Sandbox Provider](VERCEL_SANDBOX_PROVIDER.md)
for the full runtime, snapshot, and resource configuration model.

> **Important**: the Vercel provider has no fleet-wide key of its own. Add the key for the models
> you plan to use — `ANTHROPIC_API_KEY` for Claude — as a **global secret** in Settings > Secrets
> after deploying. See [Secrets Management](SECRETS.md) for details.

### E2B

> Only required when `sandbox_provider = "e2b"`.

E2B needs a single credential — the **API key** (`e2b_api_key`). The control plane uses it at
runtime for the E2B REST API, and the `e2b-infra` module uses it to build the sandbox template (via
the E2B Template SDK). Create it at the [E2B dashboard](https://e2b.dev) → API Keys.

1. Set `sandbox_provider = "e2b"` in `terraform.tfvars`.
2. Set `e2b_api_key` and `e2b_template_id` (e.g. `open-inspect-sandbox`).
3. Terraform's `e2b-infra` module builds the template automatically on `terraform apply`, and
   rebuilds it when `packages/e2b-infra` or `packages/sandbox-runtime` change. To build manually:
   ```bash
   cd packages/e2b-infra
   uv sync --frozen
   E2B_API_KEY=e2b_… E2B_TEMPLATE_ID=open-inspect-sandbox uv run python build-template.py
   ```

The control plane calls the E2B REST API directly from Cloudflare Workers. Each session runs in a
single long-lived sandbox: when its TTL (deploy setting `E2B_SANDBOX_TIMEOUT_SECONDS`, default 7200)
expires the sandbox is **paused** rather than killed (`E2B_AUTO_PAUSE`, default true), so sessions
survive idle gaps; the next prompt resumes it through the control plane. On the **Hobby** tier (~1h
runtime cap) lower `E2B_SANDBOX_TIMEOUT_SECONDS` to 3300. Set `E2B_AUTO_PAUSE=false` to kill on
timeout instead.

For the full runtime, lifecycle, and configuration model, see
[E2B Sandbox Provider](E2B_SANDBOX_PROVIDER.md).

> **Important**: the E2B provider has no fleet-wide key of its own. Add the key for the models you
> plan to use — `ANTHROPIC_API_KEY` for Claude — as a **global secret** in Settings > Secrets after
> deploying. See [Secrets Management](SECRETS.md) for details.

### Boat

> Only required when `sandbox_provider = "boat"`.

Boat needs a single credential — the **API key** (`boat_api_key`). The control plane uses it at
runtime for the Boat REST API, and the `boat-infra` module uses it to build the base snapshot.
Create it in the [Boat dashboard](https://boat.dev) under API keys.

1. Set `sandbox_provider = "boat"` in `terraform.tfvars`.
2. Set `boat_api_key` and `boat_base_snapshot` (a name prefix such as `open-inspect`).
3. Terraform's `boat-infra` module builds the saved snapshot automatically on `terraform apply`, and
   builds a new one when `packages/boat-infra`, `packages/sandbox-images` or
   `packages/sandbox-runtime` change. To build manually:
   ```bash
   cd packages/boat-infra
   uv sync --frozen
   BOAT_API_KEY=boat_… BOAT_BASE_SNAPSHOT=open-inspect uv run python build-template.py
   ```

The control plane calls the Boat REST API directly from Cloudflare Workers. Each session runs in a
single Boat VM: idle sessions are **stopped** (the disk is snapshotted and the machine released),
and the next prompt resumes the same sandbox on a new machine with its files intact. Boat keeps a
stopped sandbox's disk for 14 days. Sessions pick the smallest Boat machine size that satisfies
their CPU and memory settings, or the deploy setting `BOAT_SANDBOX_TYPE` (default `default`) when
they set none.

For the full runtime, lifecycle, and configuration model, see
[Boat Sandbox Provider](BOAT_SANDBOX_PROVIDER.md).

> **Important**: the Boat provider has no fleet-wide key of its own. Add the key for the models you
> plan to use — `ANTHROPIC_API_KEY` for Claude — as a **global secret** in Settings > Secrets after
> deploying. See [Secrets Management](SECRETS.md) for details.

### EC2 (AWS-hosted control plane)

When the control plane runs on AWS (see [AWS bring-up](AWS_BRING_UP.md)), sandboxes can run as EC2
instances in the same account: one instance per session, stopped when idle and started again on the
next prompt. Set `ec2_sandboxes` in the AWS Terraform environment, build the base AMI, and name it.
See [EC2 Sandbox Provider](EC2_SANDBOX_PROVIDER.md).

---

## Enable Google Login (Optional)

Google login lets non-developer users (PMs, support agents) sign in without a GitHub account. Git
operations still use the shared GitHub App, and their PRs fall back to the App bot (no personal
GitHub attribution unless the same verified email is also a linked GitHub identity).

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an
   **OAuth client ID** of type **Web application**.
2. Add the authorized redirect URI `{your-web-app-url}/api/auth/callback/google` (e.g.
   `https://open-inspect-yourname.vercel.app/api/auth/callback/google`). It must match the deployed
   URL exactly.
3. On the OAuth consent screen, request only the `openid`, `email`, and `profile` scopes — these are
   non-sensitive, so Google requires no app-verification review.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (both required together). For restricted
   access, admit Google users through `ALLOWED_EMAILS` (exact addresses) or `ALLOWED_EMAIL_DOMAINS`;
   for intentionally open access with no allowlists, set `UNSAFE_ALLOW_ALL_USERS=true`. Leave the
   GitHub client pair empty for Google-only sign-in, or keep it configured to offer both providers.
   The next request to `/login` reflects the deployed pair without a web flag or rebuild.

> **Security note**: Under restricted access, Google sign-in is admitted only for **verified**
> emails that match an allowlist. Because addresses on shared domains like `gmail.com` are generic,
> prefer `ALLOWED_EMAILS` (exact match) over `ALLOWED_EMAIL_DOMAINS` for those users.

---

## Slack Bot (Optional)

Skip this section if you don't need Slack integration.

### Create the Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From scratch"**
3. Name it (e.g., `Open-Inspect`) and select your workspace

After deploying the Slack worker, you can configure the app from
[`packages/slack-bot/slack-app-manifest.yaml`](../packages/slack-bot/slack-app-manifest.yaml)
instead of entering the settings below individually. Replace `SLACK_EVENTS_URL` with the worker's
`/events` URL and `SLACK_INTERACTIONS_URL` with its `/interactions` URL before applying the
manifest. The template includes `message.channels` and `message.groups` for channel-message
automations; remove those subscriptions if the deployment will not use that feature.

Before `terraform apply`, configure the OAuth scopes below, install the app, and collect its bot
token and signing secret. Apply the URL-dependent manifest after deployment, when Slack can verify
the worker's `/events` and `/interactions` endpoints.

#### Configure OAuth & Permissions

1. Go to **OAuth & Permissions** in the sidebar
2. Add **Bot Token Scopes**:
   - `assistant:write`
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `files:read` (lets the bot read images attached to messages and forward them to sessions)
   - `files:write`
   - `reactions:write`
   - `users:read`
   - `users:read.email` (required: the bot links each new Slack user to an account by profile email
     and won't act for users it can't link)
3. Click **"Install to Workspace"**
4. Note the **Bot Token** (`xoxb-...`)

> **Important**: If you update bot token scopes later, you must **reinstall the app** to your
> workspace for the new permissions to take effect.

#### Upgrade an Existing Slack Deployment

Queued delivery applies to every Slack completion, including text-only replies. Before the first
`terraform apply` and deploy after upgrading:

1. Add **Account | Queues | Edit** to the Cloudflare API token used by Terraform. Terraform needs
   this permission to create the completion queue, dead-letter queue, Worker binding, and consumer.
2. Ensure the Slack app has `assistant:write`, `users:read`, `users:read.email`, `files:read`, and
   `files:write`. Reinstall the app once for the workspace, and update `SLACK_BOT_TOKEN` if Slack
   issued a replacement. These scopes enable Agent view, user identity resolution, inbound images,
   and generated-media delivery.
3. Run `terraform apply` and the Cloudflare deploy, then verify a text completion, an inbound image
   attached to a prompt, and a generated-media attachment. If the token lacks Queue access, the
   apply fails while provisioning the new resources; grant the permission and rerun the apply.

No individual Slack user needs to reauthorize the app. Deployments with `enable_slack_bot = false`
still create the image-build finalization Queue and dead-letter Queue.

#### Get Signing Secret

1. Go to **Basic Information**
2. Note the **Signing Secret**

#### Enable the Slack Bot

Set `enable_slack_bot = true` in `terraform.tfvars` and run `terraform apply` from
`terraform/environments/production`. Then set these in `deploy.env` and run the
[Cloudflare deploy](#deploy-the-workers). The control plane binds the Slack bot, which has no code
yet, so keep service bindings off for this first deploy; after it succeeds, set
`ENABLE_SERVICE_BINDINGS=true` (or remove it) and deploy again. In GitHub Actions, set
`ENABLE_SERVICE_BINDINGS` as a variable on the environment for that run.

```bash
ENABLE_SERVICE_BINDINGS=false # first deploy only
ENABLE_SLACK_BOT=true
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=your-signing-secret
CLASSIFICATION_ANTHROPIC_API_KEY=sk-ant-... # Classifier-only; or set ANTHROPIC_API_KEY
```

The Slack classifier needs an Anthropic key unless `CLASSIFICATION_MODEL` points at an OpenAI or
Bedrock model; see [Anthropic (Optional)](#anthropic-optional).

#### Event Subscriptions (Configure After Deployment)

Event Subscriptions require the Slack bot worker to be deployed first for URL verification. You'll
configure this in [Complete Slack Setup](#complete-slack-setup) after deploying.

### Complete Slack Setup

Now that the Slack bot worker is deployed, configure the agent experience, App Home, and event
subscriptions.

#### Enable Agents

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **Agents**
2. Enable the agent feature and use `AI coding assistant for your codebase` as the agent description

#### Enable App Home

The App Home provides settings for users' preferred model, reasoning effort, and branch. The
writable Messages tab lets users start direct-message sessions.

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **App Home**
2. Under **Show Tabs**, toggle **"Home Tab"** to On
3. Toggle **"Messages Tab"** to On and allow users to send messages

#### Configure Event Subscriptions

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **Event Subscriptions**
2. Toggle **"Enable Events"** to On
3. Enter the **Request URL** shown by `terraform output -raw slack_bot_events_url`:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/events
   ```
   (Replace `YOUR-SUBDOMAIN` with your Cloudflare Workers subdomain and `{deployment_name}` with
   your deployment name from terraform.tfvars)
4. Wait for the green **"Verified"** checkmark
5. Under **Subscribe to bot events**, add:
   - `app_home_opened` (required for App Home settings)
   - `app_mention`
   - `message.channels` (optional - if you want the bot to see all channel messages)
   - `message.groups` (optional - if you want automations in private channels)
   - `message.im` (enables direct message support)
6. Click **Save Changes**

#### Configure Interactivity

1. Go to **Interactivity & Shortcuts**
2. Toggle **"Interactivity"** to On
3. Enter the **Request URL** shown by `terraform output -raw slack_bot_interactions_url`:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/interactions
   ```
4. Under **Select Menus**, enter **Options Load URL** using the same endpoint:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/interactions
   ```
   This is required for searchable Slack repository pickers that use external data sources.
5. Click **Save Changes**

#### Invite the Bot to Channels

In Slack, for each channel where you want the bot to respond:

- Type `/invite @YourBotName`, or
- Click the channel name → Integrations → Add apps

The bot only responds to @mentions in channels it has been invited to.

#### Choose Team Routing

In Open-Inspect, bind each Slack channel in **Teams > your team > Channels**. Then open **Settings >
Integrations > Slack** and save **Unbound channels**: `workspace` (the default, **Create
workspace-level sessions**) or `reject` (**Reject requests until the channel is bound**). This is
the integration's workspace-wide `unboundChannels` setting, not an environment variable or Terraform
input. Slack DMs are personal conversations and bypass the unbound-channel rejection policy; session
creation still checks other policies, including `requireTeamOnCreate`. A workspace fallback does not
override a requirement to choose a team. See [Slack Integration](integrations/SLACK.md).

---

## Linear Agent (Optional)

Skip this section if you don't need the Linear Agent integration.

### Create a Linear OAuth App

1. Create an application in **Linear Settings → API → Applications**.
2. Enable webhooks and subscribe to **Agent session events**. **Permission changes** and **Inbox
   notifications** are also useful operational signals.
3. Enable **Client credentials tokens**. This Linear-side setting is not managed by Terraform.
4. Configure these URLs, replacing the deployment name and Workers subdomain:
   - Callback URL:
     `https://open-inspect-linear-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/oauth/callback`
   - Webhook URL:
     `https://open-inspect-linear-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhook`
5. Record the client ID, client secret, and webhook signing secret for `deploy.env`.
6. Set `enable_linear_bot = true` in `terraform.tfvars` and run `terraform apply`, then set
   `ENABLE_SERVICE_BINDINGS=false` (first deploy only, because the control plane binds the Linear
   bot before it has code), `ENABLE_LINEAR_BOT=true`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
   and `LINEAR_WEBHOOK_SECRET` in `deploy.env` and run the Cloudflare deploy. After it succeeds, set
   `ENABLE_SERVICE_BINDINGS=true` (or remove it) and deploy again. Like Slack, the Linear classifier
   needs an Anthropic key unless `CLASSIFICATION_MODEL` points at an OpenAI or Bedrock model; see
   [Anthropic (Optional)](#anthropic-optional).

The app is installed after deployment in [Install the Linear Agent](#install-the-linear-agent).
Runtime access uses replaceable client-credentials tokens; authorization-code refresh tokens are not
stored as runtime credentials.

### Install the Linear Agent

After the Linear bot Worker is deployed, visit:

```text
https://open-inspect-linear-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/oauth/authorize
```

A Linear workspace admin must approve the installation. After installation, the agent appears in
mention and assignment menus. Before testing, bind the external Linear team in Open-Inspect's
**Teams > your team > Channels**. In **Settings > Integrations > Linear**, save **Unbound Linear
teams**: `workspace` (the default, **Create workspace-level sessions**) or `reject` (**Reject
requests until bound**). This workspace-wide integration setting is named `unboundChannels`; it is
not an environment variable or Terraform input. Workspace fallback still must satisfy other creation
policies, including `requireTeamOnCreate`.

Test by mentioning the agent on an issue in the bound Linear team, then use **View Session** to
verify the corresponding Open-Inspect session has the intended owning team and repository.

For upgrades, enable **Client credentials tokens** before deploying. No reinstall is expected for an
eligible existing installation, but allow already-running sessions to finish before upgrading
because older callback contexts may not contain the installed app-user identity.

For configuration and troubleshooting, see [Linear Integration](./integrations/LINEAR.md).

---

## GitHub Bot (Optional)

The GitHub bot handles PR review assignments and @mention commands. To deploy it, set
`enable_github_bot = true` in `terraform.tfvars` and run `terraform apply`, then set these in
`deploy.env` and run the Cloudflare deploy. Unlike Slack and Linear, this needs no
`ENABLE_SERVICE_BINDINGS` step: only the GitHub bot binds the control plane, which is already
deployed.

```bash
ENABLE_GITHUB_BOT=true
GH_WEBHOOK_SECRET=your-generated-value   # From Step 4
GH_BOT_USERNAME="my-app[bot]"            # See "Find Your Bot Username" below
```

The GitHub App also needs the GitHub bot permissions listed in Step 3 (Actions, Checks, and Issues).

After the GitHub bot worker is deployed, configure the GitHub App for webhook delivery.

### Configure Webhook on GitHub App

1. Go to your [GitHub App settings](https://github.com/settings/apps)
2. Select your Open-Inspect app
3. Under **Webhook**:
   - Check **"Active"**
   - **Webhook URL**:
     ```
     https://open-inspect-github-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhooks/github
     ```
     (Replace `YOUR-SUBDOMAIN` with your Cloudflare Workers subdomain and `{deployment_name}` with
     your deployment name from terraform.tfvars)
   - **Webhook secret**: Enter the `GH_WEBHOOK_SECRET` value from your `deploy.env`
4. Under **Subscribe to events**, check:
   - **Pull requests**
   - **Issues**
   - **Issue comments**
   - **Pull request reviews**
   - **Pull request review comments**
   - **Check suites**
   - **Workflow runs** _(required for GitHub workflow-run automations)_
5. Click **Save changes**

### Find Your Bot Username

Your GitHub App's bot username is its slug with `[bot]` appended. You can find it by:

1. Having the bot perform any action (e.g., a PR review)
2. Checking the actor's login in the webhook payload

Or construct it from your App's slug: if your app is named `My-Inspect-App`, the bot username is
`my-inspect-app[bot]`. Ensure this matches the `GH_BOT_USERNAME` value in your `deploy.env`.

### Usage

- **Code Review**: Open a non-draft PR in a repository where auto-review is enabled — it performs an
  automated review
- **Comment Actions**: @mention the bot in a PR comment with instructions (e.g.,
  `@my-app[bot] explain why this test is failing`)

For day-to-day workflows, see [GitHub Integration](./integrations/GITHUB.md).

---

## Custom Domain for the Web App (Optional)

Custom domains require `web_platform = "cloudflare"`. By default the web app is served from
`https://open-inspect-web-{deployment_name}.YOUR-SUBDOMAIN.workers.dev`. To use your own hostname,
set both of these in `deploy.env` and rerun the Cloudflare deploy, which attaches the domain:

```bash
CLOUDFLARE_ZONE_ID=your-zone-id             # zone that owns the hostname
CLOUDFLARE_CUSTOM_DOMAIN=app.example.com    # bare hostname, no scheme
```

Cloudflare provisions the DNS record and edge certificate automatically. Notes:

- The canonical browser-auth origin and the links the bots send become
  `https://{your-custom-domain}`, and the workers.dev route for the web Worker is disabled so the
  app has a single canonical origin.
- Update the GitHub App callback URL (and the Google redirect URI, if Google login is enabled) to
  the new hostname, or sign-in will fail with a redirect URI mismatch.
- The Cloudflare API token needs zone-level **Workers Routes: Edit** permission to attach the
  domain.

---

## Set Up CI/CD (Optional)

Enable automatic deployments when you push to main by configuring GitHub Actions secrets and
variables under your fork's **Settings → Secrets and variables → Actions**.

Use the **Variables** tab for the following non-secret settings (only configure the providers and
features you use):

```text
# Deployment and Cloudflare
DEPLOYMENT_NAME
WEB_PLATFORM
SANDBOX_PROVIDER
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_WORKER_SUBDOMAIN
R2_MEDIA_LOCATION
R2_MEDIA_BUCKET_NAME
SANDBOX_INACTIVITY_TIMEOUT_MS
SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS
SANDBOX_BOOT_TIMEOUT_MS
SESSION_DO_LOCATION_HINT
ENABLE_SERVICE_BINDINGS
CLOUDFLARE_ZONE_ID
CLOUDFLARE_CUSTOM_DOMAIN
CLOUDFLARE_STAGING_ENABLED

# Vercel web app
VERCEL_TEAM_ID
VERCEL_PROJECT_ID

# Documentation site (packages/docs)
DOCS_SITE_ENABLED
DOCS_CUSTOM_DOMAIN

# Modal
MODAL_WORKSPACE
MODAL_ENVIRONMENT
MODAL_ENVIRONMENT_WEB_SUFFIX

# Application IDs and bot configuration
GH_OAUTH_CLIENT_ID
GOOGLE_CLIENT_ID
GH_APP_ID
GH_APP_INSTALLATION_ID
ENABLE_SLACK_BOT
ENABLE_GITHUB_BOT
GH_BOT_USERNAME
ENABLE_LINEAR_BOT
LINEAR_CLIENT_ID

# Access control and branding
TEAMS_ENFORCEMENT
ALLOWED_USERS
ALLOWED_EMAIL_DOMAINS
ALLOWED_EMAILS
ALLOWED_GITHUB_ORGS
UNSAFE_ALLOW_ALL_USERS
APP_NAME
APP_ICON_URL

# Daytona
DAYTONA_API_URL
DAYTONA_BASE_SNAPSHOT
DAYTONA_BASE_SNAPSHOT_MEMORY_GIB
DAYTONA_TARGET
DAYTONA_TOOLBOX_API_URL
DAYTONA_PREBUILDS_ENABLED

# Vercel Sandbox
VERCEL_SANDBOX_PROJECT_ID
VERCEL_SANDBOX_TEAM_ID
VERCEL_SANDBOX_API_BASE_URL
VERCEL_BASE_SNAPSHOT_ID
VERCEL_SANDBOX_RUNTIME
VERCEL_SNAPSHOT_EXPIRATION_MS

# E2B
E2B_TEMPLATE_ID
E2B_API_URL
E2B_SANDBOX_TIMEOUT_SECONDS
E2B_AUTO_PAUSE
E2B_TEMPLATE_CPU
E2B_TEMPLATE_MEMORY_MB

# Boat
BOAT_BASE_SNAPSHOT
BOAT_API_URL
BOAT_ORG
BOAT_SANDBOX_TYPE
```

These settings resolve as **non-empty variable → same-named secret → existing default**, where a
workflow default exists. Existing secret-only deployments need no migration. If both are set, the
variable wins; delete it to return to the secret. An empty variable does not clear an existing
secret. Values such as `false` and `0` are strings in Actions variables and are preserved.

For Teams, the deploy uses the variable `TEAMS_ENFORCEMENT`, then the same-named secret, then
`shadow`. Set the variable to `on` when enabling non-private team read enforcement through CI; a
local `deploy.env` choice alone does not configure the workflow.

Keep credentials in the **Secrets** tab: API tokens/keys, OAuth client secrets, signing secrets,
private keys, encryption keys, and both `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. Allowlist values
may contain personal information; leave them in secrets if you prefer masking in workflow logs.

The table below describes deployment settings and credentials; use Variables for the names above and
Secrets for credentials:

| Setting Name                               | Value                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                     | Your Cloudflare API token                                                                                                         |
| `CLOUDFLARE_ACCOUNT_ID`                    | Your Cloudflare account ID                                                                                                        |
| `CLOUDFLARE_WORKER_SUBDOMAIN`              | Your workers.dev subdomain                                                                                                        |
| `R2_MEDIA_LOCATION`                        | R2 location hint for the media bucket (defaults to `ENAM`)                                                                        |
| `R2_MEDIA_BUCKET_NAME`                     | Optional name for the media bucket Terraform creates (import an existing bucket first)                                            |
| `DEPLOYMENT_NAME`                          | Your deployment name                                                                                                              |
| `TEAMS_ENFORCEMENT`                        | Session enforcement: `off`, `shadow` (default), or `on`; prefer a repository variable                                             |
| `R2_ACCESS_KEY_ID`                         | R2 access key ID                                                                                                                  |
| `R2_SECRET_ACCESS_KEY`                     | R2 secret access key                                                                                                              |
| `WEB_PLATFORM`                             | `vercel` or `cloudflare`                                                                                                          |
| `VERCEL_API_TOKEN`                         | Vercel API token _(only if `web_platform = "vercel"`)_                                                                            |
| `VERCEL_TEAM_ID`                           | Vercel team/account ID _(only if `web_platform = "vercel"`)_                                                                      |
| `VERCEL_PROJECT_ID`                        | Vercel project ID _(only if `web_platform = "vercel"`)_                                                                           |
| `DOCS_SITE_ENABLED`                        | `true` keeps the docs site Vercel project (default: `false`; see `packages/docs/README.md`)                                       |
| `DOCS_CUSTOM_DOMAIN`                       | Optional docs site hostname, e.g. `docs.example.com` (default: the vercel.app URL only)                                           |
| `MODAL_TOKEN_ID`                           | Modal token ID                                                                                                                    |
| `MODAL_TOKEN_SECRET`                       | Modal token secret                                                                                                                |
| `MODAL_WORKSPACE`                          | Modal workspace name                                                                                                              |
| `MODAL_ENVIRONMENT`                        | Modal environment name (defaults to `main`)                                                                                       |
| `MODAL_ENVIRONMENT_WEB_SUFFIX`             | Modal environment web suffix for endpoint URLs; lowercase letters, digits, dashes, or empty                                       |
| `SANDBOX_PROVIDER`                         | `modal` (default), [`modal-vm`](MODAL_DOCKER.md), `daytona`, `vercel`, `e2b`, or `boat`                                           |
| `SANDBOX_INACTIVITY_TIMEOUT_MS`            | Regular sandbox idle timeout in milliseconds for user, Slack, and Linear sessions (defaults to `600000`)                          |
| `SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS` | Sandbox idle timeout in milliseconds for automation, GitHub bot, and agent child sessions (defaults to `120000`, minimum `60000`) |
| `SANDBOX_BOOT_TIMEOUT_MS`                  | Milliseconds a connected sandbox may keep booting before it fails (defaults to `1800000`)                                         |
| `DAYTONA_API_URL`                          | Daytona API URL _(only if `sandbox_provider = "daytona"`)_                                                                        |
| `DAYTONA_API_KEY`                          | Daytona API key _(only if `sandbox_provider = "daytona"`)_                                                                        |
| `DAYTONA_BASE_SNAPSHOT`                    | Daytona base snapshot name prefix _(only if `sandbox_provider = "daytona"`)_                                                      |
| `DAYTONA_BASE_SNAPSHOT_MEMORY_GIB`         | Base snapshot memory in GiB (defaults to `2`)                                                                                     |
| `DAYTONA_TARGET`                           | Optional Daytona target name                                                                                                      |
| `DAYTONA_TOOLBOX_API_URL`                  | Optional Daytona toolbox proxy override; empty uses the proxy each sandbox reports                                                |
| `DAYTONA_PREBUILDS_ENABLED`                | `true` to admit new Daytona prebuilt-image builds and boot from them (default: `false`)                                           |
| `VERCEL_SANDBOX_TOKEN`                     | Vercel API token _(only if `sandbox_provider = "vercel"`)_                                                                        |
| `VERCEL_SANDBOX_PROJECT_ID`                | Vercel project ID for sandbox sessions _(only if `sandbox_provider = "vercel"`)_                                                  |
| `VERCEL_SANDBOX_TEAM_ID`                   | Optional Vercel team/account ID for sandbox sessions                                                                              |
| `VERCEL_BASE_SNAPSHOT_ID`                  | Optional manual Vercel base-runtime snapshot; skips Terraform-managed snapshot builds                                             |
| `VERCEL_SANDBOX_RUNTIME`                   | Optional Vercel Sandbox runtime (defaults to `node24`)                                                                            |
| `VERCEL_SNAPSHOT_EXPIRATION_MS`            | Optional Vercel runtime snapshot expiration in milliseconds (`0` means no expiration)                                             |
| `VERCEL_SANDBOX_API_BASE_URL`              | Optional advanced Vercel Sandbox API base URL override                                                                            |
| `E2B_API_KEY`                              | E2B API key _(only if `sandbox_provider = "e2b"`)_                                                                                |
| `BOAT_API_KEY`                             | Boat API key _(only if `sandbox_provider = "boat"`)_                                                                              |
| `GH_OAUTH_CLIENT_ID`                       | Optional GitHub sign-in client ID; set with `GH_OAUTH_CLIENT_SECRET`                                                              |
| `GH_OAUTH_CLIENT_SECRET`                   | Optional GitHub sign-in client secret; set with `GH_OAUTH_CLIENT_ID`                                                              |
| `GOOGLE_CLIENT_ID`                         | Optional Google sign-in client ID; set with `GOOGLE_CLIENT_SECRET`                                                                |
| `GOOGLE_CLIENT_SECRET`                     | Optional Google sign-in client secret; set with `GOOGLE_CLIENT_ID`                                                                |
| `GH_APP_ID`                                | Required GitHub App repository-access ID                                                                                          |
| `GH_APP_PRIVATE_KEY`                       | Required GitHub App repository-access private key (PKCS#8 format)                                                                 |
| `GH_APP_INSTALLATION_ID`                   | Required GitHub App repository-access installation ID                                                                             |
| `ENABLE_SLACK_BOT`                         | `true` to deploy Slack bot, `false` to skip (default: `true`)                                                                     |
| `SLACK_BOT_TOKEN`                          | Slack bot token (required if enabled)                                                                                             |
| `SLACK_SIGNING_SECRET`                     | Slack signing secret (required if enabled)                                                                                        |
| `ENABLE_LINEAR_BOT`                        | `true` to deploy Linear bot, `false` to skip (default: `false`)                                                                   |
| `LINEAR_CLIENT_ID`                         | Linear OAuth application client ID (required if Linear enabled)                                                                   |
| `LINEAR_CLIENT_SECRET`                     | Linear OAuth application client secret (required if Linear enabled)                                                               |
| `LINEAR_WEBHOOK_SECRET`                    | Linear webhook signing secret (required if Linear enabled)                                                                        |
| `LINEAR_API_KEY`                           | Optional Linear API key used as a comment-posting fallback                                                                        |
| `ANTHROPIC_API_KEY`                        | Optional; reaches Modal sandboxes; classifier fallback                                                                            |
| `CLASSIFICATION_ANTHROPIC_API_KEY`         | Optional classifier-only Anthropic key; never reaches sandboxes                                                                   |
| `CLASSIFICATION_OPENAI_API_KEY`            | Classifier OpenAI key (required when `CLASSIFICATION_MODEL` is an OpenAI id)                                                      |
| `CLASSIFICATION_BEDROCK_API_KEY`           | Classifier Amazon Bedrock API key (required when `CLASSIFICATION_MODEL` is a Bedrock id)                                          |
| `OPENAI_API_KEY`                           | Optional OpenAI API key used when a session selects API-key authentication                                                        |
| `XAI_API_KEY`                              | Optional xAI API key used when a session selects API-key authentication                                                           |
| `DEEPSEEK_API_KEY`                         | DeepSeek API key (optional, required only for DeepSeek models)                                                                    |
| `TOKEN_ENCRYPTION_KEY`                     | Generated encryption key (OAuth tokens)                                                                                           |
| `REPO_SECRETS_ENCRYPTION_KEY`              | Generated encryption key (repo secrets)                                                                                           |
| `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`         | Optional existing provider-account key override; Terraform generates one when omitted                                             |
| `MODAL_API_SECRET`                         | Generated Modal API secret                                                                                                        |
| `NEXTAUTH_SECRET`                          | Generated browser-auth secret (legacy Actions secret name)                                                                        |
| `ALLOWED_USERS`                            | Comma-separated GitHub usernames (empty = list unused; see note below)                                                            |
| `ALLOWED_EMAIL_DOMAINS`                    | Comma-separated email domains (empty = list unused; see note below)                                                               |
| `ALLOWED_EMAILS`                           | Comma-separated exact email addresses (for individual users on shared domains)                                                    |
| `ALLOWED_GITHUB_ORGS`                      | Comma-separated GitHub orgs whose active members can sign in                                                                      |
| `UNSAFE_ALLOW_ALL_USERS`                   | `true` to allow any authenticated user when every allowlist is empty (defaults to `false`)                                        |
| `ENABLE_SERVICE_BINDINGS`                  | Optional deploy flag; `false` only for the first deploy (defaults to `true`)                                                      |
| `CLOUDFLARE_STAGING_ENABLED`               | Repository variable; `true` enables the pull-request staging deploy (`deploy-staging.yml`)                                        |
| `ENABLE_GITHUB_BOT`                        | `true` to deploy GitHub bot worker (or empty to skip)                                                                             |
| `GH_WEBHOOK_SECRET`                        | GitHub webhook secret (required if GitHub bot enabled)                                                                            |
| `GH_BOT_USERNAME`                          | GitHub App bot username, e.g., `my-app[bot]` (required if GitHub bot enabled)                                                     |
| `APP_NAME`                                 | Optional display name for whitelabeling (default: `Open-Inspect`)                                                                 |
| `APP_ICON_URL`                             | Optional URL to a custom logo/favicon (default: built-in icon)                                                                    |

For sessions with source `automation`, `github-bot`, or `agent` (including nested agent children),
the effective idle timeout is
`min(SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS, SANDBOX_INACTIVITY_TIMEOUT_MS)`. Set the unattended
value at or above the regular timeout to disable the shorter timeout. Terraform and the control
plane reject unattended values below `60000` ms. User (`user`), Slack (`slack-bot`), and Linear
(`linear-bot`) sessions keep the regular 10-minute default. For local deploys, set the same names in
`deploy.env`.

A connected session-page WebSocket keeps the existing idle-timer extensions and warnings, including
for unattended sessions. Direct terminal, VS Code, or VNC connections alone do not extend the timer.
Runtime heartbeats renew activity while a prompt is processing, so quiet running turns are not
treated as idle. A follow-up prompt after an inactivity stop resumes the existing session and
restores or resumes its sandbox rather than creating a new session.

An empty allowlist only means that list is not used; it does not admit everyone. The deploy fails
unless at least one of `ALLOWED_USERS`, `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`, or
`ALLOWED_GITHUB_ORGS` is set, or `UNSAFE_ALLOW_ALL_USERS` is `true`. Each enabled sign-in provider
also needs a compatible allowlist; see [Choose Sign-In Providers](#choose-sign-in-providers).

`CLASSIFICATION_MODEL` is an optional Actions **variable**, not a secret — add it under Settings →
Secrets and variables → Actions → _Variables_ to point the Slack/Linear classifiers at a different
model (for example `gpt-5.4-mini`). Leave it unset to keep the deploy default. An OpenAI value also
requires the `CLASSIFICATION_OPENAI_API_KEY` secret, and a Bedrock value
(`bedrock/<aws-region>/<inference-profile-id>`) requires the `CLASSIFICATION_BEDROCK_API_KEY`
secret; an Anthropic value is served by `CLASSIFICATION_ANTHROPIC_API_KEY`, falling back to
`ANTHROPIC_API_KEY`. To keep the classifier key out of Modal sandboxes, set
`CLASSIFICATION_ANTHROPIC_API_KEY` and leave `ANTHROPIC_API_KEY` unset; sandboxes then take model
credentials from Open-Inspect's secret store. The optional `CLASSIFICATION_REASONING_EFFORT`
variable sets the reasoning effort an OpenAI classifier requests (for example `low`); leave it unset
to use the model's default.

When enabling or upgrading the Linear bot, also enable **Client credentials tokens** on the OAuth
application in **Linear Settings → API → Applications**. This provider-side setting is not managed
by Terraform. Existing eligible single-workspace installations transition on their next request
without uninstalling or reinstalling the app.

**Bulk upload with `gh` CLI:**

For non-secret settings, create a `.variables` file:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
DEPLOYMENT_NAME=my-deployment
WEB_PLATFORM=cloudflare
ENABLE_SLACK_BOT=false
```

Upload it with `gh variable set -f .variables`. For credentials, create a `.secrets` file (don't
commit this!):

```
CLOUDFLARE_API_TOKEN=your-token
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
# ... add all secrets
```

Then upload all at once (run from your fork's directory, or use
`-R {your_github_username}/{background-agents}`):

```bash
gh secret set -f .secrets
```

If you bulk upload from a file, set multiline secrets like `GH_APP_PRIVATE_KEY` separately so the
PEM formatting is preserved:

```bash
gh secret set GH_APP_PRIVATE_KEY < private-key-pkcs8.pem
```

Once configured, the GitHub Actions workflows will:

- Run `terraform plan` on pull requests (with PR comment), using repository-level settings
- Run `terraform apply` in the `production` GitHub Environment when merged to main
  (`terraform-production.yml`). Do not add required reviewers to `production`: merging is the
  approval, and reviewers would hold every merge's Terraform and deploy jobs for manual approval
- Deploy the Workers with `deploy-production.yml` on pushes that change Worker, web, or shared
  packages, D1 migrations, or `scripts/cloudflare-deploy`. When Terraform will apply for the push,
  the deploy waits for that apply to finish.

Control-plane and shared sources are Terraform inputs only when `SANDBOX_PROVIDER` is `vercel` (they
hash the managed Vercel snapshot); for other providers a code-only push deploys immediately. The
deploy also checks that the sandbox artifact Terraform built exists before it binds the control
plane to it. See [terraform/README.md](../terraform/README.md#cicd-pipeline) for the ordering
limits.

After the first apply, copy the Terraform-generated secrets (`SERVICE_AUTH_SECRET_WEB`,
`SERVICE_AUTH_SECRET_SLACK_BOT`, `SERVICE_AUTH_SECRET_GITHUB_BOT`, `SERVICE_AUTH_SECRET_LINEAR_BOT`,
`IMAGE_CALLBACK_TOKEN_PEPPER`, `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`) into the `production` GitHub
Environment once:

```bash
node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment production
```

Existing deployments keep working without this step: Wrangler keeps secrets already on the Worker,
and the deploy only fails if a needed generated secret is neither supplied nor already bound.

**Staging (optional).** Set the repository variable `CLOUDFLARE_STAGING_ENABLED=true` and create a
`staging` GitHub Environment with required reviewers, its own `DEPLOYMENT_NAME` and its own Modal
environment (anything it leaves unset falls back to production's repository-level value). Each pull
request that changes deployable paths then applies `terraform/environments/staging` and deploys to
staging with `deploy-staging.yml`, after a reviewer approves the run; **Run workflow** on `main`
deploys `main` the same way, for the first bring-up. Pull requests from forks are included, so the
approval is the only gate: the fork's code runs with the staging secrets. Sync its generated secrets
once with `--environment staging`, unless you have already set all six in the `staging` Environment.
See [terraform/README.md](../terraform/README.md#staging).

Terraform generates and persists `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` when no override is configured.
Existing local Terraform installations retain an existing key through the
`provider_accounts_encryption_key` input; Actions deployments retain it through the
`PROVIDER_ACCOUNTS_ENCRYPTION_KEY` repository or production-environment secret. Changing the key
makes stored provider credentials unreadable. Preserve backups of the remote Terraform state because
it is the recovery source for automatically generated keys.

---

## Customizing the App Name and Icon (Optional)

Open-Inspect can be whitelabeled by overriding the brand name and logo. Both values are optional and
default to the built-in `Open-Inspect` brand.

Add these to your `terraform.tfvars`:

```hcl
# Display name shown in:
#   - Web tab title, sign-in page, landing hero
#   - Slack App Home settings page
#   - Linear OAuth success page and completion comments
#   - PR body footer ("Created with [<app_name>](<session-url>)")
#   - Outbound HTTP User-Agent headers (GitHub, GitLab API)
app_name = "Acme Bot"

# Optional URL to a custom logo image (SVG/PNG). When set, replaces the icon in
# the command menu and favicon. Leave empty to keep the built-in favicon.
# Use an absolute URL or a root-relative path served from packages/web/public/.
app_icon_url = "/branding/acme-logo.svg"   # or "https://cdn.example.com/logo.svg"
```

Set `APP_NAME` and `APP_ICON_URL` to the same values in `deploy.env`. After changing any of these
values, run `terraform apply` and the Cloudflare deploy, and (for Vercel) redeploy the web app so
the new build picks up the `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_APP_ICON_URL` env vars (the
Cloudflare deploy rebuilds the Cloudflare web Worker).

> **Note**: `NEXT_PUBLIC_*` vars are inlined into the client bundle at build time, so changes
> require a fresh web build. The bot/control-plane workers read `APP_NAME` at request time, so they
> pick up the new value immediately after the Cloudflare deploy.

---

## Updating Your Deployment

To update after pulling changes from upstream:

Terraform generates the provider-account credential key for installations without an existing
override. For local applies, keep any existing `provider_accounts_encryption_key` input unchanged.
For Actions deployments, keep any existing `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` repository or
production-environment secret unchanged so stored provider credentials remain readable.

```bash
# Pull latest changes
git pull upstream main

# Rebuild shared package if it changed
npm run build -w @open-inspect/shared

# Re-run Terraform (it only changes what's needed), then redeploy the Workers
terraform -chdir=terraform/environments/production apply
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token \
  node --env-file=deploy.env scripts/cloudflare-deploy/deploy.mjs
```

The deploy reads the token from the environment, not from `deploy.env` or `terraform.tfvars`.

Upgrading from a release where Terraform deployed the Workers? See
[Upgrading from a single Terraform apply](../terraform/README.md#upgrading-from-a-single-terraform-apply).
Variables that moved to the deploy only produce "undeclared variable" warnings in an old
`terraform.tfvars`; move their values into `deploy.env`.

### Configure Provider Accounts

Open **Settings > Provider Accounts** to add and verify accounts. Setting a provider default changes
only sessions created afterward; existing sessions remain pinned to legacy scoped OAuth, a specific
account, or API-key mode. Legacy credentials may coexist during rollout, and the settings page lists
their locations. Remove them only after dependent legacy-bound sessions are no longer needed.
Rebuild all sandbox runtime images, templates, and provider snapshots so new sessions use the
generic broker.

---

## Troubleshooting

### "Backend initialization required"

Re-run init with backend config:

```bash
terraform init -backend-config=backend.tfvars
```

### GitHub App authentication fails

1. Verify the private key is in PKCS#8 format (starts with `-----BEGIN PRIVATE KEY-----`)
2. Check the Installation ID matches your installation
3. Ensure the app has required permissions on the repository
4. Verify the callback URL matches your deployed web app URL exactly

### GitHub OAuth "redirect_uri is not associated with this application"

The callback URL in your GitHub App settings doesn't match your deployed URL. Update the callback
URL to match your web app URL:

- **Vercel**: `https://open-inspect-{deployment_name}.vercel.app/api/auth/callback/github`
- **Cloudflare**:
  `https://open-inspect-web-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/api/auth/callback/github`
- **Cloudflare with a custom domain**: `https://{your-custom-domain}/api/auth/callback/github`

### GitHub sign-in returns to the login page with an email permission error

GitHub refused the `/user/emails` request, and the control plane logs
`auth.github_email_lookup_failed` with `status: 403`. Every GitHub sign-in reads verified emails, so
the GitHub App needs the **Account permissions > Email addresses: Read-only** permission even when
admission uses only `ALLOWED_USERS` or `ALLOWED_GITHUB_ORGS`. Add the permission, save, and sign in
again; GitHub asks the user to approve the added permission.

### Modal deployment fails

```bash
# Check Modal CLI is working (from packages/modal-infra)
cd packages/modal-infra
uv run modal token show

# View Modal logs
uv run modal app logs open-inspect
```

### Modal deployment fails with "No module named 'sandbox_runtime'"

The `sandbox_runtime` package is a sibling package that must be installed before deploying. From the
repository root:

```bash
cd packages/modal-infra && uv sync --frozen && cd -
```

This installs all Modal deployment dependencies including `sandbox_runtime` (resolved via
`[tool.uv.sources]` in `pyproject.toml`).

### Worker deployment fails

The Cloudflare deploy builds the Workers itself unless you pass `--skip-build`; with that flag,
build them first (`npm run build -w @open-inspect/shared`, then the Worker packages). Run the deploy
with `--dry-run` to check its configuration without changing anything. If it reports a missing
generated secret, supply it from
`terraform -chdir=terraform/environments/production output -json generated_worker_secrets` or run
`scripts/cloudflare-deploy/sync-generated-secrets.mjs`.

### Slack bot not responding

1. Verify Event Subscriptions URL is verified (green checkmark)
2. Ensure the bot is invited to the channel (`/invite @BotName`)
3. Check that you're @mentioning the bot in your message
4. If you updated bot token scopes, reinstall the app to your workspace

### Slack bot ignores thread context

If the bot doesn't see the original message when tagged in a thread reply:

1. Verify the bot has `channels:history` scope (for public channels) and `groups:history` (for
   private channels). These are required by the `conversations.replies` API to fetch thread
   messages.
2. Verify the bot has `channels:read` and `groups:read` scopes. These are required by
   `conversations.info` to fetch channel name and description for context, and by
   `conversations.list` to populate the automation channel picker. If the picker shows no channels,
   check these scopes and that the bot is invited to the target channel.
3. If you added missing scopes, **reinstall the app** to your workspace for the new permissions to
   take effect.

### Slack image attachment does not reach the agent

1. Verify the bot has the `files:read` scope and reinstall the app after adding it. The
   `files:write` scope is for generated media posted back to Slack, not images sent to the agent.
2. Use PNG, JPEG, WebP, or GIF images no larger than 10 MiB. Open-Inspect forwards at most six
   images per message.
3. In a channel, `@mention` the bot with the image. DMs do not require a mention. Watched-channel
   automations do not forward file attachments.
4. For channel mentions and replies, verify `channels:history` for public channels or
   `groups:history` for private channels. Slack may omit files from the mention event, so the bot
   uses conversation history to retrieve them.
5. Check the Slack thread for a warning about images that were too large or could not be downloaded
   or uploaded. Other images and any text are still sent when possible.

### Slack completion does not attach generated media

1. Verify the bot has the `files:write` scope and reinstall the app after adding it.
2. Confirm the agent registered the image or video as a session artifact; repository files are not
   uploaded automatically.
3. Check that the file is PNG, JPEG, WebP, or MP4 and no larger than 10 MiB. A completion attaches
   at most five files and 25 MiB total; other media remains available through **View Session**.
4. Check Slack workspace policies for disabled uploads, prohibited file types, or exhausted storage.

### GitHub bot not responding to webhooks

1. Verify the webhook URL matches
   `https://open-inspect-github-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhooks/github`
2. Check the webhook secret matches `GH_WEBHOOK_SECRET` in `deploy.env`
3. Confirm `enable_github_bot = true` in terraform.tfvars, `ENABLE_GITHUB_BOT=true` in `deploy.env`,
   and the worker is deployed
4. Check that `GH_BOT_USERNAME` matches your App's bot login (e.g., `my-app[bot]`)
5. For PR reviews, ensure auto-review is enabled for the repository and the PR is not a draft
6. For comment actions, ensure the bot is @mentioned in a **PR** comment (not an issue)

### "Model not found" errors

If sessions fail with "Model not found", the API key for the selected model is missing. Deployments
that set no fleet-wide key in Terraform supply model credentials as secrets instead:

1. Go to **Settings > Secrets** in the web app
2. Select **All Repositories (Global)** from the scope dropdown
3. Add the key for your chosen provider (e.g., `ANTHROPIC_API_KEY` for Claude models or
   `DEEPSEEK_API_KEY` for DeepSeek models, `KIMI_API_KEY` for Kimi Coding Plan models,
   `ZHIPU_API_KEY` for Z.AI Coding Plan models, or `OPENCODE_API_KEY` for OpenCode Zen and OpenCode
   Go models)
4. Click **Save**

See [Secrets Management](SECRETS.md) for more on global and repository secrets.

### Vercel provider error when using `web_platform = "cloudflare"`

The Vercel Terraform provider validates its API token on initialization, even when no Vercel
resources are created. If you set `vercel_api_token = ""` in your `terraform.tfvars`, the provider
will reject it. **Fix**: Remove the `vercel_api_token` and `vercel_team_id` lines from your
`terraform.tfvars` entirely — the built-in defaults (`"unused"`) satisfy the provider's non-empty
validation. This is a known Terraform limitation (providers validate credentials on init regardless
of whether any resources use them).

### Durable Objects / Service Binding errors

Durable Object migrations are applied by the deploy automatically. Service binding errors occur on a
first deploy, because the bots and control plane bind each other:

1. Deploy with `ENABLE_SERVICE_BINDINGS=false`
2. After success, set it to `true` and run the deploy again

---

## Security Notes

- **Never commit** `terraform.tfvars`, `backend.tfvars`, or `deploy.env` to source control
- The `.gitignore` excludes `.env` files and the Terraform state; check that your `deploy.env` and
  tfvars files are not tracked

- Use GitHub Secrets for CI/CD, not hardcoded values
- Rotate credentials periodically (API tokens, bot tokens, webhook secrets) by updating `deploy.env`
  (or the GitHub secrets) and rerunning the deploy. Do not do this for `TOKEN_ENCRYPTION_KEY`,
  `REPO_SECRETS_ENCRYPTION_KEY` or `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`: replacing one makes the data
  already encrypted with it unreadable. Changing an encryption key needs the stored data
  re-encrypted first; keep the old key until that is done.
- Review the [Security Model](../README.md#security-model-single-tenant-only) - this system is
  designed for single-tenant deployment

---

## Architecture Reference

For details on the infrastructure components, see:

- [terraform/README.md](../terraform/README.md) - Terraform module documentation
- [README.md](../README.md) - System architecture overview
- [AVAILABLE_MODELS.md](AVAILABLE_MODELS.md) - Supported model list and reasoning efforts
- [OPENAI_MODELS.md](OPENAI_MODELS.md) - Configuring OpenAI Codex models
- [GROK_MODELS.md](GROK_MODELS.md) - Configuring Grok with a SuperGrok subscription
