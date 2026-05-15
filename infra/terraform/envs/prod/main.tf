# Prod environment composition.
#
# Owns:
#   - All Polaris-managed sender/recipient zones (DNS + Email Routing + Email
#     Service onboarding).
#   - Cloudflare Access apps fronting admin endpoints + `/v1/send/raw`.
#
# Does NOT own (Wrangler does): Workers, D1, KV, R2 (in this account),
# Queues, Durable Objects.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }

  # Initialize with:
  #   terraform -chdir=infra/terraform/envs/prod init \
  #     -backend-config=bucket=polaris-tfstate \
  #     -backend-config=key=prod/terraform.tfstate \
  #     -backend-config=region=auto \
  #     -backend-config=endpoints='{"s3":"https://<ACCOUNT_ID>.r2.cloudflarestorage.com"}'
  backend "s3" {
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id_prod" {
  type = string
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# -----------------------------------------------------------------------------
# Example: one zone wired up. Uncomment and copy per domain.
#
# TODO(operator): replace `cf_zone_id` with the real ID from
# `cloudflare_zone` data source or hardcoded after manual zone creation.
# -----------------------------------------------------------------------------
#
# module "zone_example_com" {
#   source = "../../modules/zone"
#
#   cf_account_id     = var.cloudflare_account_id_prod
#   cf_zone_id        = "REPLACE_WITH_ZONE_ID"
#   domain_name       = "example.com"
#   dkim_selector     = "polaris1"
#   dkim_cname_target = "polaris1.dkim.example.com.cloudflare.net" # TODO: real value after onboard
#
#   capabilities = {
#     inbound  = true
#     outbound = true
#   }
#
#   inbound_worker_name = "polaris-in"
#
#   spf_record   = "v=spf1 include:_spf.mx.cloudflare.net ~all"
#   dmarc_policy = "none"
#   dmarc_rua    = "mailto:dmarc@example.com"
# }
#
# module "access_admin" {
#   source = "../../modules/access-app"
#
#   cf_account_id = var.cloudflare_account_id_prod
#   cf_zone_id    = "REPLACE_WITH_ZONE_ID"
#   app_name      = "polaris-admin"
#   domain        = "admin.polaris.example.com"
#
#   identity_provider_ids    = [] # TODO: WebAuthn IdP ID
#   allowed_emails           = ["ops@example.com"]
#   require_webauthn_step_up = true
#   session_duration         = "1h"
# }
#
# module "access_send_raw" {
#   source = "../../modules/access-app"
#
#   cf_account_id = var.cloudflare_account_id_prod
#   cf_zone_id    = "REPLACE_WITH_ZONE_ID"
#   app_name      = "polaris-send-raw"
#   domain        = "submit.polaris.example.com"
#
#   identity_provider_ids    = [] # TODO: service-token-only IdP
#   require_webauthn_step_up = false # daemons use service tokens, not WebAuthn
#   session_duration         = "24h"
# }

# -----------------------------------------------------------------------------
# R2 public custom domain for the `polaris-email` bucket (B5).
#
# Fronts the bucket on `r2.mail.plrs.im`. Inbound + outbound message bodies
# and per-attachment R2 objects are served from this hostname; the API
# embeds the full URL in `Message.body_url` and `attachment.url`.
#
# The `polaris-anchors` bucket stays PRIVATE — DO NOT wire it through this
# module. Audit anchors must not be publicly readable.
# -----------------------------------------------------------------------------
#
# module "r2_public_polaris_email" {
#   source = "../../modules/r2-public"
#
#   cf_account_id = var.cloudflare_account_id_prod
#   cf_zone_id    = "REPLACE_WITH_MAIL_PLRS_IM_ZONE_ID"
#   bucket_name   = "polaris-email"
#   public_host   = "r2.mail.plrs.im"
#   domain_name   = "r2.mail.plrs.im"
#   record_name   = "r2.mail" # relative to the `plrs.im` zone
# }
