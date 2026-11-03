import type { HostFunction, QuickJSOptions } from "quickjs-wasi";
import { QuickJS } from "quickjs-wasi";
import * as z from "zod/mini";

import { QuickjsTimeoutError } from "./errors.ts";
import type { DependencyTemplate } from "./worker-contract.ts";

const LogSchema = z.array(z.json());
const LocalesSchema = z.optional(z.union([z.string(), z.array(z.string())]));
const DateTimeOptionsSchema = z.object({
  localeMatcher: z.optional(z.enum(["best fit", "lookup"])),
  calendar: z.optional(z.string()),
  numberingSystem: z.optional(z.string()),
  timeZone: z.optional(z.string()),
  hour12: z.optional(z.boolean()),
  hourCycle: z.optional(z.enum(["h11", "h12", "h23", "h24"])),
  formatMatcher: z.optional(z.enum(["basic", "best fit"])),
  dateStyle: z.optional(z.enum(["full", "long", "medium", "short"])),
  timeStyle: z.optional(z.enum(["full", "long", "medium", "short"])),
  weekday: z.optional(z.enum(["long", "short", "narrow"])),
  era: z.optional(z.enum(["long", "short", "narrow"])),
  year: z.optional(z.enum(["numeric", "2-digit"])),
  month: z.optional(z.enum(["numeric", "2-digit", "long", "short", "narrow"])),
  day: z.optional(z.enum(["numeric", "2-digit"])),
  hour: z.optional(z.enum(["numeric", "2-digit"])),
  minute: z.optional(z.enum(["numeric", "2-digit"])),
  second: z.optional(z.enum(["numeric", "2-digit"])),
  fractionalSecondDigits: z.optional(z.union([z.literal(1), z.literal(2), z.literal(3)])),
  timeZoneName: z.optional(z.enum(["long", "short", "shortOffset", "longOffset", "shortGeneric", "longGeneric"])),
});
const IntlRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("create"), args: z.tuple([LocalesSchema, z.optional(DateTimeOptionsSchema)]) }),
  z.object({
    method: z.literal("supportedLocalesOf"),
    args: z.tuple([LocalesSchema, z.optional(DateTimeOptionsSchema)]),
  }),
  z.object({ method: z.literal("resolvedOptions"), args: z.tuple([z.int()]) }),
  z.object({
    method: z.enum(["format", "formatToParts"]),
    args: z.tuple([z.int(), z.optional(z.nullable(z.number()))]),
  }),
  z.object({ method: z.enum(["formatRange", "formatRangeToParts"]), args: z.tuple([z.int(), z.number(), z.number()]) }),
]);

/** Create or restore a dependency VM. No project module or host resource may enter its snapshot. */
export async function createExecutionVm({
  wasm,
  extensions,
  modules,
  startedAtMs,
  template,
  onUnhandledRejection,
}: {
  wasm: WebAssembly.Module;
  extensions: NonNullable<QuickJSOptions["extensions"]>;
  modules: Map<string, string>;
  startedAtMs: number;
  template?: DependencyTemplate;
  onUnhandledRejection?: QuickJSOptions["onUnhandledRejection"];
}) {
  let interrupted = false;
  const options = {
    wasm,
    extensions,
    memoryLimit: 192 * 1024 * 1024,
    interruptHandler() {
      interrupted ||= performance.now() - startedAtMs > 20_000;

      return interrupted;
    },
    onUnhandledRejection,
    moduleLoader: {
      normalize(base, name) {
        if (!name.startsWith(".")) {
          throw new Error(`Unapproved QuickJS module import: ${name}`);
        }

        return new URL(name, `file:///${base}`).pathname.slice(1);
      },
      load(name) {
        const source = modules.get(name);

        if (source === undefined) {
          throw new Error(`Missing QuickJS project module: ${name}`);
        }

        return source;
      },
    },
  } satisfies QuickJSOptions;
  const vm = template ? await QuickJS.restore(template, options) : await QuickJS.create(options);
  const logs: z.output<typeof LogSchema>[] = [];
  const intlFormatters: Intl.DateTimeFormat[] = [];
  const callbacks: [string, HostFunction][] = [
    ["probeRandomUUID", () => vm.newString(crypto.randomUUID())],
    [
      "probeRandomBytes",
      (length) => {
        const size = z.int().check(z.minimum(0), z.maximum(65_536)).parse(length.toNumber());

        return vm.hostToHandle(Array.from(crypto.getRandomValues(new Uint8Array(size))));
      },
    ],
    [
      "probeLog",
      (value) => {
        logs.push(LogSchema.parse(JSON.parse(value.toString())));

        return vm.undefined;
      },
    ],
    [
      "probeIntl",
      (operation, values) => {
        const parsed = IntlRequestSchema.safeParse({
          method: operation.toString(),
          args: JSON.parse(values.toString()),
        });

        if (!parsed.success) {
          throw new Error("Unsupported Intl.DateTimeFormat request", { cause: parsed.error });
        }

        const request = parsed.data;

        if (request.method === "create") {
          return vm.newNumber(intlFormatters.push(new Intl.DateTimeFormat(...request.args)) - 1);
        }

        if (request.method === "supportedLocalesOf") {
          return vm.hostToHandle(Intl.DateTimeFormat.supportedLocalesOf(request.args[0] ?? [], request.args[1]));
        }

        const formatter = intlFormatters[request.args[0]];

        if (!formatter) {
          throw new Error(`Unknown Intl formatter: ${request.args[0]}`);
        }

        switch (request.method) {
          case "resolvedOptions":
            return vm.hostToHandle(formatter.resolvedOptions());
          case "format":
            return vm.hostToHandle(formatter.format(request.args[1] ?? undefined));
          case "formatToParts":
            return vm.hostToHandle(formatter.formatToParts(request.args[1] ?? undefined));
          case "formatRange":
            return vm.hostToHandle(formatter.formatRange(request.args[1], request.args[2]));
          case "formatRangeToParts":
            return vm.hostToHandle(formatter.formatRangeToParts(request.args[1], request.args[2]));
        }
      },
    ],
  ];

  try {
    for (const [name, callback] of callbacks) {
      if (template) {
        vm.registerHostCallback(name, callback);
        continue;
      }

      const handle = vm.newFunction(name, callback);
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    }

    if (!template) {
      vm.evalCode(`
        globalThis.console = Object.fromEntries(["log", "warn", "error", "debug", "info"].map(k => [k, (...args) => probeLog(JSON.stringify([k, ...args]))]));
        globalThis.crypto = { randomUUID: probeRandomUUID, getRandomValues: value => {
          if (!ArrayBuffer.isView(value) || !["Uint8Array", "Int8Array", "Uint8ClampedArray", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "BigInt64Array", "BigUint64Array"].some(name => Object.prototype.toString.call(value) === "[object " + name + "]")) throw new TypeError("Expected an integer typed array");
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength).set(probeRandomBytes(value.byteLength));
          return value;
        } };
        globalThis.navigator = { userAgent: "QuickJS-WASI" };
        globalThis.queueMicrotask = callback => Promise.resolve().then(callback);
        globalThis.fetch = () => Promise.reject(new Error("Network access is unavailable in the QuickJS runtime"));
        for (const name of ["Blob", "File", "FormData", "Headers", "Request", "Response", "ReadableStream", "WritableStream", "TransformStream"]) {
          globalThis[name] ??= class { constructor() { throw new Error(name + " is unavailable in the QuickJS runtime"); } };
        }
        globalThis.Intl = {
          DateTimeFormat: class DateTimeFormat {
            constructor(...args) { this.id = probeIntl("create", JSON.stringify(args)); }
            static supportedLocalesOf(...args) { return probeIntl("supportedLocalesOf", JSON.stringify(args)); }
            resolvedOptions() { return probeIntl("resolvedOptions", JSON.stringify([this.id])); }
            get format() { return (...args) => probeIntl("format", JSON.stringify([this.id, ...args])); }
            formatToParts(...args) { return probeIntl("formatToParts", JSON.stringify([this.id, ...args])); }
            formatRange(...args) { return probeIntl("formatRange", JSON.stringify([this.id, ...args])); }
            formatRangeToParts(...args) { return probeIntl("formatRangeToParts", JSON.stringify([this.id, ...args])); }
          },
        };
      `).dispose();
    }

    return { vm, logs, intlFormatters, wasInterrupted: () => interrupted };
  } catch (cause) {
    vm.dispose();
    throw interrupted ? new QuickjsTimeoutError(cause) : cause;
  }
}
