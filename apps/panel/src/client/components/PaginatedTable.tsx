// PaginatedTable — minimal cursor/offset pagination over a list of rows.
//
// Page sizes are decided by the caller via `nextCursor` + `onNext`. The
// component renders a shadcn-shaped <Table>; row clicks bubble to whatever the
// caller wires to each `cell`.
import type { ReactNode } from 'react';
import { Button } from './ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Skeleton } from './ui/skeleton.js';

export interface PaginatedTableProps<T> {
  rows: T[];
  columns: { key: keyof T | string; header: string; cell?: (row: T) => ReactNode }[];
  nextCursor?: string | null;
  onNext?: () => void;
  loading?: boolean;
  empty?: ReactNode;
}

export function PaginatedTable<T extends Record<string, unknown>>({
  rows,
  columns,
  nextCursor,
  onNext,
  loading,
  empty,
}: PaginatedTableProps<T>) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">{empty ?? 'No rows.'}</p>;
  }
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={String(c.key)}>{c.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={String(c.key)}>
                  {c.cell ? c.cell(r) : String(r[c.key as keyof T] ?? '')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {nextCursor && onNext ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onNext}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
