// Postmark provider — alternative failover backstop.
//
// v1 implementation is a thin HTTPS POST to /email with the X-Postmark-Server-Token
// header. Per-server tokens map to per-domain `domains.provider_config`.
//
// Status: stub. Same v1.x rationale as SES.

import type { Provider, SendOutcome, SendRequest } from './provider.js';

export interface PostmarkConfig {
  serverToken: string;
  endpoint?: string; // override for testing
}

export class PostmarkProvider implements Provider {
  constructor(private cfg: PostmarkConfig) {}

  name(): string {
    return 'postmark';
  }

  async send(req: SendRequest): Promise<SendOutcome> {
    void req;
    void this.cfg;
    throw new Error(
      'Postmark provider not implemented; v1.x deliverable per Resolved Q1.'
    );
  }
}
