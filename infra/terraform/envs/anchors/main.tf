# Anchors environment composition.
#
# This account is intentionally minimal — it exists for two-person-rule
# isolation of the audit anchor R2 bucket. Per the design plan:
#   - polaris-anchors holds R2 ONLY (no Workers, no D1, no KV).
#   - The automation token is scoped to `R2:PutObject` on `anchors`.
#   - The bucket is compliance-mode-locked with 7-year retention.
#
# Wrangler does NOT manage R2 buckets in this account (different deploy
# cadence, separate destruction blast radius). Terraform owns the bucket
# definition + lifecycle here.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }

  # Initialize with:
  #   terraform -chdir=infra/terraform/envs/anchors init \
  #     -backend-config=bucket=polaris-tfstate \
  #     -backend-config=key=anchors/terraform.tfstate \
  #     -backend-config=region=auto \
  #     -backend-config=endpoints='{"s3":"https://<PROD_ACCOUNT_ID>.r2.cloudflarestorage.com"}'
  #
  # NOTE: the state bucket lives in PROD's R2, not anchors' — anchors is
  # compliance-locked and unsuitable for mutable state.
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

variable "cloudflare_account_id_anchors" {
  type = string
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# -----------------------------------------------------------------------------
# Audit anchor R2 bucket. Compliance-mode object lock + 7-year retention.
# -----------------------------------------------------------------------------

resource "cloudflare_r2_bucket" "anchors" {
  account_id = var.cloudflare_account_id_anchors
  name       = "anchors"
  location   = "ENAM" # TODO(operator): pick a jurisdiction; ENAM = Eastern North America
}

# TODO(operator): cloudflare_r2_bucket_lock + lifecycle resources are still
# being added to the provider. Configure object-lock + lifecycle via the
# `wrangler r2 bucket lock` CLI or the Cloudflare API directly until the
# resources land. Tracked in design finding I12 follow-up.
#
# Required configuration (per design plan, section "Cloudflare"):
#   - Object lock: COMPLIANCE mode, 7-year (2557-day) retention.
#   - Lifecycle: no transitions; explicit no-op so audit objects aren't
#     auto-tiered to anything cheaper that breaks compliance posture.
#   - Versioning: enabled.

# resource "cloudflare_r2_bucket_lock" "anchors" {
#   account_id  = var.cloudflare_account_id_anchors
#   bucket_name = cloudflare_r2_bucket.anchors.name
#   default_retention_mode = "COMPLIANCE"
#   default_retention_days = 2557
# }
