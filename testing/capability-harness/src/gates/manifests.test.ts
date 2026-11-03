import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { readGuestPackages } from "../../../../scripts/guests/guest-packages.ts";
import { getHarnessPair } from "./contract.ts";
import { createAcceptanceManifest } from "./fixtures.ts";
import { createOrmCorpusManifest } from "./orm-corpus.ts";

void describe("Harness guest selection", () => {
  void it("should retain each selected image in every acceptance and ORM manifest", async () => {
    const guests = await readGuestPackages(fileURLToPath(new URL("../../../../guests/", import.meta.url)));

    for (const guest of guests) {
      const pair = getHarnessPair(guest);
      assert.equal(pair.guestFlavor, guest.guestFlavor);

      for (const dialect of ["sqlite", "postgresql"] as const) {
        for (const kind of [
          "full",
          "failure",
          "failed_query",
          "package_outside_schema",
          "query_plans",
          "recovery",
        ] as const) {
          const manifest = createAcceptanceManifest({ pair, dialect, kind });
          assert.equal(manifest.guestFlavor ?? "slim", guest.guestFlavor, `${guest.id} ${dialect} ${kind}`);
        }

        const manifest = createOrmCorpusManifest(pair, dialect);
        assert.equal(manifest.guestFlavor ?? "slim", guest.guestFlavor, `${guest.id} ${dialect} ORM`);
      }
    }
  });
});
