import type { DatabaseTargetId, GuestFlavor } from "../releases/catalog.ts";

/**
 * How Drizzle Run exposes one guest package, without its version
 *
 * The guest packages decide which versions exist and which release pairs ship them; a policy decides what user code
 * may import from a package and where. Roles:
 * - `orm`: drizzle-orm, whose specifiers come from the generated ORM export inventory.
 * - `kit`: drizzle-kit, an internal module the runner loads.
 * - `database-client`: a client the runner drives (`pg`, `@libsql/client`); never an approved module.
 * - `user_module`: importable by user code through `specifiers`, on `targets` (all by default) and in `guestFlavors`
 *   (all by default), on every release pair whose guest ships it.
 *
 * Specifiers are checked per version: type artifact generation fails when a pinned version does not export one. A
 * version that moved its subpaths lists its own in `specifiersByVersion`, keyed by exact version.
 */
export type GuestPackagePolicy =
  | { readonly role: "orm" }
  | { readonly role: "kit" }
  | { readonly role: "database-client" }
  | UserModulePolicy;

/** The policy of a package user code imports. */
export interface UserModulePolicy {
  readonly role: "user_module";
  readonly specifiers: readonly string[];
  /** The specifiers of a version whose exports differ from `specifiers`, keyed by exact version. */
  readonly specifiersByVersion?: Readonly<Record<string, readonly string[]>>;
  readonly targets?: readonly DatabaseTargetId[];
  readonly guestFlavors?: readonly GuestFlavor[];
}

/**
 * Every package a guest may pin, in the order its approved modules are listed
 *
 * A guest dependency without a policy fails the registry tests.
 */
export const GUEST_PACKAGE_POLICIES = {
  "drizzle-orm": { role: "orm" },
  "drizzle-kit": { role: "kit" },
  pg: { role: "database-client" },
  "@libsql/client": { role: "database-client" },
  "@js-temporal/polyfill": { role: "user_module", specifiers: ["@js-temporal/polyfill"] },
  "drizzle-seed": { role: "user_module", specifiers: ["drizzle-seed"] },
  "drizzle-zod": { role: "user_module", specifiers: ["drizzle-zod"] },
  "drizzle-valibot": { role: "user_module", specifiers: ["drizzle-valibot"] },
  "drizzle-typebox": { role: "user_module", specifiers: ["drizzle-typebox"] },
  "drizzle-arktype": { role: "user_module", specifiers: ["drizzle-arktype"] },
  zod: {
    role: "user_module",
    // drizzle-zod and drizzle-orm/zod declare their types against `zod/v4`; `zod/v4/core` is zod's documented entry
    // for library code. Both are documented imports, so user code may import them too.
    specifiers: ["zod", "zod/v4", "zod/v4/core"],
  },
  valibot: { role: "user_module", specifiers: ["valibot"] },
  arktype: { role: "user_module", specifiers: ["arktype"] },
  "@sinclair/typebox": {
    role: "user_module",
    specifiers: [
      "@sinclair/typebox",
      "@sinclair/typebox/compiler",
      "@sinclair/typebox/errors",
      "@sinclair/typebox/parser",
      "@sinclair/typebox/syntax",
      "@sinclair/typebox/system",
      "@sinclair/typebox/type",
      "@sinclair/typebox/value",
    ],
  },
  effect: {
    role: "user_module",
    // Besides the everyday modules, this covers every effect subpath the declarations of drizzle-orm's Effect
    // integrations and the SQL clients import, so the editor resolves their types.
    specifiers: [
      "effect",
      "effect/Cause",
      "effect/Config",
      "effect/Console",
      "effect/Context",
      "effect/Duration",
      "effect/Effect",
      "effect/Layer",
      "effect/Redacted",
      "effect/Schema",
      "effect/SchemaAST",
      "effect/Scope",
      "effect/Stream",
      "effect/reactivity/Reactivity",
      "effect/sql/SqlClient",
      "effect/sql/SqlConnection",
      "effect/sql/SqlError",
      "effect/sql/Statement",
    ],
    guestFlavors: ["effect"],
  },
  "@effect/sql-pg": {
    role: "user_module",
    specifiers: ["@effect/sql-pg", "@effect/sql-pg/PgClient"],
    targets: ["postgresql-pglite"],
    guestFlavors: ["effect"],
  },
  "@effect/sql-libsql": {
    role: "user_module",
    specifiers: ["@effect/sql-libsql", "@effect/sql-libsql/LibsqlClient"],
    targets: ["sqlite-wasm"],
    guestFlavors: ["effect"],
  },
  typebox: { role: "user_module", specifiers: ["typebox", "typebox/value"] },
} as const satisfies Record<string, GuestPackagePolicy>;

/** Get the policy of a guest package; `null` when the package has none. */
export function getGuestPackagePolicy(packageName: string): GuestPackagePolicy | null {
  return Object.entries(GUEST_PACKAGE_POLICIES).find(([name]) => name === packageName)?.[1] ?? null;
}

/**
 * Get the specifiers a user module exposes at one version
 *
 * The version's own list from `specifiersByVersion` when the policy has one, and `specifiers` otherwise.
 */
export function getUserModuleSpecifiers(policy: UserModulePolicy, version: string): readonly string[] {
  const versionSpecifiers = Object.entries(policy.specifiersByVersion ?? {}).find(
    ([policyVersion]) => policyVersion === version,
  )?.[1];

  return versionSpecifiers ?? policy.specifiers;
}
