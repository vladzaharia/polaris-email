// ActionBar — shared toolbar used above tables for primary/secondary actions.
//
// Rationale: every list page hand-rolls `flex flex-wrap items-end gap-2`
// (sometimes with `justify-end`, sometimes `justify-between`) which makes
// the visual rhythm jitter between pages. This wrapper centralises spacing,
// alignment and responsive wrap behaviour.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface ActionBarProps {
  /** Left-aligned children — typically filter inputs. */
  children?: ReactNode;
  /** Right-aligned actions — typically primary buttons. */
  actions?: ReactNode;
  className?: string;
}

export function ActionBar({ children, actions, className }: ActionBarProps) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-wrap items-end justify-between gap-2',
        className,
      )}
    >
      <div className="flex flex-wrap items-end gap-2">{children}</div>
      {actions ? <div className="flex flex-wrap items-end gap-2">{actions}</div> : null}
    </div>
  );
}
