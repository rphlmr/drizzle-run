import type { Subscription } from "./run-contract.ts";

/** A submission that could not start. */
export class RunRefusedError extends Error {
  override name = "RunRefusedError";

  constructor(
    readonly requester: string,
    problem?: string,
  ) {
    super(problem ?? "A run is already going. Try again once it finishes.");
  }
}

/** The controller is disposed or stopped before the requested operation completed. */
export class RunStoppedError extends Error {
  override name = "RunStoppedError";

  constructor() {
    super("The run controller closed before the operation completed.");
  }
}

/** Internal request correlation shared by the two concrete controllers. */
export interface AnswerSource<Outcome extends { requestId: string }> {
  onSettled(listener: (outcome: Outcome) => void): Subscription;
  onRefused(listener: (requestId: string, problem?: string) => void): Subscription;
  onStopped(listener: (cause?: unknown) => void): Subscription;
  cancel(requestId: string): void;
  send(request: { requestId: string; requester: string }): void;
}

export function request<Outcome extends { requestId: string }>({
  source,
  requester,
  signal,
}: {
  source: AnswerSource<Outcome>;
  requester: string;
  signal: AbortSignal | undefined;
}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const requestId = crypto.randomUUID();
    const cancel = () => source.cancel(requestId);
    const subscriptions: Subscription[] = [];

    function stopListening() {
      signal?.removeEventListener("abort", cancel);

      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    }

    subscriptions.push(
      source.onSettled((outcome) => {
        if (outcome.requestId === requestId) {
          stopListening();
          resolve(outcome);
        }
      }),
      source.onRefused((refusedId, problem) => {
        if (refusedId === requestId) {
          stopListening();
          reject(new RunRefusedError(requester, problem));
        }
      }),
      source.onStopped((cause) => {
        stopListening();
        reject(cause ?? new RunStoppedError());
      }),
    );
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      source.send({ requestId, requester });
    } catch (cause) {
      stopListening();
      reject(cause);
    }
  });
}
