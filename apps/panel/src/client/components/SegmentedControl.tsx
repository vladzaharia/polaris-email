// SegmentedControl — flat pill toggle for small enum picks (≤4 options).
//
// Canonical recipe carried over from Dashboard's `WindowSwitcher`: muted
// `bg-secondary` track with a `bg-card shadow-sm` active pill. Inactive
// items render in muted-foreground and tween to foreground on hover so the
// inactive state still feels interactive.
//
// Use this for the Dashboard time-window switcher, the IssueCredentialDialog
// protocol toggle (SMTPS/IMAP), and the AbuseHub Suppressions tab's
// Recipients/Senders scope toggle. Anything ≥5 options should be a Select.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional inline subtext (rendered in muted-foreground after the label). */
  hint?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedControlOption<T>>;
  value: T;
  onChange: (v: T) => void;
  /** Required for a11y — surfaces as `aria-label` on the radiogroup. */
  ariaLabel: string;
  /** Size knob — `sm` is the dialog/inline size (text-xs); `default` is dashboard scale. */
  size?: 'sm' | 'default';
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'default',
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex rounded-md bg-[var(--color-secondary)] p-0.5',
        size === 'sm' ? 'text-xs' : 'text-xs',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={active}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'cursor-pointer rounded-[5px] font-medium transition-colors',
              size === 'sm' ? 'px-3 py-1' : 'px-3 py-1',
              active
                ? 'bg-[var(--color-card)] text-[var(--color-foreground)] shadow-sm'
                : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
            )}
          >
            <span>{opt.label}</span>
            {opt.hint ? (
              <span className="ml-1 text-[var(--color-muted-foreground)]">{opt.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
