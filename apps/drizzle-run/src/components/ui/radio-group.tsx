"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { KeyboardEvent } from "react";

import { cn } from "../../lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive data-slot="radio-group" className={className} {...props} />;
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] border-muted bg-surface p-0 data-checked:border-ink dark:data-checked:border-lime",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="data-checked:size-2 data-checked:rounded-full data-checked:bg-ink dark:data-checked:bg-lime"
      />
    </RadioPrimitive.Root>
  );
}

/**
 * Whether a key press is Enter on a radio
 *
 * Base UI radios are not inputs, so Enter on one skips the form's implicit submission. A form that submits from its
 * choices checks this in its radio groups' `onKeyDown`.
 */
function isEnterOnRadio(event: KeyboardEvent<HTMLElement>) {
  return event.key === "Enter" && event.target instanceof HTMLElement && event.target.getAttribute("role") === "radio";
}

export { isEnterOnRadio, RadioGroup, RadioGroupItem };
