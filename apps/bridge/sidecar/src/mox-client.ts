// Thin Mox WebAPI client. In production, talks over a Unix socket. For tests, an injected
// fetcher is fine.
import http from 'node:http';

export interface MoxImportInput {
  account: string;
  mailbox?: string; // 'Inbox' by default
  rfc822: Buffer;
  flags?: string[];
}

export interface MoxAccountSpec {
  /** Mox account name (typically the address local-part or the full address). */
  account: string;
  /** Primary address (used as login). */
  address: string;
  /** Pre-hashed password material (Argon2id / PBKDF2 PHC string). */
  passwordHash: string;
}

export interface MoxClient {
  messageImport(input: MoxImportInput): Promise<{ uid: number; uidvalidity: number }>;
  reloadConfig(): Promise<void>;
  /**
   * Ensure a Mox account exists with the given hashed password material. Idempotent.
   * Returns true on success, false if the Mox WebAPI rejected the call (e.g. it does
   * not accept hash-based password set — see DKIM key custody discussion). Callers
   * should log and continue with the next sender rather than aborting the cycle.
   */
  ensureAccount(spec: MoxAccountSpec): Promise<boolean>;
  /** Disable a Mox account (idempotent). */
  disableAccount(account: string): Promise<boolean>;
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
    async ensureAccount(spec) {
      // Mox WebAPI exposes Account / AccountAdd / SetPassword endpoints. Some Mox
      // versions accept a pre-hashed password (`PasswordHash`), others only accept
      // plaintext. We try the hash-aware path first; on rejection we log and return
      // false rather than fail the whole sync cycle.
      try {
        await call<unknown>('AccountAdd', {
          Account: spec.account,
          Address: spec.address,
          PasswordHash: spec.passwordHash,
        });
      } catch {
        // AccountAdd may legitimately fail with "already exists" — fall through to
        // SetPassword.
      }
      try {
        await call<unknown>('SetPasswordHash', {
          Account: spec.account,
          PasswordHash: spec.passwordHash,
        });
        return true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `mox: SetPasswordHash failed for ${spec.account}: ${e instanceof Error ? e.message : 'unknown'}`,
        );
        return false;
      }
    },
    async disableAccount(account) {
      try {
        await call<unknown>('AccountDisable', { Account: account });
        return true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `mox: AccountDisable failed for ${account}: ${e instanceof Error ? e.message : 'unknown'}`,
        );
        return false;
      }
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
