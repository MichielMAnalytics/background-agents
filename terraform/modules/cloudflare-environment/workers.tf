# =============================================================================
# Cloudflare Workers (scripts only) and Queues
# =============================================================================
# Terraform creates each Worker script and the resources its bindings point
# at. The code, bindings, secrets, crons, queue consumers and Durable Object
# migrations are uploaded by the Cloudflare deploy (scripts/cloudflare-deploy),
# which derives the same names from deployment_name.

module "control_plane_worker" {
  source = "../cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = local.control_plane_worker_name
  worker_subdomain = var.cloudflare_worker_subdomain
}

module "slack_bot_worker" {
  count  = var.enable_slack_bot ? 1 : 0
  source = "../cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-slack-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
}

module "github_bot_worker" {
  count  = var.enable_github_bot ? 1 : 0
  source = "../cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-github-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
}

module "linear_bot_worker" {
  count  = var.enable_linear_bot ? 1 : 0
  source = "../cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-linear-bot-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
}

# One producer binding per job kind (packages/control-plane/src/jobs.ts; the
# mapping lives in src/cloudflare/job-queue.ts).
resource "cloudflare_queue" "image_build_finalization" {
  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-image-build-finalization-${local.name_suffix}"
}

resource "cloudflare_queue" "image_build_finalization_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-image-build-finalization-dlq-${local.name_suffix}"
}

resource "cloudflare_queue" "slack_completion_delivery" {
  count = var.enable_slack_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-slack-completion-${local.name_suffix}"
}

resource "cloudflare_queue" "slack_completion_delivery_dlq" {
  count = var.enable_slack_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-slack-completion-dlq-${local.name_suffix}"
}

resource "cloudflare_queue" "github_autofix" {
  count = var.enable_github_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-github-autofix-${local.name_suffix}"
}

resource "cloudflare_queue" "github_autofix_dlq" {
  count = var.enable_github_bot ? 1 : 0

  account_id = var.cloudflare_account_id
  queue_name = "open-inspect-github-autofix-dlq-${local.name_suffix}"
}
