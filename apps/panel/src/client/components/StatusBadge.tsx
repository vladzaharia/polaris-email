// StatusBadge — thin renderer around `statusBadge()` + `<Badge>`.
//
// Callsites use this in lieu of stitching together `<Badge variant=...>` +
// icon imports inline. Color is never the only differentiator: every variant
// ships with an icon prefix.
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Clock,
  Info,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { Badge } from './ui/badge.js';
import { statusBadge, type StatusIcon, type StatusKind } from '../lib/status-badge.js';

const ICONS: Record<StatusIcon, ComponentType<SVGProps<SVGSVGElement>>> = {
  check: Check,
  clock: Clock,
  'alert-triangle': AlertTriangle,
  x: X,
  info: Info,
  'shield-alert': ShieldAlert,
  'arrow-down': ArrowDownToLine,
  'arrow-up': ArrowUpFromLine,
};

export interface StatusBadgeProps {
  kind: StatusKind;
  value: string | number;
  /** Override the label (e.g. for compact direction pills that show only the icon). */
  label?: string;
  className?: string;
}

export function StatusBadge({ kind, value, label, className }: StatusBadgeProps) {
  const spec = statusBadge(kind, value);
  const Icon = spec.icon ? ICONS[spec.icon] : null;
  return (
    <Badge variant={spec.variant} className={className}>
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
      <span>{label ?? spec.label}</span>
    </Badge>
  );
}
