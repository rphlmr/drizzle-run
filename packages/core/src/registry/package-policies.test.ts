import { describe, expect, it } from "vitest";

import { EFFECT_PACKAGE_NAMES, GUEST_IMAGES, getGuestPackageVersion } from "../releases/catalog.ts";
import {
  GUEST_PACKAGE_POLICIES,
  getGuestPackagePolicy,
  getUserModuleSpecifiers,
  type UserModulePolicy,
} from "./package-policies.ts";

describe("GUEST_PACKAGE_POLICIES", () => {
  it("should cover every package a guest pins", () => {
    const unpoliced = Object.entries(GUEST_IMAGES).flatMap(([imageId, image]) =>
      Object.keys(image.packages)
        .filter((packageName) => getGuestPackagePolicy(packageName) === null)
        .map((packageName) => `${imageId}: ${packageName}`),
    );

    expect(unpoliced).toEqual([]);
  });

  it("should give Effect policies exactly to the effect packages", () => {
    const effectOnly = Object.entries(GUEST_PACKAGE_POLICIES)
      .filter(([, policy]) => policy.role === "user_module" && "guestFlavors" in policy)
      .map(([packageName]) => packageName);

    expect(effectOnly).toEqual([...EFFECT_PACKAGE_NAMES]);
  });
});

/** The version-keyed specifiers of a policy; empty when it has none. */
function getVersionSpecifiers(policy: UserModulePolicy): Readonly<Record<string, readonly string[]>> {
  return policy.specifiersByVersion ?? {};
}

describe("getUserModuleSpecifiers", () => {
  const effectPolicy: UserModulePolicy = {
    role: "user_module",
    specifiers: ["effect", "effect/unstable/sql/SqlClient"],
    specifiersByVersion: { "4.0.5": ["effect", "effect/sql/SqlClient"] },
  };

  it("should take a version's own specifiers when the policy lists them", () => {
    expect(getUserModuleSpecifiers(effectPolicy, "4.0.5")).toEqual(["effect", "effect/sql/SqlClient"]);
  });

  it("should take the policy's specifiers for any other version", () => {
    expect(getUserModuleSpecifiers(effectPolicy, "4.0.0-beta.83")).toEqual(["effect", "effect/unstable/sql/SqlClient"]);
    expect(getUserModuleSpecifiers({ role: "user_module", specifiers: ["zod"] }, "4.4.3")).toEqual(["zod"]);
  });

  it("should key version specifiers only by versions a guest pins", () => {
    const stale = Object.entries(GUEST_PACKAGE_POLICIES).flatMap(([packageName, policy]) => {
      const policyVersions = policy.role === "user_module" ? Object.keys(getVersionSpecifiers(policy)) : [];
      const pinnedVersions = new Set(
        Object.keys(GUEST_IMAGES).map((imageId) => getGuestPackageVersion({ imageId, packageName })),
      );

      return policyVersions
        .filter((version) => !pinnedVersions.has(version))
        .map((version) => `${packageName}@${version}`);
    });

    expect(stale).toEqual([]);
  });
});
