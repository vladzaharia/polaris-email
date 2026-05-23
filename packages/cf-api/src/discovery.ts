// Zone discovery + diff engine.
//
// Pulls every zone in the operator's CF account, inspects each one's Email
// Routing + Email Service state via CF APIs, and computes the operations
// needed to bring it to polaris-mail's canonical state. The applier runs
// the operations through CF's auto-publish endpoints (enable Email Routing,
// onboard sender domain) so Cloudflare manages the DNS records — manual
// `dns.ts` edits are reserved for non-CF DNS edge cases.
//
// The status object surfaces six independent checks so the panel can render
// a per-zone traffic-light grid:
//   - routing_enabled    — Email Routing is on for the zone
//   - routing_status_ok  — CF reports `status === 'ready'`
//   - dns_records_locked — CF auto-published + locked the inbound MX/SPF
//   - sender_onboarded   — outbound DKIM/SPF/DMARC/bounce records resolve
//   - catch_all_correct  — catch-all rule routes to our `polaris-mail-in`
//   - d1_mailbox_exists  — `mail_domains` row present (operator-tracked)
//
// `computeDiff()` is pure: given a status + canonical config, it lists the
// operations needed. `applyDiff()` runs them; failures of one op don't
// abort the others — the result reports applied + failed lists for the
// panel to render granular feedback.

import type { CloudflareApiClient } from './client.js';
import { listZones } from './zones.js';
import {
  enableEmailRouting,
  getCatchAllRule,
  getEmailRoutingDnsState,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  setCatchAllRule,
} from './email-routing.js';
import { onboardSenderDomain, verifyOnboarding } from './email-service.js';
import type { EmailRoutingRule, Zone } from './types.js';

export interface NamedRouteRule {
  /** Rule name as set in CF (operator-defined). */
  name: string;
  enabled: boolean;
  /** First matcher's address pattern, e.g. `support@example.com` or `*@…`. */
  address_pattern: string | null;
  /** First action: 'worker' | 'forward' | 'drop'. */
  action_type: string | null;
  /** First action target: worker name for 'worker', email for 'forward'. */
  action_target: string | null;
  /** True when this rule routes to polaris-mail-in (the canonical inbound Worker). */
  routes_to_polaris: boolean;
}

export interface ZoneDomainStatus {
  zone: Zone;
  routing_enabled: boolean;
  /** CF's own reported status: 'ready' | 'unconfigured' | 'misconfigured' | 'unknown'. */
  routing_status: string;
  routing_status_ok: boolean;
  dns_records_locked: boolean;
  /** CF-reported DNS errors (typos, conflicting MX, etc.). */
  dns_record_errors: string[];
  sender_onboarded: boolean;
  /** What the sender check observed; useful when sender_onboarded is false. */
  sender_missing_records: string[];
  catch_all_target: string | null;
  catch_all_correct: boolean;
  /**
   * Named-address routing rules (excluding catch-all). Operator-defined:
   * polaris-mail lists them for visibility but does NOT modify them — those
   * are the operator's domain. Use `has_conflicting_rules` to surface rules
   * that route mail away from polaris-mail-in.
   */
  named_rules: NamedRouteRule[];
  /**
   * True when any enabled named rule routes mail somewhere other than
   * polaris-mail-in (e.g. forwards `support@` to a personal mailbox). These
   * rules take priority over the catch-all, so polaris-mail never sees that
   * traffic. Surface to the operator; don't auto-remediate.
   */
  has_conflicting_rules: boolean;
  d1_mail_domain_exists: boolean;
  /** Top-line: 'ok' | 'partial' | 'unconfigured' | 'error'. */
  overall: 'ok' | 'partial' | 'unconfigured' | 'error';
  /** Last-error message when CF API calls fail; null on success. */
  error: string | null;
}

export type ZoneConfigureOpKind =
  | 'enable_routing'
  | 'set_catch_all_worker'
  | 'onboard_sender_domain'
  | 'create_d1_mail_domain';

export interface ZoneConfigureOp {
  kind: ZoneConfigureOpKind;
  description: string;
  detail?: Record<string, unknown>;
}

export interface ZoneConfigureDiff {
  zone: Zone;
  current: ZoneDomainStatus;
  /** Operations needed; empty array means already converged. */
  ops: ZoneConfigureOp[];
  /**
   * Informational warnings — surfaced to the operator but not turned into
   * ops. Most common: existing named-address rules route mail away from
   * polaris-mail-in (operator-owned, not auto-remediated).
   */
  warnings: string[];
}

export interface InspectorEnv {
  /** Worker name the catch-all rule should target. Default 'polaris-mail-in'. */
  inboundWorkerName: string;
  /** Whether a `mail_domains` row exists in D1 for this zone name. */
  d1HasMailDomain(zoneName: string): Promise<boolean>;
  /** Optional override for sender DoH verification (test injection). */
  dohFetch?: typeof fetch;
}

export interface ApplyEnv extends InspectorEnv {
  /** Insert a `mail_domains` row for `zoneName`. Called only for the create_d1_mail_domain op. */
  d1InsertMailDomain(zoneName: string): Promise<void>;
}

/** Fetch + inspect every zone in the operator's account. */
export async function inspectAllZones(
  client: CloudflareApiClient,
  env: InspectorEnv,
): Promise<ZoneDomainStatus[]> {
  const zones = await listZones(client);
  const out: ZoneDomainStatus[] = [];
  for (const z of zones) {
    out.push(await inspectZone(client, z, env));
  }
  return out;
}

/** Inspect a single zone. `Zone` is passed in (caller already has it). */
export async function inspectZone(
  client: CloudflareApiClient,
  zone: Zone,
  env: InspectorEnv,
): Promise<ZoneDomainStatus> {
  let routingEnabled = false;
  let routingStatus = 'unknown';
  let dnsLocked = false;
  let dnsErrors: string[] = [];
  let catchAllTarget: string | null = null;
  let catchAllCorrect = false;
  let namedRules: NamedRouteRule[] = [];
  let hasConflictingRules = false;
  let senderOnboarded = false;
  let senderMissing: string[] = [];
  let d1Exists = false;
  let topErr: string | null = null;

  try {
    const settings = await getEmailRoutingSettings(client, zone.id);
    routingEnabled = settings.enabled;
    routingStatus = settings.status ?? (settings.enabled ? 'ready' : 'unconfigured');
  } catch (err) {
    topErr = errorMessage(err);
  }

  // CF's routing-DNS endpoint returns the records it auto-publishes
  // (MX × N + DKIM TXT under whatever selector CF chose + SPF). We
  // store the response so the sender-onboarding heuristic below can
  // read it too — keeps the two derivations consistent.
  let routingDnsRecords: import('./types.js').EmailRoutingDnsRecord[] = [];
  if (routingEnabled) {
    try {
      const dnsState = await getEmailRoutingDnsState(client, zone.id);
      if (dnsState) {
        dnsErrors = dnsState.errors ?? [];
        routingDnsRecords = dnsState.records ?? [];
        // Older CF API versions returned an explicit `locked: true` per
        // record; the current shape omits it entirely. Treat the
        // *presence* of CF-managed records with no errors as the canonical
        // "CF is locking these for routing" — matches what CF's own
        // dashboard renders. Fall back to the legacy `locked === true`
        // check when at least one record carries the field, so consumers
        // on older API versions still observe the strict semantics.
        const someExplicitLockFlag = routingDnsRecords.some((r) => typeof r.locked === 'boolean');
        if (someExplicitLockFlag) {
          const required = routingDnsRecords.filter((r) => r.required ?? true);
          dnsLocked = required.length > 0 && required.every((r) => r.locked === true);
        } else {
          dnsLocked = routingDnsRecords.length > 0 && dnsErrors.length === 0;
        }
      }
    } catch (err) {
      topErr ??= errorMessage(err);
    }

    try {
      const catchAll = await getCatchAllRule(client, zone.id);
      if (catchAll) {
        const action = catchAll.actions[0];
        if (action) {
          catchAllTarget =
            action.type === 'worker'
              ? `worker:${action.value?.[0] ?? ''}`
              : `${action.type}:${action.value?.join(',') ?? ''}`;
          catchAllCorrect =
            catchAll.enabled === true &&
            action.type === 'worker' &&
            (action.value?.[0] ?? '') === env.inboundWorkerName;
        }
      }
    } catch (err) {
      topErr ??= errorMessage(err);
    }

    // Named-address rules. Operator-owned: list for visibility, never auto-modify.
    // Mark as "conflicting" when an enabled rule routes mail somewhere other
    // than polaris-mail-in (those rules take priority over the catch-all).
    try {
      const rules = await listEmailRoutingRules(client, zone.id);
      namedRules = rules
        .filter((r) => r.matchers.some((m) => m.type !== 'all'))
        .map((r) => summarizeRule(r, env.inboundWorkerName));
      hasConflictingRules = namedRules.some((r) => r.enabled && !r.routes_to_polaris);
    } catch (err) {
      topErr ??= errorMessage(err);
    }
  }

  // Sender onboarding heuristic — two-stage:
  //
  //   1. If CF's Email Routing is `ready` AND its routing-DNS state
  //      response contains the records CF auto-publishes (≥1 MX, a DKIM
  //      TXT at any `*._domainkey.<domain>` selector, and an SPF TXT),
  //      the domain IS onboarded from CF's perspective — exactly the
  //      signal CF's own UI uses for "Email Sending is enabled."
  //      Honour that as the source of truth.
  //
  //   2. Otherwise fall back to verifyOnboarding's DoH-canonical
  //      comparison so operators with operator-managed DKIM (custom
  //      selector, no CF auto-publish) still get a deterministic answer.
  //      `sender_missing_records` is populated from the strict DoH check
  //      in both cases — it's diagnostic info for the operator to see
  //      what CF's wizard would have published vs what's there.
  const cfManagedDkim = routingDnsRecords.some(
    (r) => r.type.toUpperCase() === 'TXT' && /_domainkey\./i.test(r.name),
  );
  const cfManagedSpf = routingDnsRecords.some(
    (r) =>
      r.type.toUpperCase() === 'TXT' &&
      r.name.toLowerCase() === zone.name.toLowerCase() &&
      /v=spf1/i.test(r.content),
  );
  const cfManagedMx = routingDnsRecords.some((r) => r.type.toUpperCase() === 'MX');
  const cfReportsOnboarded =
    routingEnabled &&
    routingStatus === 'ready' &&
    cfManagedDkim &&
    cfManagedSpf &&
    cfManagedMx &&
    dnsErrors.length === 0;
  try {
    const v = await verifyOnboarding(client, zone.id, zone.name, { dohFetch: env.dohFetch });
    senderOnboarded = cfReportsOnboarded || v.verified;
    senderMissing = v.missing;
  } catch (err) {
    topErr ??= errorMessage(err);
    senderOnboarded = cfReportsOnboarded;
  }

  try {
    d1Exists = await env.d1HasMailDomain(zone.name);
  } catch (err) {
    topErr ??= errorMessage(err);
  }

  const checks = [
    routingEnabled,
    routingStatus === 'ready',
    dnsLocked,
    senderOnboarded,
    catchAllCorrect,
    d1Exists,
  ];
  const passed = checks.filter(Boolean).length;
  const overall: ZoneDomainStatus['overall'] = topErr
    ? 'error'
    : passed === checks.length
      ? 'ok'
      : passed === 0
        ? 'unconfigured'
        : 'partial';

  return {
    zone,
    routing_enabled: routingEnabled,
    routing_status: routingStatus,
    routing_status_ok: routingStatus === 'ready',
    dns_records_locked: dnsLocked,
    dns_record_errors: dnsErrors,
    sender_onboarded: senderOnboarded,
    sender_missing_records: senderMissing,
    catch_all_target: catchAllTarget,
    catch_all_correct: catchAllCorrect,
    named_rules: namedRules,
    has_conflicting_rules: hasConflictingRules,
    d1_mail_domain_exists: d1Exists,
    overall,
    error: topErr,
  };
}

function summarizeRule(rule: EmailRoutingRule, inboundWorkerName: string): NamedRouteRule {
  const firstMatcher = rule.matchers.find((m) => m.type === 'literal') ?? rule.matchers[0];
  const action = rule.actions[0];
  const actionType = action?.type ?? null;
  const actionTarget = action?.value?.[0] ?? null;
  return {
    name: rule.name,
    enabled: rule.enabled,
    address_pattern: firstMatcher?.value ?? null,
    action_type: actionType,
    action_target: actionTarget,
    routes_to_polaris: actionType === 'worker' && actionTarget === inboundWorkerName,
  };
}

/**
 * Pure: given a status, return the operations needed to converge to
 * polaris-mail's canonical state. Order is dependency-aware (enable
 * routing before setting catch-all; sender-onboard before D1 row).
 */
export function computeDiff(
  status: ZoneDomainStatus,
  opts: { inboundWorkerName: string },
): ZoneConfigureDiff {
  const ops: ZoneConfigureOp[] = [];

  if (!status.routing_enabled) {
    ops.push({
      kind: 'enable_routing',
      description: `Enable Cloudflare Email Routing on ${status.zone.name} (auto-publishes inbound MX + SPF, locks them)`,
    });
  }

  // The catch-all rule depends on routing being enabled. List it even when
  // routing isn't yet on — applyDiff runs ops in order so it'll succeed.
  if (!status.catch_all_correct) {
    ops.push({
      kind: 'set_catch_all_worker',
      description: `Point catch-all rule at the ${opts.inboundWorkerName} Worker`,
      detail: { current: status.catch_all_target, target: opts.inboundWorkerName },
    });
  }

  if (!status.sender_onboarded) {
    ops.push({
      kind: 'onboard_sender_domain',
      description: `Onboard ${status.zone.name} for outbound (CF auto-publishes DKIM CNAMEs, SPF, DMARC, cf-bounce MX)`,
      detail: { missing: status.sender_missing_records },
    });
  }

  if (!status.d1_mail_domain_exists) {
    ops.push({
      kind: 'create_d1_mail_domain',
      description: `Create polaris-mail mail_domains row for ${status.zone.name}`,
    });
  }

  const warnings: string[] = [];
  if (status.has_conflicting_rules) {
    const conflicting = status.named_rules.filter((r) => r.enabled && !r.routes_to_polaris);
    warnings.push(
      `${conflicting.length} named-address rule(s) on ${status.zone.name} route mail elsewhere ` +
        `and will intercept those addresses before the catch-all reaches polaris-mail-in: ` +
        conflicting
          .map((r) => `${r.address_pattern ?? '?'} → ${r.action_type}:${r.action_target ?? '?'}`)
          .join(', '),
    );
  }
  if (status.dns_record_errors.length > 0) {
    warnings.push(
      `Cloudflare reports DNS errors for ${status.zone.name}: ${status.dns_record_errors.join('; ')}`,
    );
  }

  return { zone: status.zone, current: status, ops, warnings };
}

export interface ApplyResult {
  applied: ZoneConfigureOp[];
  failed: Array<{ op: ZoneConfigureOp; error: string }>;
}

/**
 * Apply each op in order. A failure on one op records it and continues with
 * the rest — the panel renders applied + failed lists separately so the
 * operator can retry individual failures.
 */
export async function applyDiff(
  client: CloudflareApiClient,
  diff: ZoneConfigureDiff,
  env: ApplyEnv,
): Promise<ApplyResult> {
  const applied: ZoneConfigureOp[] = [];
  const failed: Array<{ op: ZoneConfigureOp; error: string }> = [];

  for (const op of diff.ops) {
    try {
      switch (op.kind) {
        case 'enable_routing':
          await enableEmailRouting(client, diff.zone.id);
          break;
        case 'set_catch_all_worker':
          await setCatchAllRule(client, diff.zone.id, { workerScript: env.inboundWorkerName });
          break;
        case 'onboard_sender_domain':
          await onboardSenderDomain(client, {
            zoneId: diff.zone.id,
            domain: diff.zone.name,
            cfManagedDns: true,
          });
          break;
        case 'create_d1_mail_domain':
          await env.d1InsertMailDomain(diff.zone.name);
          break;
      }
      applied.push(op);
    } catch (err) {
      failed.push({ op, error: errorMessage(err) });
    }
  }

  return { applied, failed };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
