// Bridge installer — curl-pipe-able bootstrap script.
//
// Two routes, one handler:
//   * `GET /v1/installer/bridge/:token`  (api.mail.plrs.im — canonical)
//   * `GET /:token`                       (dl.mail.plrs.im  — short form)
//
// The short form lights up only when BRIDGE_INSTALLER_BASE_URL is set and
// the request's Host header matches that URL's hostname. Both paths route
// to the same handler; the only difference is the URL the operator types.
//
// KV-stash per-token bundle (bridge_id, name, hmac, deployment mode) under
// `bridge_installer:<token>` with a 1h TTL at registration time, then
// DELETE on first read so the same URL can't be replayed.
//
// Public endpoint — no admin auth. Security boundary is the token's
// unguessability (32 bytes from `generateNonce`, base32 Crockford).
//
// The emitted script:
//   1. Detects docker. If missing, prompts to run the official
//      `https://get.docker.com` install script (auto-skipped when
//      `POLARIS_AUTO_INSTALL=1` is set in the caller's env — the
//      true one-click path).
//   2. Detects `docker compose` (v2 plugin). Bails with a clear message
//      if the host has v1 only.
//   3. Writes docker-compose.yml + docker-compose.env to CWD. If files
//      already exist, apt-style diff + per-file prompt:
//      [Y]es overwrite / [N]o keep / [d]iff / [a]bort.
//   4. Writes ./secrets/{bridge_id,hmac_key} with mode 600. The TS auth
//      key + CF DNS token never touch the host disk pre-startup — the
//      bootstrap init container HMAC-fetches the TS key into
//      ./secrets/ts_authkey before the TS sidecar starts; the bridge
//      fetches the CF DNS token at /v1/bridge/config on every boot.
//   5. `docker compose pull && docker compose up -d`.
//   6. Tails `docker compose logs -f` for the operator.

import { Hono, type Context } from 'hono';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const bridgeInstaller = new Hono<{ Bindings: Env }>();

/** KV key under which a bridge-installer payload lives. */
export function bridgeInstallerKvKey(token: string): string {
  return `bridge_installer:${token}`;
}

/** 1 hour. Enough for operators to walk over to the bridge host and run curl. */
export const BRIDGE_INSTALLER_KV_TTL_SECONDS = 60 * 60;

export interface BridgeInstallerPayload {
  bridge_id: string;
  bridge_name: string;
  hmac_key: string;
  mode: 'tailscale' | 'public';
  api_url: string;
  /** Bridge image tag the script should pull. Defaults to `latest`. */
  image: string;
}

/** Token shape — same alphabet/length as `generateNonce`. */
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{24,128}$/;

async function handleInstaller(c: Context<{ Bindings: Env }>, token: string): Promise<Response> {
  if (!TOKEN_RE.test(token)) {
    return buildError(c, 'bad_request', 'invalid token format');
  }
  const raw = await c.env.KV_KEY_CACHE.get(bridgeInstallerKvKey(token));
  if (!raw) {
    return buildError(c, 'not_found', 'installer token expired or already consumed');
  }
  // One-shot: delete before we return so a replay can't pick it up.
  // Fire-and-forget — even if delete fails the TTL caps the window.
  c.executionCtx.waitUntil(c.env.KV_KEY_CACHE.delete(bridgeInstallerKvKey(token)));
  let payload: BridgeInstallerPayload;
  try {
    payload = JSON.parse(raw) as BridgeInstallerPayload;
  } catch {
    return buildError(c, 'degraded', 'installer payload corrupted');
  }
  const script = renderInstaller(payload);
  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

bridgeInstaller.get('/v1/installer/bridge/:token', (c) => handleInstaller(c, c.req.param('token')));

// Short-form: dl.mail.plrs.im/<token>. Mounted at the root so the URL is
// `dl.mail.plrs.im/<token>` with no path prefix. Host check filters this
// out on api.mail.plrs.im (where bare `/<token>` would otherwise shadow
// unrelated 404s but never returns a 200 because the host gate fails).
bridgeInstaller.get('/:token', (c) => {
  const base = c.env.BRIDGE_INSTALLER_BASE_URL;
  if (!base) return buildError(c, 'not_found', 'short-form installer route disabled');
  let expectedHost: string;
  try {
    expectedHost = new URL(base).hostname;
  } catch {
    return buildError(c, 'degraded', 'BRIDGE_INSTALLER_BASE_URL is not a valid URL');
  }
  const host = new URL(c.req.url).hostname;
  if (host !== expectedHost) {
    return buildError(c, 'not_found', 'use /v1/installer/bridge/<token> on this host');
  }
  return handleInstaller(c, c.req.param('token'));
});

function renderInstaller(p: BridgeInstallerPayload): string {
  const composeYml = p.mode === 'tailscale' ? composeTailscale(p) : composePublic(p);
  const composeEnv = composeEnvFile(p);
  // POSIX sh. Stays portable across Debian/Ubuntu/Alpine/RHEL.
  return `#!/usr/bin/env sh
# polaris-mail-bridge installer for ${p.bridge_name} (id=${p.bridge_id}).
# Generated by the polaris api; do not edit. The token in your URL is
# one-shot — re-running this curl will 404.
set -eu

POLARIS_BRIDGE_DIR="\${POLARIS_BRIDGE_DIR:-./polaris-mail-bridge}"
POLARIS_AUTO_INSTALL="\${POLARIS_AUTO_INSTALL:-0}"

say() { printf '\\033[1;36m▶\\033[0m %s\\n' "$*" >&2; }
warn() { printf '\\033[1;33m!\\033[0m %s\\n' "$*" >&2; }
die() { printf '\\033[1;31m✘ %s\\033[0m\\n' "$*" >&2; exit 1; }

prompt_yes() {
  # $1 = prompt text. Returns 0 on yes (default), 1 on no.
  if [ "$POLARIS_AUTO_INSTALL" = "1" ]; then return 0; fi
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    die "$1 — no TTY available; rerun with POLARIS_AUTO_INSTALL=1 to accept defaults"
  fi
  while :; do
    printf '%s [Y/n] ' "$1" >&2
    if [ -r /dev/tty ]; then
      read REPLY </dev/tty || REPLY=Y
    else
      read REPLY || REPLY=Y
    fi
    case "$REPLY" in
      Y|y|"") return 0 ;;
      N|n)    return 1 ;;
    esac
  done
}

install_docker() {
  # Use Docker Inc.'s official convenience script. It detects the distro
  # (apt/dnf/yum/zypper), adds the right repo, installs docker-ce +
  # docker-ce-cli + containerd + the compose v2 plugin in one shot.
  say "Installing Docker via https://get.docker.com"
  if [ "$(id -u)" -eq 0 ]; then
    curl -fsSL https://get.docker.com | sh
  elif command -v sudo >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sudo sh
  else
    die "Docker install needs root; rerun as root or install sudo first"
  fi
  # Add the invoking user to the docker group so subsequent compose calls
  # don't need sudo. Only relevant when we ran the install via sudo.
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    warn "Added $USER to the docker group. You may need to log out + back in"
    warn "for group membership to take effect. This script will use sudo for"
    warn "the remaining 'docker' calls in this run."
    POLARIS_DOCKER='sudo docker'
  fi
}

POLARIS_DOCKER='docker'
if ! command -v docker >/dev/null 2>&1; then
  warn "docker is not installed."
  if prompt_yes "Install Docker now via https://get.docker.com?"; then
    install_docker
  else
    die "docker is required; install it and rerun"
  fi
fi

if ! $POLARIS_DOCKER compose version >/dev/null 2>&1; then
  die "'docker compose' v2 plugin missing — get.docker.com installs it; if your distro doesn't, install 'docker-compose-plugin'"
fi

say "Installing polaris-mail-bridge '${p.bridge_name}' into $POLARIS_BRIDGE_DIR"
mkdir -p "$POLARIS_BRIDGE_DIR"
cd "$POLARIS_BRIDGE_DIR"

write_or_prompt() {
  # $1 = destination filename
  # $2 = new content
  dst="$1"
  new_content="$2"
  if [ ! -e "$dst" ]; then
    printf '%s' "$new_content" > "$dst"
    say "wrote $dst (new)"
    return 0
  fi
  if [ "$(cat "$dst")" = "$new_content" ]; then
    say "$dst unchanged — skipping"
    return 0
  fi
  warn "$dst differs from the installer's version."
  if [ "$POLARIS_AUTO_INSTALL" = "1" ]; then
    printf '%s' "$new_content" > "$dst"
    say "overwrote $dst (POLARIS_AUTO_INSTALL=1)"
    return 0
  fi
  while :; do
    printf '  [Y]es overwrite / [N]o keep / [d]iff / [a]bort? ' >&2
    read REPLY </dev/tty || REPLY=N
    case "$REPLY" in
      Y|y|"")
        printf '%s' "$new_content" > "$dst"
        say "overwrote $dst"; return 0 ;;
      N|n)
        say "kept existing $dst"; return 0 ;;
      d|D)
        tmp="$(mktemp)"
        printf '%s' "$new_content" > "$tmp"
        diff -u "$dst" "$tmp" || true
        rm -f "$tmp" ;;
      a|A)
        die "aborted by operator" ;;
    esac
  done
}

COMPOSE_YML=$(cat <<'__POLARIS_COMPOSE_YML_EOF__'
${composeYml}__POLARIS_COMPOSE_YML_EOF__
)
COMPOSE_ENV=$(cat <<'__POLARIS_COMPOSE_ENV_EOF__'
${composeEnv}__POLARIS_COMPOSE_ENV_EOF__
)

write_or_prompt docker-compose.yml "$COMPOSE_YML"
write_or_prompt docker-compose.env "$COMPOSE_ENV"

say "Writing ./secrets/ (mode 600)"
mkdir -p secrets
chmod 700 secrets
umask 077
printf '%s' '${p.bridge_id}' > secrets/bridge_id
printf '%s' '${p.hmac_key}' > secrets/hmac_key
# Tailscale auth key (if applicable) is fetched + written by the
# bootstrap init container in docker-compose.yml.
chmod 600 secrets/*

say "docker compose pull"
$POLARIS_DOCKER compose pull
say "docker compose up -d"
$POLARIS_DOCKER compose up -d

say "Bridge is running. Streaming logs (Ctrl-C to detach; bridge keeps running)"
$POLARIS_DOCKER compose logs -f
`;
}

// Compose snippets — keep aligned with the panel templates in
// `apps/panel/src/client/pages/bridges/BridgeConnectionCard.tsx`.

function composeTailscale(p: BridgeInstallerPayload): string {
  const tsHost = `${p.bridge_name}-mail`;
  return `# docker-compose.yml — bridge + Tailscale sidecar
#
# Bootstrap init: the bridge image is reused as a short-lived sibling
# that fetches the per-bridge Tailscale auth key from the polaris API
# (HMAC-authed) and writes it to ./secrets/ts_authkey before the TS
# sidecar starts. Operators never touch the TS auth key — only the
# bridge_id + HMAC key need to exist in ./secrets/ before compose up.
networks:
  polaris-mail-net:
    driver: bridge

services:
  bootstrap:
    image: ${p.image}
    container_name: polaris-mail-bootstrap
    command: ['polaris-bridge', 'bootstrap-tailscale']
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
      TS_AUTHKEY_PATH: /run/secrets/ts_authkey
    volumes:
      - ./secrets:/run/secrets

  tailscale:
    image: tailscale/tailscale:stable
    container_name: polaris-mail
    hostname: ${tsHost}
    restart: unless-stopped
    networks: [polaris-mail-net]
    cap_add: [NET_ADMIN, NET_RAW]
    devices: ['/dev/net/tun:/dev/net/tun']
    environment:
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: 'false'
      TS_EXTRA_ARGS: --advertise-tags=tag:mail-bridge
      TS_AUTHKEY_FILE: /run/secrets/ts_authkey
    volumes:
      - ts-state:/var/lib/tailscale
      - ./secrets:/run/secrets:ro
    depends_on:
      bootstrap:
        condition: service_completed_successfully

  bridge:
    image: ${p.image}
    container_name: polaris-mail-bridge
    restart: unless-stopped
    network_mode: 'service:tailscale'
    depends_on:
      - tailscale
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
    volumes:
      - ./secrets:/run/secrets:ro
      - bridge-certs:/var/lib/polaris-bridge/certs
      - bridge-data:/var/lib/polaris-bridge
      - bridge-logs:/var/log/polaris-bridge

volumes:
  ts-state:
  bridge-certs:
  bridge-data:
  bridge-logs:
`;
}

function composePublic(p: BridgeInstallerPayload): string {
  return `# docker-compose.yml — bridge on public host (no Tailscale)
services:
  bridge:
    image: ${p.image}
    container_name: polaris-mail-bridge
    restart: unless-stopped
    network_mode: host
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
    volumes:
      - ./secrets:/run/secrets:ro
      - bridge-certs:/var/lib/polaris-bridge/certs
      - bridge-data:/var/lib/polaris-bridge
      - bridge-logs:/var/log/polaris-bridge

volumes:
  bridge-certs:
  bridge-data:
  bridge-logs:
`;
}

function composeEnvFile(p: BridgeInstallerPayload): string {
  return `# docker-compose.env — referenced by docker-compose.yml via env_file.
# No secrets in here; the HMAC key + bridge id (and TS auth key) live
# as files under ./secrets/ that the bridge reads via *_FILE env vars.

BRIDGE_NAME=${p.bridge_name}
BRIDGE_POLARIS_API_URL=${p.api_url}
`;
}
