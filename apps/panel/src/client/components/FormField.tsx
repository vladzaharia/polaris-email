// FormField — label + input + (optional) helper text + required indicator.
// Replaces ad-hoc `<Label><Input/></Label>` blocks where a uniform
// spacing/required-indicator treatment is desired.
import type { ReactNode } from 'react';
import { Label } from './ui/label.js';
import { cn } from '../lib/cn.js';

export interface FormFieldProps {
  /** htmlFor / id wiring: pass the same string here and as the input's id. */
  id: string;
  /** Human label shown above the input. */
  label: ReactNode;
  /** Render an asterisk + aria-required="true" on the wrapper. */
  required?: boolean;
  /** Helper text shown below the input in muted color. */
  helper?: ReactNode;
  /** The actual input element (or any control). */
  children: ReactNode;
  className?: string;
}

export function FormField({ id, label, required, helper, children, className }: FormFieldProps) {
  return (
    <div className={cn('space-y-1', className)} aria-required={required ? true : undefined}>
      <Label htmlFor={id} className="flex items-center gap-1">
        <span>{label}</span>
        {required ? (
          <span className="text-[var(--color-destructive)]" aria-hidden="true">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {helper ? <p className="text-xs text-[var(--color-muted-foreground)]">{helper}</p> : null}
    </div>
  );
}
