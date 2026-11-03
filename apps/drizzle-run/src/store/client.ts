import type { StoreArgs, StoreOperationName, StoreRequest, StoreResponse, StoreResults } from "./service";

/** Where store requests go: the store worker, or a message port in tests. */
export interface StorePort {
  postMessage<Name extends StoreOperationName>(message: StoreRequest<Name>): void;
  addEventListener(type: "message", listener: (event: MessageEvent<StoreResponse>) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
}

/** Calls store operations; each call is one message to the store worker and one transaction there. */
export interface StoreClient {
  call<Name extends StoreOperationName>(operation: Name, ...args: StoreArgs[Name]): Promise<StoreResults[Name]>;
  /** Set once the port failed, such as a worker script that could not load. Every later call rejects. */
  readonly failure: Error | undefined;
}

/**
 * Create a store client over a port
 *
 * A call posts its request at once, without waiting for an earlier one, so a save sent while the page unloads is
 * already with the worker. When the port reports an error, pending and later calls reject with it.
 */
export function createStoreClient(port: StorePort): StoreClient {
  // The worker answers each id with the result of the operation it was sent, which no type can check across
  // threads: a call's `resolve` takes that operation's result.
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let failure: Error | undefined;

  port.addEventListener("message", (event) => {
    const response = event.data;
    const request = pending.get(response.id);

    if (request === undefined) {
      return;
    }

    pending.delete(response.id);

    if (response.ok) {
      request.resolve(response.result);
    } else {
      request.reject(Object.assign(new Error(response.error.message), { name: response.error.name }));
    }
  });
  port.addEventListener("error", (event) => {
    // A worker script that failed to load reports an ErrorEvent with a message; other ports may not.
    const reason = "message" in event && typeof event.message === "string" ? event.message : "";
    const message = reason || "The local store did not start.";
    failure = new Error(`Local storage is unavailable: ${message}`);

    for (const request of pending.values()) {
      request.reject(failure);
    }

    pending.clear();
  });

  function call<Name extends StoreOperationName>(operation: Name, ...args: StoreArgs[Name]) {
    return new Promise<StoreResults[Name]>((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure);
        return;
      }

      const id = nextId++;
      const request: StoreRequest<Name> = { id, operation, args };
      pending.set(id, { resolve, reject });
      port.postMessage(request);
    });
  }

  return {
    call,
    get failure() {
      return failure;
    },
  };
}

const clients = new Map<string, StoreClient>();

/**
 * Get the client of this tab's store worker for a store name
 *
 * One worker per store name and tab; storages that share a name share it. A worker that failed to start is replaced
 * on the next call, so Retry can recover.
 */
export function getStoreClient(storeName: string): StoreClient {
  const existing = clients.get(storeName);

  if (existing !== undefined && existing.failure === undefined) {
    return existing;
  }

  const worker = new Worker(new URL("./store.worker.ts", import.meta.url), { type: "module", name: storeName });
  const client = createStoreClient(worker);
  clients.set(storeName, client);

  return client;
}
