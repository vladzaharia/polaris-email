// Mox admin-API client.
//
// Mox v0.0.15 exposes two HTTP RPC surfaces:
//
//   1. /admin/api/<Method> — sherpa RPC for server-level admin ops
//      (account/address/password management). Auth is a session cookie +
//      CSRF header obtained from a LoginPrep/Login ceremony backed by a
//      bcrypt hash file (AdminPasswordFile in mox.conf). See
//      mjl-/mox webauth/admin.go and webadmin/admin.go.
//   2. /webapi/v0/<Method> — JSON HTTP API for per-account mail ops.
//      Auth is HTTP basic (email + plaintext). See webapi/webapi.go +
//      webapisrv/server.go.
//
// Wire-format rules (sherpa):
//   - Request: POST application/json with body = JSON ARRAY of positional
//     args (NOT an object). Order matches the Go method signature.
//   - Response: HTTP 200 in all cases. Body is either a JSON value
//     (single return), a JSON array (multi-return), or a sherpa error
//     envelope {"code": "user:...", "message": "..."}. A void method may
//     respond with `null` or `[]`. NEVER use the HTTP status code as a
//     success signal: parse the body.
//
// Citations into mjl-/mox at tag v0.0.15:
//   - AccountAdd(accountName, address): webadmin/admin.go:1983
//   - AccountRemove(accountName): webadmin/admin.go:1989
//   - SetPassword(accountName, password): webadmin/admin.go:2009
//   - Accounts() -> (all []string, disabled []string): webadmin/admin.go:1598-1602
//   - LoginPrep / Login: webadmin/admin.go:262-272 and webauth/admin.go:44-60
//   - Admin password is bcrypt-hashed in AdminPasswordFile: config/config.go:55
//
// Deliberately NOT implemented (verified non-existent in v0.0.15):
//   - MessageImport (no such webapi method — webapi/webapi.go:17-31).
//     Replaced by submitMessage() which submits to local SMTPS @ 465 with
//     the account's credentials (verified canonical path per the research
//     findings).
//   - ConfigReload (no such admin method). domains.conf reloads
//     automatically on file change (config/doc.go:6-19); mox.conf
//     requires a process restart.
import { createTransport } from 'nodemailer';

export interface MoxAccountSpec {
  /** Mox account name (we use the full address). */
  account: string;
  /** Primary address (used as login). */
  address: string;
}

export interface MoxSubmitInput {
  /** Account login (full email address). */
  account: string;
  /** Plaintext password matching the account. */
  password: string;
  /** RFC822 bytes to relay. */
  rfc822: Buffer;
  /** Envelope MAIL FROM. */
  from: string;
  /** Envelope RCPT TO. */
  to: string[];
}

export interface MoxClient {
  /** Submit an RFC822 message via SMTPS using the account's own credentials. */
  submitMessage(input: MoxSubmitInput): Promise<void>;
  /** Ensure a Mox account exists. Idempotent. */
  ensureAccount(spec: MoxAccountSpec): Promise<boolean>;
  /** Set the plaintext password for a Mox account. */
  setAccountPassword(account: string, plaintext: string): Promise<boolean>;
  /** Remove a Mox account. Idempotent. */
  removeAccount(account: string): Promise<boolean>;
  /** List Mox accounts (Accounts RPC return value [0]: allNames). */
  listAccounts(): Promise<string[]>;
  /** Parse a Mox outgoing-webhook payload into a canonical shape. */
  parseOutgoingWebhook(payload: unknown): {
    account: string;
    rfc822: Buffer;
    from: string;
    to: string[];
  };
}

/** Sherpa error envelope (returned with HTTP 200). */
export class MoxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`mox: ${code}: ${message}`);
  }
}

interface MoxClientOpts {
  /** e.g. http://127.0.0.1:80 */
  adminBaseUrl: string;
  /** e.g. http://127.0.0.1:80 (may be the same as admin) */
  webapiBaseUrl?: string;
  /** Plaintext admin password (matches AdminPasswordFile bcrypt). */
  adminPassword: string;
  /** Host for SMTPS submission. */
  submitHost?: string;
  /** Port for SMTPS submission. */
  submitPort?: number;
  /** Inject a fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

export function makeMoxClient(opts: MoxClientOpts): MoxClient {
  const adminBase = opts.adminBaseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Session state for the admin sherpa RPC.
  let sessionCookie = ''; // value of `webadminsession`
  let csrfToken = '';

  // Parse Set-Cookie headers and extract a named cookie's value. The
  // standard fetch Headers.get('set-cookie') concatenates multiple values
  // with commas which is ambiguous for cookies (date fields contain
  // commas). Use Headers.getSetCookie() on Node 20+ for a clean split.
  function readSetCookie(res: Response, name: string): string | null {
    const all =
      typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
      'function'
        ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie') as string]
          : [];
    for (const c of all) {
      const m = c.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
      if (m) return m[1] ?? null;
    }
    return null;
  }

  // Sherpa wire format: POST /admin/api/<Method> with body = JSON array
  // of positional args; response is HTTP 200 with either a JSON value or
  // a {"code","message"} error envelope.
  async function sherpaRaw(
    pathPrefix: string,
    method: string,
    args: unknown[],
    extraHeaders: Record<string, string> = {},
    extraCookie = '',
  ): Promise<{ res: Response; body: unknown }> {
    const url = `${adminBase}${pathPrefix}/${method}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...extraHeaders,
    };
    const cookies: string[] = [];
    if (sessionCookie) cookies.push(`webadminsession=${sessionCookie}`);
    if (extraCookie) cookies.push(extraCookie);
    if (cookies.length > 0) headers['cookie'] = cookies.join('; ');
    if (csrfToken && pathPrefix === '/admin/api' && method !== 'LoginPrep' && method !== 'Login') {
      headers['x-mox-csrf'] = csrfToken;
    }
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON body — surface raw text.
        throw new Error(`mox ${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
    }
    return { res, body };
  }

  // Run the LoginPrep -> Login ceremony to populate sessionCookie + csrfToken.
  async function loginAdmin(): Promise<void> {
    if (!opts.adminPassword) throw new Error('mox: admin password not configured');
    // 1. LoginPrep — no args, sets `webadminlogin=<token>` cookie and
    //    returns a loginToken string in the body.
    sessionCookie = '';
    csrfToken = '';
    const prep = await sherpaRaw('/admin/api', 'LoginPrep', []);
    if (isSherpaError(prep.body)) {
      throw new MoxError(prep.body.code, prep.body.message);
    }
    const loginToken = typeof prep.body === 'string' ? prep.body : '';
    if (!loginToken) throw new Error('mox: LoginPrep returned no token');
    const webadminlogin = readSetCookie(prep.res, 'webadminlogin');
    if (!webadminlogin) throw new Error('mox: LoginPrep did not set webadminlogin cookie');

    // 2. Login [loginToken, "", password] — sets `webadminsession=<token>`
    //    cookie and returns a CSRF token in the body. The "" is the
    //    unused username slot (admin login is single-user).
    const login = await sherpaRaw(
      '/admin/api',
      'Login',
      [loginToken, '', opts.adminPassword],
      {},
      `webadminlogin=${webadminlogin}`,
    );
    if (isSherpaError(login.body)) {
      throw new MoxError(login.body.code, login.body.message);
    }
    const session = readSetCookie(login.res, 'webadminsession');
    if (!session) throw new Error('mox: Login did not set webadminsession cookie');
    sessionCookie = session;
    csrfToken = typeof login.body === 'string' ? login.body : '';
    if (!csrfToken) throw new Error('mox: Login returned no CSRF token');
  }

  async function ensureSession(): Promise<void> {
    if (sessionCookie && csrfToken) return;
    await loginAdmin();
  }

  // Admin sherpa call with single-shot 401 retry that re-runs the
  // ceremony. Throws MoxError on sherpa error envelopes; throws Error
  // on transport / non-JSON / HTTP-status failure.
  async function admin<T>(method: string, args: unknown[]): Promise<T> {
    await ensureSession();
    let attempt = 0;
    // Loop runs at most twice: once normally, once after a fresh login.
    // We treat HTTP 401/403 AND the sherpa "user:noAuth" code as auth
    // failures.
    while (true) {
      attempt++;
      const { res, body } = await sherpaRaw('/admin/api', method, args);
      const authFail =
        res.status === 401 ||
        res.status === 403 ||
        (isSherpaError(body) && /noauth|badauth|unauthor/i.test(body.code));
      if (authFail && attempt === 1) {
        await loginAdmin();
        continue;
      }
      if (res.status >= 400 && !isSherpaError(body)) {
        throw new Error(`mox ${method}: HTTP ${res.status}`);
      }
      if (isSherpaError(body)) {
        throw new MoxError(body.code, body.message);
      }
      return body as T;
    }
  }

  function isSherpaError(b: unknown): b is { code: string; message: string } {
    return (
      typeof b === 'object' &&
      b !== null &&
      typeof (b as { code?: unknown }).code === 'string' &&
      typeof (b as { message?: unknown }).message === 'string'
    );
  }

  return {
    async submitMessage(input) {
      // Replaces the (non-existent) webapi/v0/MessageImport. Path:
      // SMTPS submission to local Mox on 127.0.0.1:465 with the account's
      // own credentials. This is the canonical Mox-supported route for
      // injecting a pre-built RFC822 (see webapi/webapi.go — no Import
      // method; the only programmatic paths are SMTP submission, IMAP
      // APPEND, or `mox import` via the local ctl socket).
      const transport = createTransport({
        host: opts.submitHost ?? '127.0.0.1',
        port: opts.submitPort ?? 465,
        secure: true,
        auth: { user: input.account, pass: input.password },
        // We're talking to local loopback inside the ts netns; the cert
        // hostname won't match 127.0.0.1, but the TLS still happens.
        tls: { rejectUnauthorized: false },
      });
      try {
        await transport.sendMail({
          envelope: { from: input.from, to: input.to },
          raw: input.rfc822,
        });
      } finally {
        transport.close();
      }
    },

    async ensureAccount(spec) {
      // AccountAdd(accountName, address). Sherpa positional args:
      //   webadmin/admin.go:1983.
      try {
        await admin<unknown>('AccountAdd', [spec.account, spec.address]);
        return true;
      } catch (e) {
        if (e instanceof MoxError && /exist|already/i.test(e.message)) return true;
        const msg = e instanceof Error ? e.message : 'unknown';
        // eslint-disable-next-line no-console
        console.warn(`mox: AccountAdd failed for ${spec.account}: ${msg}`);
        return false;
      }
    },

    async setAccountPassword(account, plaintext) {
      // SetPassword(accountName, password). Min 8 chars (server-enforced).
      //   webadmin/admin.go:2009. Plaintext required because Mox derives
      //   bcrypt + CRAM-MD5 + SCRAM-SHA-1/256 from it (store/account.go:2525).
      try {
        await admin<unknown>('SetPassword', [account, plaintext]);
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
      // AccountRemove(accountName). webadmin/admin.go:1989.
      try {
        await admin<unknown>('AccountRemove', [account]);
        return true;
      } catch (e) {
        if (e instanceof MoxError && /not.?found|unknown account/i.test(e.message)) return true;
        const msg = e instanceof Error ? e.message : 'unknown';
        // eslint-disable-next-line no-console
        console.warn(`mox: AccountRemove failed for ${account}: ${msg}`);
        return false;
      }
    },

    async listAccounts() {
      // Accounts() -> (all []string, disabled []string).
      //   webadmin/admin.go:1598-1602.
      // Sherpa serialises multi-return as a JSON array: [allNames, disabledNames].
      try {
        const r = await admin<[string[], string[]]>('Accounts', []);
        if (!Array.isArray(r) || !Array.isArray(r[0])) {
          // eslint-disable-next-line no-console
          console.warn('mox: Accounts returned unexpected shape:', JSON.stringify(r).slice(0, 200));
          return [];
        }
        return r[0];
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`mox: Accounts list failed: ${e instanceof Error ? e.message : 'unknown'}`);
        return [];
      }
    },

    parseOutgoingWebhook(payload) {
      // Outgoing webhook payload — see queue/hook.go + webhook/webhook.go
      // in mox v0.0.15. The exact field names use PascalCase in Mox.
      // Tolerate both casings while we shake the integration out.
      const p = payload as Record<string, unknown>;
      const account =
        (p.account as string | undefined) ?? (p.Account as string | undefined) ?? '';
      const rfc822b64 =
        (p.rfc822 as string | undefined) ?? (p.Rfc822 as string | undefined) ?? '';
      const from =
        (p.envelope_from as string | undefined) ??
        (p.From as string | undefined) ??
        (p.MailFrom as string | undefined) ??
        '';
      const to =
        (p.envelope_to as string[] | undefined) ??
        (p.To as string[] | undefined) ??
        (p.RcptTo as string[] | undefined) ??
        [];
      if (!account || !rfc822b64) throw new Error('mox: bad outgoing webhook payload');
      return {
        account,
        rfc822: Buffer.from(rfc822b64, 'base64'),
        from,
        to,
      };
    },
  };
}
