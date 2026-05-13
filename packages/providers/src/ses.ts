// AWS SES provider — failover backstop for vendor independence.
//
// v1 implementation is a thin SigV4-signed HTTPS POST to the SES SendRawEmail
// API. Operators provision an IAM role with SES:SendRawEmail and store the
// access key + secret as Workers Secrets (SES_ACCESS_KEY_ID, SES_SECRET_KEY,
// SES_REGION). Per-domain configuration sets are out of scope for v1.
//
// Status: stub. The interface conforms; the actual SigV4 signing + HTTP call
// is left as a v1.x deliverable per Resolved Q1 (EMAIL is GA; SES fallback is
// no longer launch-blocking).

import type { Provider, SendOutcome, SendRequest } from './provider.js';

export interface SesConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export class SesProvider implements Provider {
  constructor(private cfg: SesConfig) {}

  name(): string {
    return 'ses';
  }

  async send(req: SendRequest): Promise<SendOutcome> {
    // Intentionally not implemented in v1. Calling this throws so misconfigured
    // domain rows surface immediately.
    void req;
    void this.cfg;
    throw new Error(
      'SES provider not implemented; v1.x deliverable per Resolved Q1. ' +
        'Configure domain to use the cloudflare provider until then.'
    );
  }
}
