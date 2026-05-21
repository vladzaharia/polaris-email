// FilterAddressPicker — single-address filter input rendered inside a
// FilterBar popover.
import { useState, type ReactElement } from 'react';
import { Input } from '../ui/input.js';
import { Button } from '../ui/button.js';

export interface FilterAddressPickerProps {
  value: string | null;
  onChange: (next: string | null) => void;
  close: () => void;
  placeholder?: string;
}

export function FilterAddressPicker({
  value,
  onChange,
  close,
  placeholder = 'any@example.com',
}: FilterAddressPickerProps): ReactElement {
  const [draft, setDraft] = useState<string>(value ?? '');

  const apply = () => {
    const trimmed = draft.trim();
    onChange(trimmed.length === 0 ? null : trimmed);
    close();
  };

  const clear = () => {
    setDraft('');
    onChange(null);
    close();
  };

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="email"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
        }}
        placeholder={placeholder}
        autoFocus
      />
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={clear}>
          Clear
        </Button>
        <Button size="sm" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  );
}
