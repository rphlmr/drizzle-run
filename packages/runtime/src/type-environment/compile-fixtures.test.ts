import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPairProject, parseGuideManifest, resolveStep } from "@drizzle-run/core/guide";
import { PAIR_SIDES, pairSide } from "@drizzle-run/core/pair";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { serveLocalRuntimeAssets } from "../../test/type-environment/local-runtime-assets.ts";
import { createProjectTypeEnvironment } from "./create-project-type-environment.ts";
import type { ProjectTypeEnvironment, ProjectTypeFile, RunManifest } from "./types.ts";

beforeAll(serveLocalRuntimeAssets);
afterAll(() => vi.unstubAllGlobals());

describe("API comparison guide types", () => {
  it.each(["pagination-apis-postgresql", "pagination-apis-sqlite", "helper-apis-postgresql", "helper-apis-sqlite"])(
    "should type-check both APIs at every runnable step of %s",
    async (slug) => {
      const guide = parseGuideManifest(
        JSON.parse(
          readFileSync(new URL(`../../../../apps/drizzle-run/guides/${slug}/guide.json`, import.meta.url), "utf8"),
        ),
      );

      for (const [index, step] of guide.steps.entries()) {
        if (step.run === "none") {
          continue;
        }

        const { project } = resolveStep(guide, index);

        if (!isPairProject(project)) {
          throw new Error(`Expected ${slug}/${step.id} to compare two APIs.`);
        }

        for (const side of PAIR_SIDES) {
          const environment = await createProjectTypeEnvironment(pairSide(project, side));
          expect(compileVirtualProject(environment), `${slug}/${step.id} side ${side}`).toBe("");
        }
      }
    },
    120_000,
  );
});

const virtualUriToDiskPath = (root: string, uri: string): string => {
  const parsed = new URL(uri);
  const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");

  return join(root, pathname);
};

const materializeEnvironment = (root: string, environment: ProjectTypeEnvironment): readonly ProjectTypeFile[] => {
  const files = environment.files.map((file) => ({
    ...file,
    uri: virtualUriToDiskPath(root, file.uri),
  }));
  const projectRoot = "file:///__drizzle_run_project__";
  const diskProjectRoot = join(root, "__drizzle_run_project__");

  for (const file of files) {
    const directory = dirname(file.uri);
    mkdirSync(directory, { recursive: true });
    // Generated context declarations refer to the virtual schema URI; this tsc probe needs its path on disk.
    const content = file.content.replaceAll(projectRoot, diskProjectRoot);
    writeFileSync(file.uri, content);
  }

  return files;
};

const compileVirtualProject = (environment: ProjectTypeEnvironment): string => {
  const root = join(tmpdir(), `drizzle-run-typecheck-${environment.fingerprint}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const files = materializeEnvironment(root, environment);
  const projectFiles = files.filter((file) => file.kind === "project");
  const generatedFiles = files.filter((file) => file.kind === "generated");
  const paths = Object.fromEntries(
    Object.entries(environment.compilerOptions.paths).map(([specifier, mapped]) => [
      specifier,
      mapped.map((uri) => virtualUriToDiskPath(root, uri)),
    ]),
  );
  const typeRoots = environment.compilerOptions.typeRoots?.map((uri) => virtualUriToDiskPath(root, uri));
  const configPath = join(root, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        ...environment.compilerOptions,
        paths,
        ...(typeRoots === undefined ? {} : { typeRoots }),
        skipLibCheck: true,
      },
      files: [...projectFiles, ...generatedFiles].map((file) => file.uri),
    }),
  );
  const tscPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/typescript/bin/tsc");

  if (!existsSync(tscPath)) throw new Error(`TypeScript compiler is missing: ${tscPath}`);

  try {
    return execFileSync(process.execPath, [tscPath, "-p", configPath, "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    const stdout = typeof cause === "object" && cause !== null && "stdout" in cause ? String(cause.stdout) : "";
    const stderr = typeof cause === "object" && cause !== null && "stderr" in cause ? String(cause.stderr) : "";

    return `${stdout}${stderr}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

type FixtureTarget = RunManifest["target"];
type FixtureReleaseLine = "legacy" | "next";

const projectFixture = ({
  target,
  releaseLine,
}: {
  target: FixtureTarget;
  releaseLine: FixtureReleaseLine;
}): RunManifest => {
  const isPostgres = target.dialect === "postgresql";
  const dependencies: RunManifest["dependencies"] =
    releaseLine === "legacy"
      ? { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" }
      : { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" };
  const schema = isPostgres
    ? `
      import { customType, pgTable, serial, text } from "drizzle-orm/pg-core";
      import { integer as directlyImportedInteger } from "drizzle-orm/pg-core/columns/integer";
      const payloadType = customType<{ data: string; driverData: string }>({ dataType: () => "text" });
      export const users = pgTable("users", {
        id: serial("id").primaryKey(),
        name: text("name").notNull(),
        payload: payloadType("payload").notNull(),
      });
      ${
        releaseLine === "next"
          ? `
        import { defineRelations } from "drizzle-orm/relations";
        export const posts = pgTable("posts", {
          id: serial("id").primaryKey(),
          userId: serial("user_id").notNull(),
          title: text("title").notNull(),
        });
        export const relations = defineRelations({ users, posts }, (helpers) => ({
          users: { posts: helpers.many.posts({ from: helpers.users.id, to: helpers.posts.userId }) },
          posts: { user: helpers.one.users({ from: helpers.posts.userId, to: helpers.users.id }) },
        }));
      `
          : ""
      }
      void directlyImportedInteger;
    `
    : `
      import { customType, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
      import { integer as directlyImportedInteger } from "drizzle-orm/sqlite-core/columns/integer";
      const payloadType = customType<{ data: string; driverData: string }>({ dataType: () => "text" });
      export const users = sqliteTable("users", {
        id: integer("id").primaryKey(),
        name: text("name").notNull(),
        payload: payloadType("payload").notNull(),
      });
      ${
        releaseLine === "next"
          ? `
        import { defineRelations } from "drizzle-orm/relations";
        export const posts = sqliteTable("posts", {
          id: integer("id").primaryKey(),
          userId: integer("user_id").notNull(),
          title: text("title").notNull(),
        });
        export const relations = defineRelations({ users, posts }, (helpers) => ({
          users: { posts: helpers.many.posts({ from: helpers.users.id, to: helpers.posts.userId }) },
          posts: { user: helpers.one.users({ from: helpers.posts.userId, to: helpers.users.id }) },
        }));
      `
          : ""
      }
      void directlyImportedInteger;
    `;
  const schemaType = releaseLine === "next" ? 'typeof import("./schema.ts").relations' : 'typeof import("./schema.ts")';
  const dbType = isPostgres
    ? `import type { NodePgDatabase } from "drizzle-orm/node-postgres";
      import type { Client } from "pg";
      const exactDb: NodePgDatabase<${schemaType}> & { $client: Client } = db;`
    : `import type { LibSQLDatabase, LibSQLSession } from "drizzle-orm/libsql";
      const exactDb: LibSQLDatabase<${schemaType}> & { $client: ConstructorParameters<typeof LibSQLSession>[0] } = db;`;
  const legacyGoodies = `
      import { createSelectSchema as zodSchema } from "drizzle-zod";
      import { createSelectSchema as valibotSchema } from "drizzle-valibot";
      import { createSelectSchema as typeboxSchema } from "drizzle-typebox";
      import { createSelectSchema as arktypeSchema } from "drizzle-arktype";
      import { z } from "zod";
      import * as v from "valibot";
      import { type } from "arktype";
      import { Type } from "@sinclair/typebox";
      const schemas = [zodSchema(users), valibotSchema(users), typeboxSchema(users), arktypeSchema(users)];
      const validatorValues = [z.string(), v.string(), type("string"), Type.String()];
  `;
  const nextGoodies = `
      import { createSelectSchema as zodSchema } from "drizzle-orm/zod";
      import { createSelectSchema as valibotSchema } from "drizzle-orm/valibot";
      import { createSelectSchema as arktypeSchema } from "drizzle-orm/arktype";
      import { createSelectSchema as legacyTypeboxSchema } from "drizzle-orm/typebox-legacy";
      import { createSelectSchema as typeboxSchema } from "drizzle-orm/typebox";
      import { z } from "zod";
      import * as v from "valibot";
      import { type } from "arktype";
      import { Type as LegacyType } from "@sinclair/typebox";
      import { Type } from "typebox";
      const schemas = [zodSchema(users), valibotSchema(users), arktypeSchema(users), legacyTypeboxSchema(users), typeboxSchema(users)];
      const validatorValues = [z.string(), v.string(), type("string"), LegacyType.String(), Type.String()];
  `;
  const goodies = releaseLine === "legacy" ? legacyGoodies : nextGoodies;

  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target,
    dependencies,
    files: {
      "schema.ts": schema,
      "seed.ts": `
      import { db } from "@drizzle-run/runtime/context";
      import { users } from "./schema.ts";
      await db.insert(users).values({ name: "Ada", payload: "stable payload" });
    `,
      "run.ts": `
      import { db } from "@drizzle-run/runtime/context";
      import { eq } from "drizzle-orm";
      import { users } from "./schema.ts";
      import { seed } from "drizzle-seed";
      import type { migrate as targetMigrator } from "${isPostgres ? "drizzle-orm/node-postgres/migrator" : "drizzle-orm/libsql/migrator"}";
      const migrationApi: typeof targetMigrator | undefined = undefined;
      ${dbType}
      const exactDbAgain: typeof db = exactDb;
      const rows = await db.select().from(users).where(eq(users.id, 1));
      for (const row of rows) {
        const exactName: string = row.name;
        const exactPayload: string = row.payload;
        // @ts-expect-error inferred text columns reject numeric values
        const invalidName: number = row.name;
        void exactName; void exactPayload; void invalidName;
      }
      await db.insert(users).values({ name: "Grace", payload: "custom" });
      // @ts-expect-error custom type input is a string
      await db.insert(users).values({ name: "Grace", payload: 42 });
      await db.transaction(async (tx) => {
        await tx.insert(users).values({ name: "Lin", payload: "transaction" });
        return tx.select().from(users);
      });
      const prepared = db.select({ name: users.name }).from(users)${isPostgres ? '.prepare("users-by-name")' : ".prepare()"};
      const preparedRows = await prepared.execute();
      for (const row of preparedRows) {
        const exactPreparedName: string = row.name;
        void exactPreparedName;
      }
      const displayed: void = $.display("Users", rows);
      $.display("Overview", rows, { total: rows.length }, []);
      // @ts-expect-error labels must be strings
      $.display(42, rows);
      // @ts-expect-error at least one value is required
      $.display("Missing value");
      void displayed;
      ${
        releaseLine === "next"
          ? `
        const relationRows = await db.query.users.findMany({ with: { posts: true } });

        for (const row of relationRows) {
          for (const post of row.posts) {
            const exactTitle: string = post.title;
            void exactTitle;
          }
          // @ts-expect-error unknown relations are rejected
          await db.query.users.findMany({ with: { missing: true } });
        }
      `
          : ""
      }
      ${goodies}
      void exactDbAgain; void schemas; void validatorValues; void seed; void migrationApi;
      export default rows;
    `,
    },
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "run.ts" },
  };
};

describe("compile-time project fixtures", () => {
  it.each(["postgresql", "sqlite"] as const)(
    "should infer Temporal custom-type reads and writes for rc.5 %s",
    async (dialect) => {
      const postgres = dialect === "postgresql";
      const project = projectFixture({ target: { dialect }, releaseLine: "next" });
      const environment = await createProjectTypeEnvironment({
        ...project,
        files: {
          "schema.ts": `
          import { Temporal } from "@js-temporal/polyfill";
          import { customType, integer, ${postgres ? "pgTable" : "sqliteTable"} } from "drizzle-orm/${postgres ? "pg-core" : "sqlite-core"}";
          const plainDate = customType<{ data: Temporal.PlainDate; driverData: string }>({
            dataType: () => "${postgres ? "date" : "text"}",
            codec: "${postgres ? "date:string" : "text"}",
            toDriver: (value) => value.toString(),
            fromDriver: (value) => Temporal.PlainDate.from(value),
          });
          export const bookings = ${postgres ? "pgTable" : "sqliteTable"}("bookings", {
            id: integer("id").primaryKey(),
            startsOn: plainDate("starts_on").notNull(),
            followUp: plainDate("follow_up"),
          });
        `,
          "seed.ts": "export {};",
          "run.ts": `
          import { Temporal } from "@js-temporal/polyfill";
          import { db } from "@drizzle-run/runtime/context";
          import { bookings } from "./schema";
          await db.insert(bookings).values({ id: 1, startsOn: Temporal.PlainDate.from("2024-02-29") });
          // @ts-expect-error custom column writes require PlainDate, not a raw string
          await db.insert(bookings).values({ id: 2, startsOn: "2024-02-29" });
          for (const row of await db.select().from(bookings)) {
            const exact: Temporal.PlainDate = row.startsOn;
            const nullable: Temporal.PlainDate | null = row.followUp;
            const rendered: string = exact.add({ days: 1 }).toString();
            // @ts-expect-error selected dates are not numbers
            const wrong: number = row.startsOn;
            void nullable; void rendered; void wrong;
          }
        `,
        },
      });

      expect(compileVirtualProject(environment)).toBe("");
    },
  );

  for (const target of [{ dialect: "postgresql" }, { dialect: "sqlite" }] as const) {
    for (const releaseLine of ["legacy", "next"] as const) {
      it(`should type-check natural ${target.dialect} schema/seed/run modules for ${releaseLine} integrations`, async () => {
        const environment = await createProjectTypeEnvironment(projectFixture({ target, releaseLine }));
        expect(compileVirtualProject(environment)).toBe("");
      });
    }
  }

  for (const dialect of ["postgresql", "sqlite"] as const) {
    it(`should type-check Effect Schema and the Effect query API on the ${dialect} effect guest`, async () => {
      const fixture = projectFixture({ target: { dialect }, releaseLine: "next" });
      const isPostgres = dialect === "postgresql";
      const environment = await createProjectTypeEnvironment({
        ...fixture,
        guestFlavor: "effect",
        files: {
          ...fixture.files,
          "run.ts": `
          import * as Effect from "effect/Effect";
          import * as Schema from "effect/Schema";
          import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
          ${
            isPostgres
              ? 'import * as PgClient from "@effect/sql-pg/PgClient";\n          import * as Drizzle from "drizzle-orm/effect-postgres";'
              : 'import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";\n          import * as Drizzle from "drizzle-orm/effect-libsql";'
          }
          import { ${isPostgres ? "postgresConnection" : "db"} } from "@drizzle-run/runtime/context";
          import { users } from "./schema.ts";

          const UserInsert = createInsertSchema(users);
          const UserSelect = createSelectSchema(users);
          const ada = Schema.decodeUnknownSync(UserInsert)({ name: "Ada", payload: "p" });
          const program = Effect.gen(function* () {
            const effectDb = yield* Drizzle.makeWithDefaults();
            yield* effectDb.insert(users).values(ada);
            const rows = yield* effectDb.select().from(users);
            return rows.map((row) => Schema.decodeUnknownSync(UserSelect)(row));
          });
          const clientLayer = ${
            isPostgres
              ? "PgClient.layerFrom(PgClient.makeClient(postgresConnection))"
              : "LibsqlClient.layer({ liveClient: db.$client })"
          };
          const rows = await Effect.runPromise(program.pipe(Effect.provide(clientLayer)));
          const exactName: string = rows[0]!.name;
          // @ts-expect-error an Effect is not a number
          const typeProbe: number = Effect.succeed("text");
          void exactName; void typeProbe;
        `,
        },
      });

      expect(compileVirtualProject(environment)).toBe("");
    });
  }

  it("should type the ES2025 features the QuickJS guest implements and reject the ones it lacks", async () => {
    const fixture = projectFixture({
      target: { dialect: "sqlite" },
      releaseLine: "next",
    });
    const environment = await createProjectTypeEnvironment({
      ...fixture,
      files: {
        ...fixture.files,
        "run.ts": `
          const sorted: number[] = [3, 1, 2].toSorted();
          const grouped = Object.groupBy(sorted, (value) => (value % 2 === 0 ? "even" : "odd"));
          const { promise } = Promise.withResolvers<number>();
          const transferred: ArrayBuffer = new ArrayBuffer(4).transfer(8);
          const wellFormed: boolean = "text".isWellFormed();
          const evens: number[] = sorted.values().filter((value) => value % 2 === 0).toArray();
          const union: Set<number> = new Set([1]).union(new Set([2]));
          const tried: Promise<number> = Promise.try(() => 1);
          const escaped: string = RegExp.escape("a.b");
          const halves = new Float16Array([1.5]);
          const patterns = [/[\\p{L}--[a-z]]/v, /(?i:a)b/, /(?<year>\\d{4})|(?<year>\\d{2})/];
          // @ts-expect-error the guest Intl has no DurationFormat
          void Intl.DurationFormat;
          // @ts-expect-error the guest Intl has no NumberFormat range formatting
          void new Intl.NumberFormat("en").formatRange;
          // @ts-expect-error the guest has no Atomics.waitAsync
          void Atomics.waitAsync;
          void grouped; void promise; void transferred; void wellFormed; void evens; void union;
          void tried; void escaped; void halves; void patterns;
          export default undefined;
        `,
      },
    });

    expect(compileVirtualProject(environment)).toBe("");
  });

  it("should reject next-only integrations from legacy type environments", async () => {
    const fixture = projectFixture({
      target: { dialect: "postgresql" },
      releaseLine: "legacy",
    });
    const environment = await createProjectTypeEnvironment({
      ...fixture,
      files: {
        ...fixture.files,
        "run.ts":
          'import { createSelectSchema } from "drizzle-orm/zod"; void createSelectSchema; export default undefined;',
      },
    });
    expect(compileVirtualProject(environment)).toMatch(/Cannot find module .*drizzle-orm\/zod/);
  });

  it("should reject standalone validator integrations from next type environments", async () => {
    const fixture = projectFixture({
      target: { dialect: "sqlite" },
      releaseLine: "next",
    });
    const environment = await createProjectTypeEnvironment({
      ...fixture,
      files: {
        ...fixture.files,
        "run.ts":
          'import { createSelectSchema } from "drizzle-zod"; void createSelectSchema; export default undefined;',
      },
    });
    expect(compileVirtualProject(environment)).toMatch(/Cannot find module .*drizzle-zod/);
  });
});
