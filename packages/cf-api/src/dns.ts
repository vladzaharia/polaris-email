import { z } from 'zod';
import type { CloudflareApiClient } from './client.js';
import { DnsRecordSchema, type DnsRecord } from './types.js';

export interface DnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

export interface DnsRecordFilter {
  type?: string;
  name?: string;
}

export async function listRecords(
  client: CloudflareApiClient,
  zoneId: string,
  filter: DnsRecordFilter = {},
): Promise<DnsRecord[]> {
  const params = new URLSearchParams();
  if (filter.type) params.set('type', filter.type);
  if (filter.name) params.set('name', filter.name);
  const qs = params.toString();
  const path = `/zones/${zoneId}/dns_records${qs ? `?${qs}` : ''}`;
  return client.get(path, z.array(DnsRecordSchema));
}

export async function createRecord(
  client: CloudflareApiClient,
  zoneId: string,
  record: DnsRecordInput,
): Promise<DnsRecord> {
  return client.post(`/zones/${zoneId}/dns_records`, record, DnsRecordSchema);
}

export async function updateRecord(
  client: CloudflareApiClient,
  zoneId: string,
  recordId: string,
  patch: Partial<DnsRecordInput>,
): Promise<DnsRecord> {
  return client.patch(`/zones/${zoneId}/dns_records/${recordId}`, patch, DnsRecordSchema);
}

export async function deleteRecord(
  client: CloudflareApiClient,
  zoneId: string,
  recordId: string,
): Promise<void> {
  await client.delete<{ id: string }>(`/zones/${zoneId}/dns_records/${recordId}`);
}

export async function findRecord(
  client: CloudflareApiClient,
  zoneId: string,
  filter: DnsRecordFilter,
): Promise<DnsRecord | null> {
  const records = await listRecords(client, zoneId, filter);
  return records[0] ?? null;
}
