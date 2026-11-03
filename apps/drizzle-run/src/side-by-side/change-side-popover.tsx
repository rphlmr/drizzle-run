import {
  DIALECTS,
  releaseLineOf,
  resolveGuestFlavor,
  type Dialect,
  type GuestFlavor,
  type RuntimeTupleId,
} from "@drizzle-run/core/catalog";
import { listProjectImports } from "@drizzle-run/core/manifest";
import {
  otherSide,
  PAIR_SEED_PATH,
  pairSide,
  pairSideName,
  type PairManifest,
  type PairSideFiles,
  type PairSideIndex,
} from "@drizzle-run/core/pair";
import { useState, type ReactElement, type RefObject } from "react";

import { Button } from "../components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "../components/ui/drawer";
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { getSideTuples } from "../project/projects";
import { toReleaseChoiceKey } from "../ui/release-options";
import {
  BlockedReleaseNotes,
  DatabasePicker,
  listBlockedChoices,
  listCatalogChoices,
  OptionRows,
  toPairRow,
} from "./choices";
import { getSideRelease } from "./side-labels";

/** Props of the popover that changes one side's pair. */
export interface ChangeSidePopoverProps {
  manifest: PairManifest;
  side: PairSideIndex;
  /** The pair button that opens the popover. */
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (tupleId: RuntimeTupleId, files: PairSideFiles, guestFlavor: GuestFlavor) => void;
}

/** Move one side to another release pair or database, keeping, copying or sharing its files. */
export function ChangeSidePopover({ manifest, side, trigger, open, onOpenChange, onConfirm }: ChangeSidePopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        sideOffset={12}
        alignOffset={44}
        className="grid w-100 max-w-[calc(100vw-32px)] gap-3 rounded-lg border-[1.5px] border-card-border bg-bg p-3.5 shadow-sticker-lg"
      >
        <ChangeSideForm manifest={manifest} side={side} onConfirm={onConfirm} surface="popover" />
      </PopoverContent>
    </Popover>
  );
}

export type ChangeSideSheetProps = Omit<ChangeSidePopoverProps, "trigger"> & {
  /** Where focus goes when the sheet closes, when what opened it is gone, such as a menu item. */
  returnFocus?: RefObject<HTMLElement | null>;
};

/** The same choice as a bottom sheet, for phones, whose sides show no pane head to open the popover from. */
export function ChangeSideSheet({ manifest, side, open, onOpenChange, onConfirm, returnFocus }: ChangeSideSheetProps) {
  const [shownSide, setShownSide] = useState(side);

  if (open && side !== shownSide) {
    setShownSide(side);
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[86%] rounded-t-[18px] border-[1.5px] border-b-0 border-card-border px-4 pt-2 pb-5"
        finalFocus={() => (returnFocus?.current?.isConnected === true ? returnFocus.current : true)}
      >
        <span className="mt-0.5 mb-2 h-1 w-9 shrink-0 self-center rounded-full bg-border" aria-hidden="true" />
        <div className="grid gap-3">
          <ChangeSideForm manifest={manifest} side={open ? side : shownSide} onConfirm={onConfirm} surface="sheet" />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ChangeSideForm({
  manifest,
  side,
  onConfirm,
  surface,
}: Pick<ChangeSidePopoverProps, "manifest" | "side" | "onConfirm"> & { surface: "popover" | "sheet" }) {
  const tuples = getSideTuples(manifest);
  const own = tuples[side];
  const other = tuples[otherSide(side)];
  const ownFlavor = resolveGuestFlavor(manifest.sides[side]);
  const ownKey = toReleaseChoiceKey({ tupleId: own.id, guestFlavor: ownFlavor });
  const otherKey = toReleaseChoiceKey({
    tupleId: other.id,
    guestFlavor: resolveGuestFlavor(manifest.sides[otherSide(side)]),
  });
  const ownDialect = manifest.sides[side].target.dialect;
  const otherDialect = manifest.sides[otherSide(side)].target.dialect;
  const [dialect, setDialect] = useState<Dialect>(ownDialect);
  const [target, setTarget] = useState(ownKey);
  const [files, setFiles] = useState<PairSideFiles>("keep");
  const choices = listCatalogChoices({ dialect });
  const blocked = listBlockedChoices(choices, listProjectImports(pairSide(manifest, side).files));
  const picked =
    choices.find((choice) => choice.key === target) ??
    choices.find((choice) => choice.key === ownKey) ??
    choices.find((choice) => blocked.get(choice.key) === undefined);
  const pickedTuple = picked?.tuple ?? own;
  const pickedFlavor = picked?.guestFlavor ?? ownFlavor;
  const pickedKey = picked?.key ?? ownKey;
  const current = getSideRelease(manifest, side);
  const otherLabel = getSideRelease(manifest, otherSide(side)).label;
  const pickedShort = pairSideName({ ormVersion: pickedTuple.ormVersion, guestFlavor: pickedFlavor });
  const crossLine = pickedTuple.releaseLine !== other.releaseLine;
  const splitNote =
    crossLine && Object.keys(manifest.files).some((path) => path !== PAIR_SEED_PATH)
      ? " Shared files get a copy per side."
      : "";
  const schema = manifest.entrypoints.schema;
  const schemaDialect = (choice: PairSideFiles) =>
    choice === "keep" || dialect === ownDialect ? ownDialect : otherDialect;
  const rewriteNote = (choice: PairSideFiles) =>
    schemaDialect(choice) === dialect
      ? ""
      : ` ${schema} stays written for ${DIALECTS[schemaDialect(choice)].label}: its tab marks what to rewrite for ${DIALECTS[dialect].label}.`;
  const crossDatabase = dialect !== otherDialect;

  return (
    <>
      {surface === "popover" ? (
        <PopoverTitle className="m-0 text-[14px] font-[650]">Change this side’s version</PopoverTitle>
      ) : (
        <DrawerTitle className="m-0 text-[16px] font-[650]">Change this side’s version</DrawerTitle>
      )}
      <DatabasePicker
        label="Database of this side"
        value={dialect}
        onChange={(next) => {
          setDialect(next);
          setTarget(ownKey);
          setFiles("keep");
        }}
      />
      <OptionRows
        label={<span className="sr-only">Drizzle version</span>}
        dense
        value={pickedKey}
        options={choices.map((choice) =>
          toPairRow(
            choice,
            choice.key === ownKey && choice.key === otherKey
              ? "Both sides"
              : choice.key === ownKey
                ? "This side"
                : choice.key === otherKey
                  ? "Other side"
                  : undefined,
            choice.key !== ownKey && blocked.get(choice.key) !== undefined,
          ),
        )}
        onChange={(value) => {
          setTarget(value);
          setFiles("keep");
        }}
      />
      <BlockedReleaseNotes reasons={new Map([...blocked].filter(([key]) => key !== ownKey && key !== otherKey))} />
      <OptionRows<PairSideFiles>
        label="Files on this side"
        value={files}
        options={[
          {
            value: "keep",
            title: "Keep this side’s files",
            body: `${
              releaseLineOf(pickedTuple.ormVersion) === releaseLineOf(own.ormVersion)
                ? "Nothing changes in the editor."
                : `Written for ${current.short}. They may need changes to run on ${pickedShort}.`
            }${splitNote}${rewriteNote("keep")}`,
          },
          {
            value: "copy",
            title: `Copy ${otherLabel}’s files`,
            body: `Replaces this side’s files with a copy you edit here only${
              crossDatabase && dialect === ownDialect ? `, but this side keeps its own ${schema}` : ""
            }.${splitNote}${rewriteNote("copy")}`,
          },
          {
            value: "share",
            title: `Share ${otherLabel}’s files`,
            body: crossLine
              ? "Not for Legacy next to RC: each side writes its own code."
              : `One set of files for both sides: edit once, both run it.${
                  crossDatabase
                    ? ` Each side keeps its own ${schema} for its database.${rewriteNote("share")}`
                    : " Split a file later if one side needs a change."
                }`,
            disabled: crossLine,
          },
        ]}
        onChange={setFiles}
      />
      <div className="flex justify-end gap-2">
        {surface === "popover" ? (
          <PopoverClose render={<Button variant="outline" />}>Cancel</PopoverClose>
        ) : (
          <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
        )}
        <Button variant="sticker" onClick={() => onConfirm(pickedTuple.id, files, pickedFlavor)}>
          {pickedKey === ownKey
            ? `Keep ${current.short}`
            : dialect === ownDialect
              ? `Move this side to ${pickedShort}`
              : `Move this side to ${DIALECTS[dialect].shortName} ${pickedShort}`}
        </Button>
      </div>
    </>
  );
}
