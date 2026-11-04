import { serializeValue } from "@drizzle-run/core/contracts";

import { expect, test } from "./fixtures";
import { readOfficialExamples } from "./official-examples";
import { groupDisplaysByLabel, runStoredProject } from "./run-project";

for (const dialect of ["postgresql", "sqlite"] as const) {
  test(`should decode root and nested PlainDate columns through rc.5 codecs on ${dialect}`, async ({ page }) => {
    const manifest = readOfficialExamples().find(({ slug }) => slug === `temporal-bookings-${dialect}`)?.manifest;

    if (!manifest || manifest.kind !== "drizzle-run") {
      throw new Error(`Missing single-project temporal-bookings-${dialect} example.`);
    }

    await page.goto("/");
    const result = await runStoredProject(page, `Temporal codecs ${dialect}`, {
      ...manifest,
      files: {
        ...manifest.files,
        "schema.ts": `import { defineRelations } from "drizzle-orm";
${manifest.files["schema.ts"]}
export const relations = defineRelations({ bookings }, (r) => ({
  bookings: {
    self: r.one.bookings({ from: r.bookings.id, to: r.bookings.id, optional: false }),
  },
}));
`,
        "query.ts": `import { db } from "@drizzle-run/runtime/context";
import { Temporal } from "@js-temporal/polyfill";
import { EmptyFilter } from "drizzle-orm";

const rows = await db.query.bookings.findMany({
  where: EmptyFilter,
  columns: { id: true, startsOn: true, followUp: true },
  with: { self: { columns: { startsOn: true, followUp: true } } },
  orderBy: { id: "asc" },
});

$.display("Decoded dates", rows.map((row) => ({
  id: row.id,
  rootIsTemporal: row.startsOn instanceof Temporal.PlainDate,
  nestedIsTemporal: row.self.startsOn instanceof Temporal.PlainDate,
  date: row.startsOn.toString(),
  nestedDate: row.self.startsOn.toString(),
  nextDay: row.self.startsOn.add({ days: 1 }).toString(),
  followUp: row.self.followUp?.toString() ?? null,
})));
`,
      },
    });

    expect(result.outcome, result.error?.message).toBe("succeeded");
    expect(groupDisplaysByLabel(result)["Decoded dates"]).toEqual([
      serializeValue([
        {
          id: 1,
          rootIsTemporal: true,
          nestedIsTemporal: true,
          date: "2024-02-28",
          nestedDate: "2024-02-28",
          nextDay: "2024-02-29",
          followUp: null,
        },
        {
          id: 2,
          rootIsTemporal: true,
          nestedIsTemporal: true,
          date: "2024-02-29",
          nestedDate: "2024-02-29",
          nextDay: "2024-03-01",
          followUp: "2024-03-01",
        },
      ]),
    ]);
  });
}
