# =============================================================================
# Boat Sandbox Infrastructure
# =============================================================================

# Shared build-input hash: the runtime, the image package, the Boat builder and
# this module. A change to any of them builds a new saved snapshot under a new
# name; the deploy switches the Worker to it after this apply has verified it.
data "external" "boat_source_hash" {
  count = local.use_boat_backend ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "boat"]
}

module "boat_infra" {
  count  = local.use_boat_backend ? 1 : 0
  source = "../boat-infra"

  api_key              = var.boat_api_key
  api_url              = var.boat_api_url
  org                  = var.boat_org
  snapshot_name_prefix = var.boat_base_snapshot
  deploy_path          = "${var.project_root}/packages/boat-infra"
  source_hash          = data.external.boat_source_hash[0].result.hash
}

# Older bases under boat_base_snapshot are pruned by the Cloudflare deploy once
# the control plane serves the new one (scripts/cloudflare-deploy): only a
# Worker deployment that references the new snapshot proves the old one is
# replaced. The replaced base is retained for rollback and for requests still
# running on the previous Worker version.
