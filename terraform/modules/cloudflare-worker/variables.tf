variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "worker_name" {
  description = "Name of the Worker script"
  type        = string
}

variable "worker_subdomain" {
  description = "Cloudflare account workers.dev subdomain (the part before .workers.dev), used to build worker_url"
  type        = string
}
