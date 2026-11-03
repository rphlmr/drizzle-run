import type { Dialect } from "@drizzle-run/core/catalog";
import type { SupportedRuntimeTuple } from "@drizzle-run/core/catalog";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { RUNTIME_CONTEXT_SPECIFIER } from "@drizzle-run/core/registry";

interface RuntimeContextInput {
  target: RunManifestTarget;
  tuple: SupportedRuntimeTuple;
  schemaUri: string;
}

// The type environment ships no `@libsql/client` declarations, so the sqlite client type comes from drizzle's session
const CONTEXT_TYPES = {
  postgresql: {
    database: 'import("drizzle-orm/node-postgres").NodePgDatabase',
    client: 'import("pg").Client',
  },
  sqlite: {
    database: 'import("drizzle-orm/libsql").LibSQLDatabase',
    client: 'ConstructorParameters<typeof import("drizzle-orm/libsql").LibSQLSession>[0]',
  },
} as const satisfies Record<Dialect, { database: string; client: string }>;

function getDatabaseType(target: RunManifestTarget, releaseLine: SupportedRuntimeTuple["releaseLine"]): string {
  const contextTypes = CONTEXT_TYPES[target.dialect];
  const schemaType = releaseLine === "next" ? "SchemaRelations" : "typeof schema";

  return `${contextTypes.database}<${schemaType}> & { $client: ${contextTypes.client} }`;
}

function createPostgresConnectionMember(target: RunManifestTarget, indent: string, declareKeyword: string): string {
  if (target.dialect !== "postgresql") {
    return "";
  }

  return `${indent}/** Settings for a client of the playground's PostgreSQL, such as \`PgClient.makeClient(postgresConnection)\`. */
${indent}${declareKeyword}const postgresConnection: {
${indent}  readonly username: string;
${indent}  readonly database: string;
${indent}  /** Open another connection to the playground's database. */
${indent}  readonly stream: () => import("node:stream").Duplex;
${indent}};
`;
}

function createContextMembers(
  { target, tuple, schemaUri }: RuntimeContextInput,
  indent: string,
  declareKeyword: string,
): string {
  return `${indent}${declareKeyword}const schema: typeof import(${JSON.stringify(schemaUri)});
${indent}type SchemaRelations = typeof schema extends { relations: infer Relations }
${indent}  ? Relations
${indent}  : {};
${indent}${declareKeyword}const db: ${getDatabaseType(target, tuple.releaseLine)};
${indent}${declareKeyword}const env: Readonly<Record<string, string>>;
${indent}${declareKeyword}const target: ${JSON.stringify(target)};
${createPostgresConnectionMember(target, indent, declareKeyword)}
${indent}export { db, env, schema, target${target.dialect === "postgresql" ? ", postgresConnection" : ""} };`;
}

/**
 * Generate the ambient runtime context declaration
 *
 * Declares `db`, `env`, `schema` and `target` for the context specifier with a `declare module` block.
 */
export function generateRuntimeContextDeclaration(input: RuntimeContextInput): string {
  return `// Generated for ${input.tuple.id}; do not edit.
declare module ${JSON.stringify(RUNTIME_CONTEXT_SPECIFIER)} {
${createContextMembers(input, "  ", "")}
}
`;
}

/**
 * Generate the runtime context as a module file
 *
 * The same context as a module file rather than ambient `declare module` blocks, for a host that
 * resolves the context specifier to this file itself: two projects in one TypeScript program
 * would otherwise merge their ambient contexts.
 */
export function generateRuntimeContextModule(input: RuntimeContextInput): string {
  return `// Generated for ${input.tuple.id}; do not edit.
${createContextMembers(input, "", "declare ")}
`;
}

/** Generate the ambient declaration of the playground `$` tools */
export function generatePlaygroundToolsDeclaration(): string {
  return `// Generated runtime lexical binding; do not edit.
interface DrizzleRunPlaygroundTools {
  /** Add labeled output to Results. Await queries before displaying their values. */
  display(label: string, value: unknown, ...values: unknown[]): void;
  readonly random: Readonly<{
    uuid(): string;
    integer(min?: number, max?: number): number;
    sequence(length: number): number[];
    decimal(min?: number, max?: number): string;
    lorem(wordCount?: number): string;
    firstName(): string;
    lastName(): string;
    fullName(): string;
    email(): string;
    date(start?: Date, end?: Date): Date;
    url(): string;
    imageUrl(): string;
    array<T>(length: number, generator: () => T): T[];
  }>;
  wait(ms: number): Promise<void>;
}

declare const $: Readonly<DrizzleRunPlaygroundTools>;
`;
}
