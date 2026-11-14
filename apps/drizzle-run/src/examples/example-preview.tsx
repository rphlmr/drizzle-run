import { pairSide } from "@drizzle-run/core/pair";
import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { CheckIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";
import { formatProjectDialects, isPairManifest } from "../project/projects";
import { resolveExampleSides, type OfficialExample } from "./catalog";
import { getExampleCallToAction, getResumeStep } from "./gallery-model";
import { LinkList } from "./link-list";

function QueryCode({ code }: { code: string }) {
  const [colored, setColored] = useState<{ code: string; html: string }>();

  useEffect(() => {
    let current = true;
    let request = 0;

    const color = () => {
      const latest = ++request;
      setColored(undefined);
      void import("../editor/environment")
        .then((editor) => editor.colorizeCode(code, "typescript"))
        .then((html) => {
          if (current && request === latest) {
            setColored({ code, html });
          }
        })
        .catch(() => undefined);
    };

    const observer = new MutationObserver(color);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    color();

    return () => {
      current = false;
      observer.disconnect();
    };
  }, [code]);

  return colored?.code === code ? <code dangerouslySetInnerHTML={{ __html: colored.html }} /> : <code>{code}</code>;
}

/** What the quick look shows around the example: its title element and controls such as a database switch. */
export interface ExamplePreviewProps {
  example: OfficialExample;
  /** Saved progress, for a guide started in this browser. */
  progress?: GuideProgress;
  /** The title to show, such as the family title without its database. */
  title: string;
  /** Renders the title, so a dialog can name itself by it. */
  renderTitle: (title: string) => ReactNode;
  /** Shown under the description, such as the database switch of an example written for both. */
  controls?: ReactNode;
}

/** Read-only catalog details; opening the example, rather than previewing it, records a visit. */
export function ExamplePreview({ example, progress, title, renderTitle, controls }: ExamplePreviewProps) {
  const project = example.guide?.project ?? example.manifest;
  const run = isPairManifest(project) ? pairSide(project, 0) : project;
  const query = run.entrypoints.run === undefined ? undefined : run.files[run.entrypoints.run];
  const sides = resolveExampleSides(example);
  const comparison = sides?.map((side) => side.name ?? `Drizzle ${side.ormVersion}`).join(" vs ");
  const resumeStep = getResumeStep(example, progress);
  const completed = new Set(progress?.completed);

  return (
    <>
      <div
        data-slot="gallery-preview-content"
        className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-contain p-5.5 max-phone:p-5"
      >
        <p className="text-[12px] text-muted">
          {example.guide ? `Guide · ${example.guide.steps.length} steps` : "Example"} ·{" "}
          {formatProjectDialects(example.manifest)}
        </p>
        {renderTitle(title)}
        <p className="mt-3 text-[13px]/[1.7] text-muted">{example.description}</p>
        {comparison && <p className="mt-3 text-[13px] font-medium">{comparison}</p>}
        {controls && <div className="mt-4">{controls}</div>}
        {example.guide && (
          <section className="mt-6 border-t border-border pt-5" aria-label="Guide outline">
            <h3 className="mb-3 text-[13px] font-medium">What you’ll explore</h3>
            <ol className="flex flex-col gap-2.5 text-[13px] text-soft">
              {example.guide.steps.map((step, index) => {
                const done = progress?.finished === true || completed.has(step.id);
                const current = progress !== undefined && !progress.finished && resumeStep === index + 1;

                return (
                  <li key={step.id} className={cn("flex items-start gap-2.5", current && "font-medium text-text")}>
                    <span
                      className={cn(
                        "mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full border border-card-border text-[10px] font-semibold text-muted",
                        done && "border-ok bg-ok text-surface",
                        current && "border-text text-text",
                      )}
                      aria-hidden="true"
                    >
                      {done ? <CheckIcon className="size-3" /> : index + 1}
                    </span>
                    <span>
                      {step.title}
                      {done && <span className="sr-only"> (done)</span>}
                      {current && <span className="sr-only"> (current step)</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        {query !== undefined && (
          <section className="mt-6" aria-label="Query preview">
            <h3 className="mb-3 text-[13px] font-medium">
              {isPairManifest(project) ? `Starting query · ${sides?.[0].name ?? "First side"}` : "Starting query"}
            </h3>
            {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role -- The code region needs keyboard focus and arrow keys for horizontal scrolling. */}
            <pre
              className="max-w-full overflow-x-auto rounded-md border border-border bg-surface-2 p-4 font-mono text-[12px]/[1.7] [overflow-wrap:normal] whitespace-pre"
              tabIndex={0}
              role="region"
              aria-label="Starting query code"
              onKeyDown={(event) => {
                if (
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  (event.key === "ArrowLeft" || event.key === "ArrowRight")
                ) {
                  event.preventDefault();
                  event.currentTarget.scrollBy({ left: event.key === "ArrowRight" ? 40 : -40 });
                }
              }}
            >
              <QueryCode code={query} />
            </pre>
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role */}
          </section>
        )}
        {example.links.length > 0 && (
          <section className="mt-6 border-t border-border pt-5" aria-label="Related resources">
            <h3 className="mb-2 text-[13px] font-medium">Related resources</h3>
            <LinkList links={example.links} surface="panel" />
          </section>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-surface px-5.5 py-4 max-phone:px-5">
        <Link
          to={`/examples/${example.slug}`}
          className={buttonVariants({ variant: "sticker", className: "rounded-md" })}
        >
          {getExampleCallToAction(example, progress)} →
        </Link>
        <p className="mt-2 text-[12px] text-muted">Opens an editable copy. Fork it to keep your changes.</p>
      </div>
    </>
  );
}
