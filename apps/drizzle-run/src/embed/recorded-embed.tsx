import type { RecordedRunResult } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { useRunController } from "@drizzle-run/react";
import { RunProvider } from "@drizzle-run/react";
import { CircleDotIcon } from "lucide-react";
import { useLayoutEffect, useState } from "react";

import { buttonVariants } from "../components/ui/button";
import { resolveDiagnosticFile } from "../editor/diagnostics";
import { formatLongDate } from "../lib/dates";
import { cn } from "../lib/utils";
import { embedViews } from "../project/project-view";
import { orderProjectFiles, type OneVersionProject } from "../project/projects";
import { AppHeader } from "../shell/app-header";
import { CodePreview } from "../ui/code-preview";
import { FileTabs } from "../ui/file-tabs";
import { OutputPanel } from "../ui/output-panel";

/** Why the embed shows a recording instead of running: the host page, or the browser itself, cannot run it. */
export type RecordedReason = "embedding_context_unsupported" | "browser_unsupported";

/** Who recorded the run: a share's author, or Drizzle Run for its official examples and guides. */
export type RecordedBy = "author" | "drizzle-run";

/** Code lines the recorded code shows before it scrolls. */
const MAX_CODE_LINES = 14;
/** The preview's line height and its padding, in px, as `CodePreview` draws it. */
const CODE_LINE_PX = 26;
const CODE_PADDING_PX = 24 + 10;

/**
 * Show a recorded run in a run machine
 *
 * Replays `result` once into a run machine of its own, so the existing output views show it as a settled run with no
 * runtime.
 */
export function useReplayedRun({
  manifest,
  revision,
  result,
}: {
  manifest: RunManifest;
  /** The project revision the output belongs to, so it never reads as stale. */
  revision: number;
  result: RecordedRunResult;
}) {
  const execution = useRunController();

  useLayoutEffect(() => {
    if (execution.getState().history.length === 0) {
      execution.replay({ submission: { manifest, revision, debug: false }, result });
    }
  }, [execution, manifest, revision, result]);

  return execution;
}

/** "Run in a new tab", where the shared link runs; drawn like Run. */
export function RunInNewTabLink({ href }: { href: string }) {
  return (
    <a
      className={cn(buttonVariants({ variant: "run", size: "run" }), "no-underline")}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      Run in a new tab ↗
    </a>
  );
}

/** The note that says whose run this is, when it ran, and why it is not live. */
export function RecordedNote({
  recordedAt,
  reason,
  recordedBy,
}: {
  recordedAt: string;
  reason: RecordedReason;
  recordedBy: RecordedBy;
}) {
  const whose = recordedBy === "author" ? "the author's run" : "a recorded run";

  return (
    <p
      className="m-0 flex shrink-0 items-start gap-2 border-b border-border bg-surface px-3.5 py-2 text-[13px]/[1.5] text-muted"
      role="note"
    >
      <CircleDotIcon className="mt-0.75 size-3.5 shrink-0 text-accent-text" aria-hidden="true" />
      <span>
        <span className="font-medium text-text">
          Recorded by {recordedBy === "author" ? "the author" : "Drizzle Run"} · {formatLongDate(recordedAt)}.
        </span>{" "}
        {reason === "embedding_context_unsupported"
          ? `This page can't run it live, so you see ${whose}.`
          : `This browser can't run Drizzle Run, so you see ${whose}.`}
      </span>
    </p>
  );
}

export interface RecordedEmbedProps {
  project: OneVersionProject;
  result: RecordedRunResult;
  recordedAt: string;
  reason: RecordedReason;
  recordedBy: RecordedBy;
  /** The full playground, which runs the code in its own tab. */
  playgroundHref: string;
}

/**
 * A one-version embed that cannot run in its page: the read-only code and its recorded run in the embed's
 * Results, Story and SQL. It loads no editor and no runtime. Run becomes "Run in a new tab" when only the page is
 * the problem.
 */
export function RecordedEmbed({ project, result, recordedAt, reason, recordedBy, playgroundHref }: RecordedEmbedProps) {
  const manifest = project.manifest;
  const files = orderProjectFiles(manifest, manifest.entrypoints.seed);
  const [selected, setSelected] = useState(manifest.entrypoints.run ?? manifest.entrypoints.schema);
  const execution = useReplayedRun({ manifest, revision: project.revision, result });
  const code = manifest.files[selected] ?? "";
  const codeLines = Math.min(
    Math.max(...Object.values(manifest.files).map((content) => content.split("\n").length)),
    MAX_CODE_LINES,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader
        logo={false}
        compact
        tabs={<FileTabs files={files} selected={selected} onSelect={setSelected} />}
        actions={
          <>
            <a
              className="text-[13px] font-medium whitespace-nowrap text-accent-text hover:text-text"
              href={playgroundHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open full playground
            </a>
            {reason === "embedding_context_unsupported" && <RunInNewTabLink href={playgroundHref} />}
          </>
        }
      />
      <section
        className="flex shrink-0 flex-col border-b border-border bg-code"
        style={{ height: codeLines * CODE_LINE_PX + CODE_PADDING_PX }}
        aria-label="Code, read only"
      >
        <CodePreview code={code} />
      </section>
      <RecordedNote recordedAt={recordedAt} reason={reason} recordedBy={recordedBy} />
      <div className="flex min-h-70 flex-1 flex-col">
        <RunProvider controller={execution}>
          <OutputPanel
            revision={project.revision}
            framed={false}
            runPicker={false}
            views={embedViews}
            onDiagnostic={(diagnostic) => {
              const path = resolveDiagnosticFile(diagnostic.source, Object.keys(manifest.files));

              if (path !== undefined) {
                setSelected(path);
              }
            }}
          />
        </RunProvider>
      </div>
    </div>
  );
}
