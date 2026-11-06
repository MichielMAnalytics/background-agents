# The boxd backend builds a snapshot and binds the control plane to it, and
# only to it: a deployment on another backend neither builds nor binds
# anything boxd.

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
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "boxd-backend-test"

  sandbox_provider   = "boxd"
  boxd_api_key       = "test-boxd-key"
  boxd_base_snapshot = "open-inspect"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "boxd_builds_a_snapshot_and_binds_the_worker_to_it" {
  command = plan

  assert {
    condition     = local.use_boxd_backend && length(module.boxd_infra) == 1 && length(data.external.boxd_source_hash) == 1
    error_message = "The boxd backend must hash its build inputs and build the snapshot."
  }

  assert {
    condition     = module.boxd_infra[0].snapshot_name == "open-inspect-0123456789abcdef"
    error_message = "The snapshot must be the prefix plus the first 16 characters of the source hash."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "BOXD_BASE_SNAPSHOT") &&
      contains(module.control_plane_worker.plain_text_binding_names, "BOXD_SANDBOX_SIZE") &&
      contains(module.control_plane_worker.secret_binding_names, "BOXD_API_KEY")
    )
    error_message = "The control plane must receive the boxd snapshot, machine size and key."
  }

  assert {
    condition = (
      !contains(module.control_plane_worker.plain_text_binding_names, "BOXD_ORG") &&
      !contains(module.control_plane_worker.plain_text_binding_names, "BOXD_REGION") &&
      !contains(module.control_plane_worker.plain_text_binding_names, "BOXD_LABELS")
    )
    error_message = "An empty org, region or label set must not be bound."
  }

  assert {
    condition     = length(module.e2b_infra) == 0 && length(module.daytona_infra) == 0 && length(module.modal_app) == 0 && length(module.boat_infra) == 0
    error_message = "The boxd backend must not provision another backend's infrastructure."
  }
}

run "boxd_region_org_and_labels_bind_the_worker" {
  command = plan

  variables {
    boxd_region         = "fra"
    boxd_org            = "acme"
    boxd_machine_labels = { team = "platform" }
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "BOXD_REGION") &&
      contains(module.control_plane_worker.plain_text_binding_names, "BOXD_ORG") &&
      contains(module.control_plane_worker.plain_text_binding_names, "BOXD_LABELS")
    )
    error_message = "A configured region, org and machine labels must reach the control plane."
  }
}

run "rejects_an_invalid_snapshot_prefix" {
  command = plan

  variables {
    boxd_base_snapshot = "Open_Inspect"
  }

  expect_failures = [var.boxd_base_snapshot]
}

run "rejects_an_unknown_machine_size" {
  command = plan

  variables {
    boxd_sandbox_size = "3x12"
  }

  expect_failures = [var.boxd_sandbox_size]
}

run "other_backends_build_and_bind_nothing_boxd" {
  command = plan

  variables {
    sandbox_provider   = "modal"
    modal_token_id     = "test-modal-token-id"
    modal_token_secret = "test-modal-token-secret"
    modal_workspace    = "test-workspace"
    modal_api_secret   = "test-modal-api-secret"
    boxd_api_key       = "test-boxd-key"
    boxd_base_snapshot = "Not_Valid_Elsewhere"
    boxd_sandbox_size  = "huge"
  }

  assert {
    condition     = length(module.boxd_infra) == 0
    error_message = "A deployment on another backend must not build boxd snapshots, nor be blocked by boxd-only settings."
  }

  assert {
    condition = (
      !contains(module.control_plane_worker.plain_text_binding_names, "BOXD_BASE_SNAPSHOT") &&
      !contains(module.control_plane_worker.secret_binding_names, "BOXD_API_KEY")
    )
    error_message = "A deployment on another backend must not bind boxd settings."
  }
}
