import { useActorRef, useSelector } from "@xstate/react";
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";

import { useAppServices } from "../app-services";
import { Skeleton } from "../components/ui/skeleton";
import { getRuntimePolicy } from "../lib/runtime-policy";
import { cn } from "../lib/utils";
import { ChooseReleasePanel } from "../project/choose-release-dialog";
import { ProjectView } from "../project/project-view";
import { isOneVersion } from "../project/projects";
import { SideBySideEmbed } from "../side-by-side/side-by-side-embed";
import { VolatileProjectStorage } from "../store/storage";
import { CapabilityMessage } from "../ui/capability-message";
import { createEmbedBridge } from "./bridge";
import { getEmbedFailureTitle } from "./embed-failure";
import { createEmbedLoadMachine } from "./embed-load-machine";
import { createOfficialSource, createSnapshotSource, type EmbedSource } from "./embed-source";
import { RecordedEmbed } from "./recorded-embed";
import { toEmbedRunSummary } from "./run-summary";

async function createRuntime() {
  const browser = await import("@drizzle-run/runtime/browser");

  return browser.createBrowserRuntime({ preparation: getRuntimePolicy(globalThis.navigator).preparation });
}

/** The `/embed/:snapshotId` page: a published snapshot in an embeddable workspace. */
export function EmbedSnapshot() {
  const { snapshotId = "" } = useParams();
  const { playgrounds, recordedRuns } = useAppServices();
  const source = useMemo(
    () => createSnapshotSource({ snapshotId, playgrounds, recordedRuns }),
    [snapshotId, playgrounds, recordedRuns],
  );

  return <EmbedWorkspace key={snapshotId} source={source} />;
}

/**
 * The `/embed/examples/:example` and `/embed/examples/:example/:step` pages: an official example, or one step of its
 * guide, in an embeddable workspace.
 */
export function EmbedOfficialExample() {
  const { example = "", step } = useParams();
  const source = useMemo(
    () => createOfficialSource(step === undefined ? { example } : { example, step }),
    [example, step],
  );

  return <EmbedWorkspace key={`${example}/${step ?? ""}`} source={source} />;
}

function EmbedWorkspace({ source }: { source: EmbedSource }) {
  const { playgroundHref } = source;
  const [storage] = useState(() => new VolatileProjectStorage());
  const [bridge] = useState(() => createEmbedBridge(source.target));
  const [embedLoadMachine] = useState(() =>
    createEmbedLoadMachine({
      source,
      createRuntime,
      post: (connection, event) => bridge.post(connection, event),
      postUnsupportedHost: (nonce) => bridge.postUnsupportedHost(nonce),
    }),
  );
  const embed = useActorRef(embedLoadMachine);
  const state = useSelector(embed, (snapshot) => snapshot);
  const { runtime, capabilities, recorded, project, retired, failure } = state.context;

  useLayoutEffect(() => {
    bridge.start({
      onConnect: (connection) => embed.send({ type: "parent.connect", connection }),
      onOpaqueConnect: (nonce) => embed.send({ type: "parent.connect.opaque", nonce }),
    });

    return () => bridge.dispose();
  }, [bridge, embed]);

  const reportUnexpectedError = (message: string) => embed.send({ type: "embed.fail", message });

  if (state.matches("failed") && failure) {
    return (
      <EmbedMessage
        title={getEmbedFailureTitle(failure)}
        message={failure.message}
        link={
          failure.code === "not_found"
            ? { href: "/examples", label: "Browse examples" }
            : { href: playgroundHref, label: "Open full playground" }
        }
      />
    );
  }

  if (
    !runtime ||
    !capabilities ||
    state.matches("preparing") ||
    state.matches("checking") ||
    state.matches("findingRecorded") ||
    state.matches("loading")
  ) {
    return (
      <EmbedShell>
        <main className={embedLoadingClass}>
          <Skeleton className="h-7 w-56" />
          <output className="block">Preparing this playground…</output>
        </main>
      </EmbedShell>
    );
  }

  if (state.matches("recorded") && recorded !== undefined) {
    return (
      <EmbedShell>
        <ReportShown embed={embed} />
        {recorded.kind === "one_version" ? (
          <RecordedEmbed
            project={recorded.project}
            result={recorded.result}
            recordedAt={recorded.recordedAt}
            reason={recorded.reason}
            recordedBy={recorded.recordedBy}
            playgroundHref={playgroundHref}
          />
        ) : (
          <SideBySideEmbed
            project={recorded.project}
            playgroundHref={playgroundHref}
            runtime={runtime}
            recorded={{
              sides: recorded.sides,
              recordedAt: recorded.recordedAt,
              reason: recorded.reason,
              recordedBy: recorded.recordedBy,
            }}
          />
        )}
      </EmbedShell>
    );
  }

  if (state.matches("unavailable")) {
    return (
      <main className={embedMessageClass}>
        <CapabilityMessage
          capabilities={capabilities}
          surface="embed"
          openHref={playgroundHref}
          onRetry={() => window.location.reload()}
        />
      </main>
    );
  }

  if (state.matches("choosingRelease") && retired) {
    return (
      <EmbedShell>
        <ReportShown embed={embed} />
        <main className={embedMessageClass}>
          <ChooseReleasePanel
            name={retired.playground.snapshot.name}
            manifest={retired.playground.snapshot.manifest}
            releases={retired.releases}
            onChoose={(choices) => embed.send({ type: "release.choose", choices })}
          />
        </main>
      </EmbedShell>
    );
  }

  if (!project) {
    return (
      <EmbedMessage
        title="Could not load this playground"
        message="The shared playground could not be loaded."
        link={{ href: playgroundHref, label: "Open full playground" }}
      />
    );
  }

  if (!isOneVersion(project)) {
    return (
      <EmbedShell>
        <ReportShown embed={embed} />
        <SideBySideEmbed
          project={project}
          playgroundHref={playgroundHref}
          runtime={runtime}
          onRunSettled={(settled, side) => embed.send({ type: "run.settled", run: toEmbedRunSummary(settled, side) })}
        />
      </EmbedShell>
    );
  }

  return (
    <EmbedShell>
      <ReportShown embed={embed} />
      <ProjectView
        project={project}
        storage={storage}
        update={(next) => embed.send({ type: "project.update", project: next })}
        saveState="read_only"
        warnOnLeave={false}
        readOnly="This embed is read only. Open the full playground to edit the code."
        reportError={reportUnexpectedError}
        onRunSettled={(settled) => embed.send({ type: "run.settled", run: toEmbedRunSummary(settled) })}
        compact
        projectActions={false}
        headerActions={
          <a
            className="text-[13px] font-medium whitespace-nowrap text-accent-text hover:text-text"
            href={playgroundHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open full playground
          </a>
        }
        runtime={runtime}
      />
    </EmbedShell>
  );
}

const embedShellClass = cn("flex h-dvh flex-col overflow-hidden rounded-[16px] border border-border bg-bg");
const embedContentClass = cn("flex min-h-0 flex-1 flex-col overflow-y-auto");
const embedLoadingClass = cn(
  "flex min-h-[280px] flex-col items-center justify-center gap-4 p-6 text-center text-muted",
);

/** Its paragraph rule also reaches the capability message and the release panel inside it. */
const embedMessageClass = cn(
  "flex min-h-70 flex-col items-center justify-center gap-4 p-6 text-center",
  "[&>h1]:m-0 [&>h1]:font-display [&>h1]:text-[20px] [&>h1]:font-bold",
  "[&_p]:m-0 [&_p]:max-w-105 [&_p]:leading-[1.6] [&_p]:text-muted",
);

/**
 * Tell the embed load machine the view has painted
 *
 * Two animation frames after the commit, the browser has painted it, so the parent page reveals a filled frame, not a
 * blank one while a heavy view such as the editor still renders.
 */
function ReportShown({ embed }: { embed: { send(event: { type: "view.shown" }): void } }) {
  useEffect(() => {
    let frameId = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(() => embed.send({ type: "view.shown" }));
    });

    return () => cancelAnimationFrame(frameId);
  }, [embed]);

  return null;
}

/**
 * The embed's frame
 *
 * The shell fills the iframe, whose height is the loader's default or the host container's, and its content scrolls
 * inside.
 */
function EmbedShell({ children }: { children: ReactNode }) {
  return (
    <div className={embedShellClass}>
      <div className={embedContentClass}>{children}</div>
    </div>
  );
}

function EmbedMessage({
  title,
  message,
  link,
}: {
  title: string;
  message: string;
  link: { href: string; label: string };
}) {
  return (
    <main className={embedMessageClass}>
      <h1>{title}</h1>
      <p>{message}</p>
      <a
        className="text-[13px] font-medium text-accent-text hover:text-text"
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {link.label}
      </a>
    </main>
  );
}
