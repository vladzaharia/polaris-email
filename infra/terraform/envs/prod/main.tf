# Prod (and only) environment composition.
#
# Owns:
#   - All Polaris-managed sender/recipient zones (DNS + Email Routing + Email
#     Service onboarding).
#   - Cloudflare Access apps fronting admin endpoints + `/v1/send/raw`.
#   - The R2 public custom domain for the `polaris-email` bucket.
#
# Does NOT own (Wrangler does): Workers, D1, KV, R2 buckets, Queues, Durable
# Objects.
#
# Phase O1 note: this is now the only composition under `envs/`. The prior
# `staging/` (empty stub) and `anchors/` (audit-anchor R2 bucket) roots were
# removed — staging was never reconciled to code, and anchors moved off-CF
# to a Backblaze B2 bucket with Object Lock COMPLIANCE (see
# `packages/object-lock` + `services/api/src/scheduled/anchor.ts`). The
# Backblaze credentials live in the operator's password vault and are
# delivered to the Worker via `wrangler secret put`, NOT via Terraform.

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

variable "cloudflare_account_id" {
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
#   cf_account_id     = var.cloudflare_account_id
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
#   inbound_worker_name = "polaris-email-in"
#
#   spf_record   = "v=spf1 include:_spf.mx.cloudflare.net ~all"
#   dmarc_policy = "none"
#   dmarc_rua    = "mailto:dmarc@example.com"
# }
#
# module "access_admin" {
#   source = "../../modules/access-app"
#
#   cf_account_id = var.cloudflare_account_id
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
#   cf_account_id = var.cloudflare_account_id
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
# Audit anchors live OFF Cloudflare (Phase O1) in Backblaze B2 with Object
# Lock COMPLIANCE — they are never in any R2 bucket and never publicly
# readable. See `packages/object-lock` and `services/api/src/scheduled/anchor.ts`.
# -----------------------------------------------------------------------------
#
# module "r2_public_polaris_email" {
#   source = "../../modules/r2-public"
#
#   cf_account_id = var.cloudflare_account_id
#   cf_zone_id    = "REPLACE_WITH_MAIL_PLRS_IM_ZONE_ID"
#   bucket_name   = "polaris-email"
#   public_host   = "r2.mail.plrs.im"
#   domain_name   = "r2.mail.plrs.im"
#   record_name   = "r2.mail" # relative to the `plrs.im` zone
# }

# -----------------------------------------------------------------------------
# Workers custom domains (PR 6 — cli-installer).
#
# `cloudflare_workers_custom_domain` attaches a hostname to a deployed Worker.
# The Worker itself is deployed by Wrangler (out-of-band from Terraform); this
# resource just owns the hostname-to-Worker mapping on the zone.
#
# The Worker `polaris-email-cli-installer` (apps/cli-installer) is fronted by
# `cli.mail.plrs.im` and serves the POSIX-sh installer for the operator CLI.
# -----------------------------------------------------------------------------

resource "cloudflare_workers_custom_domain" "cli_installer" {
  account_id = var.cloudflare_account_id
  zone_id    = "REPLACE_WITH_MAIL_PLRS_IM_ZONE_ID" # TODO(operator): real zone id for plrs.im
  hostname   = "cli.mail.plrs.im"
  service    = "polaris-email-cli-installer"
  environment = "production"
}

# Reference stub for the panel Worker. Uncomment and fill in once the
# `panel.polaris.example.com` hostname is finalised. Mirrors the
# cli-installer block above; the panel Worker is `polaris-email-panel`.
#
# resource "cloudflare_workers_custom_domain" "panel" {
#   account_id  = var.cloudflare_account_id
#   zone_id     = "REPLACE_WITH_PANEL_ZONE_ID"
#   hostname    = "panel.polaris.example.com"
#   service     = "polaris-email-panel"
#   environment = "production"
# }
