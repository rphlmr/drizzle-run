import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { groupDisplaysByLabel, runStoredProject } from "./run-project";

/**
 * Drizzle's Effect integrations run on the rc.5 effect guest, chosen only when a project's `guestFlavor` is
 * `effect`. Effect Schema validates rows, and the Effect query API runs on the playground's database: through
 * `db.$client` on SQLite, and on its own observed wire connection (`postgresConnection`) on PostgreSQL, so its SQL
 * shows up either way. Every other project keeps the slim guest.
 */

const SCHEMA = {
  postgresql: `import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const users = pgTable("users", { id: serial().primaryKey(), name: text().notNull(), age: integer() });
`,
  sqlite: `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", { id: integer().primaryKey(), name: text().notNull(), age: integer() });
`,
};

const QUERY = {
  postgresql: `import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { eq } from "drizzle-orm";
import { postgresConnection } from "@drizzle-run/runtime/context";
import { users } from "./schema";

const UserInsert = createInsertSchema(users);
const UserSelect = createSelectSchema(users);
const ada = Schema.decodeUnknownSync(UserInsert)({ name: "Ada", age: 36 });
const rejected = Schema.decodeUnknownExit(UserInsert)({ age: "old" });

const program = Effect.gen(function* () {
  const effectDb = yield* PgDrizzle.makeWithDefaults();
  yield* effectDb.insert(users).values([ada, { name: "Linus", age: 54 }]);
  const rows = yield* effectDb.select().from(users).where(eq(users.name, "Ada"));
  return rows.map((row) => Schema.decodeUnknownSync(UserSelect)(row));
});
const clientLayer = PgClient.layerFrom(PgClient.makeClient(postgresConnection));
const rows = await Effect.runPromise(program.pipe(Effect.provide(clientLayer)));

$.display("Effect", { rows, rejected: rejected._tag });
`,
  sqlite: `import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as LibsqlDrizzle from "drizzle-orm/effect-libsql";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

const UserInsert = createInsertSchema(users);
const UserSelect = createSelectSchema(users);
const grace = Schema.decodeUnknownSync(UserInsert)({ name: "Grace", age: 85 });
const rejected = Schema.decodeUnknownExit(UserInsert)({ age: "old" });

const program = Effect.gen(function* () {
  const effectDb = yield* LibsqlDrizzle.makeWithDefaults();
  yield* effectDb.insert(users).values(grace);
  const rows = yield* effectDb.select().from(users);
  return rows.map((row) => Schema.decodeUnknownSync(UserSelect)(row));
});
const rows = await Effect.runPromise(program.pipe(Effect.provide(LibsqlClient.layer({ liveClient: db.$client }))));

$.display("Effect", { rows, rejected: rejected._tag });
`,
};

interface GuestReadyWindow extends Window {
  __guestKitLoadMs?: number[];
}

const SLIM_GUEST = /\/quickjs\/orm-1\.0\.0-rc\.5__kit-1\.0\.0-rc\.5\/(?:postgresql|sqlite)\/execution\.guest\.js$/;
const EFFECT_GUEST =
  /\/quickjs\/orm-1\.0\.0-rc\.5__kit-1\.0\.0-rc\.5\+effect\/(?:postgresql|sqlite)\/execution\.guest\.js$/;

/** The dependency bundles the page downloads, by URL. */
function recordGuestDownloads(page: Page): string[] {
  const urls: string[] = [];

  page.on("request", (request) => {
    if (
      /\/runtime-assets\/[^/]+\/quickjs\/[^/]+\/(?:postgresql|sqlite)\/execution\.guest\.js$/.test(
        new URL(request.url()).pathname,
      )
    ) {
      urls.push(request.url());
    }
  });

  return urls;
}

/** The text of each editor line TypeScript underlines as an error, read from Monaco's rendered lines. */
async function getErrorLines(page: Page): Promise<string[]> {
  return page
    .locator(".monaco-editor")
    .first()
    .evaluate((editor) => {
      const lineTexts = new Map(
        [...editor.querySelectorAll<HTMLElement>(".view-lines .view-line")].map((line) => [
          line.style.top,
          line.textContent?.replaceAll("\u00a0", " ").trim() ?? "",
        ]),
      );
      const errorTops = [...editor.querySelectorAll(".view-overlays .squiggly-error")].map(
        (squiggle) => (squiggle.parentElement as HTMLElement).style.top,
      );

      // Firefox can render one inserted line twice under Playwright's insertText, so lines are unique by text.
      return [...new Set(errorTops.map((top) => lineTexts.get(top) ?? ""))].toSorted();
    });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const kitLoadMs: number[] = [];
    (window as GuestReadyWindow).__guestKitLoadMs = kitLoadMs;
    const NativeMessageChannel = window.MessageChannel;
    window.MessageChannel = class extends NativeMessageChannel {
      constructor() {
        super();
        this.port1.addEventListener("message", (event: MessageEvent<{ kind?: string; kitLoadMs?: number }>) => {
          if (event.data?.kind === "ready" && typeof event.data.kitLoadMs === "number") {
            kitLoadMs.push(event.data.kitLoadMs);
          }
        });
      }
    };
  });
});

for (const dialect of ["postgresql", "sqlite"] as const) {
  test(`should run a ${dialect} rc.5 project without effect on the slim guest`, async ({ page }, testInfo) => {
    const guestDownloads = recordGuestDownloads(page);
    await page.goto("/projects");

    const result = await runStoredProject(page, `Plain ${dialect}`, {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: {
        "schema.ts": SCHEMA[dialect],
        "query.ts":
          'import { db } from "@drizzle-run/runtime/context";\nimport { users } from "./schema";\n\nawait db.insert(users).values({ name: "Ada" });\n$.display("Rows", await db.select().from(users));\n',
      },
    });
    const kitLoadMs = await page.evaluate(() => (window as GuestReadyWindow).__guestKitLoadMs);

    console.log(`[${testInfo.project.name}] slim ${dialect} kitLoadMs: ${JSON.stringify(kitLoadMs)}`);
    expect(result.error ?? null).toBeNull();
    expect(guestDownloads.length).toBeGreaterThan(0);
    expect(
      guestDownloads.every((url) => SLIM_GUEST.test(url)),
      guestDownloads.join(", "),
    ).toBe(true);
  });

  test(`should run Effect Schema and the Effect query API on the ${dialect} effect guest`, async ({
    page,
  }, testInfo) => {
    const guestDownloads = recordGuestDownloads(page);
    await page.goto("/projects");

    const result = await runStoredProject(page, `Effect ${dialect}`, {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      guestFlavor: "effect",
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: { "schema.ts": SCHEMA[dialect], "query.ts": QUERY[dialect] },
    });
    const [effect] = groupDisplaysByLabel(result)["Effect"] ?? [];
    const kitLoadMs = await page.evaluate(() => (window as GuestReadyWindow).__guestKitLoadMs);
    const sql = result.sql.map((statement) => statement.sql);

    console.log(`[${testInfo.project.name}] effect ${dialect} kitLoadMs: ${JSON.stringify(kitLoadMs)}`);
    expect(result.error ?? null).toBeNull();
    expect(JSON.stringify(effect)).toContain(dialect === "postgresql" ? "Ada" : "Grace");
    expect(JSON.stringify(effect)).toContain("Failure");
    expect(sql.some((statement) => statement.startsWith('select "id", "name", "age" from "users"'))).toBe(true);

    if (dialect === "postgresql") {
      expect(result.sql).toContainEqual(
        expect.objectContaining({
          sql: expect.stringMatching(/^insert into "users"/),
          parameters: [
            { type: "primitive", value: "Ada" },
            { type: "primitive", value: 36 },
            { type: "primitive", value: "Linus" },
            { type: "primitive", value: 54 },
          ],
          outcome: "succeeded",
          rowCount: 2,
        }),
      );
    }

    expect(
      guestDownloads.some((url) => EFFECT_GUEST.test(url)),
      guestDownloads.join(", "),
    ).toBe(true);

    await page.getByRole("tab", { name: "query.ts" }).click();
    await expect.poll(() => getErrorLines(page), { timeout: 60_000 }).toEqual([]);
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.insertText('\nconst typeProbe: number = Effect.succeed("text");\n');
    await expect
      .poll(() => getErrorLines(page), { timeout: 60_000 })
      .toEqual(['const typeProbe: number = Effect.succeed("text");']);
  });
}

test("should switch a project to the Effect row and back from the release picker", async ({ page }) => {
  const guestDownloads = recordGuestDownloads(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("Effect from the picker");
  await page.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "SQLite" }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();

  const run = page.getByRole("button", { name: "Run", exact: true });
  const chip = page.getByRole("contentinfo").getByRole("button", { name: /^Drizzle version/ });
  const picker = page.getByRole("dialog", { name: "Drizzle version" });
  const rcGroup = picker.getByRole("group", { name: "RC" });

  await expect(run).toBeEnabled({ timeout: 120_000 });
  await expect(chip).not.toContainText("Effect");

  await chip.click();
  await expect(rcGroup.getByRole("button")).toHaveCount(2);
  await expect(rcGroup.getByRole("button").nth(1)).toHaveAccessibleName(
    "RC, orm 1.0.0-rc.5 · kit 1.0.0-rc.5, with Effect 4",
  );
  await rcGroup.getByRole("button").nth(1).click();
  await expect(chip).toHaveAccessibleName("Drizzle version: orm 1.0.0-rc.5 · kit 1.0.0-rc.5, with Effect 4");
  await expect(chip).toContainText("+ Effect");
  await expect(run).toBeEnabled({ timeout: 120_000 });

  const librariesButton = page.getByRole("contentinfo").getByRole("button", { name: "Libraries", exact: true });
  const libraries = page.getByRole("dialog", { name: "Libraries" });
  await librariesButton.click();
  await expect(libraries.locator("dt")).toContainText(["@effect/sql-libsql", "effect", "zod"]);
  await expect(libraries.getByRole("definition").filter({ hasText: "4.0.5" })).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(libraries).toBeHidden();

  await chip.click();
  await expect(picker).toContainText("larger image that also loads Effect 4");
  await expect(rcGroup.getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");

  await rcGroup.getByRole("button").first().click();
  await expect(chip).toHaveAccessibleName("Drizzle version: orm 1.0.0-rc.5 · kit 1.0.0-rc.5");
  await librariesButton.click();
  await expect(libraries.locator("dt", { hasText: /effect/ })).toHaveCount(0);
  await expect(libraries.locator("dt", { hasText: "zod" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await run.click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
  expect(
    guestDownloads.some((url) => EFFECT_GUEST.test(url)),
    guestDownloads.join(", "),
  ).toBe(true);
});

for (const [dialect, database] of [
  ["postgresql", "PostgreSQL"],
  ["sqlite", "SQLite"],
] as const) {
  test(`should start a ${dialect} project on the Effect release with an Effect query that runs`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Name", { exact: true }).fill(`Effect starter ${dialect}`);
    await dialog.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: database }).click();
    await dialog
      .getByRole("radio", { name: /, with Effect 4/ })
      .first()
      .click();
    await dialog.getByRole("button", { name: "Create project", exact: true }).click();

    await expect(page.locator(".monaco-editor .view-lines")).toContainText("Effect.gen", { timeout: 60_000 });
    const run = page.getByRole("button", { name: "Run", exact: true });
    await expect(run).toBeEnabled({ timeout: 120_000 });
    await run.click();

    const output = page.getByRole("region", { name: "Execution output" });
    await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
    await expect(output.getByRole("region", { name: "Users" })).toContainText("Grace");
    await expect.poll(() => getErrorLines(page), { timeout: 60_000 }).toEqual([]);
  });
}

test("should disable the releases whose guest cannot run an Effect project's imports", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name", { exact: true }).fill("Effect imports");
  await dialog.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "SQLite" }).click();
  await dialog
    .getByRole("radio", { name: /, with Effect 4/ })
    .first()
    .click();
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("Effect.gen", { timeout: 60_000 });

  const chip = page.getByRole("contentinfo").getByRole("button", { name: /^Drizzle version/ });
  const picker = page.getByRole("dialog", { name: "Drizzle version" });
  const rcGroup = picker.getByRole("group", { name: "RC" });
  const legacyRows = picker.getByRole("group", { name: "Legacy" }).getByRole("button");

  await chip.click();
  await expect(rcGroup.getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(rcGroup.getByRole("button").first()).toBeDisabled();
  await expect(rcGroup.getByRole("button").first()).toHaveAccessibleDescription(
    /^.+ not available with orm 1\.0\.0-rc\.5 · kit 1\.0\.0-rc\.5\. Pick another release\.$/,
  );
  await expect(legacyRows.first()).toBeVisible();

  for (const row of await legacyRows.all()) {
    await expect(row).toBeDisabled();
    await expect(row).toHaveAccessibleDescription(
      / not available with orm 0\.\d+\.\d+ · kit 0\.\d+\.\d+\. Pick another/,
    );
  }
});
