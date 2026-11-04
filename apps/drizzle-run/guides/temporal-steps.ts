import type { Dialect } from "@drizzle-run/core/catalog";
import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "./example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "./meta.ts";

const decodedQuery =
  'import { db } from "@drizzle-run/runtime/context";\nimport { Temporal } from "@js-temporal/polyfill";\n\nimport { bookings } from "./schema";\n\nconst rows = await db.select().from(bookings).orderBy(bookings.id);\n\n// Display strings for readability; the selected values are real PlainDate objects.\n$.display("Decoded dates", rows.map((row) => ({\n  title: row.title,\n  startsOn: row.startsOn.toString(),\n  nextDay: row.startsOn.add({ days: 1 }).toString(),\n  followUp: row.followUp?.toString() ?? null,\n  isTemporal: row.startsOn instanceof Temporal.PlainDate,\n})));\n';

/** Teach a PlainDate column using native PostgreSQL dates or canonical SQLite text. */
export function createTemporalGuide({ id, exampleId, dialect }: { id: string; exampleId: string; dialect: Dialect }) {
  const slug = `temporal-custom-type-${dialect}`;
  const other = dialect === "postgresql" ? "sqlite" : "postgresql";
  const database = dialect === "postgresql" ? "PostgreSQL" : "SQLite";
  const complete = readExampleFiles(`temporal-bookings-${dialect}`, ["schema.ts", "seed.ts", "query.ts"]);
  const storage =
    dialect === "postgresql"
      ? "PostgreSQL uses its native `date` type. The custom column selects the rc.5 `date:string` codec so `fromDriver` receives text rather than a JavaScript Date."
      : "SQLite uses text because it has no dedicated date storage class. The custom type writes canonical ISO dates. SQLite text alone does not validate calendar dates, so other writers must keep that contract too.";

  return defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id,
    title: `Store Temporal dates with a custom type (${database})`,
    description:
      "Convert between SQL values and Temporal.PlainDate, preserve nullability, and bind typed date filters.",
    project: defineRunManifest({
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      files: readExampleFiles(slug, ["schema.ts", "seed.ts", "query.ts", "temporal.ts"]),
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    }),
    steps: [
      {
        type: "walkthrough",
        id: "01-strings",
        label: "Start with strings",
        title: "A calendar date is not an instant",
        body: `This guide uses ${database} and Drizzle ORM **1.0.0-rc.5**. A booking day means a calendar date, without a time of day or time zone. \`Temporal.PlainDate\` represents that concept.\n\nStart with string dates. Press **Run**: the two bookings contain \`2024-02-28\` and \`2024-02-29\`, with a nullable follow-up date. The strings cannot perform calendar arithmetic themselves.\n\nThe playground includes \`@js-temporal/polyfill@0.5.1\`. In your own app, install it with \`pnpm add @js-temporal/polyfill\` to use these imports. A runtime with native Temporal can use its global instead; the playground's isolated engine needs the explicit polyfill.`,
        focus: { file: "schema.ts", lines: [3, 8] },
        run: "required",
        highlight: { displays: ["String dates"] },
        links: [{ label: "Custom column types", href: "https://orm.drizzle.team/docs/custom-types" }],
        meta: {
          summary: "Choose a calendar-date model and inspect the initial SQL strings.",
          changed: "Two bookings return string dates, including a null follow-up.",
        },
      },
      {
        type: "walkthrough",
        id: "02-custom",
        label: "Convert values",
        title: "Make the selected value a real PlainDate",
        body: `Open \`temporal.ts\`. \`customType\` declares \`Temporal.PlainDate\` as the application value and a string as the driver value. \`toDriver\` serializes inserts and bound query values; \`fromDriver\` reconstructs selected dates. The column's \`codec\` handles its database representation, including JSON query paths, before \`fromDriver\` builds the PlainDate.\n\n${storage}\n\nPress **Run**. \`isTemporal\` is true, and adding a day to February 28 returns February 29. The nullable follow-up stays null. Results display strings for readability, but the query calls \`add()\` on actual selected PlainDate objects. A \`$type<Temporal.PlainDate>()\` annotation by itself would not perform these conversions.`,
        edits: [
          { file: "schema.ts", write: complete["schema.ts"] },
          { file: "seed.ts", write: complete["seed.ts"] },
          { file: "query.ts", write: decodedQuery },
        ],
        focus: { file: "temporal.ts", lines: [5, 24] },
        run: "required",
        highlight: { displays: ["Decoded dates"] },
        meta: {
          summary: "Serialize PlainDate on writes and reconstruct it on reads.",
          changed: "Both selected dates are PlainDate instances; leap-day arithmetic and null handling work.",
        },
      },
      {
        type: "walkthrough",
        id: "03-query",
        label: "Typed queries",
        title: "Insert and filter with Temporal values",
        body: "The query inserts a March booking using the result of `leapDay.add({ days: 1 })`, then filters with `gte(bookings.startsOn, leapDay)`. Drizzle binds the value through the column's encoder; the database still compares stored dates.\n\nPress **Run**. The filter returns the leap-day session and the March session. Hover over `bookings.$inferInsert` or the query results in the editor: required dates use PlainDate, and the nullable follow-up allows null. Strings and JavaScript Date objects are not the custom column's application input type.\n\nThis helper deliberately supports ISO-calendar dates with years 0001–9999. It rejects other calendars and years before writing, keeping SQLite's canonical text ordering and the stored representation consistent.",
        edits: [{ file: "query.ts", write: complete["query.ts"] }],
        focus: { file: "query.ts", lines: [18, 28] },
        run: "required",
        highlight: { displays: ["Bookings from leap day"] },
        meta: {
          summary: "Use the custom type for insert inference, query parameters and selected objects.",
          changed: "The leap-day filter returns two bookings using a bound PlainDate parameter.",
        },
      },
      {
        type: "walkthrough",
        id: "04-starter",
        label: "Use the starter",
        title: "Keep storage and application types distinct",
        body: "A custom column changes how your application reads and writes a SQL value. It does not create a new SQL date concept or make every raw SQL expression run its decoder. Validate external input before constructing the values you write.\n\nPlainDate covers calendar dates. Exact instants and zoned schedules need different representations. A later Instant example would also need an explicit precision policy: PostgreSQL timestamps support microseconds, while Temporal can represent nanoseconds.\n\nOpen the complete booking starter to reuse the custom column without the guide's initial string version.",
        run: "none",
        links: [
          { label: "Complete Temporal booking starter", href: `/examples/temporal-bookings-${dialect}` },
          { label: "The other database", href: `/examples/temporal-custom-type-${other}` },
          { label: "Database checks", href: `/examples/check-constraints-${dialect}` },
        ],
        meta: { summary: "Reuse the PlainDate column and keep its supported storage contract explicit." },
      },
    ],
    meta: { slug, status: "published", example: exampleId },
  });
}
