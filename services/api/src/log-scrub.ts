// Scrub PII from log lines. CI tests assert no `from`/`to`/`subject` plaintext escapes.
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const LONG_B64_RE = /\b[A-Za-z0-9+/]{64,}={0,2}\b/g;
// Bearer-token shapes used across the system: `sk_…` / `pk_…` (Stripe-style),
// `wh_…` (webhook secrets), `sec_…` (generic), `polaris_…` (operator bearer).
// Matched independent of payload length so a 16-char `wh_*` is still caught.
const TOKEN_PREFIX_RE = /\b(?:sk|pk|wh|sec|polaris)_[A-Za-z0-9_-]{8,}/g;

export function scrub(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(to|cc|bcc|from|reply_?to|html|text|content_?b64)$/i.test(k)) {
        out[k] = '<redacted>';
      } else if (/^subject$/i.test(k)) {
        out[k] = typeof v === 'string' ? v.slice(0, 32) : '<redacted>';
      } else if (/^filename$/i.test(k)) {
        out[k] = typeof v === 'string' ? v.slice(0, 16) : '<redacted>';
      } else {
        out[k] = scrub(v);
      }
    }
    return out;
  }
  return value;
}

function scrubString(s: string): string {
  let out = s.replace(EMAIL_RE, '<email>');
  out = out.replace(TOKEN_PREFIX_RE, '<token>');
  out = out.replace(LONG_B64_RE, '<blob>');
  return out;
}

export function safeLog(label: string, payload: unknown): void {
  // eslint-disable-next-line no-console
  console.log(label, JSON.stringify(scrub(payload)));
}
