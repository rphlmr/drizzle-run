import type { Dialect } from "@drizzle-run/core/catalog";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { getRunBothButton } from "./side-by-side-project";
import { callStore } from "./store";

// Several runtimes at once in WebKit left a side stuck preparing past its 2 minute wait, so this file's tests run
// one after another on one worker.
test.describe.configure({ mode: "default" });

/**
 * Side by side compares plain Drizzle with its Effect API on one release: rc.5 on one side, rc.5 with Effect on the
 * other. Each side boots its own guest image; the other side's choice is tagged but stays open.
 */

const PAIR = { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" } as const;

const SCHEMA = {
  postgresql: `import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const users = pgTable("users", { id: serial().primaryKey(), name: text().notNull(), age: integer() });
`,
  sqlite: `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", { id: integer().primaryKey(), name: text().notNull(), age: integer() });
`,
};

const PLAIN_QUERY = `import { eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

await db.insert(users).values([{ name: "Ada", age: 36 }, { name: "Linus", age: 54 }]);
$.display("Plain", await db.select().from(users).where(eq(users.name, "Ada")));
`;

const EFFECT_QUERY = {
  postgresql: `import * as Effect from "effect/Effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { eq } from "drizzle-orm";
import { postgresConnection } from "@drizzle-run/runtime/context";
import { users } from "./schema";

const program = Effect.gen(function* () {
  const effectDb = yield* PgDrizzle.makeWithDefaults();
  yield* effectDb.insert(users).values([{ name: "Ada", age: 36 }, { name: "Linus", age: 54 }]);
  return yield* effectDb.select().from(users).where(eq(users.name, "Ada"));
});
const clientLayer = PgClient.layerFrom(PgClient.makeClient(postgresConnection));

$.display("Effect", await Effect.runPromise(program.pipe(Effect.provide(clientLayer))));
`,
  sqlite: `import * as Effect from "effect/Effect";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as LibsqlDrizzle from "drizzle-orm/effect-libsql";
import { eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

const program = Effect.gen(function* () {
  const effectDb = yield* LibsqlDrizzle.makeWithDefaults();
  yield* effectDb.insert(users).values([{ name: "Ada", age: 36 }, { name: "Linus", age: 54 }]);
  return yield* effectDb.select().from(users).where(eq(users.name, "Ada"));
});

$.display("Effect", await Effect.runPromise(program.pipe(Effect.provide(LibsqlClient.layer({ liveClient: db.$client })))));
`,
};

const PLAIN_RC_ROW = /^RC, orm 1\.0\.0-rc\.5 · kit 1\.0\.0-rc\.5(?!, with Effect)/;
const SLIM_GUEST = /\/quickjs\/orm-1\.0\.0-rc\.5__kit-1\.0\.0-rc\.5\/(?:postgresql|sqlite)\/execution\.guest\.js$/;
const EFFECT_GUEST =
  /\/quickjs\/orm-1\.0\.0-rc\.5__kit-1\.0\.0-rc\.5\+effect\/(?:postgresql|sqlite)\/execution\.guest\.js$/;

function getPlainSide(page: Page): Locator {
  return page.getByRole("region", { name: "rc.5, Drizzle orm 1.0.0-rc.5 · kit 1.0.0-rc.5", exact: true });
}

function getEffectSide(page: Page): Locator {
  return page.getByRole("region", { name: "Drizzle orm 1.0.0-rc.5 · kit 1.0.0-rc.5, with Effect 4" });
}

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

let storedCount = 0;

/** Stores a side-by-side project with rc.5 on the first side and rc.5 with Effect on the second, and opens it. */
async function openPlainVsEffect(page: Page, dialect: Dialect): Promise<void> {
  const id = `00000000-0000-4000-9100-${String((storedCount += 1)).padStart(12, "0")}`;
  const now = new Date().toISOString();
  const record = {
    version: 1,
    id,
    name: `Plain vs Effect ${dialect}`,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    trust: "trusted" as const,
    manifest: {
      kind: "drizzle-run-pair",
      manifestVersion: 1,
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: { "schema.ts": SCHEMA[dialect] },
      sides: [
        { target: { dialect }, dependencies: PAIR, files: { "query.ts": PLAIN_QUERY } },
        {
          target: { dialect },
          dependencies: PAIR,
          guestFlavor: "effect",
          files: { "query.ts": EFFECT_QUERY[dialect] },
        },
      ],
    },
  };

  await page.goto("/projects");
  await callStore(page, "saveProjects", [record], []);
  await page.goto(`/p/${id}`);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
}

for (const dialect of ["postgresql", "sqlite"] as const) {
  test(`should run ${dialect} rc.5 next to rc.5 with Effect, each side on its own guest`, async ({ page }) => {
    const guestDownloads = recordGuestDownloads(page);
    await openPlainVsEffect(page, dialect);

    await expect(page.getByText("rc.5 and rc.5 + Effect").first()).toBeVisible();
    await expect(getPlainSide(page).getByRole("button", { name: /^RC, orm 1\.0\.0-rc\.5/ })).toBeVisible();
    await expect(getEffectSide(page).getByRole("button", { name: /^RC \+ Effect, orm 1\.0\.0-rc\.5/ })).toBeVisible();

    await getRunBothButton(page).click();

    for (const side of [getPlainSide(page), getEffectSide(page)]) {
      await expect(side.locator("[data-slot=run-pill]")).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    }

    await expect(getPlainSide(page).getByRole("region", { name: "Plain", exact: true })).toContainText("Ada");
    await expect(getEffectSide(page).getByRole("region", { name: "Effect", exact: true })).toContainText("Ada");
    await expect(getEffectSide(page).getByRole("region", { name: "Effect", exact: true })).not.toContainText("Linus");
    expect(guestDownloads.filter((url) => SLIM_GUEST.test(url))).toHaveLength(1);
    expect(guestDownloads.filter((url) => EFFECT_GUEST.test(url))).toHaveLength(1);
  });
}

test("should offer rc.5 with Effect next to plain rc.5, and tag the other side's choice", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Plain vs Effect");
  await dialog.getByRole("radio", { name: /^Side by side/ }).click();

  await dialog.getByRole("button", { name: /^Second side:/ }).click();
  const second = page.getByRole("group", { name: "Second side" });
  await second.getByRole("radio", { name: /, with Effect 4/ }).click();
  await page.keyboard.press("Escape");

  await dialog.getByRole("button", { name: /^First side:/ }).click();
  const first = page.getByRole("group", { name: "First side" });
  await expect(first.getByRole("radio", { name: /, with Effect 4/ })).toBeEnabled();
  await expect(first.locator("label", { hasText: "Other side" })).toContainText("RC + Effect");
  await first.getByRole("radio", { name: PLAIN_RC_ROW }).click();
  await page.keyboard.press("Escape");

  await dialog.getByRole("radio", { name: /^Separate files/ }).click();
  await dialog.getByRole("button", { name: "Create side by side" }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByText("rc.5 and rc.5 + Effect").first()).toBeVisible();

  await getPlainSide(page)
    .getByRole("button", { name: /^RC, orm 1\.0\.0-rc\.5/ })
    .click();
  const popover = page.getByRole("dialog", { name: "Change this side’s version" });
  await expect(popover.getByRole("radio", { name: /, with Effect 4/ })).toBeEnabled();
  await expect(popover.locator("label", { hasText: "Other side" })).toContainText("RC + Effect");
  await expect(popover.getByRole("radio", { name: PLAIN_RC_ROW })).toBeChecked();
  await popover.getByRole("radio", { name: /^Legacy/ }).click();
  await expect(popover.getByRole("radio", { name: /^Copy rc\.5 \+ Effect’s files/ })).toBeVisible();
  await expect(popover.getByRole("button", { name: "Move this side to 0.45" })).toBeVisible();
});
