terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # 4.x is the last "classic" generation of the provider before the v5
      # rewrite. Pin loosely within 4.x; the v5 surface is still churning as
      # of writing and many resources we depend on (email_routing_*,
      # access_application/policy) only stabilized recently in 4.x.
      # If/when the operator wants to migrate to v5, do it in a dedicated PR.
      version = "~> 4.52"
    }

    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
