import { RouterContextProvider, type LoaderFunctionArgs } from "react-router";
import { describe, expect, it } from "vitest";

import { appServicesContext, type AppServices } from "../app-services";
import { createPlaygroundsService } from "./playgrounds-service";
import { loadSharedSnapshot } from "./shared-playground";

/** The loader's arguments for `/s/:snapshotId`, with a Worker that answers every playground as not found. */
function makeLoaderArgs(snapshotId: string): LoaderFunctionArgs {
  const playgrounds = createPlaygroundsService({
    origin: "https://drizzle.run",
    fetch: async () =>
      Response.json(
        { error: { code: "playground_not_found", message: "This shared playground does not exist." } },
        { status: 404 },
      ),
  });
  const context = new RouterContextProvider();
  context.set(appServicesContext, { playgrounds } as AppServices);

  const url = new URL(`https://drizzle.run/s/${snapshotId}`);

  return { params: { snapshotId }, context, request: new Request(url), url, pattern: "/s/:snapshotId" };
}

describe("loadSharedSnapshot", () => {
  it("should open a link the Worker does not know as not found", async () => {
    expect(await loadSharedSnapshot(makeLoaderArgs("abc123"))).toMatchObject({ status: "not_found" });
  });

  it("should open a link with a character no share id has as not found, not as a load to retry", async () => {
    expect(await loadSharedSnapshot(makeLoaderArgs("abc123."))).toEqual({
      status: "not_found",
      error: "This shared playground does not exist.",
    });
  });
});
