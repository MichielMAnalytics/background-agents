# =============================================================================
# Cloudflare D1 Database
# =============================================================================
# Schema migrations (terraform/d1/migrations) are applied by the Cloudflare
# deploy before it uploads the control plane, not by Terraform.

resource "cloudflare_d1_database" "main" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-${local.name_suffix}"

  read_replication = {
    mode = "disabled"
  }
}
