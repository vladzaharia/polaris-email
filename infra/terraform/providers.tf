# Single Cloudflare provider for the one-and-only `polaris-prod` account.
#
# History: this file used to declare three aliased providers (`prod`,
# `staging`, `anchors`) for a multi-account topology. Phase O1 collapsed the
# account list to one — audit anchors moved to an external Object-Lock target
# (Backblaze B2 via `packages/object-lock`) and `polaris-staging` was an
# empty stub. The default (un-aliased) provider here is the only one needed.

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
