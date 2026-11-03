import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own keys (design/theme.css), so `cn("size-7.5", "size-touch")` keeps only the last.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ["header", "status", "touch"],
      radius: ["base", "pill"],
      shadow: ["sticker", "sticker-lg", "pop"],
      breakpoint: ["phone", "wide"],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts, the last class winning, including the theme's own keys. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
