import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.75 rounded-base text-[14px] font-medium whitespace-nowrap transition-all select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-segment bg-segment text-segment-fg hover:opacity-88",
        outline:
          "border border-border bg-surface text-text hover:bg-surface-2 disabled:text-muted disabled:opacity-100",
        secondary: "",
        ghost: "text-text hover:bg-surface-2 disabled:text-muted disabled:opacity-100",
        destructive: "border border-err-bg bg-err-bg text-err",
        link: "text-accent-text underline",
        sticker:
          "border-[1.5px] border-run-border bg-lime font-semibold text-on-lime shadow-action hover:brightness-97 active:translate-0.5 active:shadow-none disabled:border-border disabled:bg-surface-2 disabled:text-muted disabled:opacity-100 disabled:shadow-none",
        run: "border-[1.5px] border-run-border bg-lime font-semibold text-on-lime shadow-action enabled:hover:brightness-97 enabled:active:translate-0.5 enabled:active:shadow-none disabled:border-border disabled:bg-surface-2 disabled:text-muted disabled:opacity-100 disabled:shadow-none data-[state=preparing]:disabled:cursor-progress data-[state=preparing]:disabled:border-run-border data-[state=preparing]:disabled:bg-lime data-[state=preparing]:disabled:text-on-lime data-[state=preparing]:disabled:opacity-55 data-[state=preparing]:disabled:shadow-action data-[state=running]:bg-surface data-[state=running]:text-text [&>svg]:size-3.5 [&>svg]:fill-current",
      },
      size: {
        default: "min-h-9 px-3.5",
        xs: "min-h-7.5 px-2.5 text-[13px]",
        sm: "min-h-7.5 px-2.5 text-[13px]",
        lg: "",
        icon: "size-9",
        "icon-xs": "size-7.5",
        "icon-sm": "size-7.5",
        "icon-lg": "",
        run: "h-10 gap-2.5 rounded-md pr-4 pl-3.5 max-phone:h-touch",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
