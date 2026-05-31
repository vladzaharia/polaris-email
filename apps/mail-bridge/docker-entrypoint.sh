#!/bin/sh
# docker-entrypoint.sh — chown bridge state volumes to the polaris user
# before dropping privileges and exec'ing the bridge.
#
# Why: docker named volumes are created root-owned, regardless of the
# image's USER directive or build-time chown. The bridge runs as
# `polaris`, so without this fixup it gets EACCES on the first write
# to /var/lib/polaris-bridge/certs/ (the embedded ACME loop's first
# write target) — see the loop the bridge falls into on a fresh
# install. Bind mounts mounted from host paths with arbitrary
# ownership hit the same trap.
#
# Implementation: enter as root (Dockerfile drops the USER directive),
# chown only the directories the bridge actually writes (state +
# logs), then su-exec into polaris for the bridge itself.
set -eu

# The certs dir lives under state; -R catches everything operators
# may have left behind from older images that ran as root.
# /run/bridge-runtime is the install template's writable surface that
# bootstrap-tailscale writes to before the TS sidecar reads it (the
# operator's ./secrets/ bind-mount stays read-only for the bridge).
for dir in /var/lib/polaris-bridge /var/log/polaris-bridge /run/bridge-runtime; do
  if [ -d "$dir" ]; then
    chown -R polaris:polaris "$dir" 2>/dev/null || true
  fi
done

exec su-exec polaris:polaris /usr/local/bin/polaris-bridge "$@"
