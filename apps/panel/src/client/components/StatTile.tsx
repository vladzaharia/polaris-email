// StatTile — small bordered metric card.
//
// Renders a muted uppercase label above a larger value below. Originally
// inline in MailboxDetail; extracted here so detail pages can share a single
// "stat strip" recipe. The `mono` flag swaps the value typography for the
// long-text/timestamp case (e.g. "Last sent: 3 minutes ago") where a smaller
// monospace reads better than a large bold number.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface StatTileProps {
  /** Uppercase tracked label rendered above the value. */
  label: ReactNode;
  /** The headline value — number, short string, or pre-formatted node. */
  value: ReactNode;
  /** Render the value in font-mono at body size instead of large bold. */
  mono?: boolean;
  /** Tooltip — typically the full ISO timestamp behind a relative date. */
  title?: string;
  className?: string;
}

export function StatTile({ label, value, mono = false, title, className }: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2',
        className,
      )}
      title={title}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        {label}
      </div>
      <div
        className={
          mono
            ? 'mt-0.5 font-mono text-sm text-[var(--color-muted-foreground)]'
            : 'mt-0.5 text-lg font-semibold text-[var(--color-foreground)]'
        }
      >
        {value}
      </div>
    </div>
  );
}
