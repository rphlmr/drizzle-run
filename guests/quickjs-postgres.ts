import { createPostgresSession } from "../packages/runtime/src/quickjs/postgres-session.ts";
import type { createRunObservation } from "./quickjs-observation.ts";
import { callDatabase } from "./quickjs-sqlite.ts";

/** Share transaction admission and protocol observation across the main and Effect clients. */
export function createPostgresGuestSession(observation: ReturnType<typeof createRunObservation>) {
  return createPostgresSession({
    call: callDatabase,
    connectionObserver: () => observation.connectionObserver(),
    onWaiting: ({ connection, owner }) =>
      console.warn(`PostgreSQL connection ${connection} is waiting for connection ${owner} to finish its transaction`),
  });
}
