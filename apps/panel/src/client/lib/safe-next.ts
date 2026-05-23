// safeNext — sanitiser for the `?next=` deep-link param on /login.
//
// The router redirects an unauthenticated visit to `/login?next=<original>`
// so we can return them to their target after OIDC completes. The raw `next`
// value is attacker-controllable (anyone can craft a /login?next=... link),
// so we constrain it to same-origin pathnames before forwarding it to
// better-auth as `callbackURL`. Returns the value unchanged when it passes;
// `null` when it should be ignored (the caller then falls back to `/`).
//
// Rejects:
//   • non-string / empty
//   • absolute URLs (`https://evil.com`)
//   • protocol-relative URLs (`//evil.com`)
//   • backslash-prefixed paths (`/\evil.com`) — IE/legacy treat `\` as `/`
//   • `/login*` to break a same-page redirect loop
//   • paths over 256 chars (defensive cap; nothing in the panel is deeper)

const MAX_NEXT_LENGTH = 256;

export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > MAX_NEXT_LENGTH) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.startsWith('/\\')) return null;
  // Block the page itself to prevent /login → /login bounce when the
  // operator hand-crafts a URL or a callback returns to /login.
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return null;
  return raw;
}
