// PaginatedTable — minimal cursor/offset pagination over a list of rows.
//
// Page sizes are decided by the caller via `nextCursor` + `onNext`. The
// component renders a shadcn-shaped <Table>; row clicks bubble to whatever the
// caller wires to each `cell`.
//
// Accessibility:
//   - `caption` (required) goes into a `<caption className="sr-only">` so
//     screen readers announce the table's purpose. Visible labels live in
//     PageCard's title; the caption matches that intent.
//   - `stickyFirstCol` keeps the first column anchored when the table scrolls
//     horizontally — useful for wide log views (messages, dlq).
import type { ReactNode } from 'react';
import { Button } from './ui/button.js';
import { cn } from '../lib/cn.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Skeleton } from './ui/skeleton.js';

export interface PaginatedTableColumn<T> {
  key: keyof T | string;
  header: string;
  cell?: (row: T) => ReactNode;
  /** Tailwind class names to apply to the cell + header for this column. */
  className?: string;
}

export interface PaginatedTableProps<T> {
  rows: T[];
  columns: PaginatedTableColumn<T>[];
  /** Required for screen readers — describes what the table contains. */
  caption: string;
  nextCursor?: string | null;
  onNext?: () => void;
  /** Optional Previous handler — when present the toolbar exposes the back button. */
  onPrev?: () => void;
  prevDisabled?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  /** When true, the first column is `position: sticky` against the scroll container. */
  stickyFirstCol?: boolean;
  /** Stable React key extractor — falls back to row index. */
  rowKey?: (row: T, idx: number) => string | number;
}

// Note: T is unconstrained so callers can pass plain row interfaces (no
// `Record<string, unknown>` ceremony). The default-cell path (`String(...)`)
// reaches into the row through a runtime cast — callers needing anything
// other than a string-coercible field should provide `cell?:`.
export function PaginatedTable<T>({
  rows,
  columns,
  caption,
  nextCursor,
  onNext,
  onPrev,
  prevDisabled,
  loading,
  empty,
  stickyFirstCol,
  rowKey,
}: PaginatedTableProps<T>) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">{empty ?? 'No rows.'}</p>;
  }
  const stickyCls = stickyFirstCol ? 'sticky left-0 z-10 bg-[var(--color-card)]' : undefined;
  return (
    <div className="space-y-3">
      <div className={stickyFirstCol ? 'overflow-x-auto' : undefined}>
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              {columns.map((c, i) => (
                <TableHead
                  key={String(c.key)}
                  className={cn(c.className, i === 0 ? stickyCls : undefined)}
                >
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={rowKey ? rowKey(r, i) : i}>
                {columns.map((c, j) => (
                  <TableCell
                    key={String(c.key)}
                    className={cn(c.className, j === 0 ? stickyCls : undefined)}
                  >
                    {c.cell
                      ? c.cell(r)
                      : String((r as Record<string, unknown>)[c.key as string] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {onPrev || (nextCursor && onNext) ? (
        <div className="flex items-center justify-between">
          {onPrev ? (
            <Button variant="outline" size="sm" onClick={onPrev} disabled={prevDisabled}>
              Previous
            </Button>
          ) : (
            <span />
          )}
          {nextCursor && onNext ? (
            <Button variant="outline" size="sm" onClick={onNext}>
              Next
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
