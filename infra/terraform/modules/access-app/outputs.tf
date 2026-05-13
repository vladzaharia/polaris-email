output "application_id" {
  description = "Cloudflare Access application ID. Useful for wiring service tokens (`cloudflare_access_service_token`) elsewhere."
  value       = cloudflare_access_application.this.id
}

output "aud" {
  description = "Application AUD claim. Workers verifying CF Access JWTs must check this value against the `aud` claim of the incoming `Cf-Access-Jwt-Assertion` header."
  value       = cloudflare_access_application.this.aud
}

output "domain" {
  description = "Domain protected by this Access app."
  value       = cloudflare_access_application.this.domain
}
