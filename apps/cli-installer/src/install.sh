#!/usr/bin/env sh
# polaris-email installer.
#
# Served from cli.mail.plrs.im. Source of truth lives at
# apps/cli-installer/src/install.sh in the polaris-email repo. Re-deploying
# the cli-installer Worker rolls the script forward.
#
# Usage:
#   curl -fsSL cli.mail.plrs.im | sh                # install latest
#   curl -fsSL cli.mail.plrs.im | sh -s -- install  # install latest (explicit)
#   curl -fsSL cli.mail.plrs.im | sh -s -- upgrade  # install / upgrade
#   curl -fsSL cli.mail.plrs.im | sh -s -- <args>   # install if missing, then `polaris-email <args>`
#   curl -fsSL "cli.mail.plrs.im/?v=v1.2.3" | sh    # install pinned version v1.2.3
#
# Env vars:
#   POLARIS_INSTALL_DIR   target install directory (default: /usr/local/bin
#                         when root, else $XDG_DATA_HOME/polaris-email/bin or
#                         ~/.local/bin)
#   POLARIS_NO_PATH_HINT  set to 1 to suppress the post-install PATH hint
#   GH_TOKEN              optional GitHub token for higher rate limits
#
# POSIX sh — passes `shellcheck -s sh`. No bashisms; no `[[ ]]`; no arrays.
set -eu

POLARIS_REPO='vladzaharia/polaris-email'
POLARIS_BIN_NAME='polaris-email'
POLARIS_SYMLINK='pml'
# Populated by the cli-installer Worker when ?v=<version> is supplied.
# The Worker rewrites this exact line via regex; do not reformat it.
POLARIS_PIN_VERSION=''

# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------
log() { printf '%s\n' "polaris-email: $*" >&2; }
warn() { printf '%s\n' "polaris-email: warning: $*" >&2; }
die() {
    printf '%s\n' "polaris-email: error: $*" >&2
    exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
preflight() {
    if ! have curl && ! have wget; then
        die "curl or wget is required"
    fi
    have tar || die "tar is required"
    have uname || die "uname is required"
    if ! have shasum && ! have sha256sum; then
        warn "neither shasum nor sha256sum is available; SHA256 verification will be skipped"
    fi
}

# ---------------------------------------------------------------------------
# OS / arch detect
# ---------------------------------------------------------------------------
detect_os() {
    os_raw=$(uname -s)
    case "$os_raw" in
        Darwin) printf '%s' 'darwin' ;;
        Linux) printf '%s' 'linux' ;;
        *) die "unsupported OS: $os_raw" ;;
    esac
}

detect_arch() {
    arch_raw=$(uname -m)
    case "$arch_raw" in
        x86_64 | amd64) printf '%s' 'amd64' ;;
        arm64 | aarch64) printf '%s' 'arm64' ;;
        *) die "unsupported arch: $arch_raw" ;;
    esac
}

# ---------------------------------------------------------------------------
# install dir
# ---------------------------------------------------------------------------
resolve_install_dir() {
    if [ -n "${POLARIS_INSTALL_DIR:-}" ]; then
        printf '%s' "$POLARIS_INSTALL_DIR"
        return
    fi
    uid=$(id -u 2>/dev/null || printf '%s' 1000)
    if [ "$uid" = "0" ]; then
        printf '%s' '/usr/local/bin'
        return
    fi
    if [ -n "${XDG_DATA_HOME:-}" ]; then
        printf '%s' "$XDG_DATA_HOME/polaris-email/bin"
        return
    fi
    printf '%s' "${HOME:-/tmp}/.local/bin"
}

# ---------------------------------------------------------------------------
# HTTP helpers (curl OR wget, both supported)
# ---------------------------------------------------------------------------
# http_get URL [DEST]
#   Without DEST, prints body to stdout.
#   With    DEST, writes body to DEST.
# Honors GH_TOKEN by sending Authorization: Bearer.
http_get() {
    _url=$1
    _dest=${2:-}
    if have curl; then
        if [ -n "${GH_TOKEN:-}" ]; then
            if [ -n "$_dest" ]; then
                curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -o "$_dest" "$_url"
            else
                curl -fsSL -H "Authorization: Bearer $GH_TOKEN" "$_url"
            fi
        else
            if [ -n "$_dest" ]; then
                curl -fsSL -o "$_dest" "$_url"
            else
                curl -fsSL "$_url"
            fi
        fi
    else
        if [ -n "${GH_TOKEN:-}" ]; then
            if [ -n "$_dest" ]; then
                wget -q --header "Authorization: Bearer $GH_TOKEN" -O "$_dest" "$_url"
            else
                wget -q --header "Authorization: Bearer $GH_TOKEN" -O - "$_url"
            fi
        else
            if [ -n "$_dest" ]; then
                wget -q -O "$_dest" "$_url"
            else
                wget -q -O - "$_url"
            fi
        fi
    fi
}

# ---------------------------------------------------------------------------
# version resolution
# ---------------------------------------------------------------------------
resolve_target_version() {
    if [ -n "$POLARIS_PIN_VERSION" ]; then
        printf '%s' "$POLARIS_PIN_VERSION"
        return
    fi
    api_url="https://api.github.com/repos/$POLARIS_REPO/releases/latest"
    # GitHub API returns JSON; extract `"tag_name": "vX.Y.Z"` without jq.
    tag=$(http_get "$api_url" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    [ -n "$tag" ] || die "could not determine latest release tag from $api_url"
    printf '%s' "$tag"
}

resolve_installed_version() {
    if ! have "$POLARIS_BIN_NAME"; then
        printf '%s' ''
        return
    fi
    # Expect first line of `polaris-email version` like: "polaris-email v1.2.3 (abc1234, 2026-01-01)"
    raw=$("$POLARIS_BIN_NAME" version 2>/dev/null | head -1 || true)
    ver=$(printf '%s' "$raw" | sed -E 's/.*[[:space:]](v?[0-9]+\.[0-9]+\.[0-9]+([-A-Za-z0-9.+]+)?).*/\1/')
    case "$ver" in
        v* | [0-9]*) printf '%s' "$ver" ;;
        *) printf '%s' '' ;;
    esac
}

normalize_version() {
    # Strip leading 'v' for archive filename use.
    case "$1" in
        v*) printf '%s' "${1#v}" ;;
        *) printf '%s' "$1" ;;
    esac
}

# ---------------------------------------------------------------------------
# checksum verify
# ---------------------------------------------------------------------------
# sha256_of FILE -> lower-hex digest on stdout.
sha256_of() {
    if have shasum; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif have sha256sum; then
        sha256sum "$1" | awk '{print $1}'
    else
        printf '%s' ''
    fi
}

# Look up the expected digest for $1 in checksums.txt at $2.
expected_sha_for() {
    _name=$1
    _checksums=$2
    # checksums.txt lines look like: "<sha>  polaris-email_1.2.3_linux_amd64.tar.gz"
    grep -E "  ${_name}\$" "$_checksums" | awk '{print $1}' | head -1
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
do_install() {
    target_version=$(resolve_target_version)
    installed_version=$(resolve_installed_version)

    if [ -n "$installed_version" ] && [ "$installed_version" = "$target_version" ]; then
        log "polaris-email $installed_version is already installed; skipping download"
        return 0
    fi

    os=$(detect_os)
    arch=$(detect_arch)
    version_no_v=$(normalize_version "$target_version")
    archive_name="polaris-email_${version_no_v}_${os}_${arch}.tar.gz"
    base="https://github.com/$POLARIS_REPO/releases/download/$target_version"
    archive_url="$base/$archive_name"
    checksums_url="$base/checksums.txt"

    tmp=$(mktemp -d 2>/dev/null || mktemp -d -t polaris-email)
    [ -n "$tmp" ] || die "could not create temporary directory"
    # POSIX trap; runs on EXIT / INT / TERM.
    trap 'rm -rf "$tmp"' EXIT INT TERM

    log "downloading $archive_name (version $target_version, $os/$arch)"
    http_get "$archive_url" "$tmp/$archive_name" \
        || die "failed to download $archive_url"
    http_get "$checksums_url" "$tmp/checksums.txt" \
        || die "failed to download $checksums_url"

    expected=$(expected_sha_for "$archive_name" "$tmp/checksums.txt")
    actual=$(sha256_of "$tmp/$archive_name")
    if [ -z "$expected" ]; then
        warn "no SHA256 entry for $archive_name in checksums.txt; continuing without verification"
    elif [ -z "$actual" ]; then
        warn "no SHA256 tool available; continuing without verification"
    elif [ "$expected" != "$actual" ]; then
        die "SHA256 mismatch for $archive_name: expected $expected, got $actual"
    else
        log "verified SHA256 for $archive_name"
    fi

    log "extracting archive"
    tar -xzf "$tmp/$archive_name" -C "$tmp" || die "tar extraction failed"

    [ -f "$tmp/$POLARIS_BIN_NAME" ] || die "extracted archive does not contain $POLARIS_BIN_NAME"

    install_dir=$(resolve_install_dir)
    mkdir -p "$install_dir" || die "could not create $install_dir"

    log "installing to $install_dir"
    # Use `cp` rather than `install(1)` since busybox install may differ.
    cp "$tmp/$POLARIS_BIN_NAME" "$install_dir/$POLARIS_BIN_NAME.new"
    chmod 0755 "$install_dir/$POLARIS_BIN_NAME.new"
    mv "$install_dir/$POLARIS_BIN_NAME.new" "$install_dir/$POLARIS_BIN_NAME"

    # `pml` symlink. Only overwrite if it's a symlink or missing — preserve
    # any operator-customised file at that path.
    pml_path="$install_dir/$POLARIS_SYMLINK"
    if [ -L "$pml_path" ] || [ ! -e "$pml_path" ]; then
        ln -sf "$POLARIS_BIN_NAME" "$pml_path"
    else
        warn "$pml_path exists and is not a symlink; leaving it alone"
    fi

    # macOS Gatekeeper: strip the quarantine xattr so the binary is runnable
    # without a right-click "Open" prompt.
    if [ "$os" = "darwin" ] && have xattr; then
        xattr -d com.apple.quarantine "$install_dir/$POLARIS_BIN_NAME" 2>/dev/null || true
    fi

    log "installed polaris-email $target_version to $install_dir/$POLARIS_BIN_NAME"

    # PATH hint.
    if [ "${POLARIS_NO_PATH_HINT:-0}" != "1" ] && ! printf '%s' ":$PATH:" | grep -q ":$install_dir:"; then
        printf '\n'
        log "$install_dir is not on your PATH."
        log "Add it to your shell profile, e.g.:"
        log "  export PATH=\"$install_dir:\$PATH\""
        printf '\n'
    fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    preflight

    # Determine action + pass-through args.
    action='install'
    passthrough=''
    if [ "$#" -gt 0 ]; then
        case "$1" in
            install | upgrade)
                action=$1
                shift
                # Any remaining args are passed through verbatim.
                if [ "$#" -gt 0 ]; then
                    passthrough="$*"
                fi
                ;;
            *)
                # Any other first arg is treated as a polaris-email subcommand.
                action='install-then-exec'
                passthrough="$*"
                ;;
        esac
    fi

    do_install

    if [ "$action" = "install-then-exec" ]; then
        # Resolve the freshly-installed binary; prefer install_dir over $PATH.
        install_dir=$(resolve_install_dir)
        bin="$install_dir/$POLARIS_BIN_NAME"
        if [ ! -x "$bin" ]; then
            # Fall back to $PATH lookup.
            bin=$POLARIS_BIN_NAME
        fi
        # Pass through the original args. Note: $passthrough is unquoted so
        # word-splitting reconstructs the original argv.
        # shellcheck disable=SC2086
        exec "$bin" $passthrough
    fi
}

main "$@"
