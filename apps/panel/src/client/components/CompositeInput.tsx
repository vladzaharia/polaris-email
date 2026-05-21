// CompositeInput — `left text + separator + right select` shape.
//
// Used by Add Sender (local-part `@` domain), Add Receiver (pattern `@`
// domain), and Add Domain (subdomain `.` zone). Each of those used to
// hand-roll the same `flex items-stretch gap-1.5` recipe with a muted
// separator span between an `<Input>` and a `<Select>`; this primitive
// centralises that recipe and the "Will register / Will match:" preview
// line that follows it.
//
// Wire the parent's `<Label>` outside this primitive — the composite is a
// single field but the parent labels it as a group, so the label belongs
// above the whole control. The text input owns the htmlFor when provided.
import type { ReactNode } from 'react';
import { Input } from './ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { cn } from '../lib/cn.js';

export interface CompositeInputOption {
  value: string;
  label: string;
}

export interface CompositeInputProps {
  // Text-input (left) half.
  leftValue: string;
  onLeftChange: (v: string) => void;
  leftPlaceholder?: string;
  /** Id wired to a parent `<Label htmlFor>` when the label points at the left input. */
  leftId?: string;
  /** Disable the text input — rare, but supported. */
  leftDisabled?: boolean;

  // Separator (display-only). Pass a literal character (`.`, `@`) or any node.
  separator: ReactNode;

  // Select (right) half.
  rightValue: string | undefined;
  onRightChange: (v: string) => void;
  rightOptions: ReadonlyArray<CompositeInputOption>;
  rightPlaceholder?: string;
  rightLoading?: boolean;
  rightLoadingPlaceholder?: string;

  // Preview line below the composite. Both label and value required when
  // shown — pass `undefined` for `preview` to hide the line entirely.
  previewLabel?: string;
  preview?: string;
  /** Optional trailing italic note rendered after the preview value. */
  previewNote?: ReactNode;

  className?: string;
}

export function CompositeInput({
  leftValue,
  onLeftChange,
  leftPlaceholder,
  leftId,
  leftDisabled,
  separator,
  rightValue,
  onRightChange,
  rightOptions,
  rightPlaceholder = 'Pick one',
  rightLoading = false,
  rightLoadingPlaceholder = 'Loading…',
  previewLabel,
  preview,
  previewNote,
  className,
}: CompositeInputProps) {
  return (
    <div className={className}>
      <div className="mt-1 flex items-stretch gap-1.5">
        <Input
          id={leftId}
          value={leftValue}
          onChange={(e) => onLeftChange(e.target.value)}
          placeholder={leftPlaceholder}
          autoComplete="off"
          spellCheck={false}
          disabled={leftDisabled}
          className="flex-1"
        />
        <span
          aria-hidden
          className="flex items-center text-sm text-[var(--color-muted-foreground)]"
        >
          {separator}
        </span>
        <Select value={rightValue || undefined} onValueChange={onRightChange}>
          <SelectTrigger className="flex-1" disabled={rightLoading}>
            <SelectValue placeholder={rightLoading ? rightLoadingPlaceholder : rightPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {rightOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {previewLabel && preview !== undefined ? (
        <p className={cn('mt-1 text-xs text-[var(--color-muted-foreground)]')}>
          {previewLabel}: <span className="font-mono">{preview || '—'}</span>
          {previewNote ? <> — {previewNote}</> : null}
        </p>
      ) : null}
    </div>
  );
}
