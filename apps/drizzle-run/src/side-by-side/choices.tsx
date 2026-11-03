import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  compareVersions,
  DIALECT_IDS,
  DIALECTS,
  DialectSchema,
  hasGuestFlavor,
  listSupportedTuples,
  type Dialect,
  type GuestFlavor,
  type SupportedRuntimeTuple,
} from "@drizzle-run/core/catalog";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import type { KeyboardEvent, ReactNode } from "react";

import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { cn } from "../lib/utils";
import { describeBlockedRelease, formatPairText, getReleaseLabel, toReleaseChoiceKey } from "../ui/release-options";

/** One radio row: its value, title, and optional body and tag. */
export interface OptionRow<Value extends string> {
  value: Value;
  title: ReactNode;
  /** The spoken name, when the title is not plain text. */
  name?: string;
  body?: ReactNode;
  tag?: ReactNode;
  disabled?: boolean;
}

/** Props of a radio group of option rows. */
export interface OptionRowsProps<Value extends string> {
  label: ReactNode;
  value: Value | "";
  options: readonly OptionRow<Value>[];
  onChange: (value: Value) => void;
  /** Two columns, as the New project dialog lays out its file choices. */
  columns?: boolean;
  /** 40 px rows for a pair, roomier ones for a choice with a body. */
  dense?: boolean;
  className?: string;
  /** Key presses in the group, such as Enter on a row to submit the form. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Select an option from radio rows with optional detail and tags.
 */
export function OptionRows<Value extends string>({
  label,
  value,
  options,
  onChange,
  columns = false,
  dense = false,
  className,
  onKeyDown,
}: OptionRowsProps<Value>) {
  return (
    <fieldset className={cn("m-0 grid gap-1 border-0 p-0", className)}>
      <legend className="mb-1.5 p-0 text-[12.5px] font-semibold">{label}</legend>
      <RadioGroup
        className={cn("grid gap-1", columns && "grid-cols-2 gap-2.5 max-phone:grid-cols-1")}
        value={value}
        onKeyDown={onKeyDown}
        onValueChange={(next) => {
          const picked = options.find((option) => option.value === next && !option.disabled);

          if (picked) {
            onChange(picked.value);
          }
        }}
      >
        {options.map((option) => {
          const checked = option.value === value;

          return (
            <label
              key={option.value}
              className={cn(
                "grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] gap-2.5 rounded-[9px] border border-border bg-surface px-2.5 text-text",
                dense ? "min-h-10 items-center" : "items-start py-2.25",
                checked && "border-[1.5px] border-run-border bg-mark",
                option.disabled && "cursor-default opacity-50",
              )}
            >
              <RadioGroupItem
                value={option.value}
                disabled={option.disabled}
                aria-label={option.name}
                className={cn(!dense && "mt-0.5")}
              />
              <span className="min-w-0">
                <span className={cn("text-[13px] font-semibold", !dense && "block")}>{option.title}</span>
                {option.body !== undefined &&
                  (dense ? (
                    <>
                      {" "}
                      <span className="font-mono text-[11.5px] text-muted">{option.body}</span>
                    </>
                  ) : (
                    <span className="mt-0.5 block text-[12px] leading-[1.4] text-muted">{option.body}</span>
                  ))}
              </span>
              <span className="text-[11.5px] text-muted">{option.tag}</span>
            </label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}

/** A pair in one guest flavor, as the side-by-side rows offer it. `key` is the row's radio value. */
export interface CatalogChoice {
  key: string;
  tuple: SupportedRuntimeTuple;
  guestFlavor: GuestFlavor;
}

/** Every pair the catalog runs for this database, newest first, each followed by its Effect choice when it ships one. */
export function listCatalogChoices(target: RunManifestTarget): readonly CatalogChoice[] {
  const pairs = [...listSupportedTuples(target)].toSorted((left, right) =>
    compareVersions(right.ormVersion, left.ormVersion),
  );

  return pairs.flatMap((tuple) => {
    const flavors: GuestFlavor[] = hasGuestFlavor(tuple, "effect") ? ["slim", "effect"] : ["slim"];

    return flavors.map((guestFlavor) => ({
      key: toReleaseChoiceKey({ tupleId: tuple.id, guestFlavor }),
      tuple,
      guestFlavor,
    }));
  });
}

/** A pair as a radio row: its line, "+ Effect" on an Effect choice, then "orm … · kit …". */
export function toPairRow(
  { key, tuple, guestFlavor }: CatalogChoice,
  tag?: ReactNode,
  disabled?: boolean,
): OptionRow<string> {
  const label = getReleaseLabel(tuple.ormVersion);
  const pair = formatPairText(tuple.ormVersion, tuple.kitVersion);
  const effect = guestFlavor === "effect";

  return {
    value: key,
    title: effect ? `${label} + Effect` : label,
    name: effect ? `${label}, ${pair}, with Effect 4` : `${label}, ${pair}`,
    body: pair,
    tag,
    disabled,
  };
}

/**
 * The ways to start a side-by-side project's files, as New project and Fork word them
 *
 * `sharing` is "cross_line" for a Legacy side next to a v1 side, which share only the seed, so "Shared files" is
 * disabled; and "cross_database" for sides on two databases, which share every file but the schema.
 */
export function buildFilesStartRows(
  wording: "new" | "fork",
  seed: string,
  perSide: readonly string[],
  sharing: "allowed" | "cross_line" | "cross_database",
): OptionRow<"separate" | "shared">[] {
  const copies = `${perSide.join(" and ")} get a copy per side`;

  return [
    {
      value: "separate",
      title: "Separate files",
      body:
        wording === "fork"
          ? `${copies}, so you edit one side without touching the other. ${seed} stays shared.`
          : `${copies}. ${seed} stays shared.`,
    },
    {
      value: "shared",
      title: "Shared files",
      body:
        sharing === "cross_line"
          ? "Not for Legacy next to RC: each side writes its own code."
          : sharing === "cross_database"
            ? "One set of files: an edit on one side shows on the other. Each side keeps its own schema for its database."
            : wording === "fork"
              ? "One set of files for both sides: an edit on one side shows on the other. Split a file later if one side needs a change."
              : "One set of files: an edit on one side shows on the other.",
      disabled: sharing === "cross_line",
    },
  ];
}

export interface DatabasePickerProps {
  /** The group's spoken name, such as "Database of the new side". */
  label: string;
  value: Dialect;
  onChange: (dialect: Dialect) => void;
  /** Key presses in the group, such as Enter to submit the form. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

/** A segmented choice between the databases, as New project and Fork pick a side's database. */
export function DatabasePicker({ label, value, onChange, onKeyDown }: DatabasePickerProps) {
  return (
    <RadioGroup
      aria-label={label}
      onKeyDown={onKeyDown}
      className="grid h-9 grid-cols-2 gap-0.5 rounded-md bg-surface-2 p-0.75"
      value={value}
      onValueChange={(next) => {
        const chosen = DialectSchema.safeParse(next);

        if (chosen.success) {
          onChange(chosen.data);
        }
      }}
    >
      {DIALECT_IDS.map((dialect) => (
        <DatabaseSegment key={dialect} value={dialect}>
          {DIALECTS[dialect].shortName}
        </DatabaseSegment>
      ))}
    </RadioGroup>
  );
}

/** One database in a segmented database choice. */
export function DatabaseSegment({ value, children }: { value: Dialect; children: string }) {
  return (
    <RadioPrimitive.Root
      value={value}
      className="relative inline-flex min-w-0 items-center justify-center rounded-sm border-0 bg-transparent px-2 text-[13px] font-normal text-muted after:absolute after:inset-x-0 after:-inset-y-1.25 hover:text-text data-checked:bg-segment data-checked:font-semibold data-checked:text-segment-fg"
    >
      {children}
    </RadioPrimitive.Root>
  );
}

export interface BlockedReleaseNotesProps {
  /** Why each disabled row's pair cannot run the files, by row; undefined for a row that can. */
  reasons: ReadonlyMap<string, string | undefined>;
}

/** The reasons under a list of pair rows, one per pair that cannot run the files, so a disabled row says why. */
export function BlockedReleaseNotes({ reasons }: BlockedReleaseNotesProps) {
  const notes = [...new Set(reasons.values())].filter((reason) => reason !== undefined);

  if (notes.length === 0) {
    return null;
  }

  return (
    <ul className="m-0 grid list-none gap-1 p-0 px-0.5 text-[12px] leading-[1.4] text-muted">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/** Why each choice's pair cannot run a project's imports, by choice key; undefined for a choice that can. */
export function listBlockedChoices(
  choices: readonly CatalogChoice[],
  imports: readonly string[],
): ReadonlyMap<string, string | undefined> {
  return new Map(
    choices.map((choice) => [choice.key, describeBlockedRelease(choice.tuple, choice.guestFlavor, imports)]),
  );
}
