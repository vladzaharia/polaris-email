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
  // One-shot installer URL. Null when the operator dismissed the
  // banner after deploy or the bridge has been alive long enough that
  // we cleared the bundle.
  installerUrl: string | null;
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
  stashFreshBridgeSecrets(bridgeId, { hmacKey, installerUrl: null });
}
export function readFreshBridgeKey(bridgeId: string): string | null {
  return readFreshBridgeSecrets(bridgeId)?.hmacKey ?? null;
}
export function clearFreshBridgeKey(bridgeId: string): void {
  clearFreshBridgeSecrets(bridgeId);
}
