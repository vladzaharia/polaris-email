# 5-minute quickstart

From "I have a service that wants to send mail" to "the email arrived".

## 0. Prerequisites

- The operator has registered your mailbox (`POST /v1/admin/mailboxes`) and issued you an API key (`POST /v1/admin/api-keys`) scoped to the `from` address(es) your service uses.
- You have two strings in your env:

```
POLARIS_EMAIL_URL=https://polaris-email-api.workers.dev
POLARIS_EMAIL_KEY_ID=pk_live_01HXR...
POLARIS_EMAIL_KEY_SECRET=...
```

## 1. Sign and send

The signing scheme is **identical** for outbound API calls and inbound webhooks — only the signature header tag differs (`v1=` for API direction, `v2=` for webhook direction; see [hmac-reference.md](../hmac-reference.md) for the formal spec).

`POST /v1/messages` accepts two content types:

- `application/json` — the `SendRequest` shape used in the snippets below.
- `message/rfc822` — raw RFC 5322 bytes; canonicalised by the API on receipt. Useful when forwarding an already-composed MIME message from a downstream tool or daemon.

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
  const canonical = ['polaris-api.v1', 'POST', path, query, ts, n, bodyHash].join('\n');
  const sig =
    'v1=' +
    createHmac('sha256', process.env.POLARIS_EMAIL_KEY_SECRET!).update(canonical).digest('hex');
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
	canonical := strings.Join([]string{"polaris-api.v1", "POST", "/v1/messages", "", ts, n, hex.EncodeToString(bh[:])}, "\n")
	m := hmac.New(sha256.New, []byte(os.Getenv("POLARIS_EMAIL_KEY_SECRET")))
	m.Write([]byte(canonical))
	sig := "v1=" + hex.EncodeToString(m.Sum(nil))
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-polaris-key-id", os.Getenv("POLARIS_EMAIL_KEY_ID"))
	req.Header.Set("x-polaris-ts", ts)
	req.Header.Set("x-polaris-nonce", n)
	req.Header.Set("x-polaris-sig", sig)
	res, err := http.DefaultClient.Do(req)
	if err != nil { panic(err) }
	defer res.Body.Close()
	fmt.Println(res.Status)
}
```

### Python

```python
import hashlib, hmac, json, os, secrets, time
import urllib.request

url = os.environ["POLARIS_EMAIL_URL"] + "/v1/messages"
body = json.dumps({"from":"noreply@example.com","to":["user@external.com"],"subject":"Hello","text":"Hi","category":"svc.test"}).encode()
ts = str(int(time.time()*1000))
nonce = secrets.token_urlsafe(12)
canonical = "\n".join(["polaris-api.v1","POST","/v1/messages","",ts,nonce,hashlib.sha256(body).hexdigest()]).encode()
sig = "v1=" + hmac.new(os.environ["POLARIS_EMAIL_KEY_SECRET"].encode(), canonical, hashlib.sha256).hexdigest()
req = urllib.request.Request(url, body, {
  "content-type":"application/json",
  "x-polaris-key-id": os.environ["POLARIS_EMAIL_KEY_ID"],
  "x-polaris-ts": ts,
  "x-polaris-nonce": nonce,
  "x-polaris-sig": sig,
}, method="POST")
print(urllib.request.urlopen(req).read().decode())
```

### curl (JSON)

```sh
TS=$(date +%s)000
NONCE=$(openssl rand -hex 12)
BODY='{"from":"noreply@example.com","to":["user@external.com"],"subject":"Hello","text":"Hi","category":"svc.test"}'
BH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANON="polaris-api.v1\nPOST\n/v1/messages\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POLARIS_EMAIL_KEY_SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$POLARIS_EMAIL_URL/v1/messages" \
  -H "content-type: application/json" \
  -H "x-polaris-key-id: $POLARIS_EMAIL_KEY_ID" \
  -H "x-polaris-ts: $TS" \
  -H "x-polaris-nonce: $NONCE" \
  -H "x-polaris-sig: v1=$SIG" \
  -d "$BODY"
```

### curl (raw RFC822)

Send an already-composed RFC 5322 message. The body hash is over the exact bytes on the wire, same as JSON.

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
CANON="polaris-api.v1\nPOST\n/v1/messages\n\n$TS\n$NONCE\n$BH"
SIG=$(printf "%b" "$CANON" | openssl dgst -sha256 -hmac "$POLARIS_EMAIL_KEY_SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$POLARIS_EMAIL_URL/v1/messages" \
  -H "content-type: message/rfc822" \
  -H "x-polaris-key-id: $POLARIS_EMAIL_KEY_ID" \
  -H "x-polaris-ts: $TS" \
  -H "x-polaris-nonce: $NONCE" \
  -H "x-polaris-sig: v1=$SIG" \
  --data-binary "$BODY"
```

### SDK shortcuts

If you don't want to hand-roll HMAC, use a first-party SDK — `@polaris/sdk` (Node), `polaris-sdk` (Python), or `polaris-sdk-go`. They cover signing, retries on `key_propagating`, and webhook verification. See [docs/sdk.md](../sdk.md).

## 2. Expected response

```json
{ "messageId": "01HXR...", "queuedAt": 1700000000000, "mode": "live" }
```

`202` means queued for delivery. Webhook `message.sent` fires once Cloudflare confirms delivery. `message.bounced` fires for permanent failures.

## 3. Test mode

Add `"mode": "test"` to the body to exercise the full pipeline (rate limits, scope checks, fanout) without actually sending. Recommended for CI.

## 4. Idempotency

Send the same `Idempotency-Key` header twice and you'll get the original `messageId` back with `X-Polaris-Idempotent: replay`. Different body + same key → `409 idempotency_conflict`. 24h TTL.

## 5. Receiving

If your service needs to react to inbound mail, register a webhook subscription pointing at your service's URL. See the [decision tree](../webhook-decision-tree.md) for choosing between external HTTPS, Tailnet-direct, and bridge-proxied. Then verify the signature using one of the first-party SDK verifiers:

- **Node**: `@polaris/sdk/webhook` (from `@polaris/sdk`).
- **Go**: `polarissdkgo.VerifyWebhook` (from `polaris-sdk-go`).

The webhook body is the **v2 envelope**: `{event_id, event, occurred_at, message}`. The full `Message` is inlined; no follow-up GET is required. The signature header is `X-Polaris-Sig: v2=…`. See [docs/messages.md](../messages.md) and [docs/sdk.md](../sdk.md).

## 6. Caller-side rotation

When the operator rotates your key:

- **Planned**: both old + new pairs are valid for 24 h. Cut over at your own pace; on `401 key_propagating` retry once after `Retry-After`.
- **Emergency**: old pair is dead in ≤5 s. There is no grace. Re-fetch your secret immediately.

Always treat `401 bad_signature` as terminal (do **not** retry); treat `401 key_propagating` as retryable.
