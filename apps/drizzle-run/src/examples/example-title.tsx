import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../lib/utils";

export interface ExampleTitleProps {
  title: string;
  badge: ReactNode;
  /** A guide's step, shown under the title on a phone in place of the badges. */
  phoneStep?: string;
}

/** "Examples / Title" with its kind, in the header of an example or a guided example. */
export function ExampleTitle({ title, badge, phoneStep }: ExampleTitleProps) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2",
        phoneStep && "max-phone:flex-col max-phone:items-start max-phone:gap-0",
      )}
    >
      <Link to="/examples" className="whitespace-nowrap text-muted no-underline hover:text-text max-phone:hidden">
        Examples /
      </Link>
      <span className="truncate font-semibold">{title}</span>
      <span className={cn("contents", phoneStep && "max-phone:hidden")}>{badge}</span>
      {phoneStep && (
        <span className="hidden text-[12px] whitespace-nowrap text-muted max-phone:block">{phoneStep}</span>
      )}
    </span>
  );
}
