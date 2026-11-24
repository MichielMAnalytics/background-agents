locals {
  name_suffix         = var.deployment_name
  use_modal_backend   = contains(["modal", "modal-vm"], var.sandbox_provider)
  use_daytona_backend = var.sandbox_provider == "daytona"
  use_vercel_backend  = var.sandbox_provider == "vercel"
  use_e2b_backend     = var.sandbox_provider == "e2b"
  use_boat_backend    = var.sandbox_provider == "boat"

  # Worker names and URLs. scripts/cloudflare-deploy/config.mjs derives the
  # same names from DEPLOYMENT_NAME; keep the two in step.
  control_plane_worker_name = "open-inspect-control-plane-${local.name_suffix}"
  control_plane_host        = "${local.control_plane_worker_name}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url         = "https://${local.control_plane_host}"
  ws_url                    = "wss://${local.control_plane_host}"
  web_worker_name           = "open-inspect-web-${local.name_suffix}"

  # Deployment-wide LLM keys injected into Modal session sandboxes. Every key stays
  # present with an empty value when unconfigured, so clearing one reconciles the
  # old credential away on the next apply; Modal rejects a secret with no keys at
  # all. An empty value means sandboxes take that provider's credential from the
  # per-repository secret store, which overrides this secret either way.
  modal_llm_secret_values = {
    ANTHROPIC_API_KEY = trimspace(var.anthropic_api_key)
  }

  # Web app URL depends on deployment platform. The Cloudflare web Worker is
  # uploaded by the deploy, which may also attach CLOUDFLARE_CUSTOM_DOMAIN;
  # Terraform reports its workers.dev hostname.
  web_app_url = (var.web_platform == "cloudflare"
    ? "https://${local.web_worker_name}.${var.cloudflare_worker_subdomain}.workers.dev"
    : "https://open-inspect-${local.name_suffix}.vercel.app"
  )
  effective_web_app_url = (
    var.web_platform == "vercel" ? module.web_app[0].production_url : local.web_app_url
  )

  # Documentation site hostname, null when unset. The Terraform workflow passes
  # an unset repository variable as "", which must not attach an empty domain.
  docs_custom_domain = (
    var.docs_custom_domain == null ? null :
    trimspace(var.docs_custom_domain) == "" ? null : trimspace(var.docs_custom_domain)
  )

  # Documentation site URL, when it serves a hostname of its own
  docs_custom_domain_url = local.docs_custom_domain != null ? "https://${local.docs_custom_domain}" : null
}
