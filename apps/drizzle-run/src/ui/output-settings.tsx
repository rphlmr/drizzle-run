import { DIALECTS } from "@drizzle-run/core/catalog";
import { SettingsIcon } from "lucide-react";
import { useId, useState } from "react";

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { FlagControls, QueryPlansSheet, type QueryPlansControlsProps } from "./query-plans-controls";
import { PHONE_QUERY, useMediaQuery } from "./use-media-query";

/** Props of `OutputSettings`: the Query plans flag the next run submits. */
export type OutputSettingsProps = QueryPlansControlsProps;

/** Drawn at 32 px (36 on phones) with a 44 px hit area, like the history button beside it. */
const gearClass = cn(
  "relative inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-surface p-0 text-text after:absolute after:top-1/2 after:left-1/2 after:size-touch after:-translate-1/2 hover:bg-surface-2 data-popup-open:bg-surface-2 data-popup-open:shadow-[0_0_0_2px_var(--lime)] max-phone:size-9 [&>svg]:size-3.5 max-phone:[&>svg]:size-3.75",
);

/** The lime dot that says Query plans are on, so the setting shows while its popover is closed. */
function PlansDot() {
  return (
    <span
      className="absolute top-0.75 right-0.75 size-1.75 rounded-full bg-lime shadow-[0_0_0_1.5px_var(--run-border)] max-phone:top-1 max-phone:right-1"
      aria-hidden="true"
      data-slot="plans-dot"
    />
  );
}

/**
 * Query plan settings, shown in a popover on desktop or a bottom sheet on phones.
 */
export function OutputSettings({ flag, dialect, onChange }: OutputSettingsProps) {
  const [open, setOpen] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);
  const switchLabel = useId();
  const label = flag.on ? "Output settings, query plans on" : "Output settings";

  if (phone) {
    return (
      <>
        <button
          type="button"
          className={gearClass}
          title="Output settings"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-slot="output-settings"
          onClick={() => setOpen(true)}
        >
          <SettingsIcon aria-hidden="true" />
          {flag.on && <PlansDot />}
        </button>
        <QueryPlansSheet flag={flag} dialect={dialect} onChange={onChange} open={open} onOpenChange={setOpen} />
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={gearClass} title="Output settings" aria-label={label} data-slot="output-settings">
        <SettingsIcon aria-hidden="true" />
        {flag.on && <PlansDot />}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex w-90 flex-col gap-0.5 rounded-[12px] border-[1.5px] border-card-border p-1.5 text-[13px] whitespace-normal shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
      >
        <PopoverTitle className="px-2.5 pt-2 pb-1 text-[12px] font-semibold text-muted">Output</PopoverTitle>
        <label className="flex min-h-touch cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 hover:bg-surface-2">
          <span className="flex flex-1 flex-col gap-0.5">
            <span id={switchLabel} className="font-semibold">
              Query plans
            </span>
            <span className="text-[12px] leading-[1.4] text-muted">
              After each run, {DIALECTS[dialect].shortName} plans every query your code sent. Off again when you leave
              the project.
            </span>
          </span>
          <Switch checked={flag.on} aria-labelledby={switchLabel} onCheckedChange={(on) => onChange({ ...flag, on })} />
        </label>
        {flag.on && (
          <div
            className={cn("flex flex-col gap-2 px-2.5 pt-1 pb-1.5 [&>label]:-mx-1.5")}
            data-slot="query-plans-settings"
          >
            <FlagControls flag={flag} dialect={dialect} onChange={onChange} layout="popover" />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
