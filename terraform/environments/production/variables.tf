# =============================================================================
# Provider Authentication
# =============================================================================

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers, KV, R2, and D1 permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_worker_subdomain" {
  description = "Cloudflare Workers account subdomain (e.g. 'myaccount' — .workers.dev is appended automatically)"
  type        = string
}

variable "vercel_api_token" {
  description = "Vercel API token (required only when web_platform = 'vercel'). Do NOT set to empty string — the Vercel provider validates this on init even when no Vercel resources are created. Leave unset to use the built-in dummy token for Cloudflare-only deployments."
  type        = string
  sensitive   = true
  default     = "000000000000000000000000"
}

variable "vercel_team_id" {
  description = "Vercel team ID (required only when web_platform = 'vercel'). Leave unset when using Cloudflare."
  type        = string
  default     = "unused"
}

variable "modal_token_id" {
  description = "Modal API token ID"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = !contains(["modal", "modal-vm"], var.sandbox_provider) || length(var.modal_token_id) > 0
    error_message = "modal_token_id must be set when sandbox_provider is 'modal' or 'modal-vm'."
  }
}

variable "modal_token_secret" {
  description = "Modal API token secret"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = !contains(["modal", "modal-vm"], var.sandbox_provider) || length(var.modal_token_secret) > 0
    error_message = "modal_token_secret must be set when sandbox_provider is 'modal' or 'modal-vm'."
  }
}

variable "modal_workspace" {
  description = "Modal workspace name"
  type        = string
  default     = ""

  validation {
    condition     = !contains(["modal", "modal-vm"], var.sandbox_provider) || length(var.modal_workspace) > 0
    error_message = "modal_workspace must be set when sandbox_provider is 'modal' or 'modal-vm'."
  }
}

variable "modal_environment" {
  description = "Modal environment name used by the Modal CLI"
  type        = string
  default     = "main"

  validation {
    condition     = !contains(["modal", "modal-vm"], var.sandbox_provider) || (length(trimspace(var.modal_environment)) > 0 && can(regex("^[^:/\\\\]+$", var.modal_environment)))
    error_message = "modal_environment must be set and must not contain colons, slashes, or backslashes when sandbox_provider is 'modal' or 'modal-vm'."
  }
}

variable "modal_environment_web_suffix" {
  description = "Modal environment web suffix used in endpoint URLs. Use lowercase letters, digits, and dashes, or leave empty for the environment with no web suffix."
  type        = string
  default     = ""

  validation {
    condition     = !contains(["modal", "modal-vm"], var.sandbox_provider) || can(regex("^$|^[a-z0-9-]+$", var.modal_environment_web_suffix))
    error_message = "modal_environment_web_suffix must be empty or contain only lowercase letters, digits, and dashes when sandbox_provider is 'modal' or 'modal-vm'."
  }
}

# =============================================================================
# Bots
# =============================================================================
# Each enabled bot gets a Worker script, a KV namespace and its queues. Its
# credentials and settings are Worker configuration, which the Cloudflare
# deploy validates and uploads (scripts/cloudflare-deploy).

variable "enable_github_bot" {
  description = "Provision the GitHub bot Worker script, KV namespace and autofix queues. Must match ENABLE_GITHUB_BOT for the Cloudflare deploy."
  type        = bool
  default     = false
}

variable "enable_slack_bot" {
  description = "Provision the Slack bot Worker script, KV namespace and completion queues. Must match ENABLE_SLACK_BOT for the Cloudflare deploy."
  type        = bool
  default     = true
}

variable "enable_linear_bot" {
  description = "Provision the Linear bot Worker script and KV namespace. Must match ENABLE_LINEAR_BOT for the Cloudflare deploy."
  type        = bool
  default     = false
}

# =============================================================================
# API Keys
# =============================================================================

variable "anthropic_api_key" {
  description = "Deployment-wide Anthropic API key injected into Modal session sandboxes. Daytona, E2B and Vercel read model keys only from the scoped secret store, as do Modal image builds. The Cloudflare deploy also binds it to the Slack and Linear bot classifiers when CLASSIFICATION_ANTHROPIC_API_KEY is blank. Optional: leave blank to supply model credentials as scoped secrets, which override this value on every provider."
  type        = string
  sensitive   = true
  default     = ""
  nullable    = false
}

# =============================================================================
# Security Secrets
# =============================================================================

variable "provider_accounts_encryption_key" {
  description = "Optional existing key for provider account credentials; when blank, Terraform generates and persists a dedicated key. Exposed through the generated_worker_secrets output for the Cloudflare deploy."
  type        = string
  sensitive   = true
  nullable    = false
  default     = ""

  validation {
    condition = (
      trimspace(var.provider_accounts_encryption_key) == "" ||
      can(regex("^[A-Za-z0-9+/]{43}=$", trimspace(var.provider_accounts_encryption_key)))
    )
    error_message = "provider_accounts_encryption_key must be blank or a Base64-encoded 32-byte key."
  }
}

variable "modal_api_secret" {
  description = "Shared secret for authenticating control plane to Modal API calls (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = !contains(["modal", "modal-vm"], var.sandbox_provider) || length(var.modal_api_secret) > 0
    error_message = "modal_api_secret must be set when sandbox_provider is 'modal' or 'modal-vm'."
  }
}

variable "daytona_api_url" {
  description = "Base URL for the Daytona REST API (e.g. https://app.daytona.io/api)"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "daytona" || length(var.daytona_api_url) > 0
    error_message = "daytona_api_url must be set when sandbox_provider = 'daytona'."
  }

  # Daytona credentials outlive the backend that used them: the control plane
  # keeps reclaiming sandboxes and snapshots after a provider switch, and it
  # refuses to build a Daytona client unless both the URL and the key are set.
  validation {
    condition     = trimspace(var.daytona_api_key) == "" || length(trimspace(var.daytona_api_url)) > 0
    error_message = "daytona_api_url must be set whenever daytona_api_key is set, so the control plane can still reclaim existing Daytona sandboxes after switching sandbox_provider."
  }
}

variable "daytona_api_key" {
  description = "API key for Daytona REST API (Bearer auth)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "daytona" || length(var.daytona_api_key) > 0
    error_message = "daytona_api_key must be set when sandbox_provider = 'daytona'."
  }
}

variable "daytona_base_snapshot" {
  description = "Name prefix for the Terraform-managed Daytona base snapshot"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "daytona" || length(var.daytona_base_snapshot) > 0
    error_message = "daytona_base_snapshot must be set when sandbox_provider = 'daytona'."
  }
}

variable "daytona_base_snapshot_memory_gib" {
  description = "Memory in GiB reserved by sandboxes created from the Daytona base snapshot"
  type        = number
  default     = 2

  validation {
    condition     = var.daytona_base_snapshot_memory_gib >= 1 && var.daytona_base_snapshot_memory_gib == floor(var.daytona_base_snapshot_memory_gib)
    error_message = "daytona_base_snapshot_memory_gib must be a positive integer."
  }
}

variable "daytona_target" {
  description = "Optional Daytona target name"
  type        = string
  default     = ""
}

variable "vercel_sandbox_token" {
  description = "Vercel API token for the Vercel Sandbox API"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "vercel" || length(var.vercel_sandbox_token) > 0
    error_message = "vercel_sandbox_token must be set when sandbox_provider = 'vercel'."
  }
}

variable "vercel_sandbox_project_id" {
  description = "Vercel project ID used to scope Sandbox API calls"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "vercel" || length(var.vercel_sandbox_project_id) > 0
    error_message = "vercel_sandbox_project_id must be set when sandbox_provider = 'vercel'."
  }
}

variable "vercel_sandbox_team_id" {
  description = "Optional Vercel team ID used to scope Sandbox API calls"
  type        = string
  default     = ""
}

variable "vercel_sandbox_api_base_url" {
  description = "Optional Vercel Sandbox API base URL override"
  type        = string
  default     = ""
}

variable "vercel_base_snapshot_id" {
  description = "Optional manual Vercel Sandbox snapshot ID containing the Open-Inspect base runtime. When set, Terraform skips managed Vercel base snapshot builds."
  type        = string
  default     = ""
}

variable "vercel_sandbox_runtime" {
  description = "Vercel Sandbox runtime identifier"
  type        = string
  default     = "node24"
}

# -----------------------------------------------------------------------------
# E2B (only required when sandbox_provider = "e2b")
# -----------------------------------------------------------------------------

variable "e2b_api_key" {
  description = "E2B REST API key — runtime (control-plane → E2B API + code-server HMAC)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "e2b" || length(var.e2b_api_key) > 0
    error_message = "e2b_api_key must be set when sandbox_provider = 'e2b'."
  }
}

variable "e2b_api_url" {
  description = "E2B REST API base URL"
  type        = string
  default     = "https://api.e2b.app"
}

variable "e2b_template_id" {
  description = "E2B template name built by the e2b-infra module and used for fresh sandboxes"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "e2b" || length(var.e2b_template_id) > 0
    error_message = "e2b_template_id must be set when sandbox_provider = 'e2b'."
  }
}

variable "e2b_template_cpu" {
  description = "vCPU count for the E2B sandbox template (and every sandbox created from it)."
  type        = number
  default     = 2
}

variable "e2b_template_memory_mb" {
  description = "Memory (MB, even number) for the E2B sandbox template. Default sized for the agent toolchain (OpenCode + code-server + builds); lower it on plans that cap sandbox memory. The full invariant (positive, even, integral) is validated at the e2b-infra module boundary."
  type        = number
  default     = 4096
}

# -----------------------------------------------------------------------------
# Boat (only required when sandbox_provider = "boat")
# -----------------------------------------------------------------------------

variable "boat_api_key" {
  description = "Boat REST API key — runtime (control-plane → Boat API + sandbox access password HMAC) and snapshot build"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "boat" || length(var.boat_api_key) > 0
    error_message = "boat_api_key must be set when sandbox_provider = 'boat'."
  }
}

variable "boat_api_url" {
  description = "Boat REST API base URL"
  type        = string
  default     = "https://boat.dev/api/v1"
}

variable "boat_base_snapshot" {
  description = "Prefix of the Boat base snapshots built by Terraform. Older bases under this prefix are pruned by the Cloudflare deploy after it deploys the control plane (BOAT_BASE_SNAPSHOT must match), keeping the deployed base and the actually replaced base confirmed by Cloudflare deployment history. Use a unique prefix per deployment sharing a Boat account or organization wallet."
  type        = string
  default     = ""

  validation {
    condition = var.sandbox_provider != "boat" || (
      can(regex("^[a-z0-9][a-z0-9-]{0,45}$", var.boat_base_snapshot)) &&
      var.boat_base_snapshot != "oi-img" &&
      !startswith(var.boat_base_snapshot, "oi-img-")
    )
    error_message = "boat_base_snapshot must be 1-46 lowercase letters, digits or dashes, starting with a letter or digit, when sandbox_provider = 'boat'. It must not be 'oi-img' or start with 'oi-img-', which is reserved for control-plane prebuilt snapshots."
  }
}

variable "boat_org" {
  description = "Optional Boat organization sandboxes and the saved snapshot are billed to; empty uses the account's active wallet"
  type        = string
  default     = ""
}

# =============================================================================
# Configuration
# =============================================================================

variable "sandbox_provider" {
  description = "Sandbox backend for session execution: 'modal', 'modal-vm', 'daytona', 'vercel', 'e2b', or 'boat'"
  type        = string
  default     = "modal"

  validation {
    condition     = contains(["modal", "modal-vm", "daytona", "vercel", "e2b", "boat"], var.sandbox_provider)
    error_message = "sandbox_provider must be 'modal', 'modal-vm', 'daytona', 'vercel', 'e2b', or 'boat'."
  }
}

variable "web_platform" {
  description = "Platform for the web app deployment: 'vercel' or 'cloudflare' (OpenNext)"
  type        = string
  default     = "vercel"

  validation {
    condition     = contains(["vercel", "cloudflare"], var.web_platform)
    error_message = "web_platform must be 'vercel' or 'cloudflare'."
  }
}

variable "web_serverless_region" {
  description = "Vercel function region for the web project only; requires a web redeploy after apply. Unused when web_platform is cloudflare."
  type        = string
  default     = "iad1"

  validation {
    condition     = can(regex("^[a-z]{3}[0-9]$", var.web_serverless_region))
    error_message = "web_serverless_region must be a Vercel region ID: three lowercase letters followed by one digit."
  }
}

variable "deployment_name" {
  description = "Unique deployment name used in URLs and resource names. Use something unique like your GitHub username or company name (e.g., 'acme', 'johndoe'). This will create URLs like: open-inspect-{deployment_name}.vercel.app"
  type        = string
}

variable "app_name" {
  description = "Display name shown in the web UI tab title, sign-in page, bot messages (Slack, Linear), PR body footer, and outbound HTTP User-Agent headers."
  type        = string
  default     = "Open-Inspect"
}

variable "app_icon_url" {
  description = "Optional URL (absolute or root-relative) to a custom logo image for the command menu and browser favicon. Leave empty to use the built-in favicon and default in-app icon."
  type        = string
  default     = ""
}

variable "project_root" {
  description = "Root path to the project repository"
  type        = string
  default     = "../../../"
}

# =============================================================================
# R2 Storage
# =============================================================================

variable "r2_media_location" {
  description = "Cloudflare R2 location hint for the media bucket (e.g. ENAM, WNAM, APAC, WEUR, EEUR)"
  type        = string
  default     = "ENAM"
}

variable "r2_media_bucket_name" {
  description = "Name of the R2 media bucket Terraform creates and manages. Leave empty to use the default 'open-inspect-media-<deployment_name>'. Changing a managed bucket's name plans replacement, not an in-place rename. Cloudflare rejects deletion while objects remain; Terraform does not empty the bucket. An existing bucket must be imported into module.environment.cloudflare_r2_bucket.media before applying. If that address already tracks another bucket, follow the migration steps in terraform.tfvars.example to migrate objects and replace the state entry first."
  type        = string
  default     = ""
}

# =============================================================================
# Documentation Site
# =============================================================================

variable "docs_site_enabled" {
  description = "Provision the public documentation site's Vercel project (packages/docs). Requires vercel_api_token and vercel_team_id. Deployment stays manual: the project has no git integration, so only the Deploy Docs workflow publishes it."
  type        = bool
  default     = false
}

variable "docs_custom_domain" {
  description = "Production hostname for the documentation site, e.g. 'docs.example.com'. Leave unset to serve the project's vercel.app URL only. Requires docs_site_enabled = true."
  type        = string
  default     = null
}
