# Staging environment composition.
#
# Mirrors prod's structure but targets the `polaris-staging` Cloudflare
# account. Use this to rehearse zone onboarding + Access policy changes
# before applying to prod. Keep tenant set small.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }

  # Initialize with:
  #   terraform -chdir=infra/terraform/envs/staging init \
  #     -backend-config=bucket=polaris-tfstate \
  #     -backend-config=key=staging/terraform.tfstate \
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

variable "cloudflare_account_id_staging" {
  type = string
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# -----------------------------------------------------------------------------
# Example: staging zone. Same module as prod, different account + domain.
# -----------------------------------------------------------------------------
#
# module "zone_staging_example_com" {
#   source = "../../modules/zone"
#
#   cf_account_id     = var.cloudflare_account_id_staging
#   cf_zone_id        = "REPLACE_WITH_STAGING_ZONE_ID"
#   domain_name       = "staging.example.com"
#   dkim_selector     = "polaris1"
#   dkim_cname_target = "polaris1.dkim.staging.example.com.cloudflare.net"
#
#   capabilities = {
#     inbound  = true
#     outbound = true
#   }
#
#   inbound_worker_name = "polaris-in-staging"
#   dmarc_policy        = "none"
# }
