// SuggestionChip — rounded-full clickable pill used to pre-fill an input.
//
// Used by the Add Sender, Add Receiver, and Add Domain dialogs to offer
// common local-parts / patterns / subdomains in one click. Visually a muted
// outline pill that flips to foreground+primary border on hover.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface SuggestionChipProps {
  /** Click handler — typically a setState that copies `children` into an input. */
  onSelect: () => void;
  children: ReactNode;
  /** When true the chip renders in the "active" state (filled, no hover). */
  active?: boolean;
  className?: string;
}

export function SuggestionChip({ onSelect, children, active, className }: SuggestionChipProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'cursor-pointer rounded-full border px-2 py-0.5 text-xs transition-colors',
        active
          ? 'border-[var(--color-primary)] text-[var(--color-foreground)]'
          : 'border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:border-[var(--color-primary)] hover:text-[var(--color-foreground)]',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Container that lays its `SuggestionChip` children out in a flex-wrap row
 * with a small top margin matching the audit's spec. Optional — chip
 * callers can lay them out themselves if they need a different rhythm.
 */
export function SuggestionChipRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('mt-2 flex flex-wrap gap-1.5', className)}>{children}</div>;
}
