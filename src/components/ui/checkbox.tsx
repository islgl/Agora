import { forwardRef } from 'react';
import { Check } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from '@/lib/utils';

/**
 * Multi-select checkbox — the only legitimate checkbox use in Agora (binary
 * settings go through <Toggle>). Matches the rounded-square look Finder /
 * Mail use for multi-select lists.
 */
export const Checkbox = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref as React.Ref<HTMLElement>}
    data-slot="checkbox"
    className={cn(
      'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[5px]',
      'border border-border bg-card transition-colors outline-none',
      'focus-visible:ring-2 focus-visible:ring-ring',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[checked]:bg-primary data-[checked]:border-primary',
      'data-[checked]:text-primary-foreground',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className="flex items-center justify-center text-current"
    >
      <Check className="size-3" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));

Checkbox.displayName = 'Checkbox';
