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
  anthropic_api_key           = "test-anthropic-key"
  deployment_name             = "colocation-test"

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  web_platform      = "vercel"
  docs_site_enabled = true
  vercel_team_id    = "test-team"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

}

run "defaults_preserve_placement" {
  command = plan

  assert {
    condition     = module.web_app[0].serverless_region == "iad1"
    error_message = "The web project must keep its default function region."
  }

}

run "web_region_override_leaves_docs_unchanged" {
  command = plan

  variables {
    web_serverless_region = "fra1"
  }

  assert {
    condition     = module.web_app[0].serverless_region == "fra1"
    error_message = "The configured region must reach the web project."
  }

  assert {
    condition     = module.docs_site[0].serverless_region == "iad1"
    error_message = "The web region override must not affect the docs project."
  }

}



run "rejects_invalid_web_region" {
  command = plan

  variables {
    web_serverless_region = "invalid"
  }

  expect_failures = [var.web_serverless_region]
}

