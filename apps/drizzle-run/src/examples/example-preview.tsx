import { pairSide } from "@drizzle-run/core/pair";
import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { buttonVariants } from "../components/ui/button";
import { formatProjectDialects, isPairManifest } from "../project/projects";
import { resolveExampleSides, type OfficialExample } from "./catalog";
import { getExampleCallToAction } from "./example-card";
import { getGalleryTopics } from "./gallery-filters";
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

/** Read-only catalog details; opening the example, rather than previewing it, records a visit. */
export function ExamplePreview({ example, progress }: { example: OfficialExample; progress?: GuideProgress }) {
  const project = example.guide?.project ?? example.manifest;
  const run = isPairManifest(project) ? pairSide(project, 0) : project;
  const query = run.entrypoints.run === undefined ? undefined : run.files[run.entrypoints.run];
  const sides = resolveExampleSides(example);
  const comparison = sides?.map((side) => side.name ?? `Drizzle ${side.ormVersion}`).join(" vs ");

  return (
    <>
      <div
        data-slot="gallery-preview-content"
        className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-contain p-5.5 max-phone:p-5"
      >
        <p className="text-[12px] text-muted">
          {example.guide ? "Guide" : "Example"} · {formatProjectDialects(example.manifest)}
        </p>
        <h2 className="mt-2 text-[20px]/[1.3] font-semibold tracking-[-0.02em]" id="example-preview-title">
          {example.title}
        </h2>
        <p className="mt-3 text-[13px]/[1.7] text-muted">{example.description}</p>
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          {example.guide && `${example.guide.steps.length} steps · `}
          {getGalleryTopics(example).map((topic) => (
            <span key={topic} className="rounded-sm border border-border px-1.5 py-0.5">
              {topic}
            </span>
          ))}
        </p>
        {comparison && <p className="mt-3 text-[13px] font-medium">{comparison}</p>}
        {example.guide && (
          <section className="mt-6 border-t border-border pt-5" aria-label="Guide outline">
            <h3 className="mb-3 text-[13px] font-medium">What you’ll explore</h3>
            <ol className="list-decimal space-y-2.5 pl-5 text-[13px] text-soft marker:text-muted">
              {example.guide.steps.map((step) => (
                <li key={step.id}>{step.title}</li>
              ))}
            </ol>
          </section>
        )}
        {query !== undefined && (
          <section className="mt-6" aria-label="Query preview">
            <h3 className="mb-3 text-[13px] font-medium">
              {isPairManifest(project) ? `Starting query · ${sides?.[0].name ?? "First side"}` : "Starting query"}
            </h3>
            <pre className="rounded-md border border-border bg-surface-2 p-4 font-mono text-[12px]/[1.7] wrap-anywhere whitespace-pre-wrap">
              <QueryCode code={query} />
            </pre>
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
          {getExampleCallToAction(Boolean(example.guide), progress)} →
        </Link>
        <p className="mt-2 text-[12px] text-muted">Opens an editable copy. Fork it to keep your changes.</p>
      </div>
    </>
  );
}
