terraform {
  required_version = ">= 1.14.0"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # Pin below 5.20.0: that release regressed cloudflare_worker observability
      # to emit observability.traces.propagation_policy, which fails with
      # "propagation_policy requires the trace propagation feature to be enabled"
      # (403, code 100342) on accounts without that feature.
      # See cloudflare/terraform-provider-cloudflare#7177.
      version = ">= 5.16, < 5.20.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.0"
    }
  }
}
