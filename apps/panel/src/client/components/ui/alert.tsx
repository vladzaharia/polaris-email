// shadcn Alert primitive — info/warning/destructive banner. Pairs with the
// `Alert` + `AlertTitle` + `AlertDescription` composition pattern from
// shadcn/ui so callers can `import { Alert, AlertTitle, AlertDescription }`.
//
// We render `<div role="alert">` so screen readers announce the contents.
// Variants map onto the existing colour tokens.
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn.js';

const alertVariants = cva(
  'relative w-full rounded-md border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&:has(svg)]:pl-11',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-card)] text-[var(--color-card-foreground)] border-[var(--color-border)]',
        info: 'bg-[var(--color-info)]/10 text-[var(--color-foreground)] border-[var(--color-info)]',
        warning:
          'bg-[var(--color-warning)]/10 text-[var(--color-foreground)] border-[var(--color-warning)]',
        destructive:
          'bg-[var(--color-destructive)]/10 text-[var(--color-destructive)] border-[var(--color-destructive)]',
        success:
          'bg-[var(--color-success)]/10 text-[var(--color-foreground)] border-[var(--color-success)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
  ),
);
Alert.displayName = 'Alert';

export const AlertTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5 ref={ref} className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />
));
AlertTitle.displayName = 'AlertTitle';

export const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';
