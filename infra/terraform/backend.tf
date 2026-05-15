# Remote state backend.
#
# We use the `s3` backend pointed at Cloudflare R2 (R2 is S3-compatible enough
# for state storage). The single `envs/prod` composition (Phase O1 collapsed
# the prior three-account topology) sets its `key` via
# `-backend-config=key=prod/terraform.tfstate` during `terraform init`.
#
# Why R2 instead of Terraform Cloud or S3?
#   - We're already a Cloudflare shop; one fewer vendor.
#   - The state itself rides in a bucket we already pay for.
#   - R2 has no egress fees if we ever need to mirror it.
#
# TODO(operator): create the state bucket in `polaris-prod`:
#   wrangler r2 bucket create polaris-tfstate
# Then enable versioning + lifecycle for old versions (>30 days → delete).
# Also create an R2 access key restricted to that one bucket.

terraform {
  backend "s3" {
    # TODO(operator): fill these in OR pass via `-backend-config=` at init.
    #
    # bucket                      = "polaris-tfstate"
    # key                         = "REPLACED_PER_ENV/terraform.tfstate"
    # region                      = "auto"
    # endpoints = {
    #   s3 = "https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com"
    # }
    #
    # The flags below tell the s3 backend not to apply AWS-specific checks
    # that R2 doesn't implement.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    # Credentials are read from env: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
    # set to the R2 access key id + secret. (Yes, the AWS_ names — that's how
    # the s3 backend reads them.)
  }
}
