#!/usr/bin/env bash
# deploy.sh — deploy one Worker, all Workers, or only changed ones.
# Usage:
#   bin/deploy.sh services/api          # single service (back-compat)
#   bin/deploy.sh --all                 # every service in dependency order
#   bin/deploy.sh --changed             # only services whose code or transitive deps changed since deployed/main
set -euo pipefail
# shellcheck source=bin/_lib.sh
source "$(dirname "$0")/_lib.sh"
cd "$ROOT"

MODE="single"
TARGET=""
case "${1:-}" in
  "")          echo "usage: bin/deploy.sh <services/api|--all|--changed>" >&2; exit 2 ;;
  --all)       MODE="all" ;;
  --changed)   MODE="changed" ;;
  *)           MODE="single"; TARGET="$1" ;;
esac

# Deploy a single service directory. Records the resulting version into .deploy-state.json.
deploy_one() {
  local svc_path="$1"
  local svc_name="${svc_path#services/}"; svc_name="${svc_name#apps/}"
  local dir="$ROOT/$svc_path"
  [[ -d "$dir" ]] || { warn "no such dir: $dir — skipping"; return 0; }
  log "deploying $svc_path"
  (
    cd "$dir"
    if [[ -f wrangler.jsonc && -f wrangler.local.jsonc ]]; then
      # Strip // line-comments before jq merge. Two-pass so we don't eat the `//` inside URLs:
      # only strip when `//` follows whitespace or starts a line.
      PUB="$(sed -E -e 's|[[:space:]]+//.*$||' -e 's|^//.*$||' wrangler.jsonc)"
      LOCAL="$(sed -E -e 's|[[:space:]]+//.*$||' -e 's|^//.*$||' wrangler.local.jsonc)"
      jq -s '.[0] * .[1]' <(printf '%s' "$PUB") <(printf '%s' "$LOCAL") > .wrangler.merged.json
      out="$(wrangler deploy --config .wrangler.merged.json 2>&1)"
      rc=$?
      rm -f .wrangler.merged.json
    else
      out="$(wrangler deploy 2>&1)"
      rc=$?
    fi
    printf '%s\n' "$out"
    if [[ "$rc" -ne 0 ]]; then exit "$rc"; fi
    # Try to capture the deployed version id from "Current Version ID: <uuid>".
    vid="$(printf '%s' "$out" | grep -Eo 'Current Version ID: [0-9a-f-]+' | awk '{print $4}' | head -1 || true)"
    sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    state_set ".deploys[\$name] = {version_id: \$vid, sha: \$sha, at: \$at}" \
      name "$svc_name" vid "${vid:-}" sha "$sha" at "$(date -u +%FT%TZ)"
  )
}

case "$MODE" in
  single)
    deploy_one "$TARGET"
    ;;
  all)
    for svc in "${POLARIS_SERVICES[@]}"; do
      deploy_one "services/$svc"
    done
    sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    printf '%s' "$sha" > "$LAST_SHA_FILE"
    log "all services deployed at $sha"
    ;;
  changed)
    need git
    need jq
    base_sha="$(cat "$LAST_SHA_FILE" 2>/dev/null || true)"
    if [[ -z "$base_sha" ]]; then
      base_sha="$(git rev-parse deployed/main 2>/dev/null || true)"
    fi
    if [[ -z "$base_sha" ]]; then
      base_sha="$(git rev-list --max-parents=0 HEAD | head -1)"
      log "no prior deploy SHA — falling back to repo root commit $base_sha"
    fi
    head_sha="$(git rev-parse HEAD)"
    if [[ "$base_sha" == "$head_sha" ]]; then
      log "HEAD == last deploy ($head_sha) — nothing to do"
      exit 0
    fi
    log "diffing $base_sha..$head_sha"
    changed_files="$(git diff --name-only "$base_sha".."$head_sha" || true)"
    if [[ -z "$changed_files" ]]; then
      log "no file changes — nothing to deploy"
      exit 0
    fi

    # Build a reverse dependency map: package-name -> list of services that depend on it.
    # We do this by reading every services/*/package.json and recording its dependencies +
    # devDependencies whose names match a workspace package.
    declare -A PKG_DEPS=()           # service-name -> space-separated list of workspace pkg deps
    workspace_pkgs="$(jq -r '.name' packages/*/package.json 2>/dev/null || true)"
    for svc in "${POLARIS_SERVICES[@]}"; do
      pj="services/$svc/package.json"
      [[ -f "$pj" ]] || continue
      deps="$(jq -r '((.dependencies // {}) + (.devDependencies // {})) | keys[]' "$pj" 2>/dev/null || true)"
      depset=""
      while IFS= read -r d; do
        if printf '%s\n' "$workspace_pkgs" | grep -qxF "$d"; then
          depset+="$d "
        fi
      done <<< "$deps"
      PKG_DEPS["$svc"]="$depset"
    done

    declare -A TO_DEPLOY=()

    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      case "$f" in
        services/*)
          svc="${f#services/}"; svc="${svc%%/*}"
          TO_DEPLOY["$svc"]=1
          ;;
        packages/*)
          pkg_dir="${f#packages/}"; pkg_dir="${pkg_dir%%/*}"
          pkg_pj="packages/$pkg_dir/package.json"
          if [[ -f "$pkg_pj" ]]; then
            pkg_name="$(jq -r '.name' "$pkg_pj")"
            # Find services that depend on this package.
            for svc in "${POLARIS_SERVICES[@]}"; do
              if [[ " ${PKG_DEPS[$svc]:-} " == *" $pkg_name "* ]]; then
                TO_DEPLOY["$svc"]=1
              fi
            done
          fi
          ;;
        bin/*|Makefile|.env.deploy)
          : ;; # ignored — orchestration changes don't trigger a deploy
        *) : ;;
      esac
    done <<< "$changed_files"

    if [[ "${#TO_DEPLOY[@]}" -eq 0 ]]; then
      log "no service-impacting changes detected — nothing to deploy"
      printf '%s' "$head_sha" > "$LAST_SHA_FILE"
      exit 0
    fi

    log "deploying changed services: ${!TO_DEPLOY[*]}"
    # Iterate in canonical order, not arbitrary hash order.
    for svc in "${POLARIS_SERVICES[@]}"; do
      if [[ -n "${TO_DEPLOY[$svc]:-}" ]]; then
        deploy_one "services/$svc"
      fi
    done
    printf '%s' "$head_sha" > "$LAST_SHA_FILE"
    log "deploy-changed complete at $head_sha"
    ;;
esac
