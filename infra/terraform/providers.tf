# Three aliased providers, one per Cloudflare account. Each `envs/<env>`
# composition is expected to use ONLY the alias matching its own account —
# but we declare all three here so shared modules can `configuration_aliases`
# against them if we ever need cross-account references (e.g. an Access app
# in prod that gates an R2 bucket in anchors).
#
# Account scoping note: the cloudflare provider 4.x reads `account_id` per
# resource, not per provider. The aliases here exist mostly so each env can
# pin which account is "default" and to keep intent explicit in module wiring.

provider "cloudflare" {
  alias     = "prod"
  api_token = var.cloudflare_api_token
}

provider "cloudflare" {
  alias     = "anchors"
  api_token = var.cloudflare_api_token
}

provider "cloudflare" {
  alias     = "staging"
  api_token = var.cloudflare_api_token
}
