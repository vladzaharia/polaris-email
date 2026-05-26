// Pass-the-fresh-secrets channel between the Add-bridge dialog and the
// bridge Detail page.
//
// At registration we mint up to three things for the operator's one-
// time view: the HMAC key, the Tailscale auth key (when TS minting
// is configured server-side), and an installer URL that wraps both
// into a curl-pipe bash script with a 1h server-side TTL. We don't
// want any of these in the URL (browser history, server logs), so
// they get stashed in sessionStorage under a key the Detail page
// knows. The browser tab boundary acts as the TTL: closing the tab
// or navigating away in a different tab loses them — and "rotate to
// mint new ones" is the documented recovery path.

const PREFIX = 'polaris-bridge-fresh:';

export interface FreshBridgeSecrets {
  hmacKey: string;
  tsAuthkey: string | null;
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
      tsAuthkey: parsed.tsAuthkey ?? null,
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
  stashFreshBridgeSecrets(bridgeId, { hmacKey, tsAuthkey: null, installerUrl: null });
}
export function readFreshBridgeKey(bridgeId: string): string | null {
  return readFreshBridgeSecrets(bridgeId)?.hmacKey ?? null;
}
export function clearFreshBridgeKey(bridgeId: string): void {
  clearFreshBridgeSecrets(bridgeId);
}
