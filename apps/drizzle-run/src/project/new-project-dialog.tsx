import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { getRecommendedTuple, releaseLineOf, type GuestFlavor, type RuntimeTupleId } from "@drizzle-run/core/catalog";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { PAIR_SIDE_NAME_MAX_LENGTH, type PairFilesStart } from "@drizzle-run/core/pair";
import { ChevronDownIcon, CloudIcon, MonitorIcon, PlusIcon, RectangleVerticalIcon, UploadIcon } from "lucide-react";
import { useId, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import * as z from "zod/mini";

import type { ProjectLocation } from "../cloud/project-location";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { isEnterOnRadio, RadioGroup } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import { getErrorText } from "../lib/error-text";
import { cn } from "../lib/utils";
import {
  buildFilesStartRows,
  DatabasePicker,
  DatabaseSegment,
  listCatalogChoices,
  OptionRows,
  toPairRow,
} from "../side-by-side/choices";
import { AutoHeight } from "../ui/auto-height";
import { fieldClass, FieldError, fieldInputClass, FieldNote } from "../ui/field";
import { Hint } from "../ui/hint";
import { SidesIcon } from "../ui/icons";
import { toPairKey } from "../ui/release-choices";
import {
  buildReleaseOptions,
  formatPairText,
  getNewProjectRelease,
  getReleaseChoiceName,
  getReleaseLabel,
  type ReleaseOption,
} from "../ui/release-options";
import { EffectBadge, NewestBadge, ReleasePair } from "../ui/release-pair";
import {
  releaseDescriptionClass,
  releaseDialogClass,
  releaseFooterClass,
  releaseFormClass,
  releaseTitleClass,
} from "./choose-release-dialog";
import { useProjectImportActorRef, useProjectImportSelector } from "./import-actor";

type Dialect = RunManifestTarget["dialect"];

const databases: readonly { dialect: Dialect; label: string }[] = [
  { dialect: "postgresql", label: "PostgreSQL" },
  { dialect: "sqlite", label: "SQLite" },
];

const DialectSchema = z.literal(databases.map((item) => item.dialect));

/** What New project creates: a project on one pair and flavor, or a side-by-side one on two. */
export type NewProjectKind =
  | { kind: "one"; tupleId: RuntimeTupleId; guestFlavor: GuestFlavor }
  | {
      kind: "pair";
      /** Each side's database, in order; they may differ. */
      targets: readonly [RunManifestTarget, RunManifestTarget];
      tupleIds: readonly [RuntimeTupleId, RuntimeTupleId];
      guestFlavors: readonly [GuestFlavor, GuestFlavor];
      files: PairFilesStart;
      /** Each side's name, in order; empty goes by the release. */
      names: readonly [string, string];
    };

export interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether to ask where the project is kept, Cloud first; false keeps it in this browser, as while signed out. */
  offerCloud: boolean;
  /** Throws when the project cannot be created; the message is shown in the dialog. */
  onCreate: (name: string, target: RunManifestTarget, kind: NewProjectKind, keptIn: ProjectLocation) => void;
}

const NAME_MISSING = "Give the project a name.";

/**
 * Creates a project from a name, a database and a Drizzle release, or imports one from a file through the closest
 * `ProjectImportActorProvider`; the host closes the dialog when the import emits `import.done`.
 */
export function NewProjectDialog({ open, onOpenChange, offerCloud, onCreate }: NewProjectDialogProps) {
  const importer = useProjectImportActorRef();
  const change = (next: boolean) => {
    if (!next) {
      importer.send({ type: "import.dismiss" });
    }

    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className={releaseDialogClass}>
        <AutoHeight>
          <NewProjectForm onCancel={() => change(false)} offerCloud={offerCloud} onCreate={onCreate} />
        </AutoHeight>
      </DialogContent>
    </Dialog>
  );
}

function NewProjectForm({
  onCancel,
  offerCloud,
  onCreate,
}: Pick<NewProjectDialogProps, "offerCloud" | "onCreate"> & { onCancel: () => void }) {
  const [name, setName] = useState("");
  const [chosenPlace, setPlace] = useState<ProjectLocation>("cloud");
  const [dialect, setDialect] = useState<Dialect>("postgresql");
  const [chosenPair, setChosenPair] = useState<string | undefined>(undefined);
  const [withEffect, setWithEffect] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<NewProjectKind["kind"]>("one");
  const [slots, setSlots] = useState<readonly [string | undefined, string | undefined]>([undefined, undefined]);
  const [sideNames, setSideNames] = useState<readonly [string, string]>(["", ""]);
  const [chosenSideDialects, setSideDialects] = useState<readonly [Dialect | undefined, Dialect | undefined]>([
    undefined,
    undefined,
  ]);
  const [chosenFiles, setFiles] = useState<PairFilesStart>("separate");
  const databaseLabel = useId();
  const kindLabel = useId();
  const releaseLabel = useId();
  const form = useRef<HTMLFormElement>(null);
  const importDrop = useImportDrop();
  const target: RunManifestTarget = { dialect };
  const recommended = getRecommendedTuple(target);
  const options = buildReleaseOptions(target, recommended);
  const all = [...options.lines, ...options.others];
  const pairs = all.filter((option) => option.guestFlavor === "slim");
  const pair = pairs.find((option) => toPairKey(option) === chosenPair) ?? getNewProjectRelease(options);
  const effectOption = all.find((option) => option.tupleId === pair?.tupleId && option.guestFlavor === "effect");
  const selected = withEffect && effectOption ? effectOption : pair;
  const importing = useProjectImportSelector((snapshot) => !snapshot.matches("idle") && !snapshot.matches("failed"));
  const sideDialects = [chosenSideDialects[0] ?? dialect, chosenSideDialects[1] ?? dialect] as const;
  const sideChoices = sideDialects.map((sideDialect) => listCatalogChoices({ dialect: sideDialect }));
  const crossDatabase = sideDialects[0] !== sideDialects[1];
  const slotChoices = ([0, 1] as const).map((index) => {
    const choices = sideChoices[index] ?? [];
    const start =
      index === 0 && !crossDatabase
        ? choices.find((choice) => releaseLineOf(choice.tuple.ormVersion) === "legacy")
        : choices.find((choice) => releaseLineOf(choice.tuple.ormVersion) !== "legacy");

    return choices.find((choice) => choice.key === slots[index]) ?? start;
  });
  const crossLine = slotChoices[0]?.tuple.releaseLine !== slotChoices[1]?.tuple.releaseLine;
  const sharing = crossLine ? "cross_line" : crossDatabase ? "cross_database" : "allowed";
  const files = sharing === "cross_line" && chosenFiles === "shared" ? "separate" : chosenFiles;
  const keptIn = offerCloud ? chosenPlace : "local";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (name.trim() === "") {
      setError(NAME_MISSING);
      return;
    }

    try {
      if (kind === "pair") {
        const [left, right] = slotChoices;

        if (!left || !right) {
          setError("This database has no two releases to run side by side.");
          return;
        }

        onCreate(
          name,
          target,
          {
            kind: "pair",
            targets: [{ dialect: sideDialects[0] }, { dialect: sideDialects[1] }],
            tupleIds: [left.tuple.id, right.tuple.id],
            guestFlavors: [left.guestFlavor, right.guestFlavor],
            files,
            names: sideNames,
          },
          keptIn,
        );
        return;
      }

      if (!selected) {
        setError("Choose a Drizzle release.");
        return;
      }

      onCreate(name, target, { kind: "one", tupleId: selected.tupleId, guestFlavor: selected.guestFlavor }, keptIn);
    } catch (cause) {
      setError(getErrorText(cause));
    }
  };

  const submitOnRadioEnter = (event: KeyboardEvent<HTMLElement>) => {
    if (isEnterOnRadio(event)) {
      event.preventDefault();
      form.current?.requestSubmit();
    }
  };

  return (
    <div
      className="relative"
      onDragEnter={importDrop.enter}
      onDragOver={importDrop.over}
      onDragLeave={importDrop.leave}
      onDrop={importDrop.drop}
    >
      <form ref={form} className={releaseFormClass} noValidate onSubmit={submit}>
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogTitle className={releaseTitleClass}>New project</DialogTitle>
            <ImportFileButton />
          </div>
          <DialogDescription className={releaseDescriptionClass}>
            Starts with schema, seed, and query files.
            {!offerCloud && " It's saved in this browser."}
          </DialogDescription>
          <ImportStatus />
        </DialogHeader>
        <div className={fieldClass}>
          <span id={kindLabel} className="sr-only">
            Kind
          </span>
          <RadioGroup
            aria-labelledby={kindLabel}
            onKeyDown={submitOnRadioEnter}
            className="grid grid-cols-2 gap-2.5"
            value={kind}
            onValueChange={(value) => {
              if (value === "one" || value === "pair") {
                setKind(value);
                setError("");
              }
            }}
          >
            <KindChoice
              value="one"
              title="Single"
              body="Your code on one Drizzle release."
              icon={<RectangleVerticalIcon className="size-4" aria-hidden="true" />}
            />
            <KindChoice
              value="pair"
              title="Side by side"
              body="Compare two releases or databases."
              icon={<SidesIcon className="size-4" />}
            />
          </RadioGroup>
        </div>
        <div
          className={cn(
            "grid items-end gap-3 max-phone:grid-cols-1",
            kind === "one" ? "grid-cols-[minmax(0,1fr)_200px]" : "grid-cols-1",
          )}
        >
          <label className={fieldClass}>
            Name
            <Input
              className={fieldInputClass}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              required
              aria-invalid={error === NAME_MISSING || undefined}
              maxLength={160}
            />
          </label>
          <div className={cn(fieldClass, kind === "pair" && "hidden")}>
            <span id={databaseLabel}>Database</span>
            <RadioGroup
              aria-labelledby={databaseLabel}
              onKeyDown={submitOnRadioEnter}
              className="grid h-10.5 grid-cols-2 gap-0.5 rounded-md bg-surface-2 p-0.75"
              value={dialect}
              onValueChange={(value) => {
                const chosen = DialectSchema.safeParse(value);

                if (chosen.success) {
                  setDialect(chosen.data);
                }
              }}
            >
              {databases.map((item) => (
                <DatabaseSegment key={item.dialect} value={item.dialect}>
                  {item.label}
                </DatabaseSegment>
              ))}
            </RadioGroup>
          </div>
        </div>
        {kind === "one" ? (
          <div className={fieldClass}>
            <span id={releaseLabel}>Drizzle release</span>
            <ReleaseField
              labelId={releaseLabel}
              pairs={pairs}
              pair={pair}
              effectOption={effectOption}
              withEffect={withEffect}
              onPairChange={(key) => {
                setChosenPair(key);
                setError("");
              }}
              onEffectChange={setWithEffect}
              onKeyDown={submitOnRadioEnter}
            />
            <FieldNote>ORM and Kit come as a tested pair. You can switch later from the status bar.</FieldNote>
          </div>
        ) : (
          <>
            <div className={fieldClass}>
              <span id={releaseLabel}>Drizzle releases</span>
              <fieldset
                className="grid min-w-auto grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-start"
                aria-labelledby={releaseLabel}
              >
                {([0, 1] as const).map((index) => {
                  const slot = slotChoices[index];
                  const other = sideDialects[0] === sideDialects[1] ? slotChoices[index === 0 ? 1 : 0] : undefined;
                  const choices = sideChoices[index] ?? [];
                  const sideLabel = index === 0 ? "first" : "second";
                  const tuple = slot?.tuple;
                  const effect = slot?.guestFlavor === "effect";

                  return (
                    slot &&
                    tuple && (
                      <div
                        key={index}
                        className={cn(
                          "row-start-1 flex min-w-0 flex-col gap-1.5",
                          index === 0 ? "col-start-1" : "col-start-3",
                        )}
                      >
                        <DatabasePicker
                          label={`Database of the ${sideLabel} side`}
                          onKeyDown={submitOnRadioEnter}
                          value={sideDialects[index]}
                          onChange={(chosen) => {
                            setSideDialects((current) =>
                              index === 0 ? [chosen, current[1] ?? dialect] : [current[0] ?? dialect, chosen],
                            );
                            setError("");
                          }}
                        />
                        <Popover>
                          <Hint content="Pick any release pair from the catalog">
                            <PopoverTrigger
                              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 text-left font-normal text-text"
                              aria-label={`${index === 0 ? "First" : "Second"} side: ${getReleaseLabel(tuple.ormVersion)}, orm ${tuple.ormVersion} · kit ${tuple.kitVersion}${effect ? ", with Effect 4" : ""}. Pick any release pair from the catalog`}
                            >
                              <span className="flex items-center gap-2">
                                <span className="font-semibold">{getReleaseLabel(tuple.ormVersion)}</span>
                                {effect && <EffectBadge />}
                                <ChevronDownIcon className="ml-auto size-3.5 text-muted" aria-hidden="true" />
                              </span>
                              <ReleasePair ormVersion={tuple.ormVersion} kitVersion={tuple.kitVersion} />
                            </PopoverTrigger>
                          </Hint>
                          <PopoverContent className="w-85 max-w-[calc(100vw-32px)] p-3">
                            <OptionRows
                              label={`${index === 0 ? "First" : "Second"} side`}
                              dense
                              onKeyDown={submitOnRadioEnter}
                              value={slot.key}
                              options={choices.map((item) =>
                                toPairRow(item, item.key === other?.key ? "Other side" : undefined, false),
                              )}
                              onChange={(value) =>
                                setSlots((current) => (index === 0 ? [value, current[1]] : [current[0], value]))
                              }
                            />
                          </PopoverContent>
                        </Popover>
                        <Input
                          className="m-0 h-9 min-h-9 px-2.5 py-0 text-[13px] font-normal"
                          aria-label={`Name of the ${index === 0 ? "first" : "second"} side`}
                          placeholder="Name, optional"
                          maxLength={PAIR_SIDE_NAME_MAX_LENGTH}
                          value={sideNames[index]}
                          onChange={(event) => {
                            const value = event.target.value;

                            setSideNames((current) => (index === 0 ? [value, current[1]] : [current[0], value]));
                          }}
                        />
                      </div>
                    )
                  );
                })}
                <PlusIcon
                  className="col-start-2 row-start-1 mt-18 size-4 justify-self-center text-muted"
                  aria-hidden="true"
                />
              </fieldset>
              <FieldNote>
                Any database and release on either side, even the same one. A side without a name shows its release.
              </FieldNote>
            </div>
            <div className="grid gap-1.5">
              <OptionRows<PairFilesStart>
                label={<span className="text-[14px] font-medium">Files</span>}
                columns
                value={files}
                onKeyDown={submitOnRadioEnter}
                options={buildFilesStartRows("new", "seed.ts", ["query.ts", "schema.ts"], sharing)}
                onChange={(value) => {
                  setFiles(value);
                  setError("");
                }}
              />
              <FieldNote>You can split or share a file later.</FieldNote>
            </div>
          </>
        )}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter
          className={cn(
            releaseFooterClass,
            "flex-row flex-wrap items-center border-t border-border pt-4 sm:justify-end",
          )}
        >
          {offerCloud && <KeepInSelect value={chosenPlace} onChange={setPlace} />}
          <Button variant="outline" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="sticker" disabled={importing}>
            {kind === "pair" ? "Create side by side" : "Create project"}
          </Button>
        </DialogFooter>
      </form>
      {importDrop.dragging && (
        <div
          className="pointer-events-none absolute -inset-3 flex items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-card-border bg-mark/95 font-medium"
          aria-hidden="true"
        >
          <UploadIcon className="size-4.5" />
          Drop to import the project file
        </div>
      )}
    </div>
  );
}

/** A Kind card: the checked one takes the ink border, the mark fill and the sticker shadow. */
function KindChoice({
  value,
  title,
  body,
  icon,
}: {
  value: NewProjectKind["kind"];
  title: string;
  body: string;
  icon: ReactNode;
}) {
  return (
    <RadioPrimitive.Root
      value={value}
      className="flex items-start gap-2.5 rounded-lg border border-border bg-surface p-3 text-left font-normal text-text data-checked:border-text data-checked:bg-mark data-checked:ring-1 data-checked:ring-text"
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex flex-col gap-0.75">
        <span className="font-semibold">{title}</span>
        <span className="text-[12.5px] leading-[1.4] text-muted">{body}</span>
      </span>
    </RadioPrimitive.Root>
  );
}

/** Where the project is kept, as a small select on the left of the footer: Cloud first. */
function KeepInSelect({ value, onChange }: { value: ProjectLocation; onChange: (value: ProjectLocation) => void }) {
  const Icon = value === "cloud" ? CloudIcon : MonitorIcon;

  return (
    <label className="relative mr-auto inline-flex h-9 items-center gap-1.5 rounded-md pr-1 pl-2 text-[13px] text-soft hover:bg-surface-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-text">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">Keep in</span>
      <select
        className="cursor-pointer appearance-none bg-transparent pr-4 font-medium text-text focus-visible:outline-transparent"
        value={value}
        onChange={(event) => {
          const next = event.target.value;

          if (next === "cloud" || next === "local") {
            onChange(next);
          }
        }}
      >
        <option value="cloud">Cloud</option>
        <option value="local">This browser only</option>
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-1.5 size-3.5 text-muted" aria-hidden="true" />
    </label>
  );
}

interface ReleaseFieldProps {
  labelId: string;
  /** Every plain pair the database offers, newest of each line first. */
  pairs: readonly ReleaseOption[];
  pair: ReleaseOption | undefined;
  /** The chosen pair's Effect option, when it ships one. */
  effectOption: ReleaseOption | undefined;
  withEffect: boolean;
  onPairChange: (pairKey: string) => void;
  onEffectChange: (withEffect: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * The chosen release as one row, with "Change" opening every pair, and Effect 4 as an add-on row under it. Effect
 * stays in view when the pair has none, disabled with the reason, so the option can still be found.
 */
function ReleaseField({
  labelId,
  pairs,
  pair,
  effectOption,
  withEffect,
  onPairChange,
  onEffectChange,
  onKeyDown,
}: ReleaseFieldProps) {
  const [open, setOpen] = useState(false);
  const effectLabel = useId();

  if (!pair) {
    return null;
  }

  const label = getReleaseLabel(pair.ormVersion);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface font-normal">
      <fieldset className="m-0 flex min-w-0 items-center gap-2.5 border-0 p-3" aria-labelledby={labelId}>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-2 font-medium">
            {label}
            {pair.badge && <NewestBadge />}
          </span>
          <span className="truncate font-mono text-[12.5px] text-muted">
            ORM <span className="text-text">{pair.ormVersion}</span> · Kit{" "}
            <span className="text-text">{pair.kitVersion}</span>
          </span>
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<button type="button" aria-label={`Change Drizzle release, now ${getReleaseChoiceName(pair)}`} />}
            className="inline-flex min-h-touch shrink-0 items-center self-center rounded-md px-1.5 text-[13px] font-medium text-soft underline decoration-faint underline-offset-3 hover:text-text hover:decoration-text"
          >
            Change
          </PopoverTrigger>
          <PopoverContent align="end" className="w-85 max-w-[calc(100vw-32px)] p-3">
            <OptionRows
              label="Drizzle release"
              dense
              onKeyDown={onKeyDown}
              value={toPairKey(pair)}
              options={pairs.map((option) => ({
                value: toPairKey(option),
                title: getReleaseLabel(option.ormVersion),
                name: getReleaseChoiceName(option),
                body: formatPairText(option.ormVersion, option.kitVersion),
                tag: option.badge ? "Newest" : undefined,
              }))}
              onChange={(value) => {
                onPairChange(value);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </fieldset>
      <label
        className={cn(
          "flex min-h-touch cursor-pointer items-center gap-2.5 border-t border-border bg-surface-2 px-3 py-2.5",
          !effectOption && "cursor-default",
        )}
      >
        <PlusIcon className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={effectLabel} className="font-medium">
            Effect 4
          </span>
          <span className="text-[12px] text-muted">
            {effectOption ? "Write your queries with Effect." : `Not available on ${label} ${pair.ormVersion}.`}
          </span>
        </span>
        <Switch
          aria-labelledby={effectLabel}
          checked={withEffect && effectOption !== undefined}
          disabled={!effectOption}
          onCheckedChange={onEffectChange}
        />
      </label>
    </div>
  );
}

/** Reads the project import machine: whether a file is importing, and why the last one failed. */
function useImportState() {
  const state = useProjectImportSelector((snapshot) => snapshot);

  return {
    busy: !state.matches("idle") && !state.matches("failed"),
    failed: state.matches("failed"),
    error: state.context.error,
    fileName: state.context.file?.name,
  };
}

/** Whether a drag carries files, rather than text or a link. */
function carriesFiles(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.types.includes("Files");
}

/** Drop a JSON export anywhere on the dialog to import it; `dragging` shows the drop overlay. */
function useImportDrop() {
  const importer = useProjectImportActorRef();
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  return {
    dragging,
    enter: (event: DragEvent<HTMLElement>) => {
      if (carriesFiles(event)) {
        depth.current += 1;
        setDragging(true);
      }
    },
    over: (event: DragEvent<HTMLElement>) => {
      if (carriesFiles(event)) {
        event.preventDefault();
      }
    },
    leave: (event: DragEvent<HTMLElement>) => {
      if (carriesFiles(event)) {
        depth.current = Math.max(0, depth.current - 1);
        setDragging(depth.current > 0);
      }
    },
    drop: (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event)) {
        return;
      }

      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = event.dataTransfer.files[0];

      if (file) {
        importer.send({ type: "file.pick", file });
      }
    },
  };
}

/** "Import file" in the header: picks a JSON export or backup. The project import machine reads and saves it. */
function ImportFileButton() {
  const importer = useProjectImportActorRef();
  const { busy } = useImportState();

  return (
    <Hint content="Import a .json export or backup. You can also drop it on this dialog.">
      <label
        className={cn(
          "relative mt-1 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[13px] font-medium hover:bg-surface-2 max-phone:after:absolute max-phone:after:inset-x-0 max-phone:after:-inset-y-1",
          "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-text",
          busy && "pointer-events-none opacity-50",
        )}
      >
        <UploadIcon className="size-3.5 text-muted" aria-hidden="true" />
        Import file
        <input
          className="sr-only"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];

            event.target.value = "";

            if (file) {
              importer.send({ type: "file.pick", file });
            }
          }}
        />
      </label>
    </Hint>
  );
}

/** The import's progress or failure under the description; nothing while idle. */
function ImportStatus() {
  const { busy, failed, error, fileName } = useImportState();

  if (busy) {
    return <output className="truncate text-[12.5px] text-muted">Importing {fileName ?? "project file"}…</output>;
  }

  if (failed) {
    return (
      <span className="text-[12.5px] text-err" role="alert">
        {error}
      </span>
    );
  }

  return null;
}
