import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("max-w-[85%] animate-pulse-soft rounded-[5px] bg-surface-2", className)}
      {...props}
    />
  );
}

export { Skeleton };
