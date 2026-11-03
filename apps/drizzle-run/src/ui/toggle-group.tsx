import { cn } from "../lib/utils";
import { selectionIndicatorClass, useSelectionIndicator } from "./use-selection-indicator";

export interface ToggleGroupProps<T extends string> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** One choice among a few, as pressed buttons on a sunken track. */
export function ToggleGroup<T extends string>({ label, options, value, onChange, className }: ToggleGroupProps<T>) {
  const { trackRef, indicatorStyle } = useSelectionIndicator(value);

  return (
    <fieldset
      ref={trackRef}
      className={cn("relative flex min-w-auto gap-0.5 rounded-md bg-surface-2 p-0.75", className)}
      aria-label={label}
    >
      {indicatorStyle && (
        <span
          aria-hidden="true"
          className={cn(selectionIndicatorClass, "rounded-sm bg-surface shadow-[0_0_0_1px_var(--border)]")}
          style={indicatorStyle}
        />
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            "relative rounded-sm border-0 bg-transparent px-2.75 py-1.25 text-[13px] whitespace-nowrap text-text max-phone:min-h-9.5 max-phone:flex-1",
            option.value === value && "font-medium",
          )}
          aria-pressed={option.value === value}
          data-option={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
