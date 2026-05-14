import * as React from 'react';
import { cn } from '../../lib/cn.js';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('animate-pulse rounded-md bg-[var(--color-muted)]', className)} {...props} />
  );
}
