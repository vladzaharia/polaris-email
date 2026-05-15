// R2 public-domain URL builder for B5.
//
// All polaris-email message bodies and attachments are served from the
// `r2.mail.plrs.im` Cloudflare R2 custom domain. Keys are content-addressed
// (SHA-256), so the URL itself is the capability token — no signature, no
// expiry, no auth header.
//
// Layout:
//   body:       https://<R2_PUBLIC_HOST>/<r2_key>
//               where r2_key is the existing `mime/<aa>/<bb>/<sha256>` path
//               persisted on `messages.r2_key`.
//   attachment: https://<R2_PUBLIC_HOST>/att/<sha256>/<filename>
//               where filename is URL-encoded; sha256 is the digest of the
//               decoded attachment bytes (computed by the pipeline).
//
// See plan section B5. The previous signed-URL flow lived in
// `@polaris-email/cf-api`'s `signed-urls.ts` and has been deleted.

export interface R2PublicUrlEnv {
  R2_PUBLIC_HOST: string;
}

/**
 * Build a public R2 URL for a stored object. The `filename` suffix is
 * optional — body URLs omit it (the body is the whole RFC822, the path
 * already identifies it), attachment URLs append the (encoded) filename so
 * browsers and IMAP clients get a sensible `Content-Disposition` default
 * when fetching.
 */
export function r2PublicUrl(env: R2PublicUrlEnv, key: string, filename?: string): string {
  const host = env.R2_PUBLIC_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const cleanKey = key.replace(/^\/+/, '');
  const suffix = filename ? '/' + encodeURIComponent(filename) : '';
  return `https://${host}/${cleanKey}${suffix}`;
}

/**
 * Build the R2 object key under which an attachment is stored. Keyed by
 * SHA-256 of the decoded bytes; the filename is included verbatim in the
 * key (and URL) for human readability when downloading.
 */
export function attachmentR2Key(sha256: string, filename: string): string {
  // The filename is escaped to remove path separators so the key shape stays
  // <sha256>/<single-segment>.
  const safeName = filename.replace(/[/\\]/g, '_').slice(0, 255) || 'attachment';
  return `att/${sha256}/${safeName}`;
}
