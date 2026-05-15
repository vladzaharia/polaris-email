// PageCard — content container with an optional decorative top-edge gradient
// (the only "magicui" polish kept from the ExpressCharge port).
//
// Detail pages can pass a `breadcrumbs` trail to render a small navigation
// strip above the title. A breadcrumb with a `to` is rendered as a Link; the
// final crumb is usually the current page and is rendered as plain text.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn.js';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]"
    >
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span key={`${item.label}-${idx}`} className="flex items-center gap-1">
            {item.to && !isLast ? (
              <Link to={item.to} className="hover:text-[var(--color-foreground)] hover:underline">
                {item.label}
              </Link>
            ) : (
              <span
                className={isLast ? 'text-[var(--color-foreground)]' : undefined}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </span>
            )}
            {!isLast ? <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden /> : null}
          </span>
        );
      })}
    </nav>
  );
}

export function PageCard({
  children,
  title,
  description,
  breadcrumbs,
  decorative = false,
  className,
}: {
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
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
      {title || breadcrumbs ? (
        <header className="border-b px-6 py-4">
          {breadcrumbs && breadcrumbs.length > 0 ? (
            <div className="mb-2">
              <Breadcrumbs items={breadcrumbs} />
            </div>
          ) : null}
          {title ? <h1 className="text-lg font-semibold tracking-tight">{title}</h1> : null}
          {description ? (
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{description}</p>
          ) : null}
        </header>
      ) : null}
      <div className="p-6">{children}</div>
    </section>
  );
}
