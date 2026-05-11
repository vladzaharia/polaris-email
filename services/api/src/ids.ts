// ULID (Crockford base32) + request_id generation.
// Implements Stripe-style ULID locally — no external deps so it runs unchanged on Workers.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0) throw new Error('ulid: bad time');
  let t = now;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod] + out;
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < RAND_LEN; i++) out += ENCODING[(rnd[i] ?? 0) % 32];
  return out;
}

export function requestId(): string {
  const rnd = new Uint8Array(12);
  crypto.getRandomValues(rnd);
  return 'req_' + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
}
