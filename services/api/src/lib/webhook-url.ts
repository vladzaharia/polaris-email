// Shared webhook subscription URL validator.
//
// Mirrors the policy gate that runs before any persisted `webhook_subs.url` is
// stored:
//   * The URL must parse.
//   * `external` webhooks must be HTTPS.
//   * `tailnet` webhooks must terminate inside *.ts.net.
//
// The runtime SSRF defence in `queue/ssrf.ts` (`safeFetch` + DNS pinning) is
// the authoritative guardrail at fanout time. This validator is a fast-fail
// at admin write time so a misconfigured row never reaches the queue.
//
// Returns `null` when the URL passes; otherwise returns a short human-readable
// reason suitable for surfacing as a `bad_request` error message.

export type WebhookKind = 'external' | 'tailnet';

export function validateWebhookUrl(rawUrl: string, kind: WebhookKind): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'invalid url';
  }
  if (kind === 'external' && url.protocol !== 'https:') {
    return 'external webhooks require https';
  }
  if (kind === 'tailnet' && !url.hostname.endsWith('.ts.net')) {
    return 'tailnet webhook must target *.ts.net';
  }
  return null;
}
