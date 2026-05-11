// Thin Mox WebAPI client. In production, talks over a Unix socket. For tests, an injected
// fetcher is fine.
import http from 'node:http';

export interface MoxImportInput {
  account: string;
  mailbox?: string; // 'Inbox' by default
  rfc822: Buffer;
  flags?: string[];
}

export interface MoxClient {
  messageImport(input: MoxImportInput): Promise<{ uid: number; uidvalidity: number }>;
  reloadConfig(): Promise<void>;
  /** Inspect outgoing-message webhook payload from Mox. */
  parseOutgoingWebhook(payload: unknown): {
    account: string;
    rfc822: Buffer;
    from: string;
    to: string[];
  };
}

export function makeMoxClient(opts: { sockPath?: string; baseUrl?: string }): MoxClient {
  async function call<T>(method: string, body?: unknown): Promise<T> {
    if (opts.baseUrl) {
      const res = await fetch(opts.baseUrl + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return (await res.json()) as T;
    }
    if (!opts.sockPath) throw new Error('mox: sockPath or baseUrl required');
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: opts.sockPath,
          path: '/' + method,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify(body ?? {}));
      req.end();
    });
  }
  return {
    async messageImport(input) {
      const r = await call<{ UID: number; UIDValidity: number }>('MessageImport', {
        Account: input.account,
        Mailbox: input.mailbox ?? 'Inbox',
        Data: input.rfc822.toString('base64'),
        Flags: input.flags ?? [],
      });
      return { uid: r.UID, uidvalidity: r.UIDValidity };
    },
    async reloadConfig() {
      await call('ConfigReload');
    },
    parseOutgoingWebhook(payload) {
      const p = payload as {
        account?: string;
        rfc822?: string;
        envelope_from?: string;
        envelope_to?: string[];
      };
      if (!p.account || !p.rfc822) throw new Error('mox: bad outgoing webhook payload');
      return {
        account: p.account,
        rfc822: Buffer.from(p.rfc822, 'base64'),
        from: p.envelope_from ?? '',
        to: p.envelope_to ?? [],
      };
    },
  };
}
