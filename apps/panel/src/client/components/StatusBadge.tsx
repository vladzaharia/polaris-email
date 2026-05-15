// StatusBadge — thin renderer around `statusBadge()` + `<Badge>`.
//
// Callsites use this in lieu of stitching together `<Badge variant=...>` +
// icon imports inline. Color is never the only differentiator: every variant
// ships with an icon prefix.
import { AlertTriangle, Check, Clock, Info, X } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { Badge } from './ui/badge.js';
import { statusBadge, type StatusIcon, type StatusKind } from '../lib/status-badge.js';

const ICONS: Record<StatusIcon, ComponentType<SVGProps<SVGSVGElement>>> = {
  check: Check,
  clock: Clock,
  'alert-triangle': AlertTriangle,
  x: X,
  info: Info,
};

export function StatusBadge({ kind, value }: { kind: StatusKind; value: string }) {
  const spec = statusBadge(kind, value);
  const Icon = spec.icon ? ICONS[spec.icon] : null;
  return (
    <Badge variant={spec.variant}>
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
      <span>{spec.label}</span>
    </Badge>
  );
}
