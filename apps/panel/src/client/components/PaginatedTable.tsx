// Placeholder — Phase I implements cursor-based pagination over @polaris/sdk
// list endpoints. The interface is fixed now so list pages can import it.
import type { ReactNode } from 'react';

export interface PaginatedTableProps<T> {
  rows: T[];
  columns: { key: keyof T | string; header: string; cell?: (row: T) => ReactNode }[];
  nextCursor?: string | null;
  onNext?: () => void;
  loading?: boolean;
}

export function PaginatedTable<T extends Record<string, unknown>>({
  rows,
  columns,
  loading,
}: PaginatedTableProps<T>) {
  return (
    <div className="text-sm text-[var(--color-muted-foreground)]">
      {loading ? 'Loading…' : `${rows.length} row(s), ${columns.length} column(s) — placeholder.`}
    </div>
  );
}
