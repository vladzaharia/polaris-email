import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface Me {
  authenticated: boolean;
  subject?: string;
  email?: string | null;
  display_name?: string | null;
  groups?: string[];
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: body as T };
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [page, setPage] = useState<string>('overview');
  useEffect(() => {
    void api<Me>('/api/me').then((r) => setMe(r.body));
  }, []);
  if (me == null) return <div>Loading...</div>;
  if (!me.authenticated) return <Login onLoggedIn={() => api<Me>('/api/me').then((r) => setMe(r.body))} />;
  return (
    <>
      <nav>
        <strong>polaris-email</strong>
        <a onClick={() => setPage('overview')}>Overview</a>
        <a onClick={() => setPage('services')}>Services</a>
        <a onClick={() => setPage('api-keys')}>API keys</a>
        <a onClick={() => setPage('mailboxes')}>Mailboxes</a>
        <a onClick={() => setPage('webhooks')}>Webhooks</a>
        <a onClick={() => setPage('routing')}>Routing</a>
        <a onClick={() => setPage('audit')}>Audit</a>
        <a onClick={() => setPage('diagnostics')}>Diagnostics</a>
        <span style={{ marginLeft: 'auto' }}>
          {me.email} <button onClick={() => api('/api/logout', { method: 'POST' }).then(() => setMe(null))}>Logout</button>
        </span>
      </nav>
      <main>
        {page === 'overview' && <Overview />}
        {page === 'services' && <Services />}
        {page === 'api-keys' && <ApiKeys />}
        {page === 'mailboxes' && <Mailboxes />}
        {page === 'webhooks' && <Webhooks />}
        {page === 'routing' && <Routing />}
        {page === 'audit' && <Audit />}
        {page === 'diagnostics' && <Diagnostics />}
      </main>
    </>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [subject, setSubject] = useState('dev@local');
  const [admin, setAdmin] = useState(true);
  return (
    <main>
      <h2>Login (dev mode)</h2>
      <p>In production this page redirects to OIDC. Dev mode lets you stamp a session locally.</p>
      <label>
        Subject: <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>{' '}
      <label>
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Admin
      </label>{' '}
      <button
        onClick={async () => {
          await api('/api/dev/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subject, admin }),
          });
          onLoggedIn();
        }}
      >
        Log in
      </button>
    </main>
  );
}

function Overview() {
  return (
    <div>
      <h2>Overview</h2>
      <p>
        polaris-email runs on Cloudflare Workers, with on-prem submission daemons for legacy
        SMTPS clients. Use the nav above to manage services, keys, mailboxes, webhooks, routing
        rules, and audit.
      </p>
      <p>
        Critical operational pages: <strong>Diagnostics</strong> for the green-tick self-test;{' '}
        <strong>Audit</strong> for chain-integrity status.
      </p>
    </div>
  );
}

function Services() {
  const [rows, setRows] = useState<{ id: string; name: string }[]>([]);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    void api<{ data: { id: string; name: string }[] }>('/api/tenants').then((r) => setRows(r.body?.data ?? []));
  }, []);
  return (
    <div>
      <h2>Services</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Quarantine</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.name}</td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    const ticket = prompt(`Type incident ticket ID to quarantine "${r.id}":`);
                    if (!ticket) return;
                    if (prompt(`Type "${r.id}" to confirm:`) !== r.id) return;
                    const res = await api(`/api/tenants/${r.id}/quarantine`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ incident_ticket_id: ticket }),
                    });
                    alert(JSON.stringify(res.body));
                  }}
                >
                  Quarantine
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Onboard new service</h3>
      <input placeholder="slug" value={id} onChange={(e) => setId(e.target.value)} />{' '}
      <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />{' '}
      <button
        onClick={async () => {
          const res = await api('/api/tenants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, name }),
          });
          alert(JSON.stringify(res.body));
          if (res.status === 201) location.reload();
        }}
      >
        Create
      </button>
    </div>
  );
}

function ApiKeys() {
  const [rows, setRows] = useState<{ id: string; principal_id: string | null; status: string }[]>([]);
  const [showSecret, setShowSecret] = useState<{ key_id: string; key_secret: string } | null>(null);
  useEffect(() => {
    void api<{ data: { id: string; principal_id: string | null; status: string }[] }>(
      '/api/api-keys',
    ).then((r) => setRows(r.body?.data ?? []));
  }, []);
  return (
    <div>
      <h2>API keys</h2>
      <p>
        Secrets are revealed exactly once at issuance. Copy them into your service's env vars
        immediately.
      </p>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Service</th>
            <th>Status</th>
            <th>Rotate</th>
            <th>Revoke</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.principal_id ?? ''}</td>
              <td>{r.status}</td>
              <td>
                <button
                  onClick={async () => {
                    const ok = confirm(`Rotate ${r.id} (planned)?`);
                    if (!ok) return;
                    const res = await api(`/api/api-keys/${r.id}/rotate`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ mode: 'planned' }),
                    });
                    const body = res.body as { new_key_secret?: string; new_key_id?: string };
                    if (body.new_key_secret && body.new_key_id) {
                      setShowSecret({ key_id: body.new_key_id, key_secret: body.new_key_secret });
                    } else alert(JSON.stringify(body));
                  }}
                >
                  Rotate
                </button>
              </td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    if (prompt(`Type ${r.id} to revoke emergency:`) !== r.id) return;
                    const res = await api(`/api/api-keys/${r.id}/revoke`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ mode: 'emergency', reason: 'panel-emergency' }),
                    });
                    alert(JSON.stringify(res.body));
                    if (res.status === 200) location.reload();
                  }}
                >
                  Emergency revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showSecret && (
        <div style={{ marginTop: 20, padding: 12, background: '#ffe' }}>
          <p>
            <strong>One-time reveal.</strong> Copy now — you will not see this again.
          </p>
          <pre>POLARIS_EMAIL_KEY_ID={showSecret.key_id}{'\n'}POLARIS_EMAIL_KEY_SECRET={showSecret.key_secret}</pre>
          <button onClick={() => setShowSecret(null)}>I've copied it</button>
        </div>
      )}
    </div>
  );
}

function Mailboxes() {
  const [address, setAddress] = useState('');
  return (
    <div>
      <h2>Mailboxes</h2>
      <input placeholder="address@host" value={address} onChange={(e) => setAddress(e.target.value)} />{' '}
      <button
        onClick={async () => {
          const res = await api('/api/mailboxes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address, retain_imap: true }),
          });
          alert(JSON.stringify(res.body));
        }}
      >
        Create
      </button>
    </div>
  );
}

function Webhooks() {
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'external' | 'tailnet'>('external');
  return (
    <div>
      <h2>Webhooks</h2>
      <input placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} />{' '}
      <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
        <option value="external">external</option>
        <option value="tailnet">tailnet</option>
      </select>{' '}
      <button
        onClick={async () => {
          const res = await api('/api/webhook-subs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url, kind, events: ['message.received'] }),
          });
          alert(JSON.stringify(res.body));
        }}
      >
        Create
      </button>
    </div>
  );
}

function Routing() {
  return (
    <div>
      <h2>Routing</h2>
      <p>Manage routing rules and local-webhook-targets — see the REST APIs.</p>
    </div>
  );
}

function Audit() {
  const [chain, setChain] = useState<unknown>(null);
  useEffect(() => {
    void api('/api/audit/chain-status').then((r) => setChain(r.body));
  }, []);
  return (
    <div>
      <h2>Audit</h2>
      <pre>{JSON.stringify(chain, null, 2)}</pre>
    </div>
  );
}

function Diagnostics() {
  const [result, setResult] = useState<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail?: string }[];
  } | null>(null);
  return (
    <div>
      <h2>Diagnostics</h2>
      <button
        onClick={async () => {
          const r = await api<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }>(
            '/api/diagnostics',
          );
          setResult(r.body);
        }}
      >
        Run self-test
      </button>
      {result && (
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {result.checks.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td style={{ color: c.ok ? 'green' : 'red' }}>{c.ok ? 'OK' : 'FAIL'}</td>
                <td>{c.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
