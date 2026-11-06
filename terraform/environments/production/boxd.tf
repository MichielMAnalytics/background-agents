# =============================================================================
# boxd Sandbox Infrastructure
# =============================================================================

# Shared build-input hash: the runtime, the image package, the boxd builder and
# this module. A change to any of them builds a new snapshot under a new name;
# the Worker switches to it only after the build has verified it.
data "external" "boxd_source_hash" {
  count = local.use_boxd_backend ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "boxd"]
}

module "boxd_infra" {
  count  = local.use_boxd_backend ? 1 : 0
  source = "../../modules/boxd-infra"

  api_key              = var.boxd_api_key
  region               = var.boxd_region
  org                  = var.boxd_org
  snapshot_name_prefix = var.boxd_base_snapshot
  deploy_path          = "${var.project_root}/packages/boxd-infra"
  source_hash          = data.external.boxd_source_hash[0].result.hash
}
