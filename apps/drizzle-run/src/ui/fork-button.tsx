import { GitForkIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Hint } from "./hint";
import { projectActionClass } from "./project-actions";

export interface ForkButtonProps {
  onFork: () => void;
  disabled?: boolean;
  forking?: boolean;
  className?: string;
}

export function ForkButton({ onFork, disabled = false, forking = false, className }: ForkButtonProps) {
  return (
    <Hint content={forking ? "Forking…" : "Fork to my projects"}>
      <button
        type="button"
        className={cn(projectActionClass, className)}
        onClick={onFork}
        disabled={disabled || forking}
        aria-busy={forking || undefined}
        aria-label="Fork to my projects"
      >
        <GitForkIcon aria-hidden="true" />
      </button>
    </Hint>
  );
}
