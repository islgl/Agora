import { forwardRef } from 'react';
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@/lib/utils';

/**
 * UI convention: every on/off configuration uses <Toggle>. Native checkboxes
 * are reserved for multi-select lists, never for binary settings.
 *
 * Wraps Base UI's Switch primitive with our track / thumb styling.
 */
export const Toggle = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref as React.Ref<HTMLElement>}
    data-slot="toggle"
    className={cn(
      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
      'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[checked]:bg-primary data-[unchecked]:bg-muted",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-4 rounded-full bg-background',
        'shadow-sm ring-0 transition-transform translate-x-0.5',
        'data-[checked]:translate-x-[18px]'
      )}
    />
  </SwitchPrimitive.Root>
));

Toggle.displayName = 'Toggle';
