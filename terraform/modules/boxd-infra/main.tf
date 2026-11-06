# boxd Infrastructure Module
# Builds the snapshot boxd sandboxes restore from.
# Mirrors terraform/modules/boat-infra/ (snapshot build) for the boxd backend.

locals {
  snapshot_name = "${var.snapshot_name_prefix}-${substr(var.source_hash, 0, 16)}"
}

resource "null_resource" "boxd_snapshot" {
  triggers = {
    source_hash   = var.source_hash
    snapshot_name = local.snapshot_name
    region        = var.region
    org           = var.org
    build_size    = var.build_size
    script_hash   = filesha256("${path.module}/scripts/build-snapshot.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-snapshot.sh"
    interpreter = ["bash"]

    environment = {
      BOXD_API_KEY                = var.api_key
      BOXD_REGION                 = var.region
      BOXD_ORG                    = var.org
      BOXD_BASE_SNAPSHOT          = var.snapshot_name_prefix
      BOXD_BUILD_SIZE             = var.build_size
      OPENINSPECT_IMAGE_CANDIDATE = local.snapshot_name
      DEPLOY_PATH                 = var.deploy_path
    }
  }
}
