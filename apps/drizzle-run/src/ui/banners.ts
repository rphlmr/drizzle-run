import { cn } from "../lib/utils";

/** A full-width line under the header that reports a problem. */
export const errorBannerClass = cn("flex flex-wrap items-center gap-2.5 bg-err-bg px-4 py-2.5 text-[13px] text-err");

/** A full-width line under the header that reports news, without alarm. */
export const noticeBannerClass = cn(
  "flex flex-wrap items-center gap-2.5 bg-surface-2 px-4 py-2.5 text-[13px] text-text",
);
