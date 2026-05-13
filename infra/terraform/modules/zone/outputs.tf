output "dns_records" {
  description = "All DNS records created by this module, keyed by purpose. Useful for audit + smoke tests."
  value = {
    mx_inbound    = [for r in cloudflare_record.mx_email_routing : { name = r.name, content = r.content, priority = r.priority }]
    mx_bounce     = [for r in cloudflare_record.mx_bounce : { name = r.name, content = r.content }]
    spf           = [for r in cloudflare_record.spf : { name = r.name, content = r.content }]
    dkim          = [for r in cloudflare_record.dkim : { name = r.name, content = r.content }]
    dkim_wildcard = [for r in cloudflare_record.dkim_wildcard : { name = r.name, content = r.content }]
    dmarc         = [for r in cloudflare_record.dmarc : { name = r.name, content = r.content }]
  }
}

output "email_routing_enabled" {
  description = "Whether Email Routing is enabled for this zone (true after first apply on inbound-capable domains)."
  value       = length(cloudflare_email_routing_settings.this) > 0
}

output "verification_hint" {
  description = "Operator-facing reminder of what to verify after `terraform apply` succeeds. Not a real check — terraform can't poll DNS for us."
  value       = <<-EOT
    Verify on dash + with `dig`:
      1. MX records resolve to route{1,2,3}.mx.cloudflare.net (inbound) and the cf-bounce subdomain (outbound).
      2. DKIM CNAME for ${var.dkim_selector}._domainkey.${var.domain_name} resolves to the CF target.
      3. SPF + DMARC TXT records present at apex / _dmarc.
      4. Email Routing dashboard shows zone "Active" with catch-all → ${var.inbound_worker_name}.
      5. Email Service dashboard shows ${var.domain_name} with DKIM "Verified" (manual step until provider supports it).
  EOT
}
