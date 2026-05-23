// MetaList — semantic <dl> for two-column metadata grids on detail pages.
//
// Mailbox, Domain, Bridge, Me, MessageDetail, SuppressionDetail each render
// a "key → value" detail block. Most used a `<div className="grid">` with
// paired spans, which loses the screen-reader semantics of a definition
// list. This primitive standardises on `<dl>` / `<dt>` / `<dd>` and exposes
// the same dense layout (max-content label column, min-width-0 value column
// so long mono strings wrap cleanly).
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface MetaListProps {
  children: ReactNode;
  className?: string;
}

/**
 * Container <dl>. Pair with `<MetaRow>` children.
 *
 * Spacing: row-gap is `gap-y-3` (12px) — large enough that each label/value
 * pair reads as a discrete record at scan-speed, small enough that a
 * 10-row metadata block stays on-screen. Column gap is `gap-x-6` (24px)
 * to give long mono values (DKIM keys, message-IDs) room to breathe
 * before they bump into the muted label column.
 */
export function MetaList({ children, className }: MetaListProps) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export interface MetaRowProps {
  label: ReactNode;
  children: ReactNode;
  /** Optional className override on the `<dd>` cell. */
  valueClassName?: string;
}

/**
 * A single `<dt>` + `<dd>` row inside `<MetaList>`. The `<dt>` is rendered
 * muted-small to match the existing detail-page convention; the `<dd>` is
 * the foreground value cell.
 */
export function MetaRow({ label, children, valueClassName }: MetaRowProps) {
  return (
    <>
      <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className={cn('min-w-0 text-sm break-words', valueClassName)}>{children}</dd>
    </>
  );
}
