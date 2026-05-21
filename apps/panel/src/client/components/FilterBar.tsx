// FilterBar — hybrid config-driven + children-escape-hatch filter toolbar.
//
// Replaces the per-page `grid grid-cols-{n}` filter blocks. Each `FilterSpec`
// renders as a chip (popover trigger). Active filters get a subtle primary
// tint and inline-formatted value. An optional `search` slot renders a
// full-width input below the chip row. When ≥1 filter has a non-null value,
// a summary row of removable pills + "Clear all" appears underneath.
//
// The `children` slot is an escape hatch for non-standard filters that don't
// fit the chip-and-popover pattern; rendered after the spec'd chips.
import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export type FilterValue = string | string[] | { since?: string; until?: string } | null;

export interface FilterSpec<V extends FilterValue = FilterValue> {
  id: string;
  label: string;
  icon: LucideIcon;
  value: V;
  onChange: (next: V) => void;
  /** Render the popover body. Receives `close()` so the picker can dismiss. */
  render: (ctx: { close: () => void }) => ReactNode;
  /** Human-readable formatted value for the chip + summary row. */
  formatValue?: (value: V) => string;
  /** Hide the chip entirely when value is unset (use sparingly). */
  hideWhenUnset?: boolean;
}

export interface FilterBarProps {
  filters: FilterSpec[];
  /** Inline full-width search (one per bar). */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Right-aligned slot — page-level actions like extra toggles. */
  actions?: ReactNode;
  /** Escape hatch for non-standard filters; rendered after the spec'd chips. */
  children?: ReactNode;
  className?: string;
}

/** Returns true if a filter's value is considered "set". */
function isSet(value: FilterValue): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object')
    return Boolean(
      (value.since && value.since.length > 0) || (value.until && value.until.length > 0),
    );
  return false;
}

function defaultFormat(value: FilterValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') {
    const since = value.since ?? '';
    const until = value.until ?? '';
    if (since && until) return `${since} → ${until}`;
    if (since) return `since ${since}`;
    if (until) return `until ${until}`;
    return '';
  }
  return '';
}

const CHIP_BASE =
  'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium cursor-pointer transition-colors';
const CHIP_INACTIVE =
  'border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] data-[state=open]:bg-[var(--color-accent)] data-[state=open]:text-[var(--color-foreground)]';
const CHIP_ACTIVE =
  'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-foreground)] hover:bg-[var(--color-primary)]/15 data-[state=open]:bg-[var(--color-primary)]/15';

interface ChipProps {
  spec: FilterSpec;
}

function FilterChip({ spec }: ChipProps) {
  const [open, setOpen] = useState(false);
  const active = isSet(spec.value);
  const Icon = spec.icon;
  const formatted = active
    ? spec.formatValue
      ? spec.formatValue(spec.value)
      : defaultFormat(spec.value)
    : '';

  if (!active && spec.hideWhenUnset) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE)}>
        <Icon size={14} aria-hidden="true" />
        <span className={cn(active ? 'text-[var(--color-muted-foreground)]' : undefined)}>
          {spec.label}
        </span>
        {active && formatted ? (
          <span className="font-semibold text-[var(--color-foreground)]">: {formatted}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="z-50 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] p-2 text-[var(--color-popover-foreground)] shadow-md outline-none"
      >
        {spec.render({ close: () => setOpen(false) })}
      </PopoverContent>
    </Popover>
  );
}

interface SummaryPillProps {
  spec: FilterSpec;
}

function SummaryPill({ spec }: SummaryPillProps) {
  const formatted = spec.formatValue ? spec.formatValue(spec.value) : defaultFormat(spec.value);
  const Icon = spec.icon;
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded bg-[var(--color-muted)] pl-2 pr-1 text-xs text-[var(--color-foreground)]">
      <Icon size={12} aria-hidden="true" className="text-[var(--color-muted-foreground)]" />
      <span className="text-[var(--color-muted-foreground)]">{spec.label}:</span>
      <span className="font-medium">{formatted}</span>
      <button
        type="button"
        aria-label={`Remove ${spec.label} filter`}
        className="ml-0.5 cursor-pointer rounded-sm p-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-destructive)]/15 hover:text-[var(--color-destructive)]"
        onClick={() => spec.onChange(null)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

export function FilterBar({
  filters,
  search,
  actions,
  children,
  className,
}: FilterBarProps): React.ReactElement {
  const activeFilters = filters.filter((f) => isSet(f.value));
  const hasActive = activeFilters.length > 0;

  const clearAll = () => {
    for (const f of activeFilters) f.onChange(null);
  };

  return (
    <div
      className={cn(
        'mb-4 flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-2',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((spec) => (
          <FilterChip key={spec.id} spec={spec} />
        ))}
        {children}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>

      {search ? (
        <div className="relative">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)]"
          />
          <Input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? 'Search…'}
            className="pl-8"
          />
        </div>
      ) : null}

      {hasActive ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-border)] pt-2">
          {activeFilters.map((spec) => (
            <SummaryPill key={spec.id} spec={spec} />
          ))}
          <Button variant="ghost" size="sm" onClick={clearAll} className="ml-auto">
            Clear all
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
