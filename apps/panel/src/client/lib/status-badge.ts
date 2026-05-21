// Status badge consistency helper.
//
// Every list/detail page used to inline its own ternary for "status string →
// Badge variant + label". The mappings drifted: webhook "paused" was
// sometimes `secondary` and sometimes `outline`, credentials `revoked` was
// occasionally rendered as `success`, message `failed`/`bounced` were
// inconsistent across pages.
//
// `statusBadge(kind, value)` centralises the mapping and also returns an
// icon hint so colour isn't the only signal. Callsites do:
//
//   const sb = statusBadge('message', m.status);
//   <Badge variant={sb.variant}>{renderIcon(sb.icon)} {sb.label}</Badge>
//
// Unknown values fall through to `outline` + the raw value, so nothing breaks
// if a new backend enum lands before the panel ships an icon for it.

export type StatusKind =
  | 'message'
  | 'bridge'
  | 'webhook'
  | 'domain'
  | 'credential'
  | 'severity'
  | 'alert-severity'
  | 'verdict'
  | 'classification'
  | 'tier'
  | 'confidence'
  | 'direction'
  | 'enabled';

export type StatusVariant =
  | 'success'
  | 'info'
  | 'warning'
  | 'destructive'
  | 'secondary'
  | 'outline';

export type StatusIcon =
  | 'check'
  | 'clock'
  | 'alert-triangle'
  | 'x'
  | 'info'
  | 'shield-alert'
  | 'arrow-down'
  | 'arrow-up';

export interface StatusBadgeSpec {
  variant: StatusVariant;
  label: string;
  icon?: StatusIcon;
}

// A subset of values can be numeric (tier, confidence). Accept `string | number`
// at the boundary so callers don't have to coerce.
export function statusBadge(kind: StatusKind, value: string | number): StatusBadgeSpec {
  const raw = typeof value === 'number' ? value.toString() : value;
  const v = raw.toLowerCase();
  switch (kind) {
    case 'message': {
      if (v === 'queued' || v === 'sending') {
        return { variant: 'info', label: v, icon: 'clock' };
      }
      if (v === 'sent' || v === 'delivered' || v === 'received') {
        return { variant: 'success', label: v, icon: 'check' };
      }
      if (v === 'failed' || v === 'bounced') {
        return { variant: 'destructive', label: v, icon: 'x' };
      }
      if (v === 'dlq') {
        return { variant: 'warning', label: v, icon: 'alert-triangle' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'bridge': {
      if (v === 'registered' || v === 'online' || v === 'active') {
        return { variant: 'success', label: v, icon: 'check' };
      }
      if (v === 'offline') {
        return { variant: 'warning', label: v, icon: 'alert-triangle' };
      }
      if (v === 'deregistered' || v === 'disabled') {
        return { variant: 'secondary', label: v, icon: 'x' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'webhook': {
      if (v === 'active') {
        return { variant: 'success', label: v, icon: 'check' };
      }
      if (v === 'paused') {
        return { variant: 'warning', label: v, icon: 'clock' };
      }
      if (v === 'deleted') {
        return { variant: 'secondary', label: v, icon: 'x' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'domain': {
      if (v === 'verified') {
        return { variant: 'success', label: v, icon: 'check' };
      }
      if (v === 'pending') {
        return { variant: 'info', label: v, icon: 'clock' };
      }
      if (v === 'failed') {
        return { variant: 'destructive', label: v, icon: 'x' };
      }
      if (v === 'disabled') {
        return { variant: 'secondary', label: v, icon: 'x' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'credential': {
      if (v === 'active' || v === 'primary') {
        return { variant: 'success', label: v, icon: 'check' };
      }
      if (v === 'revoked') {
        return { variant: 'destructive', label: v, icon: 'x' };
      }
      if (v === 'disabled' || v === 'retired') {
        return { variant: 'secondary', label: v, icon: 'x' };
      }
      if (v === 'pending') {
        return { variant: 'info', label: v, icon: 'clock' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'severity': {
      // Suppression/triage severity. Reuses the standard info/warn/critical
      // ladder. `info` is intentionally `secondary` (not the `info` variant)
      // because the variant maps to a chip surface; muted reads as "noise".
      if (v === 'critical') {
        return { variant: 'destructive', label: v, icon: 'shield-alert' };
      }
      if (v === 'warn' || v === 'warning') {
        return { variant: 'warning', label: v, icon: 'alert-triangle' };
      }
      if (v === 'info') {
        return { variant: 'secondary', label: v, icon: 'info' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'alert-severity': {
      // Same shape as `severity`, but kept separate so admin-alert callsites
      // can use a distinct icon family in the future without disturbing
      // suppression badges. For now the renderer is identical.
      if (v === 'critical') {
        return { variant: 'destructive', label: v, icon: 'shield-alert' };
      }
      if (v === 'warn' || v === 'warning') {
        return { variant: 'warning', label: v, icon: 'alert-triangle' };
      }
      if (v === 'info') {
        return { variant: 'secondary', label: v, icon: 'info' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'verdict': {
      // Policy verdict: pass / pass_warn / hold / block.
      if (v === 'pass') {
        return { variant: 'success', label: v, icon: 'check' };
      }
      if (v === 'pass_warn') {
        return { variant: 'secondary', label: v, icon: 'info' };
      }
      if (v === 'hold') {
        return { variant: 'warning', label: v, icon: 'clock' };
      }
      if (v === 'block') {
        return { variant: 'destructive', label: v, icon: 'x' };
      }
      // The Moderation queue uses 'open' / 'released' / 'dropped' which are
      // status-like cousins. Map them here so the same kind covers both.
      if (v === 'open') {
        return { variant: 'warning', label: v, icon: 'clock' };
      }
      if (v === 'released' || v === 'released_as_legit') {
        return { variant: 'success', label: 'released', icon: 'check' };
      }
      if (v === 'dropped' || v.startsWith('dropped_')) {
        return { variant: 'destructive', label: 'dropped', icon: 'x' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'classification': {
      // Abuse-event / triage classification. Critical categories block;
      // spam-tier categories warn; routine ones go secondary.
      if (v === 'phishing_report' || v === 'legal_takedown' || v === 'virus') {
        return { variant: 'destructive', label: raw, icon: 'shield-alert' };
      }
      if (v === 'spam_complaint' || v === 'auth_failure' || v === 'arf_complaint') {
        return { variant: 'warning', label: raw, icon: 'alert-triangle' };
      }
      if (v === 'hard_bounce' || v === 'bounce_notification' || v === 'opt_out') {
        return { variant: 'secondary', label: raw, icon: 'info' };
      }
      if (v === 'mailing_list_admin' || v === 'inquiry' || v === 'auto_reply' || v === 'noise') {
        return { variant: 'secondary', label: raw, icon: 'info' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'tier': {
      // Sender-abuse tier 0..5. Tier 0 is clean (outline); 1 is secondary;
      // 2-3 warn; 4+ destructive (permanent suppression candidate).
      const n = typeof value === 'number' ? value : Number.parseInt(raw, 10);
      if (Number.isNaN(n)) return { variant: 'outline', label: raw, icon: 'info' };
      if (n >= 4) return { variant: 'destructive', label: raw, icon: 'shield-alert' };
      if (n >= 2) return { variant: 'warning', label: raw, icon: 'alert-triangle' };
      if (n >= 1) return { variant: 'secondary', label: raw, icon: 'info' };
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'confidence': {
      // LLM triage confidence: a number in [0,1]. Render as a percentage.
      const n = typeof value === 'number' ? value : Number.parseFloat(raw);
      if (Number.isNaN(n)) return { variant: 'outline', label: raw, icon: 'info' };
      const label = `${Math.round(n * 100)}%`;
      if (n >= 0.85) return { variant: 'success', label, icon: 'check' };
      if (n >= 0.6) return { variant: 'secondary', label, icon: 'info' };
      return { variant: 'destructive', label, icon: 'alert-triangle' };
    }
    case 'direction': {
      // 'in' / 'inbound' or 'out' / 'outbound'. Always rendered as a small
      // pill with a directional arrow so the colour isn't the only signal.
      if (v === 'in' || v === 'inbound') {
        return { variant: 'info', label: v, icon: 'arrow-down' };
      }
      if (v === 'out' || v === 'outbound') {
        return { variant: 'secondary', label: v, icon: 'arrow-up' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    case 'enabled': {
      // Boolean-ish "is this row active?" used by suppressions and any other
      // disabled_at-style schema. Accepts 'active' / 'disabled' strings or
      // booleans coerced via 'true'/'false'.
      if (v === 'active' || v === 'true' || v === 'enabled') {
        return { variant: 'success', label: 'active', icon: 'check' };
      }
      if (v === 'disabled' || v === 'false') {
        return { variant: 'secondary', label: 'disabled', icon: 'x' };
      }
      return { variant: 'outline', label: raw, icon: 'info' };
    }
    default:
      return { variant: 'outline', label: raw };
  }
}
