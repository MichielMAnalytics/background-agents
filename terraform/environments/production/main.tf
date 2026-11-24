# Production Cloudflare environment.
#
# Every resource lives in the shared modules/cloudflare-environment module;
# this root only fixes the state location (backend.tf), configures providers
# (versions.tf) and passes its inputs through. terraform/environments/staging
# is the same module with its own state. moved.tf maps addresses from before
# the module existed, and removed.tf hands the Worker code deploy to
# scripts/cloudflare-deploy without destroying anything.

module "environment" {
  source = "../../modules/cloudflare-environment"

  cloudflare_api_token             = var.cloudflare_api_token
  cloudflare_account_id            = var.cloudflare_account_id
  cloudflare_worker_subdomain      = var.cloudflare_worker_subdomain
  vercel_api_token                 = var.vercel_api_token
  vercel_team_id                   = var.vercel_team_id
  modal_token_id                   = var.modal_token_id
  modal_token_secret               = var.modal_token_secret
  modal_workspace                  = var.modal_workspace
  modal_environment                = var.modal_environment
  modal_environment_web_suffix     = var.modal_environment_web_suffix
  enable_github_bot                = var.enable_github_bot
  enable_slack_bot                 = var.enable_slack_bot
  enable_linear_bot                = var.enable_linear_bot
  anthropic_api_key                = var.anthropic_api_key
  provider_accounts_encryption_key = var.provider_accounts_encryption_key
  modal_api_secret                 = var.modal_api_secret
  daytona_api_url                  = var.daytona_api_url
  daytona_api_key                  = var.daytona_api_key
  daytona_base_snapshot            = var.daytona_base_snapshot
  daytona_base_snapshot_memory_gib = var.daytona_base_snapshot_memory_gib
  daytona_target                   = var.daytona_target
  vercel_sandbox_token             = var.vercel_sandbox_token
  vercel_sandbox_project_id        = var.vercel_sandbox_project_id
  vercel_sandbox_team_id           = var.vercel_sandbox_team_id
  vercel_sandbox_api_base_url      = var.vercel_sandbox_api_base_url
  vercel_base_snapshot_id          = var.vercel_base_snapshot_id
  vercel_sandbox_runtime           = var.vercel_sandbox_runtime
  e2b_api_key                      = var.e2b_api_key
  e2b_api_url                      = var.e2b_api_url
  e2b_template_id                  = var.e2b_template_id
  e2b_template_cpu                 = var.e2b_template_cpu
  e2b_template_memory_mb           = var.e2b_template_memory_mb
  boat_api_key                     = var.boat_api_key
  boat_api_url                     = var.boat_api_url
  boat_base_snapshot               = var.boat_base_snapshot
  boat_org                         = var.boat_org
  sandbox_provider                 = var.sandbox_provider
  web_platform                     = var.web_platform
  web_serverless_region            = var.web_serverless_region
  deployment_name                  = var.deployment_name
  app_name                         = var.app_name
  app_icon_url                     = var.app_icon_url
  project_root                     = var.project_root
  r2_media_location                = var.r2_media_location
  r2_media_bucket_name             = var.r2_media_bucket_name
  docs_site_enabled                = var.docs_site_enabled
  docs_custom_domain               = var.docs_custom_domain
}
