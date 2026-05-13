#!/usr/bin/env bash
# preflight.sh — fail fast with a single remediation line per missing prerequisite.
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"

cd "$ROOT"

FAIL=0
check() {
  local name="$1" cmd="$2" remediate="$3"
  if eval "$cmd" >/dev/null 2>&1; then
    printf '  ok   %s\n' "$name"
  else
    printf '  FAIL %s\n       fix: %s\n' "$name" "$remediate"
    FAIL=1
  fi
}

echo "polaris-email preflight"
echo

check "pnpm >= 9"           "pnpm --version | awk -F. '{exit (\$1<9)}'"               "corepack enable && corepack prepare pnpm@9 --activate"
check "wrangler installed"  "command -v wrangler"                                      "pnpm install (wrangler is a workspace dep) or npm i -g wrangler"
check "wrangler logged in"  "wrangler whoami"                                          "wrangler login"
check "jq installed"        "command -v jq"                                            "brew install jq || apt-get install jq"
check "openssl installed"   "command -v openssl"                                       "brew install openssl || apt-get install openssl"
check "git installed"       "command -v git"                                           "install git"
check "curl installed"      "command -v curl"                                          "install curl"

if [[ "${POLARIS_REQUIRE_DOCKER:-0}" == "1" ]]; then
  check "docker compose"    "docker compose version"                                   "install Docker Desktop or docker-compose-plugin"
fi

# Catch the gitignore-swallows-services class of bug: every service directory on disk must
# also be tracked in git, otherwise `bin/deploy.sh --changed` will silently miss it and CI
# can't see source changes. The most common offender is a global ~/.gitignore with `out/`
# which hides services/out.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  miss_svc=()
  for svc in "${POLARIS_SERVICES[@]}"; do
    d="services/$svc"
    if [[ -d "$d" ]] && ! git ls-files --error-unmatch "$d/wrangler.jsonc" >/dev/null 2>&1; then
      miss_svc+=("$d")
    fi
  done
  if [[ ${#miss_svc[@]} -gt 0 ]]; then
    printf '  FAIL service dirs exist but are not tracked by git: %s\n       fix: check `git check-ignore -v <path>` (often a global ~/.gitignore rule); add `!<path>/` and `!<path>/**` to the repo .gitignore, then `git add` the directory.\n' "${miss_svc[*]}"
    FAIL=1
  else
    printf '  ok   all service directories tracked in git\n'
  fi
fi

if [[ -f "$ENV_FILE" ]]; then
  printf '  ok   .env.deploy present\n'
  # Validate required keys.
  miss=()
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  # SYNTHETIC_MONITOR_DOMAIN is intentionally NOT required — it only default-builds the
  # synthetic monitor's from/to addresses. A stack without synthetic monitoring doesn't
  # need it. Multi-domain configuration lives in D1's outbound_domains table, managed via
  # `polaris-email domain onboard`.
  for k in CF_ACCOUNT_ID POLARIS_API_HOSTNAME; do
    if [[ -z "${!k:-}" ]]; then miss+=("$k"); fi
  done
  if [[ ${#miss[@]} -gt 0 ]]; then
    printf '  FAIL .env.deploy is missing: %s\n       fix: make configure\n' "${miss[*]}"
    FAIL=1
  else
    printf '  ok   .env.deploy has required keys\n'
  fi

  # Best-effort scope check: CF_API_TOKEN must have Email Routing:Edit for
  # `polaris-email domain onboard` to enable routing and write rules. A GET on
  # the addresses list returns 403 with bad scopes and 200 (empty allowed) otherwise.
  if [[ -n "${CF_API_TOKEN:-}" && -n "${CF_ACCOUNT_ID:-}" ]] && command -v curl >/dev/null 2>&1; then
    er_code="$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/email/routing/addresses?per_page=1" || echo "000")"
    case "$er_code" in
      200|404) printf '  ok   CF_API_TOKEN has Email Routing scope\n' ;;
      403)     printf '  FAIL CF_API_TOKEN lacks Email Routing:Edit\n       fix: re-issue the token with Email Routing scopes (Read + Edit)\n'
               FAIL=1 ;;
      *)       printf '  warn CF_API_TOKEN Email Routing scope check inconclusive (HTTP %s)\n' "$er_code" ;;
    esac
  fi
else
  printf '  warn .env.deploy missing — run `make configure` before `make bootstrap`\n'
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "preflight failed — address the FAIL lines above." >&2
  exit 1
fi
echo "preflight OK."
