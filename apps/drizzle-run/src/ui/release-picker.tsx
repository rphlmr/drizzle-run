import { resolveSupportedTuple, type DatabaseTarget } from "@drizzle-run/core/catalog";
import { listProjectImports } from "@drizzle-run/core/manifest";
import { CheckIcon, ChevronUpIcon } from "lucide-react";
import { useId, useState } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { Hint } from "./hint";
import {
  buildReleaseOptions,
  describeBlockedRelease,
  getReleaseChoiceName,
  getReleaseLabel,
  getReleaseTriggerLabel,
  isUnavailableRelease,
  toReleaseChoiceKey,
  type ReleaseChoice,
  type ReleaseCurrent,
  type ReleaseOption,
} from "./release-options";
import { EffectBadge, NewestBadge, ReleasePair } from "./release-pair";

export interface ReleasePickerProps {
  target: DatabaseTarget;
  current: ReleaseCurrent;
  /** The project's files: a release whose guest cannot serve their imports is shown disabled, with the reason. */
  files: Readonly<Record<string, string>>;
  /** Shows the pair as plain text, without a way to change it (a guide pins its pair). */
  readOnly?: boolean;
  /** Why the release cannot change, shown as a tooltip on the read-only label. */
  readOnlyReason?: string;
  /** A switch is in flight: the chip stays in place but cannot open. */
  busy?: boolean;
  onChange: (choice: ReleaseChoice) => void;
}

/** The status bar's version chip: "Drizzle", the pair, and an up chevron. It opens the picker above it. */
export function ReleasePicker({
  target,
  current,
  files,
  readOnly = false,
  readOnlyReason,
  busy = false,
  onChange,
}: ReleasePickerProps) {
  const [open, setOpen] = useState(false);
  const pair = buildReleaseOptions(target, current).current;
  const label = getReleaseTriggerLabel(pair);
  const unavailable = isUnavailableRelease(pair);

  if (readOnly) {
    return (
      <Hint content={readOnlyReason}>
        <span className="font-mono text-[11px] text-muted" data-slot="release">
          {label.text}
        </span>
      </Hint>
    );
  }

  return (
    <Popover open={open && !busy} onOpenChange={setOpen}>
      <Hint content="Switch Drizzle version" side="top">
        <PopoverTrigger
          render={<button type="button" aria-label={label.accessibleName} aria-busy={busy || undefined} />}
          disabled={busy}
          className="inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 pr-1.5 pl-2 text-text hover:border-faint disabled:opacity-60 data-popup-open:shadow-[0_0_0_2px_var(--lime)] max-phone:min-h-touch [&>svg]:size-2.75 [&>svg]:stroke-[2.2]"
          data-slot="release"
          data-unavailable={unavailable ? "" : undefined}
        >
          <span className="font-semibold">Drizzle</span>
          <span className={cn("font-mono text-[11px] text-muted", unavailable && "text-err")}>{label.text}</span>
          <ChevronUpIcon aria-hidden="true" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        className="flex w-[min(400px,calc(100vw-24px))] flex-col gap-0.5 rounded-[12px] border-[1.5px] border-card-border p-1.5 text-[13px] shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
      >
        <div className="flex items-baseline gap-2 px-2.5 pt-2 pb-1.5">
          <PopoverTitle className="text-[13.5px] font-[650]">Drizzle version</PopoverTitle>
          <span className="text-[12px] text-muted">Tested ORM and Kit pairs</span>
        </div>
        <ReleaseList
          target={target}
          current={current}
          files={files}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface ReleaseDialogProps extends Omit<ReleasePickerProps, "readOnly" | "readOnlyReason"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The release picker on phones, opened from the ··· menu because phones have no status bar. */
export function ReleaseDialog({ target, current, files, onChange, open, onOpenChange }: ReleaseDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-32px)] w-[min(400px,calc(100vw-24px))] flex-col gap-0.5 overflow-y-auto rounded-[18px] bg-surface p-2 text-[14px]">
        <DialogHeader className="flex-row items-baseline gap-2 px-2.5 pt-2 pb-1.5">
          <DialogTitle className="font-display text-[17px] font-bold">Drizzle release</DialogTitle>
          <span className="text-[12px] text-muted">Tested ORM and Kit pairs</span>
        </DialogHeader>
        <ReleaseList
          target={target}
          current={current}
          files={files}
          onChange={onChange}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReleaseList({
  target,
  current,
  files,
  onChange,
  onClose,
}: Pick<ReleasePickerProps, "target" | "current" | "files" | "onChange"> & { onClose: () => void }) {
  const options = buildReleaseOptions(target, current);
  const imports = listProjectImports(files);
  const describeBlocked = (option: ReleaseOption) =>
    describeBlockedRelease(resolveSupportedTuple({ target, ...option }), option.guestFlavor, imports);
  const selected = isUnavailableRelease(options.current) ? undefined : options.current;
  const groups = [...new Set(options.lines.map((option) => option.line))].map((line) => ({
    line,
    pairs: [...options.lines, ...options.others].filter((item) => item.line === line),
  }));

  return (
    <>
      {isUnavailableRelease(options.current) && (
        <p className="mx-2.5 mb-2 text-[12px] leading-normal text-err">
          This project's pair is no longer available. Pick a pair below; orm {options.current.suggested.ormVersion} ·
          kit {options.current.suggested.kitVersion} is the closest tested pair.
        </p>
      )}
      {groups.map((group) => (
        <ReleaseGroup
          key={group.line}
          pairs={group.pairs}
          selected={selected}
          describeBlocked={describeBlocked}
          onSelect={(option) => {
            onClose();

            if (option !== selected) {
              onChange({ tupleId: option.tupleId, guestFlavor: option.guestFlavor });
            }
          }}
        />
      ))}
      <p className="mt-1.5 border-t border-border p-2.5 text-[12px] leading-normal text-muted">
        Switching keeps your files and reruns type checks. APIs differ between 0.x and 1.0, so some code may need
        changes.
        {selected?.guestFlavor === "effect" && (
          <span className="mt-1 block">This choice runs on a larger image that also loads Effect 4.</span>
        )}
      </p>
    </>
  );
}

function ReleaseGroup({
  pairs,
  selected,
  describeBlocked,
  onSelect,
}: {
  pairs: readonly ReleaseOption[];
  selected: ReleaseOption | undefined;
  /** Why a pair cannot run the project's imports; undefined when it can. */
  describeBlocked: (option: ReleaseOption) => string | undefined;
  onSelect: (option: ReleaseOption) => void;
}) {
  const label = pairs[0] ? getReleaseLabel(pairs[0].ormVersion) : "";
  const reasonIdPrefix = useId();

  return (
    <fieldset aria-label={label} className="flex min-w-auto flex-col gap-0.5">
      <div className="px-2.5 pt-2 pb-1 text-[12px] font-semibold text-muted" aria-hidden="true">
        {label}
      </div>
      {pairs.map((option) => {
        const key = toReleaseChoiceKey(option);
        const pressed = selected !== undefined && key === toReleaseChoiceKey(selected);
        const blockedReason = pressed ? undefined : describeBlocked(option);
        const reasonId = `${reasonIdPrefix}-${key}`;

        return (
          <button
            key={key}
            type="button"
            className={cn(
              "flex min-h-11 w-full items-center gap-3 rounded-base border-0 px-2.5 py-2 text-left text-text",
              pressed ? "bg-mark" : "bg-transparent hover:bg-surface-2",
              "disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent",
            )}
            aria-pressed={pressed}
            aria-label={option.guestFlavor === "effect" ? getReleaseChoiceName(option) : undefined}
            aria-describedby={blockedReason === undefined ? undefined : reasonId}
            disabled={blockedReason !== undefined}
            onClick={() => onSelect(option)}
          >
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <ReleasePair ormVersion={option.ormVersion} kitVersion={option.kitVersion} />
              {blockedReason !== undefined && (
                <span id={reasonId} className="text-[11.5px] leading-[1.35] text-muted">
                  {blockedReason}
                </span>
              )}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {option.badge && <NewestBadge />}
              {option.guestFlavor === "effect" && <EffectBadge />}
              <span className="inline-flex w-3.5 text-accent-text [&_svg]:size-3.5" aria-hidden="true">
                {pressed && <CheckIcon />}
              </span>
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}
