# Cloudflare Worker Module
#
# Terraform owns the Worker script itself (its name, workers.dev subdomain and
# observability settings) but no code. Versions, deployments, bindings, crons,
# queue consumers, Durable Object migrations and custom domains are uploaded
# by the Cloudflare deploy (scripts/cloudflare-deploy, run by the
# deploy-<environment> workflows), as Cloudflare recommends for Workers with
# Durable Objects:
# https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#considerations-with-durable-objects

resource "cloudflare_worker" "this" {
  account_id = var.account_id
  name       = var.worker_name

  # Enable workers.dev subdomain for direct access
  subdomain = {
    enabled = true
  }

  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
    }
  }

  lifecycle {
    # Every `wrangler deploy` re-applies workers_dev, preview_urls and
    # observability from the generated Wrangler config (which sets the same
    # values as above). Terraform sets them on create and then leaves them to
    # the deploy, so the two never fight over a nested computed attribute
    # such as subdomain.previews_enabled.
    ignore_changes = [subdomain, observability]
  }
}

# =============================================================================
# Resources handed to the Cloudflare deploy
# =============================================================================
# Earlier releases created these here. `destroy = false` forgets them from
# state without touching Cloudflare, so the running version, its deployment,
# cron schedules and custom domain stay live until the next `wrangler deploy`
# replaces them in place.

removed {
  from = cloudflare_worker_version.this

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_deployment.this

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_cron_trigger.this

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_custom_domain.this

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_route.this

  lifecycle {
    destroy = false
  }
}
