---
title: Quickstart
description: Send your first message in five minutes — sign a request, hit POST /v1/messages, and verify the webhook.
sidebar_label: Quickstart
sidebar_position: 2
---

# 5-minute quickstart

From "I have a service that wants to send mail" to "the email arrived".

## 0. Prerequisites

- The operator has registered your mailbox (`POST /v1/admin/mailboxes`) and
  issued you an API key (`POST /v1/admin/api-keys`) scoped to the `from`
  address(es) your service uses.
- You have these three strings in your environment:

```sh
POLARIS_EMAIL_URL=https://polaris-email-api.workers.dev
POLARIS_EMAIL_KEY_ID=pk_live_01HXR...
POLARIS_EMAIL_KEY_SECRET=...
```

## 1. Sign and send

The signing scheme is **identical** for outbound API calls and inbound
webhooks. What differs is the domain tag in the canonical string
(`polaris-api` vs `polaris-webhook`). The signature header is the
un-versioned `X-Polaris-Sig: <hex>` (64 lowercase hex chars, no prefix).
The full spec is in [HMAC reference](/security/hmac-reference); the
narrative is at [HMAC concept](/developers/authentication/concept).

`POST /v1/messages` accepts two content types:

| Content-Type       | Body shape                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- |
| `application/json` | `SendRequest` (see [REST reference](/reference/api/submit-a-message-json-or-rfc-822)) |
| `message/rfc822`   | Raw RFC 5322 bytes; canonicalised by the API on receipt                               |

Use `message/rfc822` when forwarding an already-composed MIME message from
a downstream tool or bridge.

### TypeScript (Node 20+)

```ts
import { createHmac, createHash, randomBytes } from 'node:crypto';

function nonce() {
  return randomBytes(15).toString('base64url');
}

async function send(body: object) {
  const text = JSON.stringify(body);
  const ts = String(Date.now());
  const n = nonce();
  const path = '/v1/messages';
  const query = '';
  const bodyHash = createHash('sha256').update(text).digest('hex');
  const canonical = ['polaris-api', 'POST', path, query, ts, n, bodyHash].join('\n');
  const sig = createHmac('sha256', process.env.POLARIS_EMAIL_KEY_SECRET!)
    .update(canonical)
    .digest('hex');
  const res = await fetch(process.env.POLARIS_EMAIL_URL! + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-polaris-key-id': process.env.POLARIS_EMAIL_KEY_ID!,
      'x-polaris-ts': ts,
      'x-polaris-nonce': n,
      'x-polaris-sig': sig,
    },
    body: text,
  });
  if (!res.ok) throw new Error(`send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

await send({
  from: 'noreply@example.com',
  to: ['user@external.com'],
  subject: 'Hello',
  text: 'Hi from polaris-email',
  category: 'svc.test',
});
```

### Go

```go
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func nonce() string {
	b := make([]byte, 15)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func main() {
	url := os.Getenv("POLARIS_EMAIL_URL") + "/v1/messages"
	body := []byte(`{"from":"noreply@example.com","to":["user@external.com"],"subject":"Hello","text":"Hi","category":"svc.test"}`)
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	n := nonce()
	bh := sha256.Sum256(body)
	canonical := strings.Join([]string{"polaris-api", "POST", "/v1/messages", "", ts, n, hex.EncodeToString(bh[:])}, "\n")
	m := hmac.New(sha256.New, []byte(os.Getenv("POLARIS_EMAIL_KEY_SECRET")))
	m.Write([]byte(canonical))
	sig := hex.EncodeToString(m.Sum(nil))
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-polaris-key-id", os.Getenv("POLARIS_EMAIL_KEY_ID"))
	req.Header.Set("x-polaris-ts", ts)
	req.Header.Set("x-polaris-nonce", n)
	req.Header.Set("x-polaris-sig", sig)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	fmt.Println(res.Status)
}
```

### curl (JSON)

```sh
TS=$(date +%s)000
NONCE=$(openssl rand -hex 12)
BODY='{"from":"noreply@example.com","to":["user@external.com"],"subject":"Hello","text":"Hi","category":"svc.test"}'
BH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-api\nPOST\n/v1/messages\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POLARIS_EMAIL_KEY_SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$POLARIS_EMAIL_URL/v1/messages" \
  -H "content-type: application/json" \
  -H "x-polaris-key-id: $POLARIS_EMAIL_KEY_ID" \
  -H "x-polaris-ts: $TS" \
  -H "x-polaris-nonce: $NONCE" \
  -H "x-polaris-sig: $SIG" \
  -d "$BODY"
```

### curl (raw RFC822)

Send an already-composed RFC 5322 message. The body hash is over the exact
bytes on the wire, same as JSON.

```sh
TS=$(date +%s)000
NONCE=$(openssl rand -hex 12)
BODY=$(cat <<'EOF'
From: noreply@example.com
To: user@external.com
Subject: Hello
Content-Type: text/plain; charset=utf-8

Hi from polaris-email
EOF
)
BH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-api\nPOST\n/v1/messages\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POLARIS_EMAIL_KEY_SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$POLARIS_EMAIL_URL/v1/messages" \
  -H "content-type: message/rfc822" \
  -H "x-polaris-key-id: $POLARIS_EMAIL_KEY_ID" \
  -H "x-polaris-ts: $TS" \
  -H "x-polaris-nonce: $NONCE" \
  -H "x-polaris-sig: $SIG" \
  --data-binary "$BODY"
```

### SDK shortcuts

If you would rather not hand-roll HMAC, use a first-party SDK —
[`@polaris/sdk`](/developers/sdks/node) (Node) or
[`polaris-sdk-go`](/developers/sdks/go). Both cover signing, retries on
`key_propagating`, and webhook verification. For other languages, see
[REST + curl](/developers/sdks/rest-curl).

## 2. Expected response

```json
{ "messageId": "01HXR...", "queuedAt": 1700000000000, "mode": "live" }
```

`202` means queued for delivery. Webhook `message.sent` fires once
Cloudflare confirms delivery. `message.bounced` fires for permanent
failures.

## 3. Test mode

Add `"mode": "test"` to the body to exercise the full pipeline (rate
limits, scope checks, fanout) without actually sending. Recommended for CI.

## 4. Idempotency

Send the same `Idempotency-Key` header twice and you get the original
`messageId` back with `X-Polaris-Idempotent: replay`. Different body +
same key → `409 idempotency_conflict`. 24h TTL.

Valid keys match `^[A-Za-z0-9_-]{8,128}$`. Both SDKs ship a strict
client-side validator (`assertIdempotencyKey` / equivalent) so a malformed
key fails before the round-trip.

## 5. Receiving

If your service needs to react to inbound mail, register a webhook
subscription pointing at your service's URL. Then verify the signature
using one of the first-party SDK verifiers:

| Language | Verifier                                            |
| -------- | --------------------------------------------------- |
| Node     | `@polaris/sdk/webhook` (`verifyWebhook`)            |
| Go       | `polarissdkgo.VerifyWebhook`                        |
| Other    | [REST + curl](/developers/sdks/rest-curl) (openssl) |

The webhook body is the **v2 envelope**:
`{event_id, event, occurred_at, message}`. The full `Message` is inlined;
no follow-up GET is required. The signature header is `X-Polaris-Sig: <hex>`
(un-versioned per B3 — 64 lowercase hex chars, no prefix).

## 6. Caller-side rotation

When the operator rotates your key:

| Rotation type | Overlap window | Retry on `401 key_propagating`? |
| ------------- | -------------- | ------------------------------- |
| Planned       | 24 h           | yes, after `Retry-After`        |
| Emergency     | ≤5 s           | no — re-fetch your secret       |

Always treat `401 bad_signature` as terminal (do **not** retry); treat
`401 key_propagating` as retryable.

<!-- Verified against: docs/quickstart/README.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
