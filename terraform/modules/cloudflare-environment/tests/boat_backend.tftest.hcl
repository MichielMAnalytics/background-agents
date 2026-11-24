# The Boat backend builds a saved snapshot named from the source hash, and a
# deployment on another backend builds nothing Boat. Binding the control plane
# to the snapshot and pruning older bases is the Cloudflare deploy's job
# (scripts/cloudflare-deploy), which derives the same name.

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
  anthropic_api_key           = "test-anthropic-key"
  deployment_name             = "boat-backend-test"

  sandbox_provider   = "boat"
  boat_api_key       = "boat_test_key"
  boat_base_snapshot = "open-inspect"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false
}

run "boat_builds_a_saved_snapshot" {
  command = plan

  assert {
    condition     = local.use_boat_backend && length(module.boat_infra) == 1 && length(data.external.boat_source_hash) == 1
    error_message = "The Boat backend must hash its build inputs and build the saved snapshot."
  }

  assert {
    condition     = module.boat_infra[0].snapshot_name == "open-inspect-0123456789abcdef"
    error_message = "The saved snapshot must be the prefix plus the first 16 characters of the source hash."
  }

  assert {
    condition     = output.boat_base_snapshot == "open-inspect-0123456789abcdef"
    error_message = "The snapshot name must be reported for the deploy and operators."
  }

  assert {
    condition     = length(module.e2b_infra) == 0 && length(module.daytona_infra) == 0 && length(module.modal_app) == 0
    error_message = "Boat must not provision other backends."
  }
}

run "rejects_an_invalid_snapshot_prefix" {
  command = plan

  variables {
    boat_base_snapshot = "Open_Inspect"
  }

  expect_failures = [var.boat_base_snapshot]
}

run "rejects_the_control_plane_prebuilt_snapshot_prefix" {
  command = plan

  variables {
    boat_base_snapshot = "oi-img-base"
  }

  expect_failures = [var.boat_base_snapshot]
}

run "rejects_the_control_plane_prebuilt_snapshot_namespace_root" {
  command = plan

  variables {
    boat_base_snapshot = "oi-img"
  }

  expect_failures = [var.boat_base_snapshot]
}

run "other_backends_build_nothing_boat" {
  command = plan

  variables {
    sandbox_provider   = "modal"
    modal_token_id     = "test-token"
    modal_token_secret = "test-secret"
    modal_workspace    = "test-workspace"
    modal_api_secret   = "test-api-secret"
  }

  assert {
    condition     = length(module.boat_infra) == 0 && output.boat_base_snapshot == null
    error_message = "Only the Boat backend builds a Boat snapshot."
  }
}
