// AWS SigV4 PUT-with-Object-Lock for Cloudflare Workers.
//
// The Workers runtime has no S3 SDK, so we hand-roll the minimum: a single
// `PutObject` request signed with AWS SigV4 ("AWS4-HMAC-SHA256"), with
// `x-amz-object-lock-mode: COMPLIANCE` and a `x-amz-object-lock-retain-until-date`
// header. Used by `services/api/src/scheduled/anchor.ts` to write hourly
// audit anchors to Backblaze B2 (or any S3-compatible Object-Lock target).
//
// Path-style URL: `${endpoint}/${bucket}/${key}`. Path-style works against
// every S3-compatible vendor we care about (B2, AWS, Wasabi, Minio) and
// keeps the canonical-resource derivation trivial. Virtual-hosted style
// would force us to embed the bucket into the Host header — gratuitously
// complex for a 200-LOC signer.
//
// SigV4 reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// (Service name "s3" + standard HMAC-SHA256 chain.)

export interface ObjectLockEnv {
  /**
   * S3-compatible endpoint URL, including scheme. Example for Backblaze B2:
   *   `https://s3.us-west-005.backblazeb2.com`
   * No trailing slash; bucket + key are appended path-style by the signer.
   */
  ANCHOR_S3_ENDPOINT: string;
  /** Bucket name (must be Object-Lock-enabled on the vendor side). */
  ANCHOR_S3_BUCKET: string;
  /** SigV4 region. For B2 this is the tag after `s3.` in the endpoint. */
  ANCHOR_S3_REGION: string;
  /** S3 Application Key ID. */
  ANCHOR_S3_ACCESS_KEY_ID?: string;
  /** S3 Application Key (secret). */
  ANCHOR_S3_SECRET_ACCESS_KEY?: string;
  /**
   * Per-object retain-until offset, in days. Defaults to 2555 (7 years).
   * The bucket's default retention enforces the floor regardless of this.
   */
  ANCHOR_RETENTION_DAYS?: string;
}

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const DEFAULT_RETENTION_DAYS = 2555;

const HEX_TABLE = (() => {
  const t = new Array<string>(256);
  for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, '0');
  return t;
})();

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX_TABLE[b];
  return s;
}

async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as ArrayBuffer));
  return toHex(digest);
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  // Workers' SubtleCrypto wants an ArrayBuffer-backed BufferSource; copy
  // into a fresh ArrayBuffer so any TypedArray view we got passed (which may
  // be a SharedArrayBuffer view in theory) is normalized.
  const keyBuf = new ArrayBuffer(key.byteLength);
  new Uint8Array(keyBuf).set(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sigBuf);
}

/**
 * SigV4 amz-date (UTC, no separators): `YYYYMMDD'T'HHMMSS'Z'`.
 */
function amzDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * RFC3339 / ISO8601 date for `x-amz-object-lock-retain-until-date`. S3
 * accepts `YYYY-MM-DDTHH:MM:SSZ` (no fractional seconds) — we strip the
 * millisecond portion that `Date#toISOString` includes. `from` anchors the
 * computation so tests can use a fixed clock; production passes `new Date()`.
 */
function retainUntilIso(from: Date, days: number): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Encode a path segment per SigV4 rules: same as encodeURIComponent, with
 * the additional caveat that `/` MUST stay literal (paths are
 * segment-by-segment encoded). We accept a full path and encode segment by
 * segment.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!*'()]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

interface SignedRequest {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  body: Uint8Array;
  /** Exposed for test introspection — the canonical request that was signed. */
  canonicalRequest: string;
  /** Exposed for tests — the full string-to-sign. */
  stringToSign: string;
}

/**
 * Build a fully-signed SigV4 PUT request for the given key + body. Pure;
 * does no IO. Exported so tests can inspect the canonical request and the
 * Authorization header without hitting the network.
 */
export async function buildSignedPutRequest(
  env: ObjectLockEnv,
  key: string,
  body: Uint8Array,
  now: Date = new Date(),
): Promise<SignedRequest> {
  const accessKeyId = env.ANCHOR_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.ANCHOR_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('object-lock: ANCHOR_S3_ACCESS_KEY_ID / ANCHOR_S3_SECRET_ACCESS_KEY required');
  }
  if (!env.ANCHOR_S3_ENDPOINT || !env.ANCHOR_S3_BUCKET || !env.ANCHOR_S3_REGION) {
    throw new Error(
      'object-lock: ANCHOR_S3_ENDPOINT / ANCHOR_S3_BUCKET / ANCHOR_S3_REGION required',
    );
  }

  const endpointUrl = new URL(env.ANCHOR_S3_ENDPOINT);
  const host = endpointUrl.host;
  const retentionDays = Number(env.ANCHOR_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`object-lock: invalid ANCHOR_RETENTION_DAYS: ${env.ANCHOR_RETENTION_DAYS}`);
  }

  const ts = amzDate(now);
  const dateStamp = ts.slice(0, 8); // YYYYMMDD
  const retainUntil = retainUntilIso(now, retentionDays);
  const payloadHash = await sha256Hex(body);

  // Path-style: /<bucket>/<key>. Bucket name needs no encoding (DNS-safe).
  // Each key segment is URL-encoded; the joining '/' stays literal.
  const canonicalUri = `/${encodeURIComponent(env.ANCHOR_S3_BUCKET)}/${encodePath(key)}`;
  const canonicalQuerystring = '';

  // Canonical headers MUST be sorted by lowercase name, trimmed of
  // surrounding whitespace, and joined with '\n'. The signed-headers list
  // mirrors that order with ';' separators.
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': ts,
    'x-amz-object-lock-mode': 'COMPLIANCE',
    'x-amz-object-lock-retain-until-date': retainUntil,
  };
  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders =
    sortedHeaderNames.map((n) => `${n}:${headers[n]!.trim()}`).join('\n') + '\n';
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${env.ANCHOR_S3_REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, ts, credentialScope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );

  // Derive the SigV4 chained signing key:
  //   kDate    = HMAC("AWS4" + secret, date)
  //   kRegion  = HMAC(kDate, region)
  //   kService = HMAC(kRegion, "s3")
  //   kSigning = HMAC(kService, "aws4_request")
  const kSecret = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  const kDate = await hmac(kSecret, dateStamp);
  const kRegion = await hmac(kDate, env.ANCHOR_S3_REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    `${ALGORITHM} ` +
    `Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const url = `${endpointUrl.protocol}//${host}${canonicalUri}`;
  const outgoingHeaders: Record<string, string> = {
    ...headers,
    Authorization: authorization,
    'Content-Type': 'application/json',
    'Content-Length': String(body.byteLength),
  };

  return {
    url,
    method: 'PUT',
    headers: outgoingHeaders,
    body,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * PUT `body` to S3 (B2/AWS/Wasabi) under `key` with COMPLIANCE-mode Object
 * Lock + a retain-until date. Throws on non-2xx with the response status +
 * body text so the caller can surface the failure to logs.
 */
export async function putObjectWithLock(
  env: ObjectLockEnv,
  key: string,
  body: Uint8Array | string,
): Promise<void> {
  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const signed = await buildSignedPutRequest(env, key, bodyBytes);
  // Pass an ArrayBuffer (a BodyInit Workers accepts) rather than a Uint8Array
  // view; the latter trips the Workers `fetch()` overloads.
  const bodyAb = new ArrayBuffer(signed.body.byteLength);
  new Uint8Array(bodyAb).set(signed.body);
  const res = await fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: bodyAb,
  });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore body-read errors; the status is the load-bearing fact
    }
    throw new Error(`object-lock: PUT ${signed.url} failed: ${res.status} ${text}`);
  }
}
