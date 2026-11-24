# Pass-through of modules/cloudflare-environment outputs. Output names are
# unchanged from before the module existed, so `terraform output` callers keep
# working.

output "slack_kv_id" {
  description = "Slack KV namespace ID"
  value       = module.environment.slack_kv_id
}

output "github_kv_id" {
  description = "GitHub KV namespace ID"
  value       = module.environment.github_kv_id
}

output "d1_database_id" {
  description = "The ID of the D1 database"
  value       = module.environment.d1_database_id
}

output "d1_database_name" {
  description = "The name of the D1 database used by operator CLI commands"
  value       = module.environment.d1_database_name
}

output "control_plane_url" {
  description = "Control plane worker URL"
  value       = module.environment.control_plane_url
}

output "control_plane_worker_name" {
  description = "Control plane worker name"
  value       = module.environment.control_plane_worker_name
}

output "slack_bot_worker_name" {
  description = "Slack bot worker name"
  value       = module.environment.slack_bot_worker_name
}

output "slack_bot_worker_url" {
  description = "Slack bot worker URL"
  value       = module.environment.slack_bot_worker_url
}

output "slack_bot_events_url" {
  description = "Slack Events API request URL"
  value       = module.environment.slack_bot_events_url
}

output "slack_bot_interactions_url" {
  description = "Slack interactivity request and options load URL"
  value       = module.environment.slack_bot_interactions_url
}

output "linear_kv_id" {
  description = "Linear KV namespace ID"
  value       = module.environment.linear_kv_id
}

output "linear_bot_worker_name" {
  description = "Linear bot worker name"
  value       = module.environment.linear_bot_worker_name
}

output "linear_bot_webhook_url" {
  description = "Linear bot webhook URL (set in Linear OAuth Application webhook config)"
  value       = module.environment.linear_bot_webhook_url
}

output "linear_bot_oauth_authorize_url" {
  description = "Visit this URL to install the Linear agent in your workspace (requires admin)"
  value       = module.environment.linear_bot_oauth_authorize_url
}

output "github_bot_worker_name" {
  description = "GitHub bot worker name"
  value       = module.environment.github_bot_worker_name
}

output "web_worker_name" {
  description = "Cloudflare web Worker name the deploy uploads when web_platform = \"cloudflare\""
  value       = module.environment.web_worker_name
}

output "web_app_url" {
  description = "Web app URL. For web_platform = \"cloudflare\" this is the workers.dev URL; the deploy serves CLOUDFLARE_CUSTOM_DOMAIN instead when one is configured."
  value       = module.environment.web_app_url
}

output "web_app_platform" {
  description = "Web app deployment platform"
  value       = module.environment.web_app_platform
}

output "sandbox_provider" {
  description = "Sandbox backend selected for this deployment"
  value       = module.environment.sandbox_provider
}

output "vercel_base_snapshot_id" {
  description = "Vercel base runtime snapshot ID configured for sandbox creation"
  value       = module.environment.vercel_base_snapshot_id
}

output "vercel_base_snapshot_name" {
  description = "Managed Vercel base runtime snapshot sandbox name"
  value       = module.environment.vercel_base_snapshot_name
}

output "boat_base_snapshot" {
  description = "Managed Boat saved snapshot fresh sandboxes deploy from"
  value       = module.environment.boat_base_snapshot
}

output "web_app_project_id" {
  description = "Vercel project ID (null when using Cloudflare)"
  value       = module.environment.web_app_project_id
}

output "modal_app_name" {
  description = "Modal app name"
  value       = module.environment.modal_app_name
}

output "modal_health_url" {
  description = "Modal health check endpoint"
  value       = module.environment.modal_health_url
}

output "verification_commands" {
  description = "Commands to verify the deployment"
  value       = module.environment.verification_commands
}

output "docs_site_project_id" {
  description = "Vercel project ID for the documentation site; set it as the VERCEL_DOCS_PROJECT_ID repository variable so Deploy Docs can publish (null when docs_site_enabled = false)"
  value       = module.environment.docs_site_project_id
}

output "docs_site_url" {
  description = "Documentation site URL (null when docs_site_enabled = false)"
  value       = module.environment.docs_site_url
}

output "generated_worker_secrets" {
  description = "Terraform-generated Worker secrets keyed by the GitHub Environment secret name the Cloudflare deploy reads"
  value       = module.environment.generated_worker_secrets
  sensitive   = true
}
