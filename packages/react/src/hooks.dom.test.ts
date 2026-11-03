import { parseGuideManifest, type GuideManifest } from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { pairSide } from "@drizzle-run/core/pair";
import { createRunController, type RunController, type RunState } from "@drizzle-run/orchestration";
import type { ComparisonController } from "@drizzle-run/orchestration";
import { type GuideProgress } from "@drizzle-run/runtime/guides";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { pairManifest } from "@drizzle-run/test-fixtures/pair";
// @vitest-environment happy-dom
import {
  act,
  Activity,
  Component,
  createElement,
  StrictMode,
  useEffect,
  type ActivityProps,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { makeRuntimeComparison } from "../test/runtime-comparison-fixture.ts";
import {
  GuideProvider,
  useGuideLastRun,
  RunProvider,
  ComparisonProvider,
  useRunController,
  useComparisonController,
  useRuntimeComparisonController,
  useComparisonState,
  useControllerState,
  useControllerSelector,
  useRunState,
  useRunActions,
  useRunSettled,
  useComparisonActions,
  useComparisonSettled,
  useGuideDebug,
  useGuideActions,
  useGuideSelector,
  useGuideStep,
  useRunOutput,
  type GuideCallbacks,
  type GuideProgressState,
  type GuideProviderProps,
} from "./index.ts";

/**
 * The hooks' effects, which server rendering never runs: subscriptions, callbacks and error reports, in a DOM
 * rendered with React's client renderer.
 */

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

async function render(element: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root?.render(element));

  return container;
}

function createActivity(mode: "visible" | "hidden", children: ReactNode) {
  // createElement supplies children separately; Activity's required children prop overlooks that overload.
  return createElement(Activity, { mode } as ActivityProps, children);
}

/** Waits for React to apply the updates an actor's async work caused. */
async function settle(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(condition()).toBe(true);
  });
  await act(async () => undefined);
}

function ComparisonSide() {
  const state = useRunState();

  return createElement("span", null, `${state.status}:${state.history.length}`);
}

function makeManifest(): GuideManifest {
  return parseGuideManifest({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id: "intro-lesson",
    title: "Lesson",
    project: projectManifest(),
    steps: [
      { type: "walkthrough", id: "01-intro", label: "Intro", title: "Welcome", body: "Read this.", run: "none" },
      { type: "walkthrough", id: "02-run", label: "Run", title: "Show a row", body: "Press Run.", run: "required" },
    ],
  });
}

type GuideEvents = ReturnType<typeof useGuideActions>;

/** The learner actions that take no argument, which `send` mirrors by name. */
type GuideEventName = Exclude<keyof GuideEvents, "goToStep">;

/** A host's error boundary; React only offers them as class components. */
class FallbackBoundary extends Component<{ onCaught: (error: unknown) => void; children?: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onCaught(error);
  }

  override render() {
    return this.state.failed ? createElement("p", null, "fallback") : this.props.children;
  }
}

/** Renders the guide's stage and hands its events out, as a host's own guide UI would. */
function GuideProbe({ onEvents, debug = false }: { onEvents: (events: GuideEvents) => void; debug?: boolean }) {
  const step = useGuideStep();
  const output = useRunOutput();
  const lastRun = useGuideLastRun();

  onEvents(useGuideActions());
  useGuideDebug(debug);

  return createElement(
    "p",
    { "data-last-run-step": lastRun.lastResultStep },
    `${step.index + 1}/${step.count} ${step.stage} running:${output.running} error:${output.error}`,
  );
}

async function renderGuide({
  debug,
  ...props
}: Omit<GuideProviderProps, "manifest" | "children"> & { debug?: boolean }) {
  let events: GuideEvents | undefined;
  const container = await render(
    createElement(
      GuideProvider,
      { manifest: makeManifest(), ...props },
      createElement(GuideProbe, {
        debug,
        onEvents: (rendered) => {
          events = rendered;
        },
      }),
    ),
  );

  await settle(() => !container.textContent.includes("loading"));

  return {
    container,
    send: async (type: GuideEventName) => {
      await act(async () => events?.[type]());
    },
    goToStep: async (index: number) => {
      await act(async () => events?.goToStep(index));
    },
  };
}

/** A runtime whose every run starts and settles with `outcome`, on the database of the manifest it runs. */
function makeSettlingRuntime(outcome: "succeeded" | "failed" = "succeeded") {
  return {
    createComparison: () => {
      throw new Error("Single-run fixture cannot execute comparisons");
    },
    createRun: (manifest: RunManifest) => ({
      start: () => undefined,
      cancel: async () => undefined,
      result: Promise.resolve(fakeRunResult(outcome, { target: manifest.target })),
      subscribe: () => ({ unsubscribe: () => undefined }),
      subscribeEvent: () => ({ unsubscribe: () => undefined }),
    }),
  };
}

describe("GuideProvider", () => {
  it("should retain the last completed run when navigating away from its step", async () => {
    const { container, send } = await renderGuide({ services: { run: async () => fakeRunResult("succeeded") } });
    expect(container.querySelector("p")?.hasAttribute("data-last-run-step")).toBe(false);
    await send("next");
    await send("run");
    await settle(() => container.textContent.includes("after"));
    await send("back");
    expect(container.textContent).toContain("1/2 before");
    expect(container.querySelector("p")?.getAttribute("data-last-run-step")).toBe("1");
  });
  it("should report each step, settled run, leave and finish to the host callbacks", async () => {
    const callback = {
      onStepChange: vi.fn(),
      onRunSettled: vi.fn(),
      onLeave: vi.fn(),
      onDone: vi.fn(),
    } satisfies GuideCallbacks;
    const { container, send } = await renderGuide({
      services: { run: async () => fakeRunResult("succeeded") },
      callback,
    });

    expect(container.textContent).toBe("1/2 before running:false error:");
    expect(callback.onStepChange).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));

    await send("next");
    await send("run");
    await settle(() => container.textContent.includes("after"));

    expect(callback.onStepChange).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }));
    expect(callback.onRunSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 1,
        project: expect.objectContaining({ files: expect.any(Object) }),
        result: expect.objectContaining({ outcome: "succeeded" }),
      }),
    );

    await send("leave");
    expect(callback.onLeave).toHaveBeenCalledOnce();

    await send("resume");
    await send("next");
    expect(callback.onDone).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("done");
  });

  it("should call the latest callbacks the host rendered, not the first ones", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const manifest = makeManifest();
    const services = { run: async () => fakeRunResult("succeeded") };
    let events: GuideEvents | undefined;
    const probe = createElement(GuideProbe, {
      onEvents: (rendered) => {
        events = rendered;
      },
    });
    const container = await render(
      createElement(GuideProvider, { manifest, services, callback: { onStepChange: first } }, probe),
    );

    await settle(() => !container.textContent.includes("loading"));
    first.mockClear();
    await act(async () =>
      root?.render(createElement(GuideProvider, { manifest, services, callback: { onStepChange: latest } }, probe)),
    );
    await act(async () => events?.next());

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });

  it("should report each step and run once under StrictMode", async () => {
    const callback = { onStepChange: vi.fn(), onRunSettled: vi.fn() } satisfies GuideCallbacks;
    let events: GuideEvents | undefined;
    const container = await render(
      createElement(
        StrictMode,
        null,
        createElement(
          GuideProvider,
          { manifest: makeManifest(), services: { run: async () => fakeRunResult("succeeded") }, callback },
          createElement(GuideProbe, {
            onEvents: (rendered) => {
              events = rendered;
            },
          }),
        ),
      ),
    );

    await settle(() => !container.textContent.includes("loading"));
    callback.onStepChange.mockClear();
    await act(async () => events?.next());
    await act(async () => events?.run());
    await settle(() => container.textContent.includes("after"));

    expect(callback.onStepChange).toHaveBeenCalledOnce();
    expect(callback.onRunSettled).toHaveBeenCalledOnce();
  });

  it("should abort a step's run and report nothing once the provider unmounts mid-run", async () => {
    const callback = { onRunSettled: vi.fn(), onRunError: vi.fn() } satisfies GuideCallbacks;
    let runSignal: AbortSignal | undefined;
    let settleRun: (() => void) | undefined;
    const { container, send } = await renderGuide({
      services: {
        run: (_project, signal) => {
          runSignal = signal;

          return new Promise((resolve) => {
            settleRun = () => resolve(fakeRunResult("succeeded"));
          });
        },
      },
      callback,
    });

    await send("next");
    await send("run");
    await settle(() => container.textContent.includes("running:true"));
    await act(async () => root?.unmount());
    root = undefined;
    settleRun?.();
    await act(async () => undefined);

    expect(runSignal?.aborted).toBe(true);
    expect(callback.onRunSettled).not.toHaveBeenCalled();
    expect(callback.onRunError).not.toHaveBeenCalled();
  });

  it("should run each step through the runtime when no run service is given", async () => {
    const runtime = makeSettlingRuntime("succeeded");
    const createRun = vi.spyOn(runtime, "createRun");
    const { container, send } = await renderGuide({ runtime });

    await send("next");
    await send("run");
    await settle(() => container.textContent.includes("after"));

    expect(createRun).toHaveBeenCalledOnce();
  });

  it("should report a step it cannot run when neither a runtime nor services.run is given", async () => {
    const onRunError = vi.fn();
    const { container, send } = await renderGuide({ callback: { onRunError } });

    await send("next");
    await send("run");
    await settle(() => container.textContent.includes("failed"));

    expect(onRunError).toHaveBeenCalledWith("GuideProvider needs a runtime or services.run.");
    expect(container.textContent).toContain("error:GuideProvider needs a runtime or services.run.");
  });

  it("should open at saved progress and save progress through the services", async () => {
    const saved: GuideProgress[] = [];
    const loadProgress = vi.fn(async () => ({
      guideId: "intro-lesson",
      stepId: "02-run",
      completed: ["01-intro"],
      finished: false,
    }));
    const { container, send } = await renderGuide({
      services: {
        run: async () => fakeRunResult("succeeded"),
        loadProgress,
        saveProgress: async (progress) => {
          saved.push(progress);
        },
      },
    });

    expect(loadProgress).toHaveBeenCalledWith("intro-lesson", expect.any(AbortSignal));
    expect(container.textContent).toMatch(/^2\/2/);

    await send("back");
    await settle(() => saved.some((progress) => progress.stepId === "01-intro"));

    expect(container.textContent).toMatch(/^1\/2/);
  });

  it("should open after progressLoadTimeoutMs without progress, and save nothing over it", async () => {
    const saveProgress = vi.fn(async () => undefined);
    const { container, send } = await renderGuide({
      progressLoadTimeoutMs: 10,
      services: {
        run: async () => fakeRunResult("succeeded"),
        loadProgress: () => new Promise(() => {}),
        saveProgress,
      },
    });

    expect(container.textContent).toMatch(/^1\/2/);

    await send("next");

    expect(container.textContent).toMatch(/^2\/2/);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it("should tell the page whether saved progress loaded, so it can say when nothing is saved", async () => {
    const seen: GuideProgressState[] = [];

    function ProgressProbe() {
      const progress = useGuideSelector((view) => view.progress);

      seen.push(progress);

      return createElement("p", null, progress);
    }

    const renderProgress = (loadProgress: () => Promise<unknown>) =>
      render(
        createElement(
          GuideProvider,
          { manifest: makeManifest(), services: { run: async () => fakeRunResult("succeeded"), loadProgress } },
          createElement(ProgressProbe),
        ),
      );

    const loaded = await renderProgress(async () => undefined);

    await settle(() => loaded.textContent === "loaded");
    expect(seen[0]).toBe("loading");

    await act(async () => root?.unmount());
    const unavailable = await renderProgress(async () => {
      throw new Error("Storage is blocked.");
    });

    await settle(() => unavailable.textContent === "unavailable");
  });

  it("should go back to an earlier step and save it as the learner's place", async () => {
    const saved: GuideProgress[] = [];
    const { container, send, goToStep } = await renderGuide({
      services: {
        run: async () => fakeRunResult("succeeded"),
        saveProgress: async (progress) => {
          saved.push(progress);
        },
      },
    });

    await send("next");
    expect(container.textContent).toMatch(/^2\/2/);

    await goToStep(0);
    await settle(() => saved.at(-1)?.stepId === "01-intro");

    expect(container.textContent).toMatch(/^1\/2/);
  });

  it("should cancel a run and restart a finished guide from the first step", async () => {
    let resolveRun: ((result: ReturnType<typeof fakeRunResult>) => void) | undefined;
    const { container, send } = await renderGuide({
      services: {
        run: () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          }),
      },
    });

    await send("next");
    await send("run");
    expect(container.textContent).toContain("running:true");

    await send("cancel");
    expect(container.textContent).toContain("before running:false");

    await send("run");
    await act(async () => resolveRun?.(fakeRunResult("succeeded")));
    await settle(() => container.textContent.includes("after"));
    await send("next");
    await send("restart");

    expect(container.textContent).toBe("1/2 before running:false error:");
  });

  it("should log the guide's states only while debugging is on", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await renderGuide({ services: { run: async () => fakeRunResult("succeeded") } });
    expect(debug).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    await renderGuide({ services: { run: async () => fakeRunResult("succeeded") }, debug: true });

    expect(debug).toHaveBeenCalledWith("[guide]", expect.anything(), expect.anything());
    debug.mockRestore();
  });
});

describe("GuideProvider onError", () => {
  it("should hand a guide machine's own error to onError, as its scope provider does", async () => {
    const parsed = makeManifest();
    const [intro, runStep] = parsed.steps;
    const broken: GuideManifest = {
      ...parsed,
      steps: [intro, { ...runStep, edits: [{ file: "query.ts", replace: { anchor: "no such anchor", with: "" } }] }],
    };
    const onError = vi.fn();
    const caught = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let events: GuideEvents | undefined;

    await render(
      createElement(
        FallbackBoundary,
        { onCaught: caught },
        createElement(
          GuideProvider,
          { manifest: broken, services: { run: async () => fakeRunResult("succeeded") }, onError },
          createElement(GuideProbe, {
            onEvents: (rendered) => {
              events = rendered;
            },
          }),
        ),
      ),
    );
    await act(async () => events?.next());

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: "GuideEditError" });
    consoleError.mockRestore();
  });
});

describe("run controller hooks", () => {
  it("should report cancellation rejection when Activity hides an owned controller", async () => {
    let owned: RunController | undefined;
    const cause = new Error("Cancellation cleanup failed");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);

    function Owner() {
      const controller = useRunController();
      useEffect(() => {
        owned = controller;
      }, [controller]);

      return null;
    }

    const owner = createElement(Owner);
    const tree = (mode: "visible" | "hidden") => createActivity(mode, owner);
    await render(tree("visible"));

    if (owned === undefined) {
      throw new Error("Expected an owned controller after rendering.");
    }

    vi.spyOn(owned, "cancel").mockRejectedValueOnce(cause);
    await act(async () => root?.render(tree("hidden")));

    expect(report).toHaveBeenCalledExactlyOnceWith("Cancelling the execution controller failed.", cause);
    report.mockRestore();
  });

  it("should reconnect ownership before a descendant submits from its effect", async () => {
    const submissions: Promise<unknown>[] = [];

    function Child({ controller }: { controller: RunController }) {
      useEffect(() => {
        const submission = controller.submit({ manifest: projectManifest(), revision: 1, debug: false });
        void submission.catch(() => undefined);
        submissions.push(submission);
      }, [controller]);

      return null;
    }

    function Owner() {
      return createElement(Child, { controller: useRunController({ runtime: makeSettlingRuntime() }) });
    }

    const owner = createElement(Owner);
    const tree = (mode: "visible" | "hidden") => createActivity(mode, owner);
    await render(tree("visible"));
    await act(async () => root?.render(tree("hidden")));
    await act(async () => root?.render(tree("visible")));
    await act(async () => root?.render(tree("hidden")));
    await act(async () => root?.render(tree("visible")));

    expect(submissions).toHaveLength(3);
    await expect(Promise.all(submissions)).resolves.toHaveLength(3);
  });

  it("should cancel hidden work and retain ownership while cancellation finishes", async () => {
    const completion = Promise.withResolvers<ReturnType<typeof fakeRunResult>>();
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(async () => {
      await cleanup.promise;
      completion.resolve(fakeRunResult("cancelled"));
    });
    const runtime = {
      createRun: vi
        .fn()
        .mockImplementationOnce(() => ({
          result: completion.promise,
          start() {},
          cancel,
          subscribe: () => ({ unsubscribe() {} }),
          subscribeEvent: () => ({ unsubscribe() {} }),
        }))
        .mockImplementation(makeSettlingRuntime().createRun),
    };
    let owned: RunController | undefined;

    function Probe() {
      const controller = useRunController({ runtime });
      useEffect(() => {
        owned = controller;
      }, [controller]);

      return createElement("p", null, useControllerState(controller).status);
    }

    const tree = (mode: "visible" | "hidden") => createActivity(mode, createElement(Probe));
    await render(tree("visible"));
    const hiddenController = owned;
    let firstSubmission: Promise<unknown> | undefined;
    await act(async () => {
      firstSubmission = owned?.submit({ manifest: projectManifest(), revision: 1, debug: false });
    });
    await act(async () => root?.render(tree("hidden")));
    expect(cancel).toHaveBeenCalledOnce();
    expect(hiddenController?.getState().status).toBe("running");

    await act(async () => root?.render(tree("visible")));
    expect(owned).toBe(hiddenController);
    cleanup.resolve();
    await act(async () => firstSubmission);
    await act(async () => {
      await owned?.submit({ manifest: projectManifest(), revision: 2, debug: false });
    });
    expect(owned?.getState().status).toBe("settled");
    await act(async () => root?.unmount());
    root = undefined;
    expect(owned?.getState().status).toBe("disposed");
  });

  it.each(["run", "comparison", "runtime comparison"] as const)(
    "should recover an owned %s controller after Activity hides and reconnects it",
    async (kind) => {
      let owned: RunController | ComparisonController | undefined;
      const controlled = makeRuntimeComparison();
      const manifest = pairManifest();

      function Probe() {
        const run = useRunController({ runtime: makeSettlingRuntime() });
        const comparison = useComparisonController({ runSide: async () => "succeeded" });
        const runtimeComparison = useRuntimeComparisonController({
          getRuntime: () => controlled.runtime,
          getManifest: () => manifest,
          runSide: async ({ runtime, side }) => {
            const handle = runtime.createRun(pairSide(manifest, side));
            handle.start();

            return (await handle.result).outcome;
          },
        });
        const controller = kind === "run" ? run : kind === "comparison" ? comparison : runtimeComparison;
        useEffect(() => {
          owned = controller;
        }, [controller]);

        return createElement("p", null, useControllerState<{ status: string }>(controller).status);
      }

      const tree = (mode: "visible" | "hidden") =>
        createElement(StrictMode, null, createActivity(mode, createElement(Probe)));
      await render(tree("visible"));
      const before = owned;
      await act(async () => root?.render(tree("hidden")));
      expect(before?.getState().status).toBe("idle");
      await act(async () => root?.render(tree("visible")));
      expect(owned?.getState().status).toBe("idle");
      expect(owned).toBe(before);
      let submission: Promise<unknown> | undefined;
      await act(async () => {
        if (kind === "run") {
          submission = (owned as RunController).submit({ manifest: projectManifest(), revision: 1, debug: false });
        } else {
          submission = (owned as ComparisonController).submit();
        }
      });
      await act(async () => {
        controlled.results.a.resolve(fakeRunResult("succeeded"));
        controlled.results.b.resolve(fakeRunResult("succeeded"));
        await submission;
      });
      expect(owned?.getState().status).toBe("settled");
      await act(async () => root?.unmount());
      root = undefined;
      expect(owned?.getState().status).toBe("disposed");
    },
  );

  it("should use current callbacks, unsubscribe on unmount, and leave borrowed controllers alive", async () => {
    const runs = createRunController({ runtime: makeSettlingRuntime() });
    const first = vi.fn();
    const latest = vi.fn();

    function Probe({ listener }: { listener: (outcome: unknown) => void }) {
      useRunSettled(listener);
      const state = useRunState();
      const actions = useRunActions();

      return createElement(
        "button",
        { onClick: () => void actions.submit({ manifest: projectManifest(), revision: 1, debug: false }) },
        state.status,
      );
    }

    const container = await render(
      createElement(RunProvider, { controller: runs }, createElement(Probe, { listener: first })),
    );
    await act(async () =>
      root?.render(createElement(RunProvider, { controller: runs }, createElement(Probe, { listener: latest }))),
    );
    await act(async () => container.querySelector("button")?.click());

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("settled");
    await act(async () => root?.unmount());
    root = undefined;
    await runs.submit({ manifest: projectManifest(), revision: 2, debug: false });
    expect(latest).toHaveBeenCalledOnce();
    await runs.dispose();
  });

  it("should preserve an owned controller through StrictMode and cancel it on real unmount", async () => {
    let owned: RunController | undefined;
    const completion = Promise.withResolvers<ReturnType<typeof fakeRunResult>>();
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(async () => {
      await cleanup.promise;
      completion.resolve(fakeRunResult("cancelled"));
    });
    const runtime = {
      createRun: () => ({
        result: completion.promise,
        start() {},
        cancel,
        subscribe: () => ({ unsubscribe() {} }),
        subscribeEvent: () => ({ unsubscribe() {} }),
      }),
    };

    function Probe() {
      const runs = useRunController({ runtime });
      useEffect(() => {
        owned = runs;
      }, [runs]);
      const state = useControllerState(runs);

      return createElement(
        "button",
        { onClick: () => void runs.submit({ manifest: projectManifest(), revision: 1, debug: false }) },
        state.status,
      );
    }

    const container = await render(createElement(StrictMode, null, createElement(Probe)));
    expect(owned?.getState().status).toBe("idle");
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe("running");
    await act(async () => root?.unmount());
    root = undefined;
    expect(cancel).toHaveBeenCalledOnce();
    expect(owned?.getState().status).toBe("disposing");
    cleanup.resolve();
    await settle(() => owned?.getState().status === "disposed");
  });

  it("should avoid rerendering an equal selection and support a changed selector", async () => {
    const runs = createRunController();
    const renderCount = vi.fn();
    const selector = (state: RunState) => ({ count: state.history.length });
    const compare = (left: { count: number }, right: { count: number }) => left.count === right.count;

    function Probe({ selected = selector }: { selected?: typeof selector }) {
      const value = useControllerSelector(runs, selected, compare);
      renderCount();

      return createElement("p", null, value.count);
    }

    const container = await render(createElement(Probe));
    const before = renderCount.mock.calls.length;
    await act(async () => runs.selectHistoryEntry(100));
    expect(renderCount).toHaveBeenCalledTimes(before);
    await act(async () =>
      runs.replay({
        submission: { manifest: projectManifest(), revision: 1, debug: false },
        result: fakeRunResult("succeeded"),
      }),
    );
    expect(container.textContent).toBe("1");
    await act(async () => root?.render(createElement(Probe, { selected: () => ({ count: 7 }) })));
    expect(container.textContent).toBe("7");
    await runs.dispose();
  });

  it("should supply defaults for an owned controller and report a disposal failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let owned: RunController | undefined;

    function Probe() {
      const runs = useRunController();
      useEffect(() => {
        owned = runs;
      }, [runs]);
      return null;
    }

    await render(createElement(Probe));
    expect(owned?.getState().status).toBe("idle");

    if (owned === undefined) {
      throw new Error("The controller was not mounted.");
    }

    const dispose = vi.spyOn(owned, "dispose").mockRejectedValue(new Error("dispose failed"));
    await act(async () => root?.unmount());
    root = undefined;
    expect(error).toHaveBeenCalledWith("Disposing the execution controller failed.", expect.any(Error));
    dispose.mockRestore();
    await owned.dispose();
    error.mockRestore();
  });
});

describe("comparison controller hooks", () => {
  it("should expose SDK comparison sides independently through providers and settle the aggregate once", async () => {
    const controlled = makeRuntimeComparison();
    const manifest = pairManifest();
    const histories = [createRunController(), createRunController()];
    const listener = vi.fn();
    let owned: ComparisonController | undefined;

    function Controls() {
      const comparison = useComparisonActions();
      const state = useComparisonState();
      useComparisonSettled(listener);

      return createElement("button", { onClick: () => void comparison.submit() }, state.status);
    }

    function Owner() {
      const comparison = useRuntimeComparisonController({
        getRuntime: () => controlled.runtime,
        getManifest: () => manifest,
        runSide: ({ side, runtime, signal }) =>
          histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: true }, { runtime, signal }),
      });
      useEffect(() => {
        owned = comparison;
      }, [comparison]);

      return createElement(
        ComparisonProvider,
        { controller: comparison },
        createElement(Controls),
        ...histories.map((controller, side) =>
          createElement(RunProvider, { controller, key: side }, createElement(ComparisonSide)),
        ),
      );
    }

    const container = await render(createElement(StrictMode, null, createElement(Owner)));
    await act(async () => container.querySelector("button")?.click());
    expect(controlled.runtime.createComparison).toHaveBeenCalledOnce();
    expect(controlled.start).toHaveBeenCalledOnce();
    await act(async () => controlled.results.a.resolve(fakeRunResult("succeeded")));

    expect([...container.querySelectorAll("span")].map((element) => element.textContent)).toEqual([
      "settled:1",
      "running:0",
    ]);
    expect(container.querySelector("button")?.textContent).toBe("running");
    expect(listener).not.toHaveBeenCalled();
    await act(async () => controlled.results.b.resolve(fakeRunResult("succeeded")));

    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcomes: ["succeeded", "succeeded"] }));
    expect(container.querySelector("button")?.textContent).toBe("settled");
    expect(controlled.unsubscribe).toHaveBeenCalledTimes(4);
    await act(async () => root?.unmount());
    root = undefined;
    await settle(() => owned?.getState().status === "disposed");
    expect(controlled.runtime.dispose).not.toHaveBeenCalled();
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should wait for SDK cancellation cleanup on unmount and unsubscribe settled listeners", async () => {
    const controlled = makeRuntimeComparison();
    const manifest = pairManifest();
    const histories = [createRunController(), createRunController()];
    const listener = vi.fn();
    let owned: ComparisonController | undefined;

    function Controls() {
      const comparison = useComparisonActions();
      useComparisonSettled(listener);

      return createElement("button", { onClick: () => void comparison.submit() }, "Compare");
    }

    function Owner() {
      const comparison = useRuntimeComparisonController({
        getRuntime: () => controlled.runtime,
        getManifest: () => manifest,
        runSide: ({ side, runtime, signal }) =>
          histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: true }, { runtime, signal }),
      });
      useEffect(() => {
        owned = comparison;
      }, [comparison]);

      return createElement(ComparisonProvider, { controller: comparison }, createElement(Controls));
    }

    const container = await render(createElement(Owner));
    await act(async () => container.querySelector("button")?.click());
    await act(async () => root?.unmount());
    root = undefined;

    expect(owned?.getState().status).toBe("disposing");
    expect(controlled.cancel).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    controlled.cleanup.resolve();
    await settle(() => owned?.getState().status === "disposed");

    expect(histories.every((history) => history.getState().result?.outcome === "cancelled")).toBe(true);
    expect(controlled.unsubscribe).toHaveBeenCalledTimes(4);
    expect(listener).not.toHaveBeenCalled();
    expect(controlled.runtime.dispose).not.toHaveBeenCalled();
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should submit through actions and observe the result without machine events", async () => {
    const listener = vi.fn();
    function Controls() {
      const comparison = useComparisonActions();
      useComparisonSettled(listener);

      return createElement("button", { onClick: () => void comparison.submit() }, "Compare");
    }

    function Owner() {
      const comparison = useComparisonController({ runSide: async () => "succeeded" });
      return createElement(ComparisonProvider, { controller: comparison }, createElement(Controls));
    }

    const container = await render(createElement(Owner));
    await act(async () => container.querySelector("button")?.click());
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ outcomes: ["succeeded", "succeeded"] }));
  });
});
