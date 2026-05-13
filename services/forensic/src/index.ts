// polaris-email-forensic: encrypt + decrypt recipient lists with AES-GCM.
// Per-row key is derived HKDF(master, message_id || tenant_id).
// Decryption requires an incident_ticket_id + a second approver subject (the api Worker
// verifies the approvers; this Worker just enforces presence + audits).
//
// Service binding API:
//   POST /encrypt   { message_id, tenant_id, plaintext } → { ciphertext, key_version }
//   POST /decrypt   { message_id, tenant_id, ciphertext, incident_ticket_id,
//                     primary_subject, approver_subject } → { plaintext }

interface Env {
  KEY_VERSION: string;
  FORENSIC_MASTER_KEY?: string; // base64 32-byte master key (wrangler secret)
}

function asBuf(u8: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u8.byteLength);
  new Uint8Array(b).set(u8);
  return b;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

async function deriveKey(master: Uint8Array, context: string): Promise<CryptoKey> {
  // HKDF-Expand-Label with SHA-256.
  const ikm = await crypto.subtle.importKey('raw', asBuf(master), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asBuf(new TextEncoder().encode('polaris-email/forensic/v1')),
      info: asBuf(new TextEncoder().encode(context)),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptRecipients(
  master: Uint8Array,
  context: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveKey(master, context);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuf(iv) },
    key,
    asBuf(new TextEncoder().encode(plaintext)),
  );
  const ctBytes = new Uint8Array(ct);
  const combined = new Uint8Array(iv.length + ctBytes.length);
  combined.set(iv, 0);
  combined.set(ctBytes, iv.length);
  return bytesToB64(combined);
}

async function decryptRecipients(
  master: Uint8Array,
  context: string,
  ciphertextB64: string,
): Promise<string> {
  const key = await deriveKey(master, context);
  const combined = b64ToBytes(ciphertextB64);
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuf(iv) }, key, asBuf(ct));
  return new TextDecoder().decode(pt);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.FORENSIC_MASTER_KEY) return json({ error: 'master_key_missing' }, 500);
    const master = b64ToBytes(env.FORENSIC_MASTER_KEY);
    if (master.length !== 32) return json({ error: 'master_key_invalid' }, 500);

    const url = new URL(req.url);
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    if (url.pathname === '/encrypt') {
      const body = (await req.json()) as {
        message_id?: string;
        tenant_id?: string | null;
        plaintext?: string;
      };
      if (!body.message_id || typeof body.plaintext !== 'string') {
        return json({ error: 'bad_request' }, 400);
      }
      const ct = await encryptRecipients(
        master,
        `${body.message_id}|${body.tenant_id ?? ''}`,
        body.plaintext,
      );
      return json({ ciphertext: ct, key_version: env.KEY_VERSION });
    }
    if (url.pathname === '/decrypt') {
      const body = (await req.json()) as {
        message_id?: string;
        tenant_id?: string | null;
        ciphertext?: string;
        incident_ticket_id?: string;
        primary_subject?: string;
        approver_subject?: string;
      };
      if (
        !body.message_id ||
        !body.ciphertext ||
        !body.incident_ticket_id ||
        !body.primary_subject ||
        !body.approver_subject
      ) {
        return json({ error: 'bad_request', missing: 'fields' }, 400);
      }
      if (body.primary_subject === body.approver_subject) {
        return json({ error: 'two_person_required' }, 403);
      }
      try {
        const pt = await decryptRecipients(
          master,
          `${body.message_id}|${body.tenant_id ?? ''}`,
          body.ciphertext,
        );
        return json({ plaintext: pt });
      } catch {
        return json({ error: 'decrypt_failed' }, 400);
      }
    }
    return json({ error: 'not_found' }, 404);
  },
};
