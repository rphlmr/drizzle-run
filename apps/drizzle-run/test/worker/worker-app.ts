import { createD1WorkerServices, createWorkerApp, type WorkerServices } from "../../worker/app";
import type { WorkerEnvironment } from "../../worker/platform";

/**
 * Answer a request with the Worker's routes
 *
 * Runs the Worker's own services, except those `services` replaces, such as ones with a fixed clock.
 */
export async function fetchWorker(
  request: Request,
  environment: WorkerEnvironment,
  services: Partial<WorkerServices> = {},
): Promise<Response> {
  return createWorkerApp({ ...createD1WorkerServices(), ...services }).fetch(request, environment);
}
