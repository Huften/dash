import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

/**
 * App-wide tooltip provider. Mount once near the root. A shared provider lets
 * tooltips coordinate the open delay: after one tooltip has opened, moving to a
 * neighbouring trigger opens instantly (skipDelayDuration) instead of waiting
 * the full delay again.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={350} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

interface TooltipProps {
  /** Tooltip text. When empty/undefined the child renders without a tooltip. */
  label?: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Extra delay override in ms (defaults to the provider's delay). */
  delayDuration?: number;
}

/**
 * Styled replacement for native `title=` tooltips. Wraps a single interactive
 * child (uses Radix `asChild`, so the child keeps its own ref/props).
 *
 *   <Tooltip label="Settings"><button>…</button></Tooltip>
 */
export function Tooltip({ label, children, side = 'top', align = 'center', delayDuration }: TooltipProps) {
  if (label === undefined || label === null || label === '') return children;

  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="tooltip-content z-50 max-w-xs select-none rounded-md border border-border/60 bg-[hsl(var(--surface-2))] px-2 py-1 text-[11px] font-medium leading-tight text-foreground shadow-md shadow-black/20"
        >
          {label}
          <RadixTooltip.Arrow className="fill-[hsl(var(--surface-2))]" width={10} height={5} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
