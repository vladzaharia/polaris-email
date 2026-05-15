output "public_host" {
  description = "Public hostname the polaris-email R2 bucket is served on. Mirror this into `R2_PUBLIC_HOST` for services/api wrangler vars."
  value       = var.public_host
}

output "domain_name" {
  description = "Full domain bound to the R2 custom domain — same as `public_host` by default."
  value       = var.domain_name
}
