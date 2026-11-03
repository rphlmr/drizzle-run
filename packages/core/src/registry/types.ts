import type { RunManifestTarget } from "../manifest/types.ts";
import type { DatabaseTargetId, GuestFlavor, RuntimeKitVersion, RuntimeOrmVersion } from "../releases/catalog.ts";
import { DIALECTS } from "../releases/dialects.ts";

/** The database a runtime tuple runs against. */
export type DatabaseTarget = RunManifestTarget;
export type { DatabaseTargetId };

/** A branded runtime tuple id, such as `postgresql-pglite__orm-0.45.4__kit-0.31.11`. */
export type RuntimeTupleId = string & { readonly __runtimeTupleId: unique symbol };

/** A runtime tuple as public callers see it. */
export interface PublicRuntimeTuple {
  id: RuntimeTupleId;
  target: DatabaseTarget;
  ormVersion: RuntimeOrmVersion;
  kitVersion: RuntimeKitVersion;
}

/** The release line a tuple belongs to. */
export type RuntimeReleaseLine = "legacy" | "next";

/** A runtime tuple the catalog ships, with its release line. */
export interface SupportedRuntimeTuple extends PublicRuntimeTuple {
  releaseLine: RuntimeReleaseLine;
  recommended: boolean;
}

/**
 * What a caller asks for: a target and a shipped ORM and Kit version
 *
 * Each version is a literal the catalog ships, so a version a release removed fails to compile. The two are checked
 * apart, not as a pair: `resolveSupportedTuple` still rejects an ORM and Kit from different pairs at runtime.
 */
export interface RuntimeTupleSelection {
  target: DatabaseTarget;
  ormVersion: RuntimeOrmVersion;
  kitVersion: RuntimeKitVersion;
}

/**
 * The same request with versions the type system has not checked
 *
 * For versions read from storage, links or Connect input; `isSupportedTuple` narrows it to a `RuntimeTupleSelection`.
 */
export interface RuntimeTupleQuery {
  target: DatabaseTarget;
  ormVersion: string;
  kitVersion: string;
}

/** How an approved module's files are verified. */
export interface IntegrityMetadata {
  algorithm: "package_manager" | "sha256";
  source: string;
  required: true;
}

/** The runtime artifact that loads an approved module. */
export interface RuntimeArtifactRef {
  id: string;
  loader: "guest_package" | "virtual_context" | "database_engine";
}

/** The type declaration artifact of an approved module. */
export interface TypeArtifactRef {
  id: string;
  manifestPath: string;
}

/**
 * The PostgreSQL driver declarations an ORM entry loads beside its own
 *
 * The `@types/pg` and `@types/node` a guest pins as devDependencies, so `pg` and Node types resolve in the editor.
 * Keyed by those two versions: every guest that pins the same ones shares the artifact.
 */
export interface DriverTypeArtifactRef extends TypeArtifactRef {
  /** The virtual folder the artifact's files live under. */
  root: string;
  /** The versions it bundles. */
  packages: { readonly "@types/pg": string; readonly "@types/node": string };
}

/** A package user code may import, with its runtime and type artifacts per tuple. */
export interface ApprovedModuleEntry {
  packageName: string;
  version: string;
  allowedSpecifiers: readonly string[];
  tupleIds: readonly RuntimeTupleId[];
  targets: readonly DatabaseTargetId[];
  /** The guest flavors that ship this module. */
  guestFlavors: readonly GuestFlavor[];
  runtimeArtifact: RuntimeArtifactRef;
  types: {
    declarationRoot: string;
    closureArtifact: TypeArtifactRef;
    virtualPaths: readonly string[];
    /** On a PostgreSQL drizzle-orm entry: the driver declarations its guest pins. */
    driverArtifact?: DriverTypeArtifactRef;
  };
  integrity: IntegrityMetadata;
  visibility: "user" | "internal";
}

/** Get the catalog id of a database target from its dialect. */
export function databaseTargetId(target: DatabaseTarget): DatabaseTargetId {
  return DIALECTS[target.dialect].targetId;
}
