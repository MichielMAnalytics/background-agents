# Daytona credentials outlive the backend that used them, so a key without a
# URL fails at plan time even after switching sandbox_provider. (The deploy
# keeps binding retained credentials to the control plane.)

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
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  deployment_name             = "daytona-credentials-test"

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

run "retained_daytona_credentials_build_nothing_after_a_provider_switch" {
  command = plan

  variables {
    daytona_api_key = "retained-key"
    daytona_api_url = "https://app.daytona.io/api"
  }

  assert {
    condition     = length(module.daytona_infra) == 0
    error_message = "A non-Daytona backend must not build a Daytona snapshot."
  }
}

run "rejects_a_retained_daytona_key_without_a_url" {
  command = plan

  variables {
    daytona_api_key = "retained-key"
  }

  expect_failures = [var.daytona_api_url]
}
