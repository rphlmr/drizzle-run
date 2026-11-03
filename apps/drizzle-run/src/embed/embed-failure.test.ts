import { describe, expect, it } from "vitest";

import { PlaygroundNotFoundError } from "../share/playgrounds-contract";
import { EmbedTargetNotFoundError, getEmbedFailureTitle, toEmbedLoadFailure } from "./embed-failure";

describe("toEmbedLoadFailure", () => {
  it("should report a shared link that answered 404 as not found", () => {
    const failure = toEmbedLoadFailure(new PlaygroundNotFoundError("This shared playground could not be found."));

    expect(failure).toEqual({ code: "not_found", message: "This shared playground could not be found." });
    expect(getEmbedFailureTitle(failure)).toBe("This playground no longer exists");
  });

  it("should report an unknown example or guide step as not found", () => {
    expect(toEmbedLoadFailure(new EmbedTargetNotFoundError("This example or guide step does not exist."))).toEqual({
      code: "not_found",
      message: "This example or guide step does not exist.",
    });
  });

  it("should report any other failure as a load failure a retry may fix", () => {
    const failure = toEmbedLoadFailure(
      new Error("The playground request failed. Check your connection and try again."),
    );

    expect(failure).toEqual({
      code: "application_load",
      message: "The playground request failed. Check your connection and try again.",
    });
    expect(getEmbedFailureTitle(failure)).toBe("Could not load this playground");
    expect(toEmbedLoadFailure("offline")).toEqual({
      code: "application_load",
      message: "Drizzle Run could not initialize this playground.",
    });
  });
});
