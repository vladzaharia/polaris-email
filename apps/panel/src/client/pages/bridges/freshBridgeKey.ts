// Pass-the-fresh-key channel between the Add-bridge dialog and the
// bridge Detail page.
//
// The HMAC key returned by POST /v1/admin/bridges is plaintext, read-
// once. We don't want it in the URL (browser history, server logs), so
// we drop it in sessionStorage under a key the Detail page knows to
// look for. The browser tab boundary acts as the TTL: closing the tab
// or navigating away in a different tab loses it, which is exactly the
// "if you didn't finish setup, rotate to get a new one" recovery path
// we already document.

const PREFIX = 'polaris-bridge-fresh:';

export function stashFreshBridgeKey(bridgeId: string, hmacKey: string): void {
  try {
    sessionStorage.setItem(PREFIX + bridgeId, hmacKey);
  } catch {
    // sessionStorage can throw in private mode or with quotas. Silent
    // failure is fine — the detail page falls back to the placeholder.
  }
}

export function readFreshBridgeKey(bridgeId: string): string | null {
  try {
    return sessionStorage.getItem(PREFIX + bridgeId);
  } catch {
    return null;
  }
}

export function clearFreshBridgeKey(bridgeId: string): void {
  try {
    sessionStorage.removeItem(PREFIX + bridgeId);
  } catch {
    // ignore
  }
}
