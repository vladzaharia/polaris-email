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
    path: '/v1/send/raw',
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
    path: '/v1/send/raw',
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
    path: '/v1/send/raw',
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
  // Empty body: signatures must still be deterministic over an empty string.
  {
    name: 'webhook/POST/empty-body',
    direction: 'polaris-webhook.v1',
    method: 'POST',
    path: '/hook',
    query: '',
    ts: '1700000000000',
    nonce: 'EMPTYBODYAAAAAAA',
    secret: SECRET,
    body: '',
    must_verify: true,
  },
  // UTF-8 multibyte body. Catches verifiers that hash by char-count instead of
  // byte-length, or that decode the body before hashing.
  {
    name: 'webhook/POST/utf8-body',
    direction: 'polaris-webhook.v1',
    method: 'POST',
    path: '/hook',
    query: '',
    ts: '1700000000000',
    nonce: 'UTF8BODYAAAAAAAA',
    secret: SECRET,
    body: '{"subject":"héllo 🌍 world","note":"日本語"}',
    must_verify: true,
  },
  // Query with percent-encoded reserved chars (RFC 3986 sub-delims). All
  // verifiers must agree on the canonical form of `q=hello%20world&q=a%2Bb`.
  {
    name: 'api/GET/query-percent-encoded',
    direction: 'polaris-api.v1',
    method: 'GET',
    path: '/v1/audit',
    query: 'q=hello%20world&q=a%2Bb&filter=k%3Dv',
    ts: '1700000000000',
    nonce: 'PERCENTENCAAAAAA',
    secret: SECRET,
    body: '',
    must_verify: true,
  },
  // Query with values that include the unreserved-but-tricky set: !'()* .
  // Verifiers historically diverge on whether to encode these. Canonical form
  // must agree byte-for-byte across node/go/python.
  {
    name: 'api/GET/query-unreserved-special',
    direction: 'polaris-api.v1',
    method: 'GET',
    path: '/v1/audit',
    query: 'q=he%21llo%27s&n=name%28x%29%2A',
    ts: '1700000000000',
    nonce: 'UNRESERVEDAAAAAA',
    secret: SECRET,
    body: '',
    must_verify: true,
  },
  // Path with percent-encoded segment. Verifiers must NOT decode the path
  // before hashing (canonical form is byte-exact).
  {
    name: 'api/GET/path-percent-encoded',
    direction: 'polaris-api.v1',
    method: 'GET',
    path: '/v1/send/raw/01HXR%2FWITHSLASH',
    query: '',
    ts: '1700000000000',
    nonce: 'PATHENCODEAAAAAA',
    secret: SECRET,
    body: '',
    must_verify: true,
  },
  // Nonce at the documented length boundary (16 chars — the minimum).
  {
    name: 'api/POST/nonce-min-length',
    direction: 'polaris-api.v1',
    method: 'POST',
    path: '/v1/send',
    query: '',
    ts: '1700000000000',
    nonce: 'AAAABBBBCCCCDDDD',
    secret: SECRET,
    body: '{}',
    must_verify: true,
  },
  // Nonce near the upper boundary (128 chars). Distinct enough to detect
  // truncation bugs.
  {
    name: 'api/POST/nonce-max-length',
    direction: 'polaris-api.v1',
    method: 'POST',
    path: '/v1/send',
    query: '',
    ts: '1700000000000',
    nonce:
      'AAAABBBBCCCCDDDD' +
      'EEEEFFFFGGGGHHHH' +
      'IIIIJJJJKKKKLLLL' +
      'MMMMNNNNOOOOPPPP' +
      'QQQQRRRRSSSSTTTT' +
      'UUUUVVVVWWWWXXXX' +
      'YYYYZZZZ22223333' +
      '4444555566667777',
    secret: SECRET,
    body: '{}',
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
  path: '/v1/send/raw',
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
  path: '/v1/send/raw',
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
  path: '/v1/send/raw',
  query: '',
  ts: '1700000000000',
  nonce: 'AAAABBBBCCCCDDDD',
  secret: SECRET,
  body: '{}',
  expected_sig: 'v1=ab',
  must_verify: false,
  expected_error: 'bad_signature',
});

// Nonce too short — under the 16-char minimum.
out.push({
  name: 'negative/nonce-too-short',
  direction: 'polaris-api.v1',
  method: 'POST',
  path: '/v1/send/raw',
  query: '',
  ts: '1700000000000',
  nonce: 'TOOSHORT',
  secret: SECRET,
  body: '{}',
  expected_sig: 'v1=' + 'a'.repeat(64),
  must_verify: false,
  expected_error: 'header_invalid',
});

// Nonce too long — over the 128-char maximum.
out.push({
  name: 'negative/nonce-too-long',
  direction: 'polaris-api.v1',
  method: 'POST',
  path: '/v1/send/raw',
  query: '',
  ts: '1700000000000',
  nonce: 'A'.repeat(129),
  secret: SECRET,
  body: '{}',
  expected_sig: 'v1=' + 'a'.repeat(64),
  must_verify: false,
  expected_error: 'header_invalid',
});

// Wrong-secret signature: signed with a different secret, otherwise valid shape.
// Forces verifiers to actually run HMAC, not just structural checks.
out.push({
  name: 'negative/wrong-secret',
  direction: 'polaris-api.v1',
  method: 'POST',
  path: '/v1/send/raw',
  query: '',
  ts: '1700000000000',
  nonce: 'AAAABBBBCCCCDDDD',
  secret: SECRET,
  // Signature computed with a different secret; will not match.
  expected_sig:
    'v1=' +
    (await (async () => {
      const wrong = await sign(
        {
          direction: 'polaris-api.v1',
          method: 'POST',
          path: '/v1/send/raw',
          query: '',
          ts: '1700000000000',
          nonce: 'AAAABBBBCCCCDDDD',
          body: '{}',
        },
        'WRONG_SECRET_DIFFERENT_FROM_OURS_X1',
      );
      return wrong.replace(/^v1=/, '');
    })()),
  body: '{}',
  must_verify: false,
  expected_error: 'bad_signature',
});

process.stdout.write(JSON.stringify({ version: 1, vectors: out }, null, 2) + '\n');
