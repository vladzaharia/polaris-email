#!/usr/bin/env bash
# Walk audit_log from id=0 → head and re-compute every row_hash. Exit 1 on chain break.
set -euo pipefail
DB="${1:-polaris-email}"
wrangler d1 execute "$DB" --remote --json --command \
  "SELECT id, actor, action, target, meta_json, prev_hash, row_hash, at FROM audit_log ORDER BY id ASC" \
  > /tmp/audit.json
python3 - <<'PY' /tmp/audit.json
import json, hashlib, sys
rows = json.load(open(sys.argv[1]))['results'] if isinstance(json.load(open(sys.argv[1])), dict) else json.load(open(sys.argv[1]))
prev = '0'*64
bad = 0
for r in rows:
    if r['id'] == 0:
        prev = r['row_hash']; continue
    if r['prev_hash'] != prev:
        print('BROKEN prev_hash at id', r['id']); bad += 1
    canonical = '\n'.join([r['actor'], r['action'], r['target'] or '', r['meta_json'], r['prev_hash'], str(r['at'])])
    expected = hashlib.sha256(canonical.encode()).hexdigest()
    if expected != r['row_hash']:
        print('BROKEN row_hash at id', r['id']); bad += 1
    prev = r['row_hash']
print('rows:', len(rows), 'broken:', bad)
sys.exit(1 if bad else 0)
PY
