import { parseGuideManifest, parseRichText, plainText, projectFiles } from "@drizzle-run/core/guide";
import { createGuideMachine } from "@drizzle-run/runtime/machines";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { GuideProvider, useGuideActions, useGuideStep, useRunOutput } from "./index.ts";

/**
 * A guide rendered by a host that is not Drizzle Run: only the engine and the runtime,
 * a fake run service, and the host's own markup.
 */
const manifest = parseGuideManifest({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "intro-lesson",
  title: "Lesson",
  project: projectManifest(),
  steps: [
    { type: "walkthrough", id: "01-intro", label: "Intro", title: "Welcome", body: "Read **this**.", run: "none" },
    {
      type: "walkthrough",
      id: "02-run",
      label: "Run",
      title: "Show a row",
      body: "Press `Run`.",
      edits: [{ file: "query.ts", replace: { anchor: "// next", with: '$.display("Rows", [{ id: 1 }]);' } }],
      run: "required",
    },
  ],
  meta: { course: "DB-101" },
});

import { guideScope } from "./guide-scope.ts";

const GuideActorProvider = guideScope.Provider;

type GuideEvents = ReturnType<typeof useGuideActions>;

let events: GuideEvents | undefined;

function LessonUi({ onEvents }: { onEvents?: (rendered: GuideEvents) => void }) {
  const step = useGuideStep();
  const output = useRunOutput();
  const guideEvents = useGuideActions();

  onEvents?.(guideEvents);

  return createElement(
    Fragment,
    null,
    createElement("h1", null, `${step.index + 1}/${step.count} ${step.step.title}`),
    createElement("p", null, plainText(parseRichText(step.step.body))),
    createElement("pre", { "data-locked": String(step.editorLocked) }, projectFiles(step.project)["query.ts"]),
    createElement(
      "output",
      null,
      `${step.stage} next:${step.canNext} rows:${output.changes?.displays.map((display) => `${display.label}+${display.added.length}`).join(",") ?? "none"}`,
    ),
  );
}

const render = (actor: Parameters<typeof GuideActorProvider>[0]["actor"]) =>
  renderToStaticMarkup(
    createElement(
      GuideActorProvider,
      { actor },
      createElement(LessonUi, {
        onEvents: (rendered) => {
          events = rendered;
        },
      }),
    ),
  );

describe("guide bindings outside the app", () => {
  it("should render each stage of a guide from the manifest and mirror actions into events", async () => {
    const run = vi.fn(async () =>
      fakeRunResult("succeeded", {
        displays: [
          {
            label: "Rows",
            values: [{ type: "array", value: [{ type: "object", value: { id: { type: "primitive", value: 1 } } }] }],
          },
        ],
      }),
    );
    const actor = createActor(createGuideMachine({ run }), { input: { manifest } }).start();

    await waitFor(actor, (snapshot) => !snapshot.matches("loading"));
    expect(render(actor)).toContain("<h1>1/2 Welcome</h1><p>Read this.</p>");

    events?.next();
    const before = render(actor);

    expect(before).toContain("<h1>2/2 Show a row</h1>");
    expect(before).toContain('data-locked="true"');
    expect(before).toContain("$.display(&quot;Rows&quot;");
    expect(before).toContain("before next:false rows:none");

    events?.run();
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    expect(run).toHaveBeenCalledOnce();
    expect(render(actor)).toContain("after next:true rows:Rows+1");

    events?.next();
    expect(render(actor)).toContain('data-locked="false"');
    expect(render(actor)).toContain("done next:false");
    actor.stop();
  });

  it("should mount the flow through GuideProvider", () => {
    const markup = renderToStaticMarkup(
      createElement(
        GuideProvider,
        { manifest, services: { run: async () => fakeRunResult("succeeded") } },
        createElement(LessonUi),
      ),
    );

    expect(markup).toContain("<h1>1/2 Welcome</h1>");
    expect(markup).toContain("loading next:false");
  });

  it("should explain a hook used outside a provider", () => {
    expect(() => renderToStaticMarkup(createElement(LessonUi))).toThrow("inside GuideProvider");
  });
});
