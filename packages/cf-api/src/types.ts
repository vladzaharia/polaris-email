import { z } from 'zod';

export const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
  account: z.object({ id: z.string(), name: z.string().optional() }).partial().optional(),
  name_servers: z.array(z.string()).optional(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const DnsRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().optional(),
  priority: z.number().optional(),
  proxied: z.boolean().optional(),
  comment: z.string().nullable().optional(),
  zone_id: z.string().optional(),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

export const EmailRoutingSettingsSchema = z.object({
  enabled: z.boolean(),
  name: z.string().optional(),
  tag: z.string().optional(),
  modified_on: z.string().optional(),
  status: z.string().optional(),
  skip_wizard: z.boolean().optional(),
});
export type EmailRoutingSettings = z.infer<typeof EmailRoutingSettingsSchema>;

export const EmailRoutingMatcherSchema = z.object({
  type: z.string(),
  field: z.string().optional(),
  value: z.string().optional(),
});
export const EmailRoutingActionSchema = z.object({
  type: z.string(),
  value: z.array(z.string()).optional(),
});
export const EmailRoutingRuleSchema = z.object({
  tag: z.string().optional(),
  id: z.string().optional(),
  name: z.string(),
  enabled: z.boolean(),
  priority: z.number().optional(),
  matchers: z.array(EmailRoutingMatcherSchema),
  actions: z.array(EmailRoutingActionSchema),
});
export type EmailRoutingRule = z.infer<typeof EmailRoutingRuleSchema>;
export type EmailRoutingMatcher = z.infer<typeof EmailRoutingMatcherSchema>;
export type EmailRoutingAction = z.infer<typeof EmailRoutingActionSchema>;

export interface ExpectedRecord {
  type: string;
  name: string;
  content: string;
  /** Optional comparator override; default normalizes whitespace + case-insensitive */
  match?: 'exact' | 'contains' | 'normalized';
}

export interface DnsOps {
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
  findRecord(
    zoneId: string,
    filter: { type?: string; name?: string },
  ): Promise<DnsRecord | null>;
}
