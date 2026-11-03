import { CopyIcon } from "lucide-react";
import { Children, Fragment, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Hint } from "./hint";

/**
 * Shared header action styling, with larger touch targets on phones.
 */
export const projectActionClass = cn(
  "relative inline-flex h-7.5 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-text hover:bg-surface-2 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent aria-busy:cursor-progress data-popup-open:bg-surface-2 data-popup-open:shadow-[0_0_0_2px_var(--lime)] max-phone:size-9 max-phone:after:absolute max-phone:after:-inset-1 [&>svg]:size-3.75",
);

/**
 * The header's project actions box
 *
 * Docs, then Duplicate on the user's own project or Fork on an official example, a guide or a shared snapshot, in one
 * bordered box with a rule between them. Nothing renders when the view has none of them.
 */
export function ProjectActionsGroup({ children }: { children: ReactNode }) {
  const actions = Children.toArray(children);

  if (actions.length === 0) {
    return null;
  }

  return (
    <fieldset
      aria-label="Project actions"
      className="m-0 flex min-w-0 shrink-0 items-center rounded-[9px] border border-border bg-surface p-0 max-phone:border-0 max-phone:bg-transparent"
    >
      {actions.map((action, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="w-px self-stretch bg-border max-phone:hidden" aria-hidden="true" />}
          {action}
        </Fragment>
      ))}
    </fieldset>
  );
}

/** Duplicate in the project actions box: a copy of the project in My projects. */
export function DuplicateButton({ onDuplicate }: { onDuplicate: () => void }) {
  return (
    <Hint content="Duplicate">
      <button type="button" className={projectActionClass} aria-label="Duplicate" onClick={onDuplicate}>
        <CopyIcon aria-hidden="true" />
      </button>
    </Hint>
  );
}
