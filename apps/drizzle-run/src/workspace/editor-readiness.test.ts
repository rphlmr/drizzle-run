import type { BrowserRuntime } from "@drizzle-run/runtime/browser";
import { projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { createProjectPreparationRegistry } from "../project/preparation-scope";
import { createEditorReadinessRequest, type EditorSession } from "./editor-readiness";

describe("editor readiness", () => {
  it.each(["eager", "on_demand"] as const)(
    "should prepare both editors and pre-warm only in eager mode (%s)",
    async (preparation) => {
      const warmUp = Promise.withResolvers<void>();
      const prepare = vi.fn<BrowserRuntime["prepare"]>(() => warmUp.promise);
      const createRun = vi.fn<BrowserRuntime["createRun"]>();
      const runtime = {
        checkCapabilities: vi
          .fn<BrowserRuntime["checkCapabilities"]>()
          .mockResolvedValue({ status: "available", reasons: [] }),
        getSnapshot: () => ({ state: "idle" as const }),
        subscribe: () => ({ unsubscribe() {} }),
        prepare,
        createRun,
        createComparison: vi.fn<BrowserRuntime["createComparison"]>(),
        dispose: async () => {},
        [Symbol.asyncDispose]: async () => {},
      } satisfies BrowserRuntime;
      const preparations = createProjectPreparationRegistry();
      const dispose = vi.fn();
      const editor = {
        dispose,
        replaceFiles() {},
        highlight() {},
        markError() {},
        onProblemsChange: () => () => {},
        problems: () => [],
        formatFiles: async () => {},
        setReadOnly() {},
        setRunNotes() {},
        setPhoneLayout() {},
        setTextSize() {},
        setPreferredFontSize() {},
        setWordWrap() {},
        select() {},
      } satisfies EditorSession;
      const report = vi.fn();

      const openEditor = vi.fn(async () => ({ ...editor }));
      const manifest = projectManifest("postgresql");
      const readManifest = vi.fn(() => manifest);
      const preparing = Promise.all(
        [0, 1].map(async (side) => {
          const request = createEditorReadinessRequest({
            key: `side-${side}`,
            preparations,
            getRuntime: async () => runtime,
            onRuntime() {},
            preparation,
            readManifest,
            openEditor,
          });
          const signal = new AbortController().signal;
          const { checked } = await request.check(signal);

          return request.prepare(checked, signal, report);
        }),
      );

      await vi.waitFor(() => expect(openEditor).toHaveBeenCalledTimes(2));
      expect(report).toHaveBeenCalledWith({ type: "editor.done" });

      const expectedPreparations = preparation === "eager" ? 2 : 0;
      const signalMatcher = expect.any(AbortSignal);
      const expectedCalls =
        preparation === "eager"
          ? [
              [manifest, { signal: signalMatcher }],
              [manifest, { signal: signalMatcher }],
            ]
          : [];
      expect(prepare.mock.calls).toEqual(expectedCalls);
      expect(readManifest).toHaveBeenCalledTimes(expectedPreparations);
      expect(report.mock.calls.filter(([event]) => event.type === "runtime.done")).toHaveLength(
        preparation === "eager" ? 0 : 2,
      );

      warmUp.resolve();
      const sessions = await preparing;

      expect(runtime.checkCapabilities).toHaveBeenCalledTimes(2);
      expect(createRun).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith({ type: "runtime.done" });
      for (const session of sessions) {
        session.dispose();
      }
      expect(dispose).toHaveBeenCalledTimes(2);
    },
  );
});
