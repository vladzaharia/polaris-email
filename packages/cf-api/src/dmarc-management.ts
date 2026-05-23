import { CloudflareApiError, type CloudflareApiClient } from './client.js';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface DmarcManagementStatus {
  enabled: boolean;
  policy: DmarcPolicy | null;
}

const ALREADY_ENABLED_HINTS = ['already_enabled', 'already enabled'];

function isAlreadyEnabled(err: CloudflareApiError): boolean {
  if (err.status === 409) return true;
  return err.errors.some(
    (e) =>
      ALREADY_ENABLED_HINTS.includes(String(e.code)) ||
      ALREADY_ENABLED_HINTS.some((h) => e.message.toLowerCase().includes(h)),
  );
}

export async function enableDmarcManagement(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<{ enabled: true }> {
  try {
    await client.post<unknown>(`/zones/${zoneId}/dmarc_management`, {});
    return { enabled: true };
  } catch (err) {
    if (err instanceof CloudflareApiError && isAlreadyEnabled(err)) {
      return { enabled: true };
    }
    throw err;
  }
}

export async function setDmarcPolicy(
  client: CloudflareApiClient,
  zoneId: string,
  policy: DmarcPolicy,
): Promise<{ policy: DmarcPolicy }> {
  const r = await client.patch<{ policy: DmarcPolicy }>(`/zones/${zoneId}/dmarc_management`, {
    policy,
  });
  return { policy: r.policy };
}

export async function getDmarcManagementStatus(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<DmarcManagementStatus | null> {
  try {
    const r = await client.get<{ enabled: boolean; policy: DmarcPolicy | null }>(
      `/zones/${zoneId}/dmarc_management`,
    );
    return { enabled: r.enabled, policy: r.policy };
  } catch (err) {
    if (err instanceof CloudflareApiError && (err.status === 404 || err.status === 410)) {
      return null;
    }
    throw err;
  }
}
