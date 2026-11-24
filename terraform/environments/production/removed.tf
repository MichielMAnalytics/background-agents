# =============================================================================
# Resources handed to the Cloudflare deploy
# =============================================================================
# Earlier releases built and uploaded Worker code from this root. That moved
# to scripts/cloudflare-deploy (the deploy-<environment> workflows).
# `destroy = false` forgets each resource from state without touching
# Cloudflare: queue consumers, the web custom domain and the generated
# wrangler.production.toml stay in place until the next deploy takes them
# over. Worker versions, deployments and crons are forgotten the same way
# inside modules/cloudflare-worker.

# Worker builds
removed {
  from = null_resource.control_plane_build

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.slack_bot_build

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.github_bot_build

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.linear_bot_build

  lifecycle {
    destroy = false
  }
}

# D1 schema migrations
removed {
  from = null_resource.d1_migrations

  lifecycle {
    destroy = false
  }
}

# Cloudflare web Worker build, secrets, config and upload
removed {
  from = null_resource.web_app_cloudflare_build

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.web_app_cloudflare_secrets

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.web_app_cloudflare_deploy

  lifecycle {
    destroy = false
  }
}

removed {
  from = local_file.web_app_wrangler_production

  lifecycle {
    destroy = false
  }
}

# Web custom domain (the deploy attaches it as a custom_domain route)
removed {
  from = cloudflare_workers_custom_domain.web_app

  lifecycle {
    destroy = false
  }
}

# Queue consumers
removed {
  from = cloudflare_queue_consumer.image_build_finalization

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_queue_consumer.slack_completion_delivery

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_queue_consumer.github_autofix

  lifecycle {
    destroy = false
  }
}

# Boat base pruning, which must follow the control-plane deploy
removed {
  from = null_resource.boat_base_snapshot_prune

  lifecycle {
    destroy = false
  }
}

# Worker configuration gates, now validated by scripts/cloudflare-deploy/config.mjs
removed {
  from = terraform_data.cloudflare_custom_domain_gate

  lifecycle {
    destroy = false
  }
}

removed {
  from = terraform_data.access_control_gate

  lifecycle {
    destroy = false
  }
}

removed {
  from = terraform_data.sign_in_provider_gate

  lifecycle {
    destroy = false
  }
}
