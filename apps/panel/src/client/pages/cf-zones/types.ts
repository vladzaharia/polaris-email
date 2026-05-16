// Wire-format types for the `/api/admin/cf-zones` panel proxy.
//
// These mirror `ZoneDomainStatus` / `ZoneConfigureDiff` from
// `@polaris-email/cf-api` (consumed via services/api). The panel client cannot
// import that package directly (different tsconfig + bundling boundary), so we
// duplicate the wire surface here. If the upstream contract changes, update
// both shapes — the JSON envelope is the source of truth.

export interface CfZone {
  id: string;
  name: string;
  status: string;
}

export interface NamedRouteRule {
  name: string;
  enabled: boolean;
  address_pattern: string | null;
  action_type: string | null;
  action_target: string | null;
  routes_to_polaris: boolean;
}

export type ZoneOverall = 'ok' | 'partial' | 'unconfigured' | 'error';

export interface ZoneDomainStatus {
  zone: CfZone;
  routing_enabled: boolean;
  routing_status: string;
  routing_status_ok: boolean;
  dns_records_locked: boolean;
  dns_record_errors: string[];
  sender_onboarded: boolean;
  sender_missing_records: string[];
  catch_all_target: string | null;
  catch_all_correct: boolean;
  named_rules: NamedRouteRule[];
  has_conflicting_rules: boolean;
  d1_mail_domain_exists: boolean;
  overall: ZoneOverall;
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
  zone: CfZone;
  current: ZoneDomainStatus;
  ops: ZoneConfigureOp[];
  warnings: string[];
}

export interface CfZoneListResponse {
  data: ZoneDomainStatus[];
  fetched_at: string;
  cached: boolean;
}

export interface CfZoneDetailResponse {
  data: ZoneDomainStatus;
}

export interface CfZoneConfigureDryRunResponse {
  dry_run: true;
  diff: ZoneConfigureDiff;
}

export interface CfZoneConfigureApplyResponse {
  dry_run: false;
  diff: ZoneConfigureDiff;
  result: {
    applied: ZoneConfigureOp[];
    failed: Array<{ op: ZoneConfigureOp; error: string }>;
    all_succeeded: boolean;
  };
}
