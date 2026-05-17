// FilterBar — responsive filter toolbar. Replaces the
// `grid grid-cols-1 gap-{2,3} md:grid-cols-{3,4,5}` blocks scattered
// across list pages. Children stack vertically on narrow viewports and
// flow into a horizontal grid above the `md` breakpoint.
//
// Conventions:
//   - Labels above inputs (the parent page is still responsible for
//     pairing <Label htmlFor> with <Input id>).
//   - Trailing actions slot stays right-aligned via flex-end.
//   - Gap is fixed at `gap-3` so spacing is consistent across pages.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface FilterBarProps {
  children: ReactNode;
  /** Right-aligned action slot — typically a Reset or Apply button. */
  actions?: ReactNode;
  className?: string;
}

export function FilterBar({ children, actions, className }: FilterBarProps) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-end gap-3', className)}>
      <div className="flex flex-1 flex-wrap gap-3">{children}</div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
