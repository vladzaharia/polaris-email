// Reusable email-address combobox.
//
// Renders as a standard `<Input>` that opens a Radix `Popover` of bucketed
// suggestions as the operator types. Suggestions are passed in from the
// parent (we deliberately don't auto-fetch — there is no "all senders" admin
// endpoint, and the N+1 detail walk would either pollute every page that
// mounts the combobox or duplicate cache logic). Pages that want sender
// suggestions use the `useAllSenderAddresses()` hook and forward its output.
//
// Behaviour:
//  - Substring match, case-insensitive, across all buckets.
//  - Down/Up navigates, Enter selects, Escape closes (typed value preserved).
//  - When the typed value doesn't match any suggestion a "Press Enter to use
//    <typed>" hint appears at the bottom — pressing Enter just keeps the
//    typed value (parent already owns it) and closes the dropdown.
//  - Clicking outside closes without reverting.
//
// We use Radix `Popover` purely for portal + outside-click semantics;
// `PopoverAnchor` is the input itself so focus stays in the input and the
// dropdown floats below it without stealing keyboard focus.
import * as React from 'react';
import { Input } from './ui/input.js';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover.js';
import { cn } from '../lib/cn.js';

export interface AddressComboboxBucket {
  label: string;
  addresses: ReadonlyArray<string>;
}

export interface AddressComboboxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Suggestion buckets shown above the freeform input. */
  suggestions?: ReadonlyArray<AddressComboboxBucket>;
  /** Inline form size — defaults to `default`. */
  size?: 'sm' | 'default';
  className?: string;
  id?: string;
  /** Forwarded to the underlying `<input>`. */
  'aria-label'?: string;
}

interface FlatMatch {
  bucket: string;
  address: string;
}

function flattenMatches(
  buckets: ReadonlyArray<AddressComboboxBucket> | undefined,
  query: string,
): FlatMatch[] {
  if (!buckets || buckets.length === 0) return [];
  const needle = query.trim().toLowerCase();
  const out: FlatMatch[] = [];
  const seen = new Set<string>();
  for (const b of buckets) {
    for (const addr of b.addresses) {
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      if (needle.length === 0 || key.includes(needle)) {
        seen.add(key);
        out.push({ bucket: b.label, address: addr });
      }
    }
  }
  return out;
}

export function AddressCombobox(props: AddressComboboxProps): React.ReactElement {
  const { value, onChange, placeholder, suggestions, size = 'default', className, id } = props;
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const matches = React.useMemo(() => flattenMatches(suggestions, value), [suggestions, value]);

  // Reset / clamp active index whenever the visible match set shrinks.
  React.useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(0);
  }, [matches.length, activeIndex]);

  // Group flattened matches back into buckets in render-stable order.
  const grouped = React.useMemo(() => {
    const byBucket = new Map<string, FlatMatch[]>();
    for (const m of matches) {
      const arr = byBucket.get(m.bucket);
      if (arr) arr.push(m);
      else byBucket.set(m.bucket, [m]);
    }
    let runningIndex = 0;
    return Array.from(byBucket.entries()).map(([label, rows]) => {
      const start = runningIndex;
      runningIndex += rows.length;
      return { label, rows, start };
    });
  }, [matches]);

  const typedMatchesExisting = React.useMemo(() => {
    if (!value) return true;
    const needle = value.toLowerCase();
    return matches.some((m) => m.address.toLowerCase() === needle);
  }, [matches, value]);

  const select = (addr: string) => {
    onChange(addr);
    setOpen(false);
    // Keep focus on the input so the operator can keep typing / tabbing.
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (matches.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      if (matches.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      if (open && matches.length > 0 && activeIndex < matches.length) {
        e.preventDefault();
        select(matches[activeIndex]!.address);
      } else {
        // Freeform Enter — close the dropdown but keep typed value.
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  const sizeCls = size === 'sm' ? 'h-8 text-xs' : '';

  return (
    <Popover
      open={open && (matches.length > 0 || (value.length > 0 && !typedMatchesExisting))}
      onOpenChange={setOpen}
    >
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? 'user@example.com'}
          autoComplete="off"
          spellCheck={false}
          aria-label={props['aria-label']}
          aria-autocomplete="list"
          aria-expanded={open}
          role="combobox"
          className={cn(sizeCls, className)}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => {
          // Don't steal focus from the input; the popover is a visual aid.
          e.preventDefault();
        }}
        // Keyboard events bubble up from the input — don't trap them here.
        className={cn(
          'w-[--radix-popover-trigger-width] min-w-[240px] rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] p-1 shadow-md max-h-72 overflow-y-auto',
        )}
      >
        <div ref={listRef} role="listbox">
          {grouped.length === 0
            ? null
            : grouped.map((g) => (
                <div key={g.label}>
                  <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    {g.label}
                  </div>
                  {g.rows.map((row, i) => {
                    const idx = g.start + i;
                    const selected = idx === activeIndex;
                    return (
                      <div
                        key={`${row.bucket}:${row.address}`}
                        role="option"
                        aria-selected={selected}
                        onMouseDown={(e) => {
                          // mousedown beats the popover's outside-click; otherwise the
                          // click gets eaten by the close-on-blur path.
                          e.preventDefault();
                          select(row.address);
                        }}
                        onMouseEnter={() => setActiveIndex(idx)}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-accent)] cursor-pointer',
                          selected && 'bg-[var(--color-accent)]',
                        )}
                      >
                        <span className="truncate font-mono">{row.address}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
          {value.length > 0 && !typedMatchesExisting ? (
            <div
              className={cn(
                'border-t border-[var(--color-border)] mt-1 pt-2 px-2 pb-1 text-xs text-[var(--color-muted-foreground)]',
                grouped.length === 0 && 'border-t-0 mt-0 pt-1',
              )}
            >
              Press Enter to use <span className="font-mono">{value}</span>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
