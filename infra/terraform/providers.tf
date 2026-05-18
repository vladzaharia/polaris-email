# Single Cloudflare provider for the one-and-only `polaris-prod` account.
# The default (un-aliased) provider is the only one needed; every module
# call inherits it.

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
