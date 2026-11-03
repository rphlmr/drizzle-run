import { describe, expect, it } from "vitest";

import { APPROVED_MODULES, listApprovedModules } from "../registry/approved-modules.ts";
import { listSupportedTuples } from "../registry/selectors.ts";
import { EFFECT_PACKAGE_NAMES, GUEST_FLAVORS, RELEASE_PAIRS, type GuestFlavor } from "./catalog.ts";
import { GUEST_IMAGES, HOST_ENGINES } from "./guest-catalog.generated.ts";

interface GeneratedGuestImage {
  readonly pairId: string;
  readonly releaseLine: string;
  readonly recommended: boolean;
  readonly guestFlavor: GuestFlavor;
  readonly ormVersion: string;
  readonly kitVersion: string;
  readonly ormApi: string;
  readonly kitApi: string;
  readonly packages: Readonly<Record<string, string>>;
  readonly lockDigest: string;
}

const guestImages: ReadonlyArray<readonly [string, GeneratedGuestImage]> = Object.entries(GUEST_IMAGES);

describe("generated guest catalog", () => {
  it("should group the guest images into the release pairs", () => {
    const pairs = Object.fromEntries(
      Object.keys(RELEASE_PAIRS).map((pairId) => {
        const images = guestImages.filter(([, image]) => image.pairId === pairId).map(([, image]) => image);
        const slim = images.find((image) => image.guestFlavor === "slim");

        return [
          pairId,
          {
            releaseLine: slim?.releaseLine,
            ormVersion: slim?.ormVersion,
            kitVersion: slim?.kitVersion,
            recommended: slim?.recommended,
            guestFlavors: GUEST_FLAVORS.filter((flavor) => images.some((image) => image.guestFlavor === flavor)),
          },
        ];
      }),
    );

    expect(pairs).toEqual(RELEASE_PAIRS);
    expect(new Set(guestImages.map(([, image]) => image.pairId))).toEqual(new Set(Object.keys(RELEASE_PAIRS)));
  });

  it("should give each image its pair id and a lock digest", () => {
    for (const [imageId, image] of guestImages) {
      const flavorSuffix = image.guestFlavor === "slim" ? "" : `+${image.guestFlavor}`;

      expect(imageId).toBe(`${image.pairId}${flavorSuffix}`);
      expect(image.pairId).toBe(`orm-${image.ormVersion}__kit-${image.kitVersion}`);
      expect(image.packages["drizzle-orm"]).toBe(image.ormVersion);
      expect(image.packages["drizzle-kit"]).toBe(image.kitVersion);
      expect(image.lockDigest).toMatch(/^sha256-[0-9a-f]{64}$/);
    }
  });

  it("should pin the Effect packages only in the effect flavor", () => {
    for (const [imageId, image] of guestImages) {
      const effectPackageNames = EFFECT_PACKAGE_NAMES.filter((name) => image.packages[name] !== undefined);

      expect(effectPackageNames, imageId).toEqual(image.guestFlavor === "effect" ? EFFECT_PACKAGE_NAMES : []);
    }
  });

  it("should pin exactly the approved user modules, the ORM, Kit and database clients of each image", () => {
    for (const [imageId, image] of guestImages) {
      const tuples = listSupportedTuples().filter(
        (tuple) => tuple.ormVersion === image.ormVersion && tuple.kitVersion === image.kitVersion,
      );
      const approvedUserPins = Object.fromEntries(
        tuples.flatMap((tuple) =>
          listApprovedModules({ tuple, guestFlavor: image.guestFlavor })
            .filter((module) => module.visibility === "user" && module.packageName !== "@drizzle-run/runtime")
            .map((module) => [module.packageName, module.version]),
        ),
      );
      const expected = {
        ...approvedUserPins,
        "drizzle-orm": image.ormVersion,
        "drizzle-kit": image.kitVersion,
        pg: image.packages.pg,
        "@libsql/client": image.packages["@libsql/client"],
      };

      expect(image.packages.pg, imageId).toBeDefined();
      expect(image.packages["@libsql/client"], imageId).toBeDefined();
      expect(image.packages, imageId).toEqual(expected);
    }
  });

  it("should read the host engines at their approved versions", () => {
    const approvedEngines = Object.fromEntries(
      APPROVED_MODULES.filter((module) => module.runtimeArtifact.loader === "database_engine").map((module) => [
        module.packageName,
        module.version,
      ]),
    );

    expect(HOST_ENGINES).toEqual(approvedEngines);
  });
});
