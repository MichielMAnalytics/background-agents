# The deployment-wide Anthropic key is optional. A deployment whose sandboxes get
# their model credentials from the per-repository secret store configures no key
# at all, so nothing outside the classifier bots may demand one.

mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  deployment_name             = "optional-anthropic-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false


  # The condition under test: no deployment-wide Anthropic key.
  anthropic_api_key = ""
}

# The whole point of the change: a deployment that configures no Anthropic key
# must plan.
run "a_deployment_with_no_anthropic_key_plans" {
  command = plan

  # The key stays present with an empty value: --force then reconciles a
  # previously configured credential away instead of leaving it behind.
  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "" }
    error_message = "An unset Anthropic key must be injected as an empty value, not a credential."
  }
}

run "a_configured_key_is_injected_into_modal" {
  command = plan

  variables {
    anthropic_api_key = "test-anthropic-key"
  }

  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "test-anthropic-key" }
    error_message = "A configured Anthropic key must be injected as a deployment-wide LLM key."
  }
}

# Whitespace is not a credential.
run "a_blank_key_is_not_treated_as_configured" {
  command = plan

  variables {
    anthropic_api_key = "   "
  }

  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "" }
    error_message = "A whitespace-only Anthropic key must normalize to empty, not reach a sandbox."
  }
}

# The classifier bots' key requirement is Worker configuration, validated by
# scripts/cloudflare-deploy/config.mjs (see config.test.mjs).
