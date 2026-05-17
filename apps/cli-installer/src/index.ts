// polaris-email cli-installer Worker.
//
// Hosted at cli.mail.plrs.im. Serves a POSIX-sh installer for the
// `polaris-email` operator CLI. The script itself lives at
// `src/install.sh` (source of truth) and is bundled in as a text module
// via the `rules` block in `wrangler.jsonc`.
//
// Endpoints:
//   GET /        -> the install script (text/x-shellscript)
//   GET /sh      -> alias of /
//   GET /healthz -> {ok: true}
//
// Query params on `/` or `/sh`:
//   ?v=<version>  pin the install to a specific release tag. Validated
//                 against SAFE_VERSION to prevent shell injection; the
//                 Worker rewrites the literal `POLARIS_PIN_VERSION=''`
//                 line in the script.

// The shell script is bundled as a text module — see `rules` in
// wrangler.jsonc which binds *.sh files via the `Text` module type.
// @ts-expect-error — handled by wrangler text module rule, not TS.
import installScript from './install.sh';

// Accept tag-like versions: `v1.2.3`, `1.2.3`, with optional `-rc.1` /
// `+build` suffixes. The whole match is anchored. We never let raw user
// input flow into the script body.
const SAFE_VERSION = /^v?[0-9]+(\.[0-9]+){0,2}(-[A-Za-z0-9.]+)?(\+[A-Za-z0-9.]+)?$/;

// Bound the script size against a runaway pin substitution.
const MAX_PIN_LEN = 64;

function renderScript(pin: string | null): string {
  let body = installScript as string;
  if (pin && pin.length <= MAX_PIN_LEN && SAFE_VERSION.test(pin)) {
    body = body.replace(/^POLARIS_PIN_VERSION=.*/m, `POLARIS_PIN_VERSION='${pin}'`);
  }
  return body;
}

export default {
  fetch(req: Request): Response {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true });
    }

    if (url.pathname === '/' || url.pathname === '/sh') {
      const pin = url.searchParams.get('v');
      const body = renderScript(pin);
      return new Response(body, {
        headers: {
          'content-type': 'text/x-shellscript; charset=utf-8',
          // Short cache; releases are infrequent but we want a fast roll-out
          // when we publish a new installer.
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler;
