import { DIALECTS, resolveGuestFlavor, resolveSupportedTuple, type Dialect } from "@drizzle-run/core/catalog";
import { listProjectImports } from "@drizzle-run/core/manifest";
import { PAIR_SEED_PATH, PAIR_SIDE_NAME_MAX_LENGTH, pairSideName, type PairFilesStart } from "@drizzle-run/core/pair";
import { ArrowLeftRightIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { getErrorText } from "../lib/error-text";
import { cn } from "../lib/utils";
import {
  forkAsSideBySide,
  getCatalogTarget,
  type OneVersionProject,
  type SideBySideProject,
} from "../project/projects";
import { Hint } from "../ui/hint";
import { formatPairText, getReleaseLabel, toReleaseChoiceKey } from "../ui/release-options";
import { EffectBadge } from "../ui/release-pair";
import {
  BlockedReleaseNotes,
  buildFilesStartRows,
  DatabasePicker,
  listBlockedChoices,
  listCatalogChoices,
  OptionRows,
  toPairRow,
} from "./choices";
import { resolveRenamedSeedRefusal } from "./pair-seed";

/** Props of the dialog that forks a one-version project into a side-by-side one. */
export interface ForkDialogProps {
  project: OneVersionProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFork: (fork: SideBySideProject) => void;
}

/** Fork a one-version project into a side-by-side project. */
export function ForkDialog({ project, open, onOpenChange, onFork }: ForkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-32px)] max-w-150 flex-col overflow-hidden rounded-[18px] border-run-border p-0">
        {open && <ForkForm project={project} onCancel={() => onOpenChange(false)} onFork={onFork} />}
      </DialogContent>
    </Dialog>
  );
}

/** Which name a side keeps: the project's own side's, or the new side's. */
function nameKeyOf(side: { own: boolean }) {
  return side.own ? "project" : "new";
}

function ForkForm({
  project,
  onCancel,
  onFork,
}: {
  project: OneVersionProject;
  onCancel: () => void;
  onFork: (fork: SideBySideProject) => void;
}) {
  const target = getCatalogTarget(project.manifest);
  const current = resolveSupportedTuple({
    target,
    ormVersion: project.manifest.dependencies["drizzle-orm"],
    kitVersion: project.manifest.dependencies["drizzle-kit"],
  });
  const currentFlavor = resolveGuestFlavor(project.manifest);
  const currentKey = toReleaseChoiceKey({ tupleId: current.id, guestFlavor: currentFlavor });
  const [secondDialect, setSecondDialect] = useState<Dialect>(target.dialect);
  const choices = listCatalogChoices({ dialect: secondDialect });
  const blocked = listBlockedChoices(choices, listProjectImports(project.manifest.files));
  const newest = choices.find((choice) => choice.tuple.id !== current.id && blocked.get(choice.key) === undefined);
  const [chosenSecond, setSecond] = useState<string | undefined>(undefined);
  const [swapped, setSwapped] = useState(false);
  const [chosenFiles, setFiles] = useState<PairFilesStart>("separate");
  const [error, setError] = useState("");
  const [sideNames, setSideNames] = useState({ project: "", new: "" });
  const other = choices.find((choice) => choice.key === chosenSecond) ?? newest;
  const crossLine = other !== undefined && other.tuple.releaseLine !== current.releaseLine;
  const crossDatabase = secondDialect !== target.dialect;
  const files = crossLine && chosenFiles === "shared" ? "separate" : chosenFiles;
  const sides = [
    { tuple: current, guestFlavor: currentFlavor, note: "This project, now", own: true },
    ...(other ? [{ tuple: other.tuple, guestFlavor: other.guestFlavor, note: "New side", own: false }] : []),
  ];
  const ordered = swapped ? sides.toReversed() : sides;
  const orderedNames = ordered.map((side) => sideNames[nameKeyOf(side)]);
  const [firstLabel = "", secondLabel = ""] = ordered.map(
    (side, index) =>
      orderedNames[index]?.trim() || pairSideName({ ormVersion: side.tuple.ormVersion, guestFlavor: side.guestFlavor }),
  );
  const [firstSuffix = "", secondSuffix = ""] = ordered.map((side, index) =>
    crossDatabase ? ` (${DIALECTS[side.tuple.target.dialect].shortName})` : ` (${index + 1})`,
  );
  const defaultName =
    firstLabel === secondLabel
      ? `${project.name}, ${firstLabel}${firstSuffix} vs ${secondLabel}${secondSuffix}`
      : `${project.name}, ${firstLabel} vs ${secondLabel}`;
  const [name, setName] = useState<string | undefined>(undefined);
  const seedRefusal = resolveRenamedSeedRefusal(project.manifest.entrypoints);
  const schema = project.manifest.entrypoints.schema;
  const perSide = Object.keys(project.manifest.files).filter((path) => path !== PAIR_SEED_PATH);
  const ready = other !== undefined && seedRefusal === null;

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();

        if (!other || seedRefusal !== null) {
          return;
        }

        try {
          onFork(
            forkAsSideBySide(
              project,
              (name ?? defaultName).trim() || defaultName,
              other.tuple.id,
              files,
              swapped ? "new" : "project",
              other.guestFlavor,
              [orderedNames[0] ?? "", orderedNames[1] ?? ""],
            ),
          );
        } catch (cause) {
          setError(getErrorText(cause));
        }
      }}
    >
      <div className="flex items-start gap-3 px-5.5 pt-5 pr-12">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-md border-[1.5px] border-run-border bg-lime text-on-lime"
          aria-hidden="true"
        >
          <CopyIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <DialogTitle className="m-0 text-[24px] leading-[1.1] font-[750]">Fork as side by side</DialogTitle>
          <DialogDescription className="mt-1.5 mb-0 text-[13px]/[1.5]">
            {project.name} stays as it is. The fork has two sides, on any two Drizzle versions and databases, even the
            same, and every Run runs both. You can change either side later.
          </DialogDescription>
        </div>
      </div>
      <div className="grid min-h-0 gap-4 overflow-y-auto px-5.5 py-4.5">
        <div className="grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-stretch">
          {ordered.map((side, index) => (
            <div
              key={side.own ? "project" : "new"}
              className={cn(
                "row-start-1 min-w-0 rounded-[12px] border border-border bg-surface px-3.5 py-3",
                index === 0 ? "col-start-1" : "col-start-3",
                !side.own && "border-[1.5px] border-run-border shadow-sticker-card",
              )}
            >
              <div className="text-[11.5px] text-muted">{DIALECTS[side.tuple.target.dialect].label}</div>
              <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                {getReleaseLabel(side.tuple.ormVersion)}
                {side.guestFlavor === "effect" && <EffectBadge />}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">
                {formatPairText(side.tuple.ormVersion, side.tuple.kitVersion)}
              </div>
              <div className="mt-2">
                <span
                  className={cn(
                    "inline-flex h-5 items-center rounded-pill px-2 text-[11px] font-semibold",
                    side.own ? "bg-surface-2 text-muted" : "bg-mark text-accent-text",
                  )}
                >
                  {side.note}
                </span>
              </div>
              <Input
                aria-label={`Name of the ${index === 0 ? "left" : "right"} side`}
                className="mt-2.5 mb-0 h-9 min-h-9 bg-bg px-2.5 py-0 text-[13px]"
                placeholder="Name, optional"
                maxLength={PAIR_SIDE_NAME_MAX_LENGTH}
                value={sideNames[nameKeyOf(side)]}
                onChange={(event) => {
                  const value = event.target.value;

                  setSideNames((names) => ({ ...names, [nameKeyOf(side)]: value }));
                }}
              />
            </div>
          ))}
          <Hint content="Swap which side shows first">
            <button
              type="button"
              className="relative col-start-2 row-start-1 grid size-7.5 place-items-center self-center justify-self-center rounded-full border-[1.5px] border-run-border bg-surface text-text after:absolute after:-inset-1.75"
              aria-label="Swap sides"
              onClick={() => setSwapped((value) => !value)}
            >
              <ArrowLeftRightIcon className="size-3.5" aria-hidden="true" />
            </button>
          </Hint>
        </div>
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold">New side’s database</span>
          <DatabasePicker
            label="Database of the new side"
            value={secondDialect}
            onChange={(dialect) => {
              setSecondDialect(dialect);
              setSecond(undefined);
              setError("");
            }}
          />
          {crossDatabase && (
            <p className="m-0 px-0.5 text-[12px] leading-[1.4] text-muted">
              Both sides start from this project’s files, so the new side’s {schema} is still written for{" "}
              {DIALECTS[target.dialect].label}. Its tab marks what to rewrite for {DIALECTS[secondDialect].label}.
            </p>
          )}
        </div>
        <OptionRows
          label="Second version"
          dense
          value={other?.key ?? ""}
          options={choices.map((choice) =>
            toPairRow(
              choice,
              choice.key === currentKey ? "Same as this project" : choice === choices[0] ? "Newest" : undefined,
              blocked.get(choice.key) !== undefined,
            ),
          )}
          onChange={setSecond}
        />
        <BlockedReleaseNotes reasons={blocked} />
        <div className="grid gap-1.5">
          <OptionRows<PairFilesStart>
            label="Files"
            value={files}
            options={buildFilesStartRows(
              "fork",
              PAIR_SEED_PATH,
              perSide,
              crossLine ? "cross_line" : crossDatabase ? "cross_database" : "allowed",
            )}
            onChange={setFiles}
          />
          <p className="m-0 px-0.5 pt-0.5 text-[12px] text-muted">You can split or share a file later.</p>
        </div>
        {seedRefusal !== null && <p className="m-0 text-[13px] text-err">{seedRefusal}</p>}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-err">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-end gap-2.5 border-t border-border bg-surface px-5.5 py-3.5 max-phone:flex-wrap">
        <label className="grid min-w-0 flex-1 gap-1 text-[11.5px] font-normal text-muted max-phone:basis-full">
          Name
          <Input
            className="h-8 text-[13px]"
            value={name ?? defaultName}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Hint
          content={seedRefusal ?? (other === undefined ? "No other release can run this project's imports" : undefined)}
        >
          <Button
            type="submit"
            variant="sticker"
            aria-disabled={!ready || undefined}
            className={cn(!ready && "opacity-55")}
          >
            Fork as side by side
          </Button>
        </Hint>
      </div>
    </form>
  );
}
