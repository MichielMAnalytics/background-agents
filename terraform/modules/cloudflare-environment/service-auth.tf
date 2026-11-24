# Per-service sig1 signing secrets.
#
# One secret per first-party service, generated in Terraform state — no
# operator-supplied variables. The Cloudflare deploy binds the control plane's
# four verification keys as SERVICE_AUTH_SECRET_<SERVICE> and each sender's
# own as SERVICE_AUTH_SECRET (a sender signs as itself, so naming its own
# service in its env var adds nothing). The deploy reads them from the GitHub
# Environment; see the generated_worker_secrets output.

resource "random_password" "service_auth_secret_web" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_slack_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_github_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_linear_bot" {
  length  = 64
  special = false
}

# Dedicated pepper for image-build callback token hashes.
resource "random_password" "image_callback_token_pepper" {
  length  = 64
  special = false
}

# Dedicated encryption key for provider-account credentials. Operators may
# supply an existing key during upgrades; new installations use this generated
# value, which remains stable in Terraform state.
resource "random_bytes" "provider_accounts_encryption_key" {
  length = 32
}

locals {
  effective_provider_accounts_encryption_key = trimspace(var.provider_accounts_encryption_key) != "" ? trimspace(var.provider_accounts_encryption_key) : random_bytes.provider_accounts_encryption_key.base64
}
