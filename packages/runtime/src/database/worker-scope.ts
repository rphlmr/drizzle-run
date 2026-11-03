/**
 * What a runtime worker uses of its global scope: messages in and out, and closing itself
 *
 * The page's `self` type already has these members, so a worker reads its scope without a cast.
 */
export interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}
