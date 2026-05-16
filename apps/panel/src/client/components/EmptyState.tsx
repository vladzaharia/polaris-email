// EmptyState — shared empty-list placeholder. Replaces ad-hoc
// `<p className="text-sm text-muted-foreground">No rows.</p>` usage scattered
// across pages so the empty-affordance reads consistently and operators can
// take a follow-up action (the optional `action` slot) without having to
// guess where the create button lives.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface EmptyStateProps {
  /** Headline shown in body text size; should answer "what's missing here?" */
  title: string;
  /** Secondary line, optional — explains why the surface is empty. */
  description?: ReactNode;
  /** Lucide icon component (or any React node) rendered above the title. */
  icon?: ReactNode;
  /** Action slot — typically a Button that opens a create dialog. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-border)] p-8 text-center',
        className,
      )}
    >
      {icon ? (
        <div className="text-[var(--color-muted-foreground)]" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-prose text-xs text-[var(--color-muted-foreground)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
