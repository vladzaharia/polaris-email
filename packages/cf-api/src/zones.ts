import { z } from 'zod';
import type { CloudflareApiClient } from './client.js';
import { ZoneSchema, type Zone } from './types.js';
import { CloudflareApiError } from './client.js';

export async function listZones(client: CloudflareApiClient): Promise<Zone[]> {
  return client.get(
    `/zones?account.id=${encodeURIComponent(client.accountId)}&per_page=50`,
    z.array(ZoneSchema),
  );
}

export async function getZone(client: CloudflareApiClient, zoneId: string): Promise<Zone> {
  return client.get(`/zones/${zoneId}`, ZoneSchema);
}

/**
 * Find a zone by DNS name. If the exact name isn't a registered zone (e.g.
 * `mail.app.example.com` is a subdomain rather than a separately delegated
 * zone), walk up the labels until a registered zone is found.
 */
export async function findZoneByName(
  client: CloudflareApiClient,
  name: string,
): Promise<Zone | null> {
  const labels = name.split('.').filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      const zones = await client.get(
        `/zones?name=${encodeURIComponent(candidate)}`,
        z.array(ZoneSchema),
      );
      if (zones.length > 0) return zones[0]!;
    } catch (err) {
      if (err instanceof CloudflareApiError && err.status === 404) continue;
      throw err;
    }
  }
  return null;
}
