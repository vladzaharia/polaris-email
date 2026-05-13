#!/usr/bin/env bash
# Spike 6: Workers Paid plan + raised cpu_ms + Argon2id timing budget.

source "$(dirname "$0")/_lib.sh"
require_jq

cat <<'EOF'
==> Two confirmations to make:

1. PAID PLAN:
   - Visit dash.cloudflare.com -> Workers & Pages -> Plans
   - Confirm "Workers Paid" or higher subscription is active
   - Without it, raised cpu_ms is unavailable and the design WILL exceed budget

2. CPU BUDGET FOR ARGON2ID:
   - Deploy a trivial Worker that runs Argon2id on a 256-byte input
   - Measure cpu_ms reported in the response
   - Argon2id parameters to test (production-grade): t=3, m=64MB, p=1
   - If cpu_ms > 30 (out of standard 50ms budget), Argon2id MUST move out of
     the request path (see I5)

Sample Worker for the CPU test (deploy + curl):
EOF

mkdir -p "$(dirname "$0")/cpu-spike/src"
cat > "$(dirname "$0")/cpu-spike/wrangler.toml" <<'WRANGLER'
name = "polaris-cpu-spike"
main = "src/worker.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[limits]
cpu_ms = 1000
WRANGLER

# Argon2 in Workers requires WASM; this stub uses a JS fallback using Web Crypto
# as a stand-in for shape — the real Argon2id timing must be measured with
# `argon2-browser` or a wasm build.
cat > "$(dirname "$0")/cpu-spike/src/worker.ts" <<'WORKER'
// NOTE: replace with a real Argon2id wasm impl (e.g., `argon2-browser`) for accurate timing.
// This stub uses PBKDF2 as a baseline lower bound; real Argon2id will be slower.

export default {
  async fetch(): Promise<Response> {
    const enc = new TextEncoder();
    const password = enc.encode("spike-test-password-with-some-length-padding-1234567890");
    const salt = enc.encode("polaris-spike-salt-16b");

    const t0 = Date.now();
    const baseKey = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
      baseKey,
      256
    );
    const wallMs = Date.now() - t0;

    return Response.json({
      // PBKDF2 600k iters is roughly comparable to Argon2id t=3,m=64MB on a CPU,
      // but Argon2id will use more memory + be slower in a Workers isolate.
      // Treat this as a LOWER BOUND.
      pbkdf2_600k_iters_wall_ms: wallMs,
      note: "Argon2id wasm will be ~2-5x slower in a Workers isolate; budget accordingly",
    });
  },
};
WORKER

cat <<'EOF'

Deploy and curl:
   cd scripts/spike/cpu-spike
   wrangler deploy
   curl -i https://polaris-cpu-spike.<your-subdomain>.workers.dev
   # Look at cf-cpu-time header (or response JSON wall_ms)

EOF
result "MANUAL" "Confirm Paid plan + measure baseline; document Argon2id timing in results.md"
