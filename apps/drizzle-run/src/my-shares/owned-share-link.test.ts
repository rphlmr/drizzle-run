import { describe, expect, it } from "vitest";

import type { CommunityShare } from "../community/contract";
import { toOwnedShareLink } from "./owned-share-link";

const linkId = "123e4567-e89b-42d3-a456-426614174000";

function makeListing({ description = null }: { description?: string | null } = {}): CommunityShare {
  return {
    id: linkId,
    title: "Users",
    description,
    topic: "bug-repros",
    releasePair: { dialect: "sqlite", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
    files: ["query.ts"],
    listedAt: "2026-10-11T00:00:00.000Z",
    owner: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
  };
}

describe("toOwnedShareLink", () => {
  it("should point at the share, and keep no description or listing it lacks", () => {
    expect(
      toOwnedShareLink(linkId, {
        updatedAt: "2026-10-12T00:00:00.000Z",
        digest: "a".repeat(64),
        description: null,
        community: null,
      }),
    ).toEqual({ linkId, publishedAt: "2026-10-12T00:00:00.000Z", publishedDigest: "a".repeat(64) });
  });

  it("should keep the description and the Community listing, so the next push starts from them", () => {
    expect(
      toOwnedShareLink(linkId, {
        updatedAt: "2026-10-12T00:00:00.000Z",
        digest: "a".repeat(64),
        description: "Soft deletes.",
        community: makeListing({ description: "On the card." }),
      }),
    ).toEqual({
      linkId,
      publishedAt: "2026-10-12T00:00:00.000Z",
      publishedDigest: "a".repeat(64),
      description: "Soft deletes.",
      listing: { topic: "bug-repros", description: "On the card." },
    });
  });
});
