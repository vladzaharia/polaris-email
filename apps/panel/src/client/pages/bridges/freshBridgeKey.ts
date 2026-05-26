// Pass-the-fresh-secrets channel between the Add-bridge dialog and the
// bridge Detail page.
//
// At registration we mint two things for the operator's one-time view:
// the HMAC key (the only secret the operator ever holds), and an
// installer URL that wraps the HMAC + the one-shot install script
// with a 1h server-side TTL. The TS auth key + CF DNS token never
// reach this channel — they flow server-to-bridge over /v1/bridge/
// config and are fetched at compose-up time by the bootstrap init
// container.
//
// We don't put either in the URL (browser history, server logs), so
// they get stashed in sessionStorage under a key the Detail page
// knows. The browser tab boundary acts as the TTL: closing the tab
// or navigating away in a different tab loses them — and "rotate to
// mint new ones" is the documented recovery path.

const PREFIX = 'polaris-bridge-fresh:';

export interface FreshBridgeSecrets {
  hmacKey: string;
  // Installer URL. Embeds the HMAC plaintext and stays valid until the
  // next rotation. Null when we couldn't compute one server-side.
  installerUrl: string | null;
  // Wall-clock ms of the moment we minted these secrets. The Detail
  // page auto-clears the banner once the bridge has phoned home AT OR
  // AFTER this timestamp — so re-rolling on an already-live bridge
  // doesn't immediately wipe the banner (stale heartbeat would clear
  // it before the operator reinstalls).
  mintedAtMs: number;
}

export function stashFreshBridgeSecrets(bridgeId: string, secrets: FreshBridgeSecrets): void {
  try {
    sessionStorage.setItem(PREFIX + bridgeId, JSON.stringify(secrets));
  } catch {
    // sessionStorage can throw in private mode or with quotas. Silent
    // failure is fine — the detail page falls back to the placeholder.
  }
}

export function readFreshBridgeSecrets(bridgeId: string): FreshBridgeSecrets | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + bridgeId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FreshBridgeSecrets>;
    if (!parsed || typeof parsed.hmacKey !== 'string') return null;
    return {
      hmacKey: parsed.hmacKey,
      installerUrl: parsed.installerUrl ?? null,
      // Older entries (pre-mintedAtMs) fall back to 0 — the auto-clear
      // path will then behave like the original "clear on first
      // heartbeat" behaviour for those.
      mintedAtMs: typeof parsed.mintedAtMs === 'number' ? parsed.mintedAtMs : 0,
    };
  } catch {
    return null;
  }
}

export function clearFreshBridgeSecrets(bridgeId: string): void {
  try {
    sessionStorage.removeItem(PREFIX + bridgeId);
  } catch {
    // ignore
  }
}

// Legacy single-string accessors retained for callers that haven't
// migrated yet (kept thin so future cleanup is a sed). New code should
// use the *Secrets variants above.
export function stashFreshBridgeKey(bridgeId: string, hmacKey: string): void {
  stashFreshBridgeSecrets(bridgeId, { hmacKey, installerUrl: null, mintedAtMs: Date.now() });
}
export function readFreshBridgeKey(bridgeId: string): string | null {
  return readFreshBridgeSecrets(bridgeId)?.hmacKey ?? null;
}
export function clearFreshBridgeKey(bridgeId: string): void {
  clearFreshBridgeSecrets(bridgeId);
}
