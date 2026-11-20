export { performance } from "unenv/node/perf_hooks";

type AbortListener = () => void;

/** Abort primitives used by guest dependencies when the host VM supplies no DOM APIs. */
export class AbortSignal {
  private readonly listeners = new Map<AbortListener, boolean>();
  aborted = false;
  reason: unknown;

  addEventListener(type: string, listener: AbortListener, options?: { once?: boolean }) {
    if (type === "abort" && !this.listeners.has(listener)) {
      this.listeners.set(listener, options?.once ?? false);
    }
  }

  removeEventListener(type: string, listener: AbortListener) {
    if (type === "abort") {
      this.listeners.delete(listener);
    }
  }

  abort(reason: unknown) {
    if (this.aborted) {
      return;
    }

    this.aborted = true;
    this.reason = reason;

    // Callbacks can register or remove listeners while this snapshot is dispatched.
    const listeners = Array.from(this.listeners);
    for (const [listener, once] of listeners) {
      if (once) {
        this.listeners.delete(listener);
      }
      listener();
    }
  }

  static timeout(delay: number) {
    const signal = new AbortSignal();
    setTimeout(
      () => signal.abort(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" })),
      delay,
    );
    return signal;
  }

  static any(signals: AbortSignal[]) {
    const result = new AbortSignal();
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) {
      result.abort(aborted.reason);
      return result;
    }

    const listeners = signals.map((signal) => {
      const listener = () => {
        for (const [source, callback] of listeners) {
          source.removeEventListener("abort", callback);
        }
        result.abort(signal.reason);
      };

      signal.addEventListener("abort", listener, { once: true });
      return [signal, listener] as const;
    });
    return result;
  }
}

export class AbortController {
  readonly signal = new AbortSignal();

  abort(reason: unknown = Object.assign(new Error("The operation was aborted"), { name: "AbortError" })) {
    this.signal.abort(reason);
  }
}
