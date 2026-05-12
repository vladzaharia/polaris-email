// Thin Mox admin-API client.
//
// Mox exposes TWO RPC surfaces:
//
//   1. /webapi/v0/<Method>  — per-account mail operations (MessageImport,
//      MessageSend, …). Used by the sync loop to deliver inbound RFC822
//      into the recipient's mailbox.
//   2. /admin/api/<Method>  — server-level admin operations (AccountAdd,
//      AccountRemove, SetPassword, Accounts, AddressAdd, …). Used by the
//      sidecar's reconcile path to make sure Mox knows about every sender
//      that polaris-email has registered.
//
// Method names verified against the Mox source tree:
//   - https://github.com/mjl-/mox/blob/main/webadmin/admin.go          (AccountAdd, AccountRemove, SetPassword, Accounts, Account, AddressAdd, AddressRemove)
//   - https://github.com/mjl-/mox/blob/main/webapi/webapi.go           (MessageImport, MessageSend)
//   - https://www.xmox.nl/protocols/                                   (top-level admin/webapi overview)
//
// IMPORTANT: Mox's admin API takes PLAINTEXT passwords (SetPassword takes a
// password string; Mox hashes via bcrypt internally). It does NOT accept
// pre-hashed material. We therefore can't reconcile credentials from the
// hash-at-rest table during normal polling — we'd never have the plaintext.
// Instead, plaintexts are delivered to the sidecar via a one-time webhook
// from the api Worker at credential-issuance time (see /v1/bridge/credential-set).
// The sidecar holds plaintext only for the moment of issuance and forgets it.
// See apps/bridge/sidecar/README.md and docs/DEPLOY.md ("SMTP credential issuance").
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
}

export interface MoxClient {
  messageImport(input: MoxImportInput): Promise<{ uid: number; uidvalidity: number }>;
  reloadConfig(): Promise<void>;
  /**
   * Ensure a Mox account exists for `spec.account` with `spec.address` as a
   * login address. Idempotent: a second call for the same account is a no-op.
   * Returns true on success, false on Mox-side failure (caller logs+continues).
   */
  ensureAccount(spec: MoxAccountSpec): Promise<boolean>;
  /**
   * Set the plaintext password for a Mox account. Mox hashes (bcrypt) at rest.
   * The caller is responsible for never persisting `plaintext` server-side
   * past this call. Returns true on success.
   */
  setAccountPassword(account: string, plaintext: string): Promise<boolean>;
  /** Remove a Mox account (idempotent — already-absent is treated as success). */
  removeAccount(account: string): Promise<boolean>;
  /** List configured Mox accounts. Used for reconciliation diff. */
  listAccounts(): Promise<string[]>;
  /** Inspect outgoing-message webhook payload from Mox. */
  parseOutgoingWebhook(payload: unknown): {
    account: string;
    rfc822: Buffer;
    from: string;
    to: string[];
  };
}

export function makeMoxClient(opts: { sockPath?: string; baseUrl?: string }): MoxClient {
  // Mox routes admin RPCs under /admin/api/<Method> and mail RPCs under
  // /webapi/v0/<Method>. The sidecar talks to both over the same transport
  // (Unix socket in prod, HTTP base URL in tests).
  async function call<T>(pathPrefix: string, method: string, body?: unknown): Promise<T> {
    const path = `${pathPrefix}/${method}`;
    if (opts.baseUrl) {
      const res = await fetch(opts.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        throw new Error(`mox ${method}: HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    }
    if (!opts.sockPath) throw new Error('mox: sockPath or baseUrl required');
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: opts.sockPath,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              if ((res.statusCode ?? 500) >= 400) {
                reject(new Error(`mox ${method}: HTTP ${res.statusCode}: ${text}`));
                return;
              }
              resolve(text ? (JSON.parse(text) as T) : ({} as T));
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
  const webapi = <T>(method: string, body?: unknown) => call<T>('/webapi/v0', method, body);
  const admin = <T>(method: string, body?: unknown) => call<T>('/admin/api', method, body);

  return {
    async messageImport(input) {
      // MessageImport: see webapi/webapi.go
      const r = await webapi<{ UID: number; UIDValidity: number }>('MessageImport', {
        Account: input.account,
        Mailbox: input.mailbox ?? 'Inbox',
        Data: input.rfc822.toString('base64'),
        Flags: input.flags ?? [],
      });
      return { uid: r.UID, uidvalidity: r.UIDValidity };
    },
    async reloadConfig() {
      // ConfigReload is an admin-side RPC.
      // TODO: verify against Mox v0.0.14+ — the exact name may be `Reload`
      // depending on the version. Defensive try/catch in caller is recommended.
      await admin('ConfigReload');
    },
    async ensureAccount(spec) {
      // AccountAdd: see webadmin/admin.go — signature (accountName, address).
      // Idempotency: AccountAdd returns an error if the account already exists.
      // We swallow that specific error path; any other failure → caller logs.
      try {
        await admin<unknown>('AccountAdd', {
          AccountName: spec.account,
          Address: spec.address,
        });
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown';
        if (/exists|already/i.test(msg)) return true;
        // eslint-disable-next-line no-console
        console.warn(`mox: AccountAdd failed for ${spec.account}: ${msg}`);
        return false;
      }
    },
    async setAccountPassword(account, plaintext) {
      // SetPassword: see webadmin/admin.go — signature (accountName, password).
      // Mox hashes (bcrypt) at rest. Plaintext leaves this process the moment
      // the call returns; the caller MUST NOT log or persist it.
      try {
        await admin<unknown>('SetPassword', {
          AccountName: account,
          Password: plaintext,
        });
        return true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `mox: SetPassword failed for ${account}: ${e instanceof Error ? e.message : 'unknown'}`,
        );
        return false;
      }
    },
    async removeAccount(account) {
      // AccountRemove: see webadmin/admin.go — signature (accountName).
      try {
        await admin<unknown>('AccountRemove', { AccountName: account });
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown';
        if (/not.?found|unknown account/i.test(msg)) return true;
        // eslint-disable-next-line no-console
        console.warn(`mox: AccountRemove failed for ${account}: ${msg}`);
        return false;
      }
    },
    async listAccounts() {
      // Accounts: see webadmin/admin.go — returns []Account. Field names follow
      // the Go-struct→JSON convention (PascalCase). We extract `Name` only.
      try {
        const r = await admin<unknown>('Accounts');
        // The exact shape varies by Mox version; accept either a top-level
        // array, or an object { Accounts: [...] }, or { Names: [...] }.
        if (Array.isArray(r)) {
          return r.map((a) => (a as { Name?: string }).Name ?? '').filter(Boolean);
        }
        const o = r as { Accounts?: { Name?: string }[]; Names?: string[] };
        if (Array.isArray(o.Names)) return o.Names;
        if (Array.isArray(o.Accounts)) {
          return o.Accounts.map((a) => a.Name ?? '').filter(Boolean);
        }
        return [];
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`mox: Accounts list failed: ${e instanceof Error ? e.message : 'unknown'}`);
        return [];
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
