output "worker_name" {
  description = "The name of the Worker script"
  value       = cloudflare_worker.this.name
}

output "worker_id" {
  description = "The ID of the Worker script"
  value       = cloudflare_worker.this.id
}

output "worker_url" {
  description = "The workers.dev URL for the worker: https://<worker_name>.<worker_subdomain>.workers.dev"
  value       = "https://${cloudflare_worker.this.name}.${var.worker_subdomain}.workers.dev"
}
