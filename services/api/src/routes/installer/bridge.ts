// Bridge installer — curl-pipe-able bootstrap script.
//
// URL shape: the install URL IS the credential. It carries the bridge
// id + the HMAC plaintext as path segments:
//
//   https://dl.mail.plrs.im/bridge/<bridge_id>/<hmac>     (short form)
//   https://<api>/v1/installer/bridge/<bridge_id>/<hmac>  (canonical)
//
// Server-side we look up the bridge row by id and verify the HMAC
// against its stored hash via `verifyPbkdf2`. Wrong/missing → 404. There
// is no KV indirection: the URL itself carries everything needed to
// install the bridge, and rotating the HMAC immediately invalidates
// every install URL ever minted with the old one. That symmetry is
// deliberate — operators only get an install URL via the rotate path,
// so possessing a working URL is equivalent to possessing the current
// HMAC.
//
// Teardown window: because the URL is a live credential, it only serves
// for a bounded window after issuance (`bridges.installer_window_expires_at`,
// opened on register/rotate, closed early by the first successful
// heartbeat). Past the deadline we 404 with the same generic message as
// a bad HMAC — operators rotate to mint a fresh link.

import { Hono, type Context } from 'hono';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';
import { verifyPbkdf2 } from '../../hashing.js';
import { bridgePlainNextKvKey } from '../../bridge-auth.js';

export const bridgeInstaller = new Hono<{ Bindings: Env }>();

/** ULID — 26 chars, Crockford base32. */
const BRIDGE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** 256-bit secret in Crockford base32 (see `packages/hmac.generateSecret`). 52 chars. */
const HMAC_RE = /^[0-9A-HJKMNP-TV-Z]{40,80}$/;

interface BridgeRowForInstaller {
  id: string;
  name: string;
  hmac_key_secret_name: string | null;
  ts_authkey_id: string | null;
  disabled_at: string | null;
  hmac_pending_rotated_at: string | null;
  installer_window_expires_at: string | null;
}

async function handleInstaller(
  c: Context<{ Bindings: Env }>,
  bridgeId: string,
  hmac: string,
): Promise<Response> {
  if (!BRIDGE_ID_RE.test(bridgeId) || !HMAC_RE.test(hmac)) {
    return buildError(c, 'bad_request', 'invalid install URL format');
  }
  const row = await c.env.DB.prepare(
    `SELECT id, name, hmac_key_secret_name, ts_authkey_id, disabled_at,
            hmac_pending_rotated_at, installer_window_expires_at
     FROM bridges WHERE id = ?`,
  )
    .bind(bridgeId)
    .first<BridgeRowForInstaller>();
  // 404 on missing, disabled, or wrong HMAC — never disclose which.
  // The whole URL is the credential; a wrong-HMAC response is
  // indistinguishable from a wrong-id response.
  if (!row || row.disabled_at || !row.hmac_key_secret_name) {
    return buildError(c, 'not_found', 'install URL invalid or bridge unavailable');
  }
  let ok = await verifyPbkdf2(row.hmac_key_secret_name, hmac, c.env.ARGON2_PEPPER);
  // Staged-roll case: the new HMAC is in KV at bridge_plain_next:<id>
  // and won't be written to hmac_key_secret_name until the bridge
  // acks the directive. Until then, the install URL returned from
  // POST /v1/admin/bridges/:id/rotate carries the new key and would
  // otherwise 404 here. Accept either the persisted hash OR the
  // staged plaintext — only relevant when hmac_pending_rotated_at is
  // set (i.e. a staged roll is in flight).
  if (!ok && row.hmac_pending_rotated_at) {
    const stagedPlain = await c.env.KV_KEY_CACHE.get(bridgePlainNextKvKey(bridgeId));
    if (stagedPlain && stagedPlain === hmac) {
      ok = true;
    }
  }
  if (!ok) return buildError(c, 'not_found', 'install URL invalid or bridge unavailable');

  // Installer-link teardown. The install URL is a leaky credential (it
  // carries the live HMAC), so it only serves for a bounded window after
  // issuance: NULL window ⇒ already closed (legacy rows + post-heartbeat),
  // past deadline ⇒ expired. Either way return the SAME generic 404 as a
  // bad HMAC — never disclose that the credential was valid-but-expired.
  // The operator rotates to mint a fresh link (which re-opens the window).
  const windowExp = row.installer_window_expires_at;
  if (windowExp == null || Date.now() >= Date.parse(windowExp)) {
    return buildError(c, 'not_found', 'install URL invalid or bridge unavailable');
  }

  // `ts_authkey_id` presence is our mode signal — same heuristic as
  // rotate. Tailscale bridges carry the column; public ones don't.
  const mode: 'tailscale' | 'public' = row.ts_authkey_id != null ? 'tailscale' : 'public';
  const script = renderInstaller({
    bridge_id: row.id,
    bridge_name: row.name,
    hmac_key: hmac,
    mode,
    api_url: c.env.API_BASE_URL,
    image: 'ghcr.io/vladzaharia/polaris-mail-bridge:latest',
  });
  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

bridgeInstaller.get('/v1/installer/bridge/:bridgeId/:hmac', (c) =>
  handleInstaller(c, c.req.param('bridgeId'), c.req.param('hmac')),
);
bridgeInstaller.get('/bridge/:bridgeId/:hmac', (c) =>
  handleInstaller(c, c.req.param('bridgeId'), c.req.param('hmac')),
);

interface RenderArgs {
  bridge_id: string;
  bridge_name: string;
  hmac_key: string;
  mode: 'tailscale' | 'public';
  api_url: string;
  image: string;
}

function renderInstaller(p: RenderArgs): string {
  const composeYml = p.mode === 'tailscale' ? composeTailscale(p) : composePublic(p);
  const composeEnv = composeEnvFile(p);
  // POSIX sh. Portable across Debian/Ubuntu/Alpine/RHEL.
  return `#!/usr/bin/env sh
# polaris-mail-bridge installer for ${p.bridge_name} (id=${p.bridge_id}).
# Generated by the polaris api; do not edit.
#
# The URL you fetched carries this bridge's current HMAC key, so it
# stays valid until the next rotation. After a rotate, every previously
# generated URL stops working — fetch a new one from the panel.
set -eu

POLARIS_BRIDGE_DIR="\${POLARIS_BRIDGE_DIR:-./polaris-mail-bridge}"
POLARIS_AUTO_INSTALL="\${POLARIS_AUTO_INSTALL:-0}"

say() { printf '\\033[1;36m▶\\033[0m %s\\n' "$*" >&2; }
warn() { printf '\\033[1;33m!\\033[0m %s\\n' "$*" >&2; }
die() { printf '\\033[1;31m✘ %s\\033[0m\\n' "$*" >&2; exit 1; }

prompt_yes() {
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
  say "Installing Docker via https://get.docker.com"
  if [ "$(id -u)" -eq 0 ]; then
    curl -fsSL https://get.docker.com | sh
  elif command -v sudo >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sudo sh
  else
    die "Docker install needs root; rerun as root or install sudo first"
  fi
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

say "Writing ./secrets/ (dir 711, files 644)"
mkdir -p secrets
# Directory is 711 (rwx for owner, --x for others). On Linux a process
# needs +x on every dir in a path to open() any file inside it. The
# bridge container runs as alpine's polaris user (UID ~100), not the
# host UID owning this dir — without +x for others the container hits
# EACCES traversing /run/secrets/, regardless of file mode. 711 still
# hides directory *listing* from anyone but the owner, so secret
# filenames stay un-enumerable; only a process that already knows the
# exact path (the bridge does — via BRIDGE_POLARIS_*_FILE) can open them.
chmod 711 secrets
printf '%s' '${p.bridge_id}' > secrets/bridge_id
printf '%s' '${p.hmac_key}' > secrets/hmac_key
# Files are 644 for the same UID-mismatch reason. Container only needs
# read; write is host-side via this installer.
chmod 644 secrets/*

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

function composeTailscale(p: RenderArgs): string {
  const tsHost = `${p.bridge_name}-mail`;
  return `# docker-compose.yml — bridge + Tailscale sidecar
#
# Bootstrap init: the bridge image is reused as a short-lived sibling
# that fetches the per-bridge Tailscale auth key from the polaris API
# (HMAC-authed) and writes it to the \`bridge-runtime\` docker volume.
# The TS sidecar reads from the same volume via TS_AUTHKEY_FILE.
#
# Why a docker volume (not the operator's ./secrets/ bind mount): the
# host secrets dir is mode 0711, owned by the operator UID — the
# bridge container runs as a non-root user that can read the existing
# bridge_id/hmac_key files but cannot create new files there. The
# docker volume gives bootstrap a writable shared surface that's still
# isolated from the host fs.
networks:
  polaris-mail-net:
    driver: bridge

services:
  bootstrap:
    image: ${p.image}
    container_name: polaris-mail-bootstrap
    # The image ENTRYPOINT already exec's the polaris-bridge binary and
    # appends this list as its args, so pass ONLY the subcommand here —
    # prefixing 'polaris-bridge' again makes os.Args[1] = "polaris-bridge",
    # which misses the bootstrap-tailscale dispatch and silently runs the
    # full bridge daemon instead of the one-shot authkey fetch.
    command: ['bootstrap-tailscale']
    env_file: docker-compose.env
    environment:
      BRIDGE_POLARIS_BRIDGE_ID_FILE: /run/secrets/bridge_id
      BRIDGE_POLARIS_HMAC_KEY_FILE: /run/secrets/hmac_key
      TS_AUTHKEY_PATH: /run/bridge-runtime/ts_authkey
    volumes:
      - ./secrets:/run/secrets:ro
      - bridge-runtime:/run/bridge-runtime

  tailscale:
    image: tailscale/tailscale:stable
    container_name: polaris-mail-ts
    hostname: ${tsHost}
    restart: unless-stopped
    networks: [polaris-mail-net]
    cap_add: [NET_ADMIN, NET_RAW]
    devices: ['/dev/net/tun:/dev/net/tun']
    environment:
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: 'false'
      TS_EXTRA_ARGS: --advertise-tags=tag:mail-bridge
      TS_AUTHKEY_FILE: /run/bridge-runtime/ts_authkey
      # Only log in if not already logged in. The per-bridge auth key is
      # single-use; without this, containerboot re-runs \`tailscale up\` with
      # the (now consumed) key on every restart and falls back to an
      # interactive auth URL. With it, the node identity in ts-state is
      # reused and the key is only spent on the first join.
      TS_AUTH_ONCE: 'true'
    volumes:
      - ts-state:/var/lib/tailscale
      - bridge-runtime:/run/bridge-runtime:ro
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
  bridge-runtime:
  bridge-certs:
  bridge-data:
  bridge-logs:
`;
}

function composePublic(p: RenderArgs): string {
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

function composeEnvFile(p: RenderArgs): string {
  return `# docker-compose.env — referenced by docker-compose.yml via env_file.
# No secrets in here; the HMAC key + bridge id (and TS auth key) live
# as files under ./secrets/ that the bridge reads via *_FILE env vars.

BRIDGE_NAME=${p.bridge_name}
BRIDGE_POLARIS_API_URL=${p.api_url}
`;
}
