// PageCard — content container with an optional decorative top-edge gradient
// (the only "magicui" polish kept from the ExpressCharge port).
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function PageCard({
  children,
  title,
  description,
  decorative = false,
  className,
}: {
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-xl border bg-[var(--color-card)] text-[var(--color-card-foreground)] shadow-sm',
        className,
      )}
    >
      {decorative ? (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, var(--color-primary), var(--color-detail), transparent)',
          }}
        />
      ) : null}
      {title ? (
        <header className="border-b px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{description}</p>
          ) : null}
        </header>
      ) : null}
      <div className="p-6">{children}</div>
    </section>
  );
}
