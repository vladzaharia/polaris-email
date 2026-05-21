// Styled tabs. Underline pattern: TabsList carries a baseline border so the
// whole strip reads as a section header; the active TabsTrigger sits on
// `-mb-px` and paints over that baseline with the primary colour, producing
// the canonical browser-tab look. Inactive triggers are muted; the active
// trigger picks up bold + foreground colour so the eye lands on it from
// across the page.
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../lib/cn.js';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex w-full items-center gap-6 border-b border-[var(--color-border)]',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'relative -mb-px inline-flex h-9 cursor-pointer items-center whitespace-nowrap border-b-2 border-transparent px-1 text-sm font-medium text-[var(--color-muted-foreground)] transition-colors',
      'hover:border-[var(--color-border)] hover:text-[var(--color-foreground)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] focus-visible:rounded-sm',
      'disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:border-[var(--color-primary)] data-[state=active]:font-semibold data-[state=active]:text-[var(--color-foreground)]',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
