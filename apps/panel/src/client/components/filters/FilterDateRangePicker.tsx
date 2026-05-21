// FilterDateRangePicker — presets + custom datetime-local range.
//
// Presets compute `since`/`until` at click time (ISO strings, UTC). Custom
// inputs are `datetime-local` (which yields local time) but we convert to a
// UTC ISO string in the value so the backend doesn't have to guess.
import { useState, type ReactElement } from 'react';
import { Input } from '../ui/input.js';
import { Button } from '../ui/button.js';
import { Label } from '../ui/label.js';
import { cn } from '../../lib/cn.js';

export interface DateRangeValue {
  since?: string;
  until?: string;
}

export interface DateRangePreset {
  id: string;
  label: string;
}

export interface FilterDateRangePickerProps {
  value: DateRangeValue | null;
  onChange: (next: DateRangeValue | null) => void;
  close: () => void;
  presets?: DateRangePreset[];
}

const DEFAULT_PRESETS: DateRangePreset[] = [
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
];

const PRESET_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

/** Convert an ISO UTC string into a value usable by `<input type="datetime-local">`. */
function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // datetime-local expects `YYYY-MM-DDTHH:mm` in *local* time.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function localInputToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function FilterDateRangePicker({
  value,
  onChange,
  close,
  presets = DEFAULT_PRESETS,
}: FilterDateRangePickerProps): ReactElement {
  const [since, setSince] = useState<string>(isoToLocalInput(value?.since));
  const [until, setUntil] = useState<string>(isoToLocalInput(value?.until));

  const applyPreset = (id: string) => {
    const ms = PRESET_MS[id];
    if (ms === undefined) return;
    const now = new Date();
    const sinceIso = new Date(now.getTime() - ms).toISOString();
    const untilIso = now.toISOString();
    onChange({ since: sinceIso, until: untilIso });
    close();
  };

  const applyCustom = () => {
    const sinceIso = localInputToIso(since);
    const untilIso = localInputToIso(until);
    if (!sinceIso && !untilIso) {
      onChange(null);
    } else {
      const next: DateRangeValue = {};
      if (sinceIso) next.since = sinceIso;
      if (untilIso) next.until = untilIso;
      onChange(next);
    }
    close();
  };

  const clear = () => {
    onChange(null);
    close();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className={cn(
              'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm',
              'hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]',
              'focus-visible:bg-[var(--color-accent)] focus-visible:outline-none',
            )}
            onClick={() => applyPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="border-t border-[var(--color-border)] pt-2">
        <div className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">
          Custom range
        </div>
        <div className="space-y-2">
          <div>
            <Label htmlFor="filter-range-since" className="text-xs">
              Since
            </Label>
            <Input
              id="filter-range-since"
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="filter-range-until" className="text-xs">
              Until
            </Label>
            <Input
              id="filter-range-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
          <Button size="sm" onClick={applyCustom}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
