// Cloudflare Email Service provider — primary implementation.
//
// Uses the account-level `EMAIL` binding (single binding for all domains; the
// `from` parameter selects the sender domain). This was confirmed by the
// Assumption: account-level binding model is correct. If that assumption
// proves otherwise, this provider needs per-domain dispatch).

import type { Provider, SendOutcome, SendRequest } from './provider.js';

/** The shape of Cloudflare's account-level Email Service binding. */
export interface CloudflareEmailBinding {
  send(message: {
    from: string;
    to: string | string[];
    raw: ReadableStream | string | Uint8Array;
  }): Promise<{ id?: string }>;
}

export class CloudflareProvider implements Provider {
  constructor(private binding: CloudflareEmailBinding) {}

  name(): string {
    return 'cloudflare';
  }

  async send(req: SendRequest): Promise<SendOutcome> {
    try {
      const result = await this.binding.send({
        from: req.envelopeFrom,
        to: req.envelopeTo,
        raw: req.rfc822,
      });
      return { kind: 'accepted', providerMessageId: result?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort classification — Cloudflare's binding error shape may evolve.
      // 4xx-shaped messages → transient; 5xx-shaped → rejected.
      const transient = /\b(429|5\d\d|timeout|temporar)/i.test(message);
      return transient
        ? { kind: 'transient', reason: message, transient: true }
        : { kind: 'rejected', reason: message, transient: false };
    }
  }
}
