// FilterEnumPicker — vertical-list picker used inside a FilterBar popover.
//
// Lives inside a Radix Popover (the FilterBar provides one per chip), so we
// don't pull in Radix Select; plain divs styled as a menu are enough.
import type { ReactElement } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn.js';

export interface FilterEnumOption {
  value: string;
  label?: string;
}

export interface FilterEnumPickerProps {
  options: FilterEnumOption[];
  value: string | null;
  onChange: (next: string | null) => void;
  close: () => void;
  anyLabel?: string;
}

export function FilterEnumPicker({
  options,
  value,
  onChange,
  close,
  anyLabel = 'Any',
}: FilterEnumPickerProps): ReactElement {
  const select = (next: string | null) => {
    onChange(next);
    close();
  };

  const rowClass =
    'flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)] focus-visible:bg-[var(--color-accent)] focus-visible:outline-none';

  return (
    <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
      <button
        type="button"
        className={cn(rowClass, value === null && 'bg-[var(--color-accent)]/60')}
        onClick={() => select(null)}
      >
        <span className="text-[var(--color-muted-foreground)]">{anyLabel}</span>
        {value === null ? <Check size={14} aria-hidden="true" /> : null}
      </button>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            className={cn(rowClass, selected && 'bg-[var(--color-accent)]/60 font-medium')}
            onClick={() => select(opt.value)}
          >
            <span className="truncate">{opt.label ?? opt.value}</span>
            {selected ? <Check size={14} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
