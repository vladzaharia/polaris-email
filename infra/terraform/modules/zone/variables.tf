variable "cf_account_id" {
  description = "Cloudflare account ID that owns this zone."
  type        = string
}

variable "cf_zone_id" {
  description = "Cloudflare zone ID for the domain. Operator must add the zone via the dashboard or a separate `cloudflare_zone` resource — we don't manage zone creation in this module."
  type        = string
}

variable "domain_name" {
  description = "Apex domain name, e.g. `example.com`. Used to construct DNS record names."
  type        = string
}

variable "capabilities" {
  description = <<-EOT
    Capability flags controlling which records are emitted. A domain might be
    inbound-only, outbound-only, or both. Match the `domain_capabilities`
    table in the control-plane D1.
  EOT
  type = object({
    inbound  = bool
    outbound = bool
  })
  default = {
    inbound  = true
    outbound = true
  }
}

variable "dkim_selector" {
  description = "DKIM selector name (the part before `._domainkey.<domain>`). Cloudflare Email Service mints these — we just CNAME the operator selector to the CF-provided target."
  type        = string
  default     = "polaris1"
}

variable "dkim_cname_target" {
  description = "Hostname that the DKIM CNAME should point at. Cloudflare returns this when Email Service onboarding completes for the domain. TODO(operator): wire from the email_service_domain resource (or null_resource output) once that exists in the provider."
  type        = string
  # TODO(operator): typically `<selector>.<domain>.<account>.email.cloudflare.net`
  # or similar — confirm format from CF dashboard once one domain is onboarded
  # by hand.
  default = "PLACEHOLDER.dkim.cloudflare.net"
}

variable "include_dkim_wildcard" {
  description = "If true, also publish a wildcard `*._domainkey` CNAME so subdomain mail works without per-subdomain DKIM records. Most operators want false."
  type        = bool
  default     = false
}

variable "spf_record" {
  description = "SPF TXT record body. Default delegates to Cloudflare Email Service's SPF include."
  type        = string
  default     = "v=spf1 include:_spf.mx.cloudflare.net ~all"
}

variable "dmarc_policy" {
  description = "DMARC policy: `none`, `quarantine`, or `reject`. Start at `none` while monitoring, then tighten."
  type        = string
  default     = "none"
}

variable "dmarc_rua" {
  description = "Aggregate report URI for DMARC. e.g. `mailto:dmarc-rua@example.com`."
  type        = string
  default     = ""
}

variable "inbound_worker_name" {
  description = "Name of the deployed `services/in` Worker that handles the catch-all rule. Wrangler deploys the Worker; this module just references it by name. Keep this in sync with `services/in/wrangler.jsonc`'s `name` field."
  type        = string
  default     = "polaris-email-in"
}

variable "enable_email_routing" {
  description = "Whether to enable Cloudflare Email Routing for this zone and create the catch-all rule. Set false for outbound-only domains."
  type        = bool
  default     = true
}
