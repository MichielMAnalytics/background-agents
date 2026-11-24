# Provider-account credentials are encrypted with a key that must never change.
# Terraform generates and persists one unless the operator supplies their own,
# and hands the effective value to the deploy through generated_worker_secrets.

mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    }
  }
}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token             = "test-cloudflare-token"
  cloudflare_account_id            = "test-account"
  cloudflare_worker_subdomain      = "test-account"
  deployment_name                  = "provider-key-test"
  provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false
}

run "operator_provided_provider_account_key" {
  command = plan

  assert {
    condition     = nonsensitive(local.effective_provider_accounts_encryption_key) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    error_message = "An operator-provided provider account key must remain unchanged."
  }

  assert {
    condition     = nonsensitive(output.generated_worker_secrets.PROVIDER_ACCOUNTS_ENCRYPTION_KEY) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    error_message = "The deploy must receive the effective provider account key."
  }
}

run "terraform_generated_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = ""
  }

  override_resource {
    target          = random_bytes.provider_accounts_encryption_key
    override_during = plan
    values = {
      base64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    }
  }

  assert {
    condition = (
      nonsensitive(local.effective_provider_accounts_encryption_key) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" &&
      length(base64decode(nonsensitive(local.effective_provider_accounts_encryption_key))) == 32
    )
    error_message = "Terraform must generate a Base64-encoded 32-byte provider account key."
  }
}

run "generated_worker_secrets_names" {
  command = plan

  assert {
    condition = toset(keys(nonsensitive(output.generated_worker_secrets))) == toset([
      "SERVICE_AUTH_SECRET_WEB",
      "SERVICE_AUTH_SECRET_SLACK_BOT",
      "SERVICE_AUTH_SECRET_GITHUB_BOT",
      "SERVICE_AUTH_SECRET_LINEAR_BOT",
      "IMAGE_CALLBACK_TOKEN_PEPPER",
      "PROVIDER_ACCOUNTS_ENCRYPTION_KEY",
    ])
    error_message = "generated_worker_secrets must use the GitHub Environment names scripts/cloudflare-deploy reads."
  }
}

run "reject_malformed_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "not-base64"
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "reject_31_byte_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZQ=="
  }

  expect_failures = [var.provider_accounts_encryption_key]
}
