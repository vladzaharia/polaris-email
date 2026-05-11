# Runbook: bridge rebuild

The bridge host failed (disk, hardware, hypervisor). You need a fresh box with the same Tailnet identity and no IMAP UID changes for clients.

## Pre-flight

1. The replacement host has Tailscale installed and is online with the Tailnet.
2. You have access to `apps/bridge/.env` values (TS_AUTHKEY, POLARIS_BRIDGE_KEY_ID/SECRET, etc.) from the password manager.

## Procedure

```sh
git clone <polaris-email-repo>
cd polaris-email/apps/bridge
cp .env.example .env
# Edit .env with values from password manager. Use the SAME hostname (`polaris-email`).

docker compose pull
docker compose up -d ts
# Wait for ts to register with the tailnet under the existing tailnet machine record.
# If the old machine record is still active, remove it from the Tailscale admin console first.

docker compose up -d cert-init
docker compose up -d mox sidecar
docker compose logs -f sidecar
```

The sidecar boots, fetches `/v1/bridge/config`, and walks every mailbox with `retain_imap=true`. For each, it queries `messages` for any row where `direction='in'` AND `delivered_to_imap_at IS NOT NULL`, fetches the R2 blob, and uses `MessageImport` with `imap_uidvalidity` from D1 preserved. After backfill is complete (~minutes), normal sync resumes.

## Verification

1. Connect with `mutt` to `polaris-email.<tailnet>.ts.net:993` using a known mailbox cred — confirm INBOX message count matches expectations.
2. Confirm `bridge.reload` rows appear in `audit_log` for this host.
3. Send a test message; confirm it appears in the right INBOX within ≤5 s.
