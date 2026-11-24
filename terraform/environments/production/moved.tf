# =============================================================================
# State Address Moves
# =============================================================================
# Everything that used to be declared directly in this root now lives in
# module.environment (modules/cloudflare-environment). These blocks keep the
# existing production state: no resource is replaced by the move.

# Releases before the bots became optional declared these without count.
moved {
  from = module.slack_kv
  to   = module.slack_kv[0]
}

moved {
  from = module.slack_kv[0]
  to   = module.environment.module.slack_kv[0]
}

moved {
  from = module.slack_bot_worker
  to   = module.slack_bot_worker[0]
}

moved {
  from = module.slack_bot_worker[0]
  to   = module.environment.module.slack_bot_worker[0]
}

moved {
  from = module.web_app
  to   = module.web_app[0]
}

moved {
  from = module.web_app[0]
  to   = module.environment.module.web_app[0]
}

moved {
  from = module.control_plane_worker
  to   = module.environment.module.control_plane_worker
}

moved {
  from = module.session_index_kv
  to   = module.environment.module.session_index_kv
}

moved {
  from = module.modal_app
  to   = module.environment.module.modal_app
}

moved {
  from = module.daytona_infra
  to   = module.environment.module.daytona_infra
}

moved {
  from = module.e2b_infra
  to   = module.environment.module.e2b_infra
}

moved {
  from = module.boat_infra
  to   = module.environment.module.boat_infra
}

moved {
  from = module.vercel_sandbox_infra
  to   = module.environment.module.vercel_sandbox_infra
}

moved {
  from = module.docs_site
  to   = module.environment.module.docs_site
}

moved {
  from = module.github_bot_worker
  to   = module.environment.module.github_bot_worker
}

moved {
  from = module.linear_bot_worker
  to   = module.environment.module.linear_bot_worker
}

moved {
  from = module.github_kv
  to   = module.environment.module.github_kv
}

moved {
  from = module.linear_kv
  to   = module.environment.module.linear_kv
}

moved {
  from = cloudflare_queue.image_build_finalization
  to   = module.environment.cloudflare_queue.image_build_finalization
}

moved {
  from = cloudflare_queue.image_build_finalization_dlq
  to   = module.environment.cloudflare_queue.image_build_finalization_dlq
}

moved {
  from = cloudflare_queue.slack_completion_delivery
  to   = module.environment.cloudflare_queue.slack_completion_delivery
}

moved {
  from = cloudflare_queue.slack_completion_delivery_dlq
  to   = module.environment.cloudflare_queue.slack_completion_delivery_dlq
}

moved {
  from = cloudflare_queue.github_autofix
  to   = module.environment.cloudflare_queue.github_autofix
}

moved {
  from = cloudflare_queue.github_autofix_dlq
  to   = module.environment.cloudflare_queue.github_autofix_dlq
}

moved {
  from = cloudflare_d1_database.main
  to   = module.environment.cloudflare_d1_database.main
}

moved {
  from = cloudflare_r2_bucket.media
  to   = module.environment.cloudflare_r2_bucket.media
}

moved {
  from = random_password.service_auth_secret_web
  to   = module.environment.random_password.service_auth_secret_web
}

moved {
  from = random_password.service_auth_secret_slack_bot
  to   = module.environment.random_password.service_auth_secret_slack_bot
}

moved {
  from = random_password.service_auth_secret_github_bot
  to   = module.environment.random_password.service_auth_secret_github_bot
}

moved {
  from = random_password.service_auth_secret_linear_bot
  to   = module.environment.random_password.service_auth_secret_linear_bot
}

moved {
  from = random_password.image_callback_token_pepper
  to   = module.environment.random_password.image_callback_token_pepper
}

moved {
  from = random_bytes.provider_accounts_encryption_key
  to   = module.environment.random_bytes.provider_accounts_encryption_key
}
