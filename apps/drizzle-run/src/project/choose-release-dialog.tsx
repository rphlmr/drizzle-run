import { listSupportedTuples } from "@drizzle-run/core/catalog";
import { RunManifestValidationError, type RetiredPair } from "@drizzle-run/core/manifest";
import { pairSideLabel, PairManifestValidationError, type PairSideIndex } from "@drizzle-run/core/pair";
import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { isEnterOnRadio } from "../components/ui/radio-group";
import { getErrorText } from "../lib/error-text";
import { cn } from "../lib/utils";
import { AutoHeight } from "../ui/auto-height";
import { fieldClass, FieldError, FieldNote } from "../ui/field";
import { ReleaseChoices, toPairKey } from "../ui/release-choices";
import { buildReleaseOptions, isUnavailableRelease, type ReleaseChoice } from "../ui/release-options";
import { listMovablePairs, splitsSharedFiles, type RetiredPairProject, type RetiredRelease } from "./projects";

export interface ChooseReleaseDialogProps {
  project: Pick<RetiredPairProject, "id" | "name" | "manifest" | "releases">;
  /** One choice per release the project lists. Throws when the project cannot move; the message is shown. */
  onChoose: (choices: readonly ReleaseChoice[]) => void;
  /** Leaves the stored project untouched, so the question comes back on the next visit; or skips an imported one. */
  onLater: () => void;
  /** The dismiss button's text: "Later" for a stored project. */
  laterLabel?: string;
}

/** The release dialogs: New project and Choose a Drizzle release. */
export const releaseDialogClass = cn(
  "max-h-[calc(100dvh-32px)] w-[min(460px,calc(100vw-24px))] overflow-y-auto rounded-[18px] bg-bg p-6 max-phone:w-[min(460px,calc(100vw-24px))]",
);
export const releaseFormClass = cn("flex flex-col gap-[18px] text-[14px]");
export const releaseTitleClass = cn("text-[24px] font-extrabold tracking-[-0.02em]");
export const releaseDescriptionClass = cn("mt-1.5 mb-0");
export const releaseFooterClass = cn("mt-1");

function formatPairText(pair: RetiredPair) {
  return `orm ${pair.ormVersion} · kit ${pair.kitVersion}`;
}

function formatSide(release: RetiredRelease & { side: PairSideIndex }) {
  return `side ${release.side + 1} (${release.name ?? pairSideLabel(release.ormVersion)})`;
}

function formatReleasesText(releases: readonly RetiredRelease[]) {
  return releases
    .map((release) =>
      release.side === undefined
        ? formatPairText(release)
        : `${formatPairText(release)} on ${formatSide({ ...release, side: release.side })}`,
    )
    .join(" and ");
}

/** Asks which supported Drizzle release a project on a retired pair should move to. */
export function ChooseReleaseDialog({ project, onChoose, onLater, laterLabel = "Later" }: ChooseReleaseDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onLater();
        }
      }}
    >
      <DialogContent className={releaseDialogClass}>
        <AutoHeight>
          <ChooseReleaseForm
            key={project.id}
            manifest={project.manifest}
            releases={project.releases}
            header={
              <DialogHeader>
                <DialogTitle className={releaseTitleClass}>Choose a Drizzle release</DialogTitle>
                <DialogDescription className={releaseDescriptionClass}>
                  “{project.name}” uses {formatReleasesText(project.releases)}, which Drizzle Run no longer ships. Pick
                  a tested pair to keep working on it. Your code stays the same.
                </DialogDescription>
              </DialogHeader>
            }
            submitLabel="Use this release"
            secondary={
              <Button variant="outline" type="button" onClick={onLater}>
                {laterLabel}
              </Button>
            }
            onChoose={onChoose}
          />
        </AutoHeight>
      </DialogContent>
    </Dialog>
  );
}

export interface ChooseReleasePanelProps {
  /** The shared playground's name. */
  name: string;
  /** The playground's manifest as published, on its removed pairs. */
  manifest: unknown;
  /** The removed pairs of the playground as published, from `listRetiredReleases`. */
  releases: readonly RetiredRelease[];
  secondary?: ReactNode;
  /** One choice per release. Throws when the playground cannot open on them; the message is shown in the panel. */
  onChoose: (choices: readonly ReleaseChoice[]) => void;
}

/** The same choice as a page section, for shared links and embeds that cannot open as published. */
export function ChooseReleasePanel({ name, manifest, releases, secondary, onChoose }: ChooseReleasePanelProps) {
  const titleId = useId();

  return (
    <section
      className="w-[min(460px,100%)] rounded-[18px] border border-border bg-surface p-6 text-left shadow-pop"
      aria-labelledby={titleId}
    >
      <ChooseReleaseForm
        manifest={manifest}
        releases={releases}
        header={
          <div>
            <h1 id={titleId} className={cn("font-display", releaseTitleClass)}>
              Choose a Drizzle release
            </h1>
            <p className="mt-1.5! max-w-none! leading-[1.6] text-muted">
              “{name}” was shared with {formatReleasesText(releases)}. Drizzle Run no longer ships{" "}
              {releases.length > 1 ? "those pairs" : "that pair"}, so it can't run as published. Pick a tested pair to
              open it. The code stays the same.
            </p>
          </div>
        }
        submitLabel="Open with this release"
        secondary={secondary}
        onChoose={onChoose}
      />
    </section>
  );
}

/**
 * Get the sentence a failed choice shows
 *
 * A manifest validation error lists its issues after a path such as `$["files"]["schema.ts"]`, which means nothing to
 * a reader; the issue messages alone say what is wrong.
 */
function toChoiceError(cause: unknown): string {
  if (cause instanceof PairManifestValidationError || cause instanceof RunManifestValidationError) {
    return `These releases cannot open this project. ${cause.issues.map((issue) => issue.message).join(" ")}`;
  }

  return getErrorText(cause);
}

interface ChooseReleaseFormProps {
  manifest: unknown;
  releases: readonly RetiredRelease[];
  header: ReactNode;
  submitLabel: string;
  secondary?: ReactNode;
  onChoose: (choices: readonly ReleaseChoice[]) => void;
}

function ChooseReleaseForm({ manifest, releases, header, submitLabel, secondary, onChoose }: ChooseReleaseFormProps) {
  const [chosenPairs, setChosenPairs] = useState<ReadonlyMap<number, string>>(() => new Map());
  const [error, setError] = useState("");
  const releaseLabel = useId();
  const form = useRef<HTMLFormElement>(null);
  const pickers = useMemo(
    () =>
      releases.map((release, index) => {
        const movablePairs = listMovablePairs(release.manifest, release.target);
        const options = buildReleaseOptions(
          release.target,
          release,
          movablePairs.length > 0 ? movablePairs : listSupportedTuples(release.target),
        );
        const suggested = isUnavailableRelease(options.current) ? options.current.suggested : options.current;
        const selected =
          [...options.lines, ...options.others].find((option) => toPairKey(option) === chosenPairs.get(index)) ??
          suggested;
        const label =
          release.side === undefined
            ? "Drizzle release"
            : `Release for ${formatSide({ ...release, side: release.side })}`;

        return { index, label, options, selected };
      }),
    [releases, chosenPairs],
  );
  const choices = useMemo(
    () => pickers.map(({ selected }) => ({ tupleId: selected.tupleId, guestFlavor: selected.guestFlavor })),
    [pickers],
  );
  const splitsFiles = useMemo(() => splitsSharedFiles(manifest, releases, choices), [manifest, releases, choices]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      onChoose(choices);
    } catch (cause) {
      setError(toChoiceError(cause));
    }
  };

  const submitOnRadioEnter = (event: KeyboardEvent<HTMLElement>) => {
    if (isEnterOnRadio(event)) {
      event.preventDefault();
      form.current?.requestSubmit();
    }
  };

  return (
    <form ref={form} className={releaseFormClass} onSubmit={submit}>
      {header}
      {pickers.map(({ index, label, options, selected }) => (
        <div key={index} className={fieldClass}>
          <span id={`${releaseLabel}-${index}`}>{label}</span>
          <ReleaseChoices
            onKeyDown={submitOnRadioEnter}
            labelId={`${releaseLabel}-${index}`}
            options={options}
            selected={selected}
            onSelect={(key) => {
              setChosenPairs((chosen) => new Map(chosen).set(index, key));
              setError("");
            }}
          />
        </div>
      ))}
      <FieldNote>APIs differ between Legacy and RC, so some code may need changes.</FieldNote>
      {splitsFiles && (
        <FieldNote>Legacy next to RC shares only seed.ts, so the other shared files get a copy per side.</FieldNote>
      )}
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter className={releaseFooterClass}>
        {secondary}
        <Button type="submit" variant="sticker">
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
