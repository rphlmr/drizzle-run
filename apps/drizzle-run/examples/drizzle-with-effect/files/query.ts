import { postgresConnection } from "@drizzle-run/runtime/context";
import * as PgClient from "@effect/sql-pg/PgClient";
import { asc } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Effect } from "effect";
import { users } from "./schema";

// A program is a plan: nothing in it runs until Effect.runPromise below.
const program = Effect.gen(function* () {
  // yield* works like await: it waits for the result and hands it back.
  const db = yield* PgDrizzle.makeWithDefaults({ paramsInErrors: true });

  return yield* db.select().from(users).orderBy(asc(users.id));
});

// The program needs a PostgreSQL client, and this layer is the one for Drizzle Run's database.
const DatabaseLive = PgClient.layerFrom(PgClient.makeClient(postgresConnection));

$.display("Users", await Effect.runPromise(program.pipe(Effect.provide(DatabaseLive))));
