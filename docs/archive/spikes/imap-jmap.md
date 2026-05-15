# Spike: IMAP and JMAP support for polaris-email

> **Status**: archived — features shipped in commits L.3a/L.3b/L.4 (2026).

**Prepared:** May 2026  
**Status:** Feasibility assessment (pre-execution)  
**Scope:** Bridge architecture, backend prerequisites, protocol analysis, effort estimate, decision points.

---

## 1. Executive Summary

**Recommendation:** Ship IMAP4rev1 v1 via a stateless bridge container that authenticates to polaris via per-mailbox HMAC, reads message state from a new `message_state` D1 table, and fetches MIME bodies from R2 on demand. JMAP deferred to v2.

**Effort range:**

- IMAP-only v1: **6–8 weeks** (backend state table + indexes, bridge + go-imap/server, auth flow, basic ops)
- IMAP + basic JMAP v1: **10–12 weeks** (serialize state-table updates, JMAP JSON codec overhead)
- Full-features v2 (SEARCH, IDLE, multi-folder, drafts): **+12 weeks**

**Key risks:**

1. **R2 egress cost** — each `FETCH BODY` is an R2 GET; high-traffic mailboxes (1k+ messages) pay egress on every client sync. Mitigation: client-side caching, BODYSTRUCTURE-only responses, eventual local mailbox sync.
2. **Concurrent-edit semantics** — two IMAP clients fetch the same message simultaneously; both auto-mark-read. Race window on the `read_at` timestamp. Mitigation: mark-read is idempotent and last-write-wins; acceptable for v1.
3. **Per-mailbox UID counter scalability** — if we implement sequential UIDs, each `APPEND` or `EXPUNGE` updates a counter; under high-load concurrent clients this contends. Recommend ULID-as-UID instead (no counter, distributed-friendly).
4. **Data-residency shift** — inbound messages today are stored for ~90 days for audit/recovery. IMAP use case requires longer retention (clients expect weeks of local sync history). Explicit policy change needed.

**Out of scope v1:** SEARCH, IDLE, multi-folder (INBOX-only), drafts, Sieve, custom flags, BURL, multi-account.

---

## 2. What Exists Today

### Inbound storage and retrieval

**Raw MIME storage:**

- `services/in/src/index.ts` (lines 109–110): Raw MIME received by Cloudflare Email Routing → parsed (lines 136–164) → stored in R2 at path `in/{domain_id}/{message_id}.eml` (line 204).
- Size cap: 25 MiB per message (`services/in/src/index.ts` line 40–41).
- Encryption: R2 server-side encryption at rest (default, configured in `docs/RUNBOOKS/data-residency.md`).

**Message metadata in D1:**

- `services/api/migrations/0001_init.sql` (lines 215–246): `messages` table.
  - Schema: `(id, tenant_id, direction, status, from_addr, subject, r2_key, created_at, ...)`.
  - No read/unread state, no soft-delete, no per-mailbox flags.
  - `direction = 'in'` for received messages.
  - Indexed by `(tenant_id, status, created_at)` implicitly via idx*messages*\*.
  - No index on recipient address or mailbox-like columns.

**Webhook dispatch:**

- `services/in/src/index.ts` (lines 229–245): on successful parse, message is enqueued to `FANOUT_QUEUE` with `message.received` event.
- Payload includes `from`, `to`, `subject`, `size_bytes`, auth results; **does not** include parsed MIME parts or body.

### Retention and deletion

- `services/cron/src/handlers/janitor.ts` (lines 15–52): nightly cron enforces per-tenant `retention_days` (from `tenants.retention_days`, default 90 days per `0001_init.sql` line 32).
  - Query (line 25): `SELECT id, r2_key FROM messages WHERE tenant_id = ? AND created_at < ? LIMIT 500`.
  - Deletes both D1 row (line 35) and R2 object (line 31).
  - **No soft-delete marker**; messages are hard-deleted after retention expires.

### Message identifiers (ULID)

- `packages/ids/src/index.ts` (lines 8–21): ULID generation.
  - 10-char timestamp (base32, ~millisecond precision), 16-char random suffix.
  - Example: `01ARZ3NDEKTSV4RRFFQ69G5FAV`.
  - Sortable by timestamp; globally unique; no collisions at expected volume.
  - **Stability:** ULIDs are immutable once assigned; suitable as permanent message identifiers.

### MIME parsing (inbound)

- `services/in/src/parse.ts`: minimal RFC822 parser inline (no external supply-chain for inbound).
  - Returns `ParsedMime` (lines 19–32): headers, from, to, cc, subject, date, messageId, textBody, htmlBody, attachments[].
  - Supports multipart + base64/quoted-printable.
  - Parser runs in inbound Worker; bodies kept in memory only during parse.
  - **Available MIME utilities:** `packages/mime/src/` exports canonicalize, sender-policy, address-norm (for outbound validation; inbound parser is standalone).

---

## 3. Backend Prerequisites (Common to IMAP + JMAP)

### 3.1 New schema: message_state table

**Why separate from `messages`?**

- `messages` is immutable (audit-trail friendly, append-only for cost tracking).
- Read-state, flags, soft-delete, and expunge-status are mutable and frequent.
- Separating allows janitor to only concern itself with hard deletes on old message rows; read-state lives in `message_state` with independent retention.

**Proposed schema** (for `services/api/migrations/0003_imap_state.sql`):

```sql
CREATE TABLE message_state (
  message_id    TEXT NOT NULL PRIMARY KEY REFERENCES messages(id),
  mailbox_addr  TEXT NOT NULL,  -- e.g., "support@acme.com"; denormalized for index
  read_at       TEXT,            -- ISO 8601; null = unread
  flagged_at    TEXT,            -- reserved for future use
  expunged_at   TEXT,            -- soft-delete marker; hard-delete on next retention sweep
  uid           TEXT NOT NULL UNIQUE,  -- UID for IMAP (ULID or sequential counter)
  uid_validity  INTEGER NOT NULL DEFAULT 1,  -- epoch counter for UID reset
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_message_state_mailbox_addr ON message_state(mailbox_addr);
CREATE INDEX idx_message_state_read_at ON message_state(read_at);
CREATE INDEX idx_message_state_expunged_at ON message_state(expunged_at);
```

**Rationale:**

- `mailbox_addr` is the recipient email address (e.g., `support@acme.com`), not a folder. Denormalized for fast mailbox listing without joins.
- `read_at IS NULL` means unread; `read_at IS NOT NULL` means read (auto-set on FETCH BODY).
- `expunged_at IS NOT NULL` marks soft-deleted; janitor will DELETE these rows after retention window.
- `uid` is immutable per client session; either ULID (recommended) or sequential counter (requires per-mailbox counter table).
- `uid_validity` increments if we ever reset the UID namespace (rare; defaults to 1).

### 3.2 Mailbox-scoped retrieval API

**Goal:** Bridge calls this to list messages and fetch individual message data.

**Proposed endpoint: POST /v1/mailbox/messages**

```
POST /v1/mailbox/messages
Authorization: HMAC-SHA256 (per-mailbox key)
Content-Type: application/json

{
  "mailbox": "support@acme.com",
  "operation": "list",  // or "fetch", "mark_read", "delete"
  "options": {
    "limit": 100,
    "offset": 0,
    "only_unread": false,
    "exclude_expunged": true
  }
}

Response (operation: "list"):
{
  "messages": [
    {
      "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "uid": "01ARZ3NDEKTSV4RRFFQ69G5FAV",  // or sequential UID if counter model
      "uid_validity": 1,
      "from": "alice@example.com",
      "subject": "Hello",
      "date": "2026-05-13T10:30:00Z",
      "size_bytes": 1024,
      "read": true,
      "received_at": "2026-05-13T10:30:00Z"
    }
  ],
  "has_more": true,
  "total_count": 5000
}

POST /v1/mailbox/messages (operation: "fetch")
{
  "mailbox": "support@acme.com",
  "operation": "fetch",
  "message_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "parts": ["headers", "body", "structure"]  // subset or all
}

Response:
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "headers": { "from": "...", "subject": "...", ... },
  "body": "raw RFC 822 or MIME part",
  "structure": { "type": "multipart/mixed", "parts": [...] },
  "read": false  // current state before FETCH modifies it
}

POST /v1/mailbox/messages (operation: "mark_read")
{
  "mailbox": "support@acme.com",
  "operation": "mark_read",
  "message_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "read": true
}

Response: { "ok": true, "read_at": "2026-05-13T10:35:12Z" }
```

**Auth:** Each mailbox address gets a unique HMAC key issued by the panel (similar to submission-daemon credentials in `services/api/migrations/0001_init.sql` lines 123–134, but for read-access).

**Pagination:** `limit` + `offset` or cursor-based (sequence of UIDs). Recommend cursor (UID-based) for IMAP efficiency.

### 3.3 Per-mailbox UID model: ULID vs. sequential counter

**ULID-as-UID (recommended):**

- Use the message's existing `message_id` (already a ULID) as the UID.
- Pros: No server state (counter table), sortable, globally unique, scales to unlimited concurrent clients.
- Cons: UIDs are not integers; some legacy IMAP clients expect 1-based integers.
- IMAP spec allows any UID format; most modern clients handle non-integer UIDs.
- **Decision:** recommend ULID for v1. If clients complain, add sequential counter in v2.

**Sequential UID counter (alternative):**

- New table `mailbox_uid_counter: (mailbox_addr TEXT PRIMARY KEY, next_uid INTEGER)`.
- On `APPEND` or new inbound message: increment counter, assign UID.
- Pros: traditional IMAP behavior; some clients expect ascending integer UIDs.
- Cons: contention under concurrent updates; requires distributed counter (e.g., atomic D1 operations via CAS).
- Not recommended for v1 due to scalability; defer to v2 if required.

### 3.4 Address → mailbox resolution

**Problem:** inbound routing today is by domain. IMAP listing needs per-address queries.

**Solution:**

- New index on `messages(tenant_id, to_addr_extracted)` where `to_addr_extracted` is the recipient from the `to` header or envelope.
- OR: denormalize recipient into `messages` table as a new column `to_addr_normalized` (slow migration if billions of rows exist; recommend for v1).
- Query for a mailbox: `SELECT * FROM messages WHERE tenant_id = ? AND to_addr_normalized = ? ORDER BY created_at DESC`.
- Mailbox listing endpoint validates the address against the calling principal's allowed addresses (see: submission-daemon credential model).

**Implementation:** Add `to_addr_normalized TEXT` column to `messages` table in migration `0002_imap_inbox.sql` (before state table).

### 3.5 Janitor integration

**Changes to `services/cron/src/handlers/janitor.ts`:**

Current flow (lines 25–35):

```sql
SELECT id, r2_key FROM messages WHERE tenant_id = ? AND created_at < ?
DELETE FROM messages WHERE id = ?
```

New flow:

```sql
-- Find soft-deleted messages past retention window
SELECT m.id, m.r2_key FROM messages m
  INNER JOIN message_state ms ON m.id = ms.message_id
  WHERE m.tenant_id = ? AND ms.expunged_at < ? AND ms.expunged_at IS NOT NULL
  LIMIT 500

-- Delete from message_state first (foreign key)
DELETE FROM message_state WHERE message_id IN (...)

-- Delete from messages and R2
FOR each message:
  DELETE FROM messages WHERE id = ?
  R2.delete(r2_key)
```

**Unread messages are never deleted** unless explicitly expunged by the client (IMAP `DELETE` command sets `expunged_at`).

### 3.6 Server-side filtering (IMAP SEARCH)

**Out of scope for v1.** IMAP `SEARCH` is expensive (full-table scans, regex matching on bodies). Defer to v2.

**v2 sketch:** Pre-index common filters (from, subject, date range, flags) at insertion time; build a separate search-index table or delegate to full-text search (D1 FTS not yet available; external ElasticSearch or MeiliSearch would be needed).

---

## 4. Protocol Comparison: IMAP4rev1 vs IMAP4rev2 vs JMAP

| Aspect                    | IMAP4rev1 (RFC 3501)                                          | IMAP4rev2 (RFC 9051)                                          | JMAP (RFC 8620/8621)                                             |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Standardization**       | 2003; widely deployed.                                        | 2021; slow adoption (not default in most servers).            | 2020; growing (Apple Mail, Fastmail, Proton Mail).               |
| **Client ecosystem 2026** | Excellent: Thunderbird, Apple Mail, Outlook, Mutt, K-9.       | Poor: few clients expect it; considered opt-in.               | Growing: Apple Mail, GMail via IMAP shim, custom mobile.         |
| **Protocol model**        | Stateful TCP conn; command/response. CRLF framing.            | Identical to rev1 (backward compatible).                      | Stateless HTTP(S) JSON; multiple methods per request.            |
| **Bridge complexity**     | Medium: TCP loop + command parser.                            | Medium: same as rev1.                                         | High: HTTP framing + JSON codec + async state management.        |
| **Connection model**      | Long-lived (IDLE keeps connection open weeks).                | Same.                                                         | Stateless; client polls or WebSocket push.                       |
| **Fetch model**           | FETCH BODY [SECTION] returns raw bytes.                       | Same.                                                         | FETCH returns JSON; bodies as base64.                            |
| **Search**                | Server-side (SEARCH command). Expensive.                      | Same.                                                         | Server-side (QUERY method); more expressive but still expensive. |
| **State synchronization** | UIDVALIDITY + UID counters. Client caches.                    | Same.                                                         | State tokens (Mailbox.state); opaque epoch.                      |
| **Push support**          | IDLE (requires long-lived connection; workers don't support). | Same.                                                         | WebSocket or long-poll; feasible with Workers.                   |
| **Compliance effort**     | High; RFC 3501 is large.                                      | Medium (mostly test suite and new commands).                  | High; JSON framing + multiple command semantics.                 |
| **Recommended for v1?**   | **YES.** Widest client support, proven protocol.              | No. Not worth the porting effort; rev1 clients exist forever. | No. Higher bridge complexity; defer to v2 after v1 is stable.    |

**Recommendation:** Ship **IMAP4rev1 (RFC 3501)** for v1. It has the largest client ecosystem and the protocol is stable. IMAP4rev2 is a superset with minor refinements (e.g., IMAP4rev2-only commands like MAILBOX, UNAUTHENTICATED); not worth the complexity for v1.

JMAP is architecturally cleaner (HTTP, JSON, async) but has higher bridge implementation cost. Defer to v2 after IMAP is stable; offer JMAP as an alternative bridge image for clients that prefer it.

---

## 5. Bridge Container Architecture

### 5.1 Technology stack

**Language + library:**

- **Go + go-imap/server** (github.com/emersion/go-imap, github.com/emersion/go-imap-imapweb, or hand-rolled)
  - Pros: compact binary, efficient goroutines, battle-tested in production (Proton Mail, Fastmail use go-imap under the hood).
  - Cons: requires Go knowledge; no async/await.
  - Alternative: Rust + imap-proto (fewer users; mature but less ecosystem).
  - **Recommendation:** Go + go-imap/server. Proven, small footprint, easy to containerize.

**Binary size:** ~20 MB (statically linked, no CGO).  
**Container base:** `golang:1.23-alpine` → `alpine:latest` for runtime (multi-stage build).

### 5.2 Stateless vs. stateful

**Recommendation: Stateless bridge.**

Each IMAP client connection opens a TCP session to the bridge. The bridge:

1. Authenticates the client (IMAP LOGIN or PLAIN).
2. Spawns a goroutine to handle that session.
3. **On each IMAP command (LIST, FETCH, etc.)**, makes a synchronous HTTPS call to polaris API.
4. Closes session when client disconnects.

Pros:

- Scales horizontally; many bridge instances can serve the same mailbox.
- No session affinity required.
- Simple to test (each request is independent).

Cons:

- Latency: each IMAP command = network round-trip to polaris API. FETCH is especially chatty (LIST + FETCH headers + FETCH body = 3 round-trips).
- Mitigation: client-side caching; bridge local memory cache (TTL'd state of mailbox). BODYSTRUCTURE-only responses to reduce FETCH round-trips.

**Session-state storage:** None needed. Bridge immediately releases resources after each command.

### 5.3 Authentication model

**IMAP LOGIN** (or PLAIN):

```
C: A001 LOGIN support@acme.com <bridge-password>
S: A001 OK LOGIN completed
```

**Bridge password generation:**

1. Panel issues a long-lived credential for each mailbox address: `(mailbox_addr, hmac_secret)`.
   - Stored in a new `mailbox_credentials` table (similar to `submission_credentials`, line 123 in 0001_init.sql).
   - Credential ID + secret hash (bcrypt).

2. Bridge generates a per-session HMAC key from the secret:

   ```
   session_hmac = HMAC-SHA256(mailbox_secret, nonce + timestamp)
   ```

3. Bridge uses `session_hmac` to sign subsequent API calls (same HMAC auth as `/v1/send/raw`).

4. Client (IMAP user) enters their mailbox password in their mail client. Bridge verifies against the stored bcrypt hash in step 1.

**Auth flow:**

```
User → Bridge (IMAP LOGIN support@acme.com / password)
  ↓ (Bridge verifies password against bcrypt hash in credential table)
  ↓ (Bridge generates session_hmac)
Bridge → Polaris API (POST /v1/mailbox/messages with session_hmac header)
  ↓ (API verifies HMAC; checks mailbox_addr matches credential)
API → Bridge (message list)
```

**Key rotation:** If the user resets their password, the bridge invalidates any in-flight sessions; next login uses the new bcrypt hash.

### 5.4 TLS termination

- **IMAP4rev1 implicit TLS** on port 993 (RFC 8314).
- Bridge loads cert + key from mounted volume (e.g., `/etc/polaris-bridge/cert.pem`, `/etc/polaris-bridge/key.pem`).
- Hot-reload on cert renewal (watch file; restart TLS listener on change).
- Certificate source: operator's choice (Let's Encrypt, self-signed, corporate CA). Example with lego (same as submission-daemon):

```bash
lego -a dns.cloudflare --dns.resolvers 1.1.1.1 renew
# Bridge detects .renewed file; reloads TLS context
```

### 5.5 Concurrency limits

- **Goroutines per connection:** 1 (lightweight; suitable for 1000+ concurrent clients).
- **Max mailbox size (v1):** 1 million messages. List pagination: 100 per request.
- **Max per-connection requests:** None (HTTP/1.1 pipelining not used; sync request/response only).
- **Rate limiting:** Delegated to polaris API. Bridge enforces no local limits.

---

## 6. Proposed Schema Additions

### 6.1 Migration `services/api/migrations/0002_imap_inbox.sql`

Adds denormalized recipient address and structural support for mailbox operations:

```sql
-- Add recipient address to messages for fast mailbox-scoped queries
ALTER TABLE messages
  ADD COLUMN to_addr_normalized TEXT;

-- Backfill from existing messages (parse from r2_key or from the To header if accessible)
-- For now, assume null for old messages; populate on inbound as of migration date.

CREATE INDEX idx_messages_to_addr ON messages(to_addr_normalized);
```

### 6.2 Migration `services/api/migrations/0003_imap_state.sql`

```sql
-- Per-message read-state, flags, soft-delete, UID assignment
CREATE TABLE message_state (
  message_id    TEXT NOT NULL PRIMARY KEY REFERENCES messages(id),
  mailbox_addr  TEXT NOT NULL,
  read_at       TEXT,
  flagged_at    TEXT,
  expunged_at   TEXT,
  uid           TEXT NOT NULL UNIQUE,
  uid_validity  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_message_state_mailbox_addr ON message_state(mailbox_addr);
CREATE INDEX idx_message_state_mailbox_unread
  ON message_state(mailbox_addr, read_at)
  WHERE read_at IS NULL;
CREATE INDEX idx_message_state_expunged_at ON message_state(expunged_at);

-- Credentials for mailbox IMAP/JMAP access
CREATE TABLE mailbox_credentials (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  mailbox_addr  TEXT NOT NULL,
  bcrypt_hash   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT,
  UNIQUE(tenant_id, mailbox_addr)
);

CREATE INDEX idx_mailbox_credentials_tenant ON mailbox_credentials(tenant_id);
CREATE INDEX idx_mailbox_credentials_addr ON mailbox_credentials(mailbox_addr);
```

---

## 7. Effort Estimate

### Per-component (T-shirt sizing + range)

| Component                                     | Size | Effort    | Notes                                                         |
| --------------------------------------------- | ---- | --------- | ------------------------------------------------------------- |
| **Backend: retrieval API**                    | M    | 1–2 weeks | POST /v1/mailbox/messages, pagination, HMAC auth              |
| **Backend: message_state table + migrations** | M    | 1–2 weeks | Schema + janitor integration                                  |
| **Backend: to_addr normalization**            | S    | 3–5 days  | Add column, populate for new messages, backfill if needed     |
| **Bridge: core IMAP4rev1 (go-imap/server)**   | L    | 2–3 weeks | Command loop, SELECT, LIST, FETCH, STORE, DELETE, QUIT        |
| **Bridge: auth (LOGIN/PLAIN + HMAC)**         | M    | 1–2 weeks | Credential lookup, session HMAC generation, polaris API calls |
| **Bridge: TLS + hot-reload**                  | S    | 3–5 days  | Cert loading, listener restart on change                      |
| **Bridge: Docker + compose**                  | S    | 2–3 days  | Dockerfile, docker-compose example                            |
| **Testing: end-to-end**                       | M    | 1–2 weeks | IMAP client tests (telnet, Thunderbird, K-9), edge cases      |
| **Integration: mark-as-read flow**            | S    | 3–5 days  | FETCH auto-marks read; verify janitor respects soft-delete    |

### Totals

- **IMAP-only v1:** 6–8 weeks (all above except optional polish)
- **IMAP + minimal JMAP v1:** +3–4 weeks (JMAP is JSON codec + similar state logic; reuse backend API)
- **Full-featured v2** (SEARCH, IDLE, multi-folder, drafts): +12 weeks

---

## 8. Risks and Unknowns

### 8.1 R2 egress cost

**Issue:** Each IMAP `FETCH BODY` reads from R2. At $0.02 per GB egress (Cloudflare public pricing), a 10 MB mailbox synced by 5 clients weekly = 50 MB/week = ~200 MB/month per mailbox = ~$0.004/month per mailbox (small). But at scale (1000 active mailboxes × 50 clients × weekly sync), this is $2–4k/month of egress alone.

**Mitigation:**

- Recommend BODYSTRUCTURE-only responses in v1 (client caches bodies locally after first sync).
- Bridge-side local cache (in-memory, TTL'd, keyed by mailbox address + UID).
- Document to users: expect egress charges for large mailbox syncs; budget accordingly.
- Consider S3 API gateway in front of R2 for large-scale deploys (not supported by Cloudflare yet; future infra work).

### 8.2 Concurrent-edit semantics

**Issue:** Two IMAP clients fetch the same message simultaneously. Both auto-mark-read. The `read_at` timestamp race window is ~10 ms (time between the two FETCH calls). Last-write-wins; one timestamp is recorded.

**Why this is acceptable:** Mark-as-read is idempotent. If client A marks read at T1 and client B marks read at T1+10ms, the final state is "read" (both agree). The ~10ms skew on the timestamp is not observable to users.

**Mitigation:** None needed for v1. If clients need precise read-state history, add a separate `read_history` audit table in v2.

### 8.3 Per-mailbox UID counter scalability

**Issue (if sequential counter is chosen):** Under concurrent IMAP sessions, the `mailbox_uid_counter.next_uid` field becomes a hot row. D1 does not support optimistic locking or CAS; you must serialize updates. At 10 concurrent clients on the same mailbox, each FETCH/LIST command contends on the counter table.

**Mitigation:** Recommend ULID-as-UID (no counter, no contention). If sequential UIDs are required in v2, batch assign UIDs (allocate 1000 at a time per client; reduce contention by 1000x).

### 8.4 Data-residency shift

**Issue:** Current model: store raw MIME for ~90 days (audit/recovery). IMAP users expect weeks or months of local sync. The retention policy boundary is blurry.

Scenario: A user expects to access a 6-month-old email via IMAP. If the message was deleted by janitor after 90 days, IMAP returns "no such message" (confusing to the user).

**Decision point (section 10):** Establish a separate retention policy for message bodies accessed via IMAP. Options:

1. **Extend global retention:** bump `tenants.retention_days` to 180 or 365 (expensive R2 storage).
2. **Dual retention:** 90 days for audit, 180+ days for IMAP bodies (adds operational complexity; two deletion schedules).
3. **User-settable retention:** let each mailbox credential specify its retention window (conflicts with global policy).

Recommend option 2 (dual retention) with default IMAP retention = 180 days.

### 8.5 IDLE support

**Issue:** IMAP IDLE keeps a connection open waiting for new mail (RFC 2177). Clients use it for real-time notifications.

**Why not feasible in v1:** Cloudflare Workers do not support long-lived TCP connections or server-initiated pushes. The bridge is stateless; it cannot maintain a connection across multiple requests.

**Workaround:** Clients poll LIST every N seconds (e.g., 30s for mobile, 5s for desktop). Not real-time, but acceptable for v1.

**v2 alternative:** Bridge polls polaris API on a timer; uses WebSocket to push changes to clients. Requires stateful bridge or a separate notification service.

### 8.6 Multi-folder support

**Issue:** IMAP supports folders (INBOX, Sent, Drafts, custom). Polaris today is single-inbox (webhook routes all inbound to a single recipient address).

**v1 scope:** INBOX only (maps to a single mailbox address, e.g., `support@acme.com`).

**v2 scope:** Multiple addresses per tenant (e.g., `support`, `sales`, `noreply` are separate IMAP folders). Requires routing rules to handle multiple recipient patterns and a folder model in the bridge.

### 8.7 Message state race conditions in soft-delete + retention

**Issue:** Janitor runs nightly. Between the time a message is soft-deleted (expunged by the user) and the time janitor hard-deletes it, the message is still accessible by clients.

More complex: if a client tries to FETCH an expunged message, what happens?

- Option A: IMAP returns a "no such message" error (correct; RFC 3501 section 7.4).
- Option B: Bridge checks `expunged_at IS NOT NULL` and refuses the FETCH (same as option A).

**Mitigation:** Bridge filters `expunged_at IS NULL` in all mailbox queries. Janitor delay (up to 24 hours before hard-delete) is acceptable.

---

## 9. Explicit Out-of-Scope for v1

- **SEARCH / QUERY:** full-text and metadata search. Defer to v2. Clients will use local search if server-side is unavailable.
- **IDLE:** real-time notifications. Fallback to polling.
- **Multi-folder:** INBOX only. Routing and folder model deferred to v2.
- **Drafts:** assume drafts are managed locally by the client (not synced to server).
- **Custom flags:** beyond read/unread. Deferred to v2.
- **Sieve:** server-side filtering. Out of scope permanently (better served by routing rules).
- **BURL / CONVERT:** binary attachments from external sources. Not applicable to inbound mail.
- **Multi-account on one bridge:** assume one bridge instance = one mailbox (credential-based isolation).
- **JMAP:** HTTP protocol. Defer to v2 as an alternative bridge image.

---

## 10. Decision Points for Implementation

**The following questions must be answered before execution starts. They shape the API contract and schema.**

### D1. UID model: ULID or sequential counter?

- **ULID** (recommended): Use message ID as UID. No server state; scales to unlimited clients. Accepted by RFC 3501; modern clients expect it.
- **Sequential counter** (alternative): New table `mailbox_uid_counter`. Traditional IMAP behavior. Requires distributed locking; higher complexity.

**Recommendation:** ULID for v1. Revisit in v2 if clients complain.

### D2. Retention policy for IMAP: dual retention or extend global?

- **Dual retention** (recommended): 90 days for audit (janitor hard-deletes), 180+ days for IMAP (separate schedule). Two deletion dates in message_state.
- **Extend global:** Bump `tenants.retention_days` globally (expensive; all tenants pay for longer R2 storage).
- **User-settable:** Per-credential retention (operational complexity; conflicts with global policy).

**Recommendation:** Dual retention. Add `imap_retention_days` column to `tenants` table; default 180. Janitor respects both.

### D3. Data residency impact: does storing message bodies for IMAP access violate data-residency constraints?

Review `RUNBOOKS/data-residency.md` (lines 1–10). Current model: D1 + R2 in declared regions. IMAP bodies in R2 are the same objects as today (no new residency issues). However, **longer retention window** may conflict with right-to-erasure expectations.

**Decision:** Confirm with operator/legal that dual-retention model (longer IMAP window) is compliant.

### D4. Bridge auth: per-mailbox password or per-tenant API key?

- **Per-mailbox password** (recommended): Each mailbox address gets a unique credential. Users enter mailbox-specific password in IMAP client (familiar model).
- **Per-tenant API key:** Bridge authenticates to polaris with admin API key; client auth is local to bridge (less familiar to users; requires bridge to manage user directory).

**Recommendation:** Per-mailbox password. Familiar to users; easier to revoke/rotate per-mailbox.

### D5. Client-side caching: should bridge or client manage cache invalidation?

- **Bridge cache:** In-memory LRU; invalidate on UPDATE. Simple; but bridge must be cache-coherent across multiple instances.
- **Client cache:** Bridge returns ETags or version tokens; clients revalidate. More scalable; standard HTTP model.

**Recommendation:** Defer to v1 prototype. Start with no caching (each FETCH hits polaris). Add bridge-side cache (LRU, TTL 5 min) if latency is unacceptable. Move to client caching (ETag model) in v2.

### D6. IMAP LIST vs. LSUB semantics: folder hierarchy or flat mailbox?

RFC 3501 defines LIST (all folders) and LSUB (subscribed folders). In a single-mailbox model, there's only INBOX.

**Decision:** Return a flat mailbox list with INBOX as the only folder. Reject LSUB requests with an error or return the same list as LIST (acceptable per RFC).

---

## 11. Appendix: References and links

- **IMAP4rev1 (RFC 3501):** https://tools.ietf.org/html/rfc3501 — the definitive spec. Sections 2–6 cover the command language; section 7 covers folders and UIDs.
- **IMAP4rev2 (RFC 9051):** https://tools.ietf.org/html/rfc9051 — clarifications and new commands; backward compatible with rev1.
- **JMAP (RFC 8620/8621):** https://tools.ietf.org/html/rfc8620 (Email) — JSON-based protocol; stateless.
- **go-imap/server:** https://github.com/emersion/go-imap — battle-tested Go IMAP library. Used by Proton Mail and others.
- **Implicit TLS (RFC 8314):** https://tools.ietf.org/html/rfc8314 — port 993 for IMAPS.
- **IDLE (RFC 2177):** https://tools.ietf.org/html/rfc2177 — real-time notifications (not supported by Cloudflare Workers).

### Codebase references (line numbers as of May 2026)

- Inbound storage: `services/in/src/index.ts:109–110, 136–164, 204`
- Message schema: `services/api/migrations/0001_init.sql:215–246`
- Retention janitor: `services/cron/src/handlers/janitor.ts:15–52`
- ULID generation: `packages/ids/src/index.ts:8–21`
- MIME parsing: `services/in/src/parse.ts:45–104`
- Submission daemon auth pattern (credential model): `services/api/migrations/0001_init.sql:123–134`
- Data residency policy: `RUNBOOKS/data-residency.md`
- Cost model egress: `docs/cost-model.md:28, 46, 62`
