import type { Executor, RunResult } from "@drizzle-run/core/contracts";
import { createComparisonController, createRunController } from "@drizzle-run/orchestration";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { createElement, Fragment, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComparisonProvider,
  RunProvider,
  useComparisonActions,
  useComparisonState,
  useRunActions,
  useRunInProgress,
  useRunSelector,
  useRunState,
} from "./index.ts";

function makeRuntime(): Executor {
  const completion = Promise.withResolvers<RunResult>();

  return {
    createRun: () => ({
      result: completion.promise,
      start() {},
      async cancel() {
        completion.resolve(fakeRunResult("cancelled"));
      },
      subscribe: () => ({ unsubscribe() {} }),
      subscribeEvent: () => ({ unsubscribe() {} }),
    }),
  };
}

function RunProbe() {
  const runs = useRunActions();
  const running = useRunInProgress();
  const count = useRunSelector((state) => state.history.length);
  const state = useRunState();

  return createElement("p", null, `${state.status} running:${running} runs:${count} same:${runs.getState() === state}`);
}

function renderOutside(component: FunctionComponent) {
  return () => renderToStaticMarkup(createElement(component));
}

describe("RunProvider", () => {
  it("should isolate two controllers and expose plain state during server rendering", async () => {
    const left = createRunController({ runtime: makeRuntime() });
    const right = createRunController();
    const pending = left.submit({ manifest: projectManifest("sqlite"), revision: 1, debug: false });
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(RunProvider, { controller: left }, createElement(RunProbe)),
        createElement(RunProvider, { controller: right }, createElement(RunProbe)),
      ),
    );

    expect(markup).toBe("<p>running running:true runs:0 same:true</p><p>idle running:false runs:0 same:true</p>");
    await left.dispose();
    await pending;
    await right.dispose();
  });

  it("should select the closest provider", async () => {
    const outer = createRunController();
    const inner = createRunController();
    inner.replay({
      submission: { manifest: projectManifest(), revision: 1, debug: false },
      result: fakeRunResult("succeeded"),
    });
    const markup = renderToStaticMarkup(
      createElement(
        RunProvider,
        { controller: outer },
        createElement(RunProvider, { controller: inner }, createElement(RunProbe)),
      ),
    );

    expect(markup).toContain("runs:1");
    await outer.dispose();
    await inner.dispose();
  });

  it("should name the required provider when a hook is used outside it", () => {
    expect(renderOutside(RunProbe)).toThrow("inside RunProvider");
  });
});

function ComparisonProbe() {
  const state = useComparisonState();
  const comparison = useComparisonActions();

  return createElement("p", null, `${state.status} same:${comparison.getState() === state}`);
}

describe("ComparisonProvider", () => {
  it("should expose comparison state without actors", async () => {
    const comparison = createComparisonController({ runSide: async () => "succeeded" });
    expect(
      renderToStaticMarkup(
        createElement(ComparisonProvider, { controller: comparison }, createElement(ComparisonProbe)),
      ),
    ).toBe("<p>idle same:true</p>");
    await comparison.dispose();
  });

  it("should name the required comparison provider", () => {
    expect(renderOutside(ComparisonProbe)).toThrow("inside ComparisonProvider");
  });
});
