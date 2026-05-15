# Webhook decision tree

You need polaris-email to deliver inbound mail events to your service. Pick one of three:

```
Is your service reachable on the public internet via HTTPS?
├── yes → kind: external
│     URL: https://api.your-service.com/email-hook
│
└── no → Is your service joined to the Tailnet (has its own *.ts.net hostname)?
      ├── yes → kind: tailnet
      │      URL: https://your-svc.<tailnet>.ts.net/email-hook
      │
      └── no → Is your service a docker container co-located on the bridge host?
            ├── yes → kind: bridge
            │      URL: https://polaris-email.<tailnet>.ts.net/hooks/<service>/<rule>
            │      (also register a `local_webhook_targets` row mapping service/rule → upstream)
            └── no → join the Tailnet first, or expose a public HTTPS endpoint
```

## What you must do as the consumer

1. Pick one of the three patterns above and tell the operator your URL.
2. Implement signature verification with the appropriate library. The signature header is `X-Polaris-Sig: <hex>` (un-versioned per B3 — 64 lowercase hex chars, no prefix) and the body is the v2 envelope (`{event_id, event, occurred_at, message}`).
   - Node: `@polaris/sdk/webhook` (from the `@polaris/sdk` package).
   - Go: `polarissdkgo.VerifyWebhook` (from `github.com/vladzaharia/polaris-email/packages/sdk-go`).
3. Read `message` directly from the envelope — no follow-up `GET /v1/messages/:id` is required. (You may still GET if you want signed attachment URLs that outlive the original delivery window.)
4. Dedupe by `X-Polaris-Event-Id` for 24 h.
5. Return 2xx within 10 s. Anything else (including 3xx) is a delivery failure and will be retried per the fanout queue's backoff (max 6 attempts, then DLQ).

## What goes wrong if you pick wrong

- `external` for a Tailnet-only service → fanout Worker can't reach you; deliveries hit the DLQ.
- `tailnet` URL for a service not on the Tailnet → 522/timeouts.
- `bridge` for a service that isn't on the bridge's docker network → bridge returns 502.

The panel auto-detects mismatches at subscription creation time.
