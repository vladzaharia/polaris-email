import { z } from 'zod';
import type { CloudflareApiClient } from './client.js';
import { CloudflareApiError } from './client.js';
import {
  EmailRoutingRuleSchema,
  EmailRoutingSettingsSchema,
  parseEmailRoutingDnsState,
  type EmailRoutingAction,
  type EmailRoutingDnsState,
  type EmailRoutingMatcher,
  type EmailRoutingRule,
  type EmailRoutingSettings,
} from './types.js';

export async function enableEmailRouting(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<void> {
  await client.post<unknown>(`/zones/${zoneId}/email/routing/enable`, {});
}

export async function disableEmailRouting(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<void> {
  await client.post<unknown>(`/zones/${zoneId}/email/routing/disable`, {});
}

export async function getEmailRoutingSettings(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<EmailRoutingSettings> {
  return client.get(`/zones/${zoneId}/email/routing`, EmailRoutingSettingsSchema);
}

export async function listEmailRoutingRules(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<EmailRoutingRule[]> {
  return client.get(`/zones/${zoneId}/email/routing/rules`, z.array(EmailRoutingRuleSchema));
}

export interface EmailRoutingRuleInput {
  name: string;
  enabled: boolean;
  matchers: EmailRoutingMatcher[];
  actions: EmailRoutingAction[];
  priority?: number;
}

export async function createEmailRoutingRule(
  client: CloudflareApiClient,
  zoneId: string,
  rule: EmailRoutingRuleInput,
): Promise<EmailRoutingRule> {
  return client.post(`/zones/${zoneId}/email/routing/rules`, rule, EmailRoutingRuleSchema);
}

export async function updateEmailRoutingRule(
  client: CloudflareApiClient,
  zoneId: string,
  ruleId: string,
  patch: Partial<EmailRoutingRuleInput>,
): Promise<EmailRoutingRule> {
  return client.patch(
    `/zones/${zoneId}/email/routing/rules/${ruleId}`,
    patch,
    EmailRoutingRuleSchema,
  );
}

export async function deleteEmailRoutingRule(
  client: CloudflareApiClient,
  zoneId: string,
  ruleId: string,
): Promise<void> {
  await client.delete<unknown>(`/zones/${zoneId}/email/routing/rules/${ruleId}`);
}

export type CatchAllAction = { workerScript: string } | { forwardTo: string[] };

export async function setCatchAllRule(
  client: CloudflareApiClient,
  zoneId: string,
  action: CatchAllAction,
): Promise<EmailRoutingRule> {
  const actions: EmailRoutingAction[] =
    'workerScript' in action
      ? [{ type: 'worker', value: [action.workerScript] }]
      : [{ type: 'forward', value: action.forwardTo }];
  const body = {
    name: 'catch-all',
    enabled: true,
    matchers: [{ type: 'all' }],
    actions,
  };
  return client.put(
    `/zones/${zoneId}/email/routing/rules/catch_all`,
    body,
    EmailRoutingRuleSchema,
  );
}

/**
 * `GET /zones/{zone_id}/email/routing/rules/catch_all`. Returns null when
 * Email Routing isn't enabled (CF returns 404 in that case).
 */
export async function getCatchAllRule(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<EmailRoutingRule | null> {
  try {
    return await client.get(
      `/zones/${zoneId}/email/routing/rules/catch_all`,
      EmailRoutingRuleSchema,
    );
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * `GET /zones/{zone_id}/email/routing/dns` — CF reports the records it
 * requires for routing to function and any verification errors it sees.
 *
 * Returns `null` when Email Routing isn't enabled on the zone (404).
 */
export async function getEmailRoutingDnsState(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<EmailRoutingDnsState | null> {
  try {
    const raw = await client.get<unknown>(`/zones/${zoneId}/email/routing/dns`);
    return parseEmailRoutingDnsState(raw);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return null;
    throw err;
  }
}
