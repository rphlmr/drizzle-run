import { Input as InputPrimitive } from "@base-ui/react/input";
import * as React from "react";

import { cn } from "../../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "mt-1.75 mb-4.5 block min-h-10 w-full min-w-0 rounded-base border border-border bg-surface px-3 py-2 text-text file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground focus-visible:border-accent-text focus-visible:outline-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
