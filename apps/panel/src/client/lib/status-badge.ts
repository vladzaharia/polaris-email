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

export type StatusKind = 'message' | 'bridge' | 'webhook' | 'domain' | 'credential';

export type StatusVariant =
  | 'success'
  | 'info'
  | 'warning'
  | 'destructive'
  | 'secondary'
  | 'outline';

export type StatusIcon = 'check' | 'clock' | 'alert-triangle' | 'x' | 'info';

export interface StatusBadgeSpec {
  variant: StatusVariant;
  label: string;
  icon?: StatusIcon;
}

export function statusBadge(kind: StatusKind, value: string): StatusBadgeSpec {
  const v = value.toLowerCase();
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
      return { variant: 'outline', label: value, icon: 'info' };
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
      return { variant: 'outline', label: value, icon: 'info' };
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
      return { variant: 'outline', label: value, icon: 'info' };
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
      return { variant: 'outline', label: value, icon: 'info' };
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
      return { variant: 'outline', label: value, icon: 'info' };
    }
    default:
      return { variant: 'outline', label: value };
  }
}
