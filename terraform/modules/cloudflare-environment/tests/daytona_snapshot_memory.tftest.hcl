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
  deployment_name             = "daytona-snapshot-memory-test"

  sandbox_provider      = "daytona"
  daytona_api_url       = "https://daytona.example/api"
  daytona_api_key       = "test-daytona-key"
  daytona_base_snapshot = "openinspect-base"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

}

run "default_memory_is_part_of_the_snapshot_identity" {
  command = plan

  assert {
    condition     = module.daytona_infra[0].snapshot_name == "openinspect-base-m2-test-source-hash"
    error_message = "The default Daytona snapshot identity must include its 2 GiB allocation."
  }
}

run "configured_memory_changes_the_snapshot_identity" {
  command = plan

  variables {
    daytona_base_snapshot_memory_gib = 4
  }

  assert {
    condition     = module.daytona_infra[0].snapshot_name == "openinspect-base-m4-test-source-hash"
    error_message = "Changing Daytona snapshot memory must select a new snapshot identity."
  }
}

run "rejects_non_positive_snapshot_memory" {
  command = plan

  variables {
    daytona_base_snapshot_memory_gib = 0
  }

  expect_failures = [var.daytona_base_snapshot_memory_gib]
}

run "rejects_fractional_snapshot_memory" {
  command = plan

  variables {
    daytona_base_snapshot_memory_gib = 1.5
  }

  expect_failures = [var.daytona_base_snapshot_memory_gib]
}
