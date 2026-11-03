import { readFile } from "node:fs/promises";

import { EvalFlags } from "quickjs-wasi";
import { describe, expect, it, vi } from "vitest";

import { createExecutionVm } from "./vm.ts";

const wasm = await WebAssembly.compile(await readFile(new URL("../../dist/quickjs/quickjs.wasm", import.meta.url)));

describe("QuickJS VM boundary", () => {
  it("should preserve timeout classification when VM initialization is interrupted", async () => {
    await expect(
      createExecutionVm({
        wasm,
        extensions: [],
        modules: new Map(),
        startedAtMs: performance.now() - 21_000,
      }),
    ).rejects.toMatchObject({ code: "run_timeout" });
  });

  it("should retain timeout evidence when QuickJS interrupts guest execution", async () => {
    const context = await createExecutionVm({
      wasm,
      extensions: [],
      modules: new Map(),
      startedAtMs: performance.now(),
    });
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 21_000);

    try {
      expect(context.wasInterrupted()).toBe(false);
      expect(() => context.vm.evalCode("while (true) {};")).toThrow("interrupted");
      expect(context.wasInterrupted()).toBe(true);
    } finally {
      clock.mockRestore();
      context.vm.dispose();
    }
  });

  it("should report a promise rejection and its later handler with the same identity", async () => {
    const observed: { identity: number; handled: boolean; message: string }[] = [];
    const context = await createExecutionVm({
      wasm,
      extensions: [],
      modules: new Map(),
      startedAtMs: performance.now(),
      onUnhandledRejection(promise, reason, handled) {
        observed.push({ identity: promise.identity, handled, message: reason.toString() });
      },
    });

    try {
      context.vm.evalCode("globalThis.rejected = Promise.reject(new Error('sentinel')); void 0;").dispose();
      context.vm.executePendingJobs();
      context.vm.evalCode("rejected.catch(() => {}); void 0;").dispose();
      context.vm.executePendingJobs();

      expect(observed).toHaveLength(2);
      expect(observed.map((entry) => entry.handled)).toEqual([false, true]);
      expect(observed[0]?.identity).toBe(observed[1]?.identity);
      expect(observed[0]?.message).toContain("sentinel");
    } finally {
      context.vm.dispose();
    }
  });

  it("should restore dependencies with fresh host callbacks and no shared project globals", async () => {
    const original = await createExecutionVm({
      wasm,
      extensions: [],
      modules: new Map(),
      startedAtMs: performance.now(),
    });

    try {
      const template = original.vm.snapshot();
      original.vm.evalCode('globalThis.projectValue = "original"; console.log("original");').dispose();
      const restored = await createExecutionVm({
        wasm,
        extensions: [],
        modules: new Map(),
        startedAtMs: performance.now(),
        template: { ...template, memory: new Uint8Array(template.memory) },
      });

      try {
        const handle = restored.vm.evalCode('console.log("restored"); typeof projectValue');

        try {
          expect(handle.toString()).toBe("undefined");
          expect(original.logs).toEqual([["log", "original"]]);
          expect(restored.logs).toEqual([["log", "restored"]]);
        } finally {
          handle.dispose();
        }
      } finally {
        restored.vm.dispose();
      }
    } finally {
      original.vm.dispose();
    }
  });

  it("should bridge the supported Intl operations and reject unsupported Web APIs", async () => {
    const context = await createExecutionVm({
      wasm,
      extensions: [],
      modules: new Map(),
      startedAtMs: performance.now(),
    });

    try {
      const handle = context.vm.evalCode(`
        const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" });
        console.log(formatter.format(0), formatter.resolvedOptions().timeZone);
        console.log(formatter.formatToParts(0).length, formatter.formatRange(0, 86400000), formatter.formatRangeToParts(0, 86400000).length);
        console.log(Intl.DateTimeFormat.supportedLocalesOf("en-US")[0]);
        console.log(crypto.randomUUID().length);
        "complete";
      `);

      try {
        expect(handle.toString()).toBe("complete");
        expect(context.logs[0]).toEqual(["log", "1970", "UTC"]);
        expect(context.logs[1]).toEqual(["log", 1, "1970", 1]);
        expect(context.logs[2]).toEqual(["log", "en-US"]);
        expect(context.logs[3]).toEqual(["log", 36]);
        expect(context.intlFormatters).toHaveLength(1);
      } finally {
        handle.dispose();
      }

      expect(() => context.vm.evalCode("new Blob()")).toThrow("unavailable");
      expect(() => context.vm.evalCode('probeIntl("unsupported", "[]")')).toThrow("Unsupported Intl");
      expect(() => context.vm.evalCode('probeIntl("resolvedOptions", "[999]")')).toThrow("Unknown Intl formatter");
    } finally {
      context.vm.dispose();
    }
  });

  it("should refuse package and missing project modules at the guest loader boundary", async () => {
    const context = await createExecutionVm({
      wasm,
      extensions: [],
      modules: new Map(),
      startedAtMs: performance.now(),
    });

    try {
      expect(() => context.vm.evalCode('import "node:fs";', "project.js", EvalFlags.TYPE_MODULE)).toThrow("Unapproved");
      expect(() => context.vm.evalCode('import "./absent.js";', "project.js", EvalFlags.TYPE_MODULE)).toThrow(
        "Missing",
      );
    } finally {
      context.vm.dispose();
    }
  });
});
