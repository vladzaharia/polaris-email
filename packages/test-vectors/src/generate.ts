// Generates the canonical HMAC test-vectors.json shared by all verifier libraries.
// Run: `pnpm --filter @polaris-email/test-vectors generate`
import { sign, type Direction } from '@polaris-email/hmac';

interface Vector {
  name: string;
  direction: Direction;
  method: string;
  path: string;
  query: string;
  ts: string;
  nonce: string;
  secret: string;
  body: string;
  expected_sig: string;
  must_verify: boolean;
  /** non-empty when must_verify=false; expected verifier error code */
  expected_error?:
    | 'bad_signature'
    | 'algorithm_rejected'
    | 'header_invalid'
    | 'clock_skew'
    | 'missing_header';
}

const SECRET = 'XBNRJYZ8WS5KQDVPM7T4F2H6CG3A1E9N';

const cases: Array<Omit<Vector, 'expected_sig'> & { tamper?: (sig: string) => string }> = [
  {
    name: 'api/POST/messages/happy',
    direction: 'polaris-api.v1',
    method: 'POST',
    path: '/v1/messages',
    query: 'mode=test',
    ts: '1700000000000',
    nonce: 'AAAABBBBCCCCDDDD',
    secret: SECRET,
    body: '{"from":"a@b.com","to":["c@d.com"],"subject":"hi","category":"svc.test"}',
    must_verify: true,
  },
  {
    name: 'api/POST/messages/empty-query',
    direction: 'polaris-api.v1',
    method: 'POST',
    path: '/v1/messages',
    query: '',
    ts: '1700000000000',
    nonce: 'AAAABBBBCCCCDDDD',
    secret: SECRET,
    body: '{"x":1}',
    must_verify: true,
  },
  {
    name: 'api/POST/messages/multi-value-query',
    direction: 'polaris-api.v1',
    method: 'POST',
    path: '/v1/messages',
    query: 'b=2&a=1&a=2',
    ts: '1700000000000',
    nonce: 'AAAABBBBCCCCDDDD',
    secret: SECRET,
    body: '',
    must_verify: true,
  },
  {
    name: 'api/GET/admin/list/happy',
    direction: 'polaris-api.v1',
    method: 'GET',
    path: '/v1/admin/api-keys',
    query: 'service=expresscharge',
    ts: '1700000000000',
    nonce: 'GHIJKLMNOPQRSTUV',
    secret: SECRET,
    body: '',
    must_verify: true,
  },
  {
    name: 'webhook/POST/external/happy',
    direction: 'polaris-webhook.v1',
    method: 'POST',
    path: '/email-hook',
    query: '',
    ts: '1700000000000',
    nonce: 'WEBHOOKNONCEAAAA',
    secret: SECRET,
    body: '{"event":"message.received","event_id":"01HXR0000000000000000000A8"}',
    must_verify: true,
  },
];

// Build vectors by signing each case.
const out: Vector[] = [];
for (const c of cases) {
  const sig = await sign(
    {
      direction: c.direction,
      method: c.method,
      path: c.path,
      query: c.query,
      ts: c.ts,
      nonce: c.nonce,
      body: c.body,
    },
    c.secret,
  );
  out.push({ ...c, expected_sig: c.tamper ? c.tamper(sig) : sig });
}

// Append additional negative cases that aren't derived from sign().
out.push({
  name: 'negative/algorithm-not-allowed',
  direction: 'polaris-api.v1',
  method: 'POST',
  path: '/v1/messages',
  query: '',
  ts: '1700000000000',
  nonce: 'AAAABBBBCCCCDDDD',
  secret: SECRET,
  body: '{}',
  expected_sig: 'v2=' + 'a'.repeat(64),
  must_verify: false,
  expected_error: 'algorithm_rejected',
});

out.push({
  name: 'negative/crlf-in-nonce',
  direction: 'polaris-api.v1',
  method: 'POST',
  path: '/v1/messages',
  query: '',
  ts: '1700000000000',
  nonce: 'AAAABBBBCCCC\r\nDD',
  secret: SECRET,
  body: '{}',
  expected_sig: 'v1=' + 'a'.repeat(64),
  must_verify: false,
  expected_error: 'header_invalid',
});

out.push({
  name: 'negative/truncated-sig',
  direction: 'polaris-api.v1',
  method: 'POST',
  path: '/v1/messages',
  query: '',
  ts: '1700000000000',
  nonce: 'AAAABBBBCCCCDDDD',
  secret: SECRET,
  body: '{}',
  expected_sig: 'v1=ab',
  must_verify: false,
  expected_error: 'bad_signature',
});

process.stdout.write(JSON.stringify({ version: 1, vectors: out }, null, 2) + '\n');
