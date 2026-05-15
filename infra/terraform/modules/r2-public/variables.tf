variable "cf_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket."
  type        = string
}

variable "cf_zone_id" {
  description = "Cloudflare zone ID for the zone hosting the public-host hostname (`mail.plrs.im` in the default config). The CNAME record is created here."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket exposed via the custom domain. Default `polaris-email` — the bucket where inbound + outbound message bodies and attachments live."
  type        = string
  default     = "polaris-email"
}

variable "public_host" {
  description = "Fully-qualified public hostname for the R2 bucket. Used both as the `cloudflare_r2_custom_domain` target and as the CNAME record name in the parent zone. Default `r2.mail.plrs.im`."
  type        = string
  default     = "r2.mail.plrs.im"
}

variable "domain_name" {
  description = "The full hostname for the R2 custom domain (e.g. `r2.mail.plrs.im`). Matches `public_host` by default; allowed to differ for split-zone scenarios."
  type        = string
  default     = "r2.mail.plrs.im"
}

variable "record_name" {
  description = "DNS record name relative to the parent zone (e.g. `r2.mail` if the zone is `plrs.im`). The composed FQDN must match `domain_name`."
  type        = string
  default     = "r2.mail"
}
