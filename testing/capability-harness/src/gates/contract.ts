import assert from "node:assert/strict";

import type { RunResult } from "../../../../packages/core/src/contracts/index.ts";
import type { Dialect } from "../../../../packages/core/src/releases/dialects.ts";
import type { GuestPackage } from "../../../../scripts/guests/guest-packages.ts";

export type { Dialect };

/** The API families implemented by the committed acceptance fixtures. */
export type HarnessPair = Pick<GuestPackage, "id" | "ormVersion" | "kitVersion"> & {
  guestFlavor: "slim" | "effect";
  ormApi: "v0" | "v1";
  kitApi: "v0" | "v1";
};

/** A settled public SDK run and its retained events. */
export interface GateRun {
  report: RunResult;
  events: RunResult["events"];
}

/** Refuse a guest API family until the corpus has fixtures for it. */
export function getHarnessPair(image: GuestPackage): HarnessPair {
  const { id, ormVersion, kitVersion, ormApi, kitApi, guestFlavor } = image;
  assert.ok(ormApi === "v0" || ormApi === "v1", `No ORM corpus supports API ${ormApi} (guest ${id})`);
  assert.ok(kitApi === "v0" || kitApi === "v1", `No Kit corpus supports API ${kitApi} (guest ${id})`);
  assert.ok(guestFlavor === "slim" || guestFlavor === "effect", `No corpus supports flavor ${guestFlavor}`);

  return { id, ormVersion, kitVersion, ormApi, kitApi, guestFlavor };
}
