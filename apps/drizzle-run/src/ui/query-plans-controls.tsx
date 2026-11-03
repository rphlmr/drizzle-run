import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { DIALECTS } from "@drizzle-run/core/catalog";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { QUERY_PLAN_SIZES } from "@drizzle-run/runtime/query-plans";
import { useId } from "react";
import * as z from "zod/mini";

import { Checkbox } from "../components/ui/checkbox";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from "../components/ui/drawer";
import { RadioGroup } from "../components/ui/radio-group";
import { cn } from "../lib/utils";
import { sizeLabels, type QueryPlansFlag } from "./query-plans";

export type Dialect = RunManifestTarget["dialect"];

const QueryPlanSizeSchema = z.literal(QUERY_PLAN_SIZES);

const fillNote = "Fills your tables with generated rows once your code is done, so results still show your data.";
const seedNote = "Plans your tables as your seed left them.";
const measureNote = "Runs each query once more on the filled tables to measure its real time and rows. Slower.";

interface FlagControlsProps {
  flag: QueryPlansFlag;
  dialect: Dialect;
  onChange: (flag: QueryPlansFlag) => void;
  layout: "popover" | "sheet";
}

/** What the size control says under it: the seed plans tables as they are; a size fills them first. */
function getSizeNote(flag: QueryPlansFlag): string {
  if (flag.size === "seed") {
    return seedNote;
  }

  return flag.size === "1m" ? `${fillNote} 1M rows adds a few seconds.` : fillNote;
}

/** "Plan as if tables held", the size control, and Measure real time: shared by the gear popover and the phone sheet. */
export function FlagControls({ flag, dialect, onChange, layout }: FlagControlsProps) {
  const sizeLabel = useId();
  const sheet = layout === "sheet";
  const alwaysTimed = DIALECTS[dialect].queryPlans.alwaysTimesQueries;

  return (
    <>
      <div className={cn("flex flex-col gap-1.5", sheet && "contents")}>
        <span id={sizeLabel} className="text-[12.5px] font-semibold">
          Plan as if tables held
        </span>
        <RadioGroup
          aria-labelledby={sizeLabel}
          className={cn("grid grid-cols-4 rounded-md bg-surface-2 p-0.75", sheet && "rounded-[11px]")}
          value={flag.size}
          onValueChange={(value) => {
            const size = QueryPlanSizeSchema.safeParse(value);

            if (size.success) {
              onChange({ ...flag, size: size.data });
            }
          }}
        >
          {QUERY_PLAN_SIZES.map((size) => (
            <RadioPrimitive.Root
              key={size}
              value={size}
              className={cn(
                "relative inline-flex h-7.5 min-w-0 items-center justify-center rounded-[7px] border-0 bg-transparent px-1 text-[12.5px] font-medium whitespace-nowrap text-muted after:absolute after:inset-x-0 after:-inset-y-1.75 hover:text-text",
                sheet
                  ? "h-9 rounded-[8px] after:-inset-y-1 data-checked:bg-surface data-checked:font-semibold data-checked:text-text data-checked:shadow-[0_0_0_1.5px_var(--card-border)]"
                  : "data-checked:bg-segment data-checked:text-segment-fg",
              )}
            >
              {sizeLabels[size]}
            </RadioPrimitive.Root>
          ))}
        </RadioGroup>
        <p className="text-[12px] leading-[1.45] text-muted">{getSizeNote(flag)}</p>
      </div>
      <label
        className={cn(
          "flex min-h-touch cursor-pointer items-start gap-2.5",
          !sheet && "rounded-md border border-border p-2.5",
          alwaysTimed && "cursor-default",
        )}
      >
        <Checkbox
          className={cn("mt-px", sheet && "size-5 border-card-border")}
          checked={alwaysTimed || flag.measureRealTime}
          disabled={alwaysTimed}
          onCheckedChange={(checked) => onChange({ ...flag, measureRealTime: checked })}
        />
        <span className="flex flex-col gap-0.5 text-[13px] font-semibold">
          Measure real time
          <span className="text-[12px] leading-[1.4] font-normal text-muted">
            {measureNote}
            {alwaysTimed && ` ${DIALECTS[dialect].label} always times each query.`}
          </span>
        </span>
      </label>
    </>
  );
}

/** Props of the Query plans controls. */
export interface QueryPlansControlsProps {
  flag: QueryPlansFlag;
  dialect: Dialect;
  onChange: (flag: QueryPlansFlag) => void;
}

export interface QueryPlansSheetProps extends QueryPlansControlsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Phones: the output bar's gear opens the same settings as a bottom sheet, with its own switch. */
export function QueryPlansSheet({ flag, dialect, onChange, open, onOpenChange }: QueryPlansSheetProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="rounded-t-[16px] border border-b-0 border-card-border px-4 pt-2 pb-5">
        <div className="flex flex-col gap-3.5">
          <span className="h-1 w-9 self-center rounded-full bg-border" aria-hidden="true" />
          <div className="flex items-center gap-2.5">
            <DrawerTitle className="flex-1 text-[17px]">Query plans</DrawerTitle>
            <SwitchPrimitive.Root
              checked={flag.on}
              aria-label="Query plans"
              onCheckedChange={(on) => onChange({ ...flag, on })}
              className="relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border-[1.5px] border-border bg-surface-2 p-0.5 after:absolute after:top-1/2 after:left-1/2 after:size-touch after:-translate-1/2 data-checked:border-run-border data-checked:bg-lime"
            >
              <SwitchPrimitive.Thumb className="block size-4.25 rounded-full bg-muted transition-transform duration-150 data-checked:translate-x-4 data-checked:bg-on-lime" />
            </SwitchPrimitive.Root>
          </div>
          <DrawerDescription className="m-0 text-left text-[12.5px] leading-[1.45] text-balance text-muted">
            After each run, the database plans every query your code sent. Off again when you leave the project.
          </DrawerDescription>
          <FlagControls flag={flag} dialect={dialect} onChange={onChange} layout="sheet" />
          <DrawerClose className="grid h-touch place-items-center rounded-md border-0 bg-segment text-[14px] font-semibold text-segment-fg">
            Done
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
