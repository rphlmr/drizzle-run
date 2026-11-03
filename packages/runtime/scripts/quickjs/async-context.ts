export { AsyncResource } from "unenv/node/internal/async_hooks/async-resource";

/** Serialized-operation context only. Concurrent async context propagation is outside the QuickJS slice. */
export class AsyncLocalStorage<Store = unknown> {
  private store: Store | undefined;

  run<Args extends unknown[], Result>(store: Store, callback: (...args: Args) => Result, ...args: Args): Result;
  run(store: Store, callback: (...args: never[]) => unknown, ...args: never[]): unknown {
    const previous = this.store;
    this.store = store;
    let result: unknown;

    try {
      result = callback(...args);
    } catch (cause) {
      this.store = previous;
      throw cause;
    }

    if (result instanceof Promise) {
      return result.finally(() => {
        this.store = previous;
      });
    }

    this.store = previous;

    return result;
  }

  getStore() {
    return this.store;
  }

  enterWith(store: Store) {
    this.store = store;
  }

  disable() {
    this.store = undefined;
  }
}

export default { AsyncLocalStorage };
