import {
  GUEST_FLAVORS,
  GUEST_IMAGES,
  HOST_ENGINES,
  KIT_VERSIONS,
  ORM_EXPORT_INVENTORY,
  RELEASE_PAIRS,
  getGuestPackageVersion,
  type GuestFlavor,
} from "../releases/catalog.ts";
import { RUNTIME_CONTEXT_SPECIFIER } from "./context-specifiers.ts";
import { toGuestImageId, type GuestSelection } from "./guest-images.ts";
import { GUEST_PACKAGE_POLICIES, getUserModuleSpecifiers, type UserModulePolicy } from "./package-policies.ts";
import { selectTupleIds } from "./tuple-ids.ts";
import { SUPPORTED_RUNTIME_TUPLES } from "./tuples.ts";
import {
  databaseTargetId,
  type ApprovedModuleEntry,
  type DatabaseTargetId,
  type DriverTypeArtifactRef,
  type RuntimeTupleId,
  type SupportedRuntimeTuple,
} from "./types.ts";

const ALL_TUPLE_IDS = SUPPORTED_RUNTIME_TUPLES.map((tuple) => tuple.id);
const ALL_TARGETS = ["postgresql-pglite", "sqlite-wasm"] as const;
const HOST_ENGINE_TARGETS = {
  "@electric-sql/pglite": "postgresql-pglite",
  "@sqlite.org/sqlite-wasm": "sqlite-wasm",
} as const satisfies Record<keyof typeof HOST_ENGINES, DatabaseTargetId>;

function toArtifactFileStem(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, "at__").replaceAll("/", "__")}__${version}`;
}

/**
 * Get the PostgreSQL driver declarations of a guest image
 *
 * Reads the `@types/pg` and `@types/node` it pins as devDependencies. Throws when it pins either one under
 * `dependencies` only or not at all, since the editor could not type `pg` then.
 */
function getDriverTypeArtifact(imageId: string): DriverTypeArtifactRef {
  const image = Object.entries(GUEST_IMAGES).find(([id]) => id === imageId)?.[1];
  const devPackages: Readonly<Record<string, string>> = image?.devPackages ?? {};
  const pgTypes = devPackages["@types/pg"];
  const nodeTypes = devPackages["@types/node"];

  if (pgTypes === undefined || nodeTypes === undefined) {
    throw new Error(
      `Guest ${imageId} must pin @types/pg and @types/node as devDependencies in guests/${imageId}/package.json`,
    );
  }

  const stem = `node-postgres__${toArtifactFileStem("@types/pg", pgTypes)}__${toArtifactFileStem("@types/node", nodeTypes)}`;

  return Object.freeze({
    id: `types:@types/pg@${pgTypes}+@types/node@${nodeTypes}`,
    manifestPath: `./artifacts/declarations/${stem}.json`,
    root: `file:///__drizzle_run_types__/${stem}`,
    packages: Object.freeze({ "@types/pg": pgTypes, "@types/node": nodeTypes }),
  });
}

function createApprovedModule({
  packageName,
  version,
  allowedSpecifiers,
  tupleIds,
  targets = ALL_TARGETS,
  guestFlavors = GUEST_FLAVORS,
  visibility = "user",
  runtimeLoader = "guest_package",
  integrity,
  driverArtifact,
}: {
  packageName: string;
  version: string;
  allowedSpecifiers: readonly string[];
  tupleIds: readonly RuntimeTupleId[];
  targets?: readonly DatabaseTargetId[];
  guestFlavors?: readonly GuestFlavor[];
  visibility?: "user" | "internal";
  runtimeLoader?: ApprovedModuleEntry["runtimeArtifact"]["loader"];
  integrity?: ApprovedModuleEntry["integrity"];
  driverArtifact?: DriverTypeArtifactRef;
}): ApprovedModuleEntry {
  const artifactId = `${packageName}@${version}`;
  const virtualArtifactId = `${encodeURIComponent(packageName)}@${version}`;

  return Object.freeze({
    packageName,
    version,
    allowedSpecifiers: Object.freeze([...allowedSpecifiers]),
    tupleIds: Object.freeze([...tupleIds]),
    targets: Object.freeze([...targets]),
    guestFlavors: Object.freeze([...guestFlavors]),
    runtimeArtifact: {
      id: `runtime:${artifactId}`,
      loader: runtimeLoader,
    },
    types: {
      declarationRoot: `file:///__drizzle_run_types__/${virtualArtifactId}/index.d.ts`,
      closureArtifact: {
        id: `types:${artifactId}`,
        manifestPath: `./artifacts/declarations/${toArtifactFileStem(packageName, version)}.json`,
      },
      virtualPaths: Object.freeze(
        allowedSpecifiers.map(
          (specifier) => `file:///__drizzle_run_types__/${virtualArtifactId}/${specifier.replaceAll("/", "__")}.d.ts`,
        ),
      ),
      ...(driverArtifact === undefined ? {} : { driverArtifact }),
    },
    integrity: integrity ?? {
      algorithm: "package_manager" as const,
      source: artifactId,
      required: true as const,
    },
    visibility,
  });
}

function createOrmModules(
  version: string,
  kitVersion: string,
  releaseLine: "legacy" | "next",
  guestFlavors: readonly GuestFlavor[],
): ApprovedModuleEntry[] {
  const exportInventory = Object.entries(ORM_EXPORT_INVENTORY).find(
    ([inventoryVersion]) => inventoryVersion === version,
  )?.[1];

  if (exportInventory === undefined) {
    throw new Error(`Missing generated ORM export inventory for drizzle-orm@${version}`);
  }

  return ALL_TARGETS.flatMap((target) => {
    const tupleIds = SUPPORTED_RUNTIME_TUPLES.filter(
      (tuple) => tuple.ormVersion === version && databaseTargetId(tuple.target) === target,
    ).map((tuple) => tuple.id);
    const targetSpecifiers = target === "postgresql-pglite" ? exportInventory.postgresql : exportInventory.sqlite;
    const integrationSpecifiers = releaseLine === "next" ? exportInventory.validators : [];
    const slimSpecifiers = [...exportInventory.common, ...targetSpecifiers, ...integrationSpecifiers];

    return guestFlavors.map((guestFlavor) => {
      const effectSpecifiers =
        guestFlavor === "effect"
          ? [
              ...exportInventory.effect.common,
              ...(target === "postgresql-pglite" ? exportInventory.effect.postgresql : exportInventory.effect.sqlite),
            ]
          : [];

      return createApprovedModule({
        packageName: "drizzle-orm",
        version,
        tupleIds,
        targets: [target],
        guestFlavors: [guestFlavor],
        allowedSpecifiers: [...slimSpecifiers, ...effectSpecifiers],
        driverArtifact:
          target === "postgresql-pglite"
            ? getDriverTypeArtifact(toGuestImageId({ ormVersion: version, kitVersion, guestFlavor }))
            : undefined,
      });
    });
  });
}

const supportedOrmModules = Object.values(RELEASE_PAIRS).flatMap(
  ({ ormVersion, kitVersion, releaseLine, guestFlavors }) =>
    createOrmModules(ormVersion, kitVersion, releaseLine, guestFlavors),
);

function createUserModules(packageName: string, policy: UserModulePolicy): ApprovedModuleEntry[] {
  const guestFlavors = policy.guestFlavors ?? GUEST_FLAVORS;
  const targets = policy.targets ?? ALL_TARGETS;
  const pairIdsByVersion = new Map<string, Set<string>>();

  for (const image of Object.values(GUEST_IMAGES)) {
    const version = Object.entries(image.packages).find(([name]) => name === packageName)?.[1];

    if (version === undefined || !guestFlavors.includes(image.guestFlavor)) {
      continue;
    }

    const pairIds = pairIdsByVersion.get(version) ?? new Set<string>();

    pairIds.add(image.pairId);
    pairIdsByVersion.set(version, pairIds);
  }

  return [...pairIdsByVersion].map(([version, pairIds]) =>
    createApprovedModule({
      packageName,
      version,
      allowedSpecifiers: getUserModuleSpecifiers(policy, version),
      tupleIds: SUPPORTED_RUNTIME_TUPLES.filter(
        (tuple) =>
          pairIds.has(toGuestImageId({ ...tuple, guestFlavor: "slim" })) &&
          targets.includes(databaseTargetId(tuple.target)),
      ).map((tuple) => tuple.id),
      targets,
      guestFlavors,
    }),
  );
}

const userModules = Object.entries(GUEST_PACKAGE_POLICIES).flatMap(([packageName, policy]) =>
  policy.role === "user_module" ? createUserModules(packageName, policy) : [],
);

/** Every module the runtime ships, user-importable and internal, with the tuples and targets it serves. */
export const APPROVED_MODULES: readonly ApprovedModuleEntry[] = Object.freeze([
  ...supportedOrmModules,
  ...userModules,
  createApprovedModule({
    packageName: "@drizzle-run/runtime",
    version: "virtual-v1",
    allowedSpecifiers: [RUNTIME_CONTEXT_SPECIFIER],
    tupleIds: ALL_TUPLE_IDS,
    runtimeLoader: "virtual_context",
    integrity: {
      algorithm: "sha256",
      source: "compiler-generated/context-v1",
      required: true,
    },
  }),
  ...KIT_VERSIONS.map((version) =>
    createApprovedModule({
      packageName: "drizzle-kit",
      version,
      allowedSpecifiers: [],
      tupleIds: selectTupleIds(SUPPORTED_RUNTIME_TUPLES, { kitVersion: version }),
      visibility: "internal",
      runtimeLoader: "guest_package",
      integrity: {
        algorithm: "package_manager",
        source: `drizzle-kit@${version}`,
        required: true,
      },
    }),
  ),
  ...Object.entries(HOST_ENGINES).map(([packageName, version]) => {
    const target = Object.entries(HOST_ENGINE_TARGETS).find(
      ([enginePackageName]) => enginePackageName === packageName,
    )?.[1];

    if (target === undefined) {
      throw new Error(`Expected a database target for the host engine ${packageName}`);
    }

    return createApprovedModule({
      packageName,
      version,
      allowedSpecifiers: [],
      tupleIds: selectTupleIds(SUPPORTED_RUNTIME_TUPLES, { targetId: target }),
      targets: [target],
      visibility: "internal",
      runtimeLoader: "database_engine",
    });
  }),
]);

/** List the modules a guest ships for its tuple and flavor, user-importable and internal. */
export function listApprovedModules({ tuple, guestFlavor }: GuestSelection): readonly ApprovedModuleEntry[] {
  return APPROVED_MODULES.filter(
    (approvedModule) =>
      approvedModule.tupleIds.includes(tuple.id) &&
      approvedModule.targets.includes(databaseTargetId(tuple.target)) &&
      approvedModule.guestFlavors.includes(guestFlavor),
  );
}

/** A library user code can import on a guest besides Drizzle itself, such as zod or effect. */
export interface CompanionLibrary {
  packageName: string;
  version: string;
}

const NOT_COMPANION_PACKAGES = new Set(["drizzle-orm", "drizzle-kit", "@drizzle-run/runtime"]);

/**
 * List the companion libraries a guest ships
 *
 * The user-importable packages of the guest's tuple and flavor other than `drizzle-orm` and `drizzle-kit`: validators,
 * seeders, Effect and its SQL client. Sorted by package name. Project files import each one at this version.
 */
export function listCompanionLibraries(guest: GuestSelection): readonly CompanionLibrary[] {
  const versionsByPackage = new Map(
    listApprovedModules(guest)
      .filter(
        (approvedModule) =>
          approvedModule.visibility === "user" && !NOT_COMPANION_PACKAGES.has(approvedModule.packageName),
      )
      .map((approvedModule) => [approvedModule.packageName, approvedModule.version]),
  );

  return [...versionsByPackage]
    .map(([packageName, version]) => ({ packageName, version }))
    .toSorted((left, right) =>
      left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
    );
}

/** Resolve the user-importable module that owns a specifier on a guest; undefined when none does. */
export function resolveApprovedModule(guest: GuestSelection, specifier: string): ApprovedModuleEntry | undefined {
  return listApprovedModules(guest).find(
    (approvedModule) => approvedModule.visibility === "user" && approvedModule.allowedSpecifiers.includes(specifier),
  );
}

/**
 * Whether some guest for a database lets user code import a specifier
 *
 * Any pair and flavor counts, so a specifier that is false here, such as a typo, is one no release can serve.
 */
export function isShippedSpecifier(target: SupportedRuntimeTuple["target"], specifier: string): boolean {
  const targetId = databaseTargetId(target);

  return APPROVED_MODULES.some(
    (approvedModule) =>
      approvedModule.visibility === "user" &&
      approvedModule.targets.includes(targetId) &&
      approvedModule.allowedSpecifiers.includes(specifier),
  );
}

/**
 * Assert that user code may import a specifier on a tuple
 *
 * Returns the module that owns it. Throws with a message that names the replacement for a known wrong import, such
 * as a validator package on the wrong release line or a database engine imported directly.
 */
export function assertApprovedSpecifier(guest: GuestSelection, specifier: string): ApprovedModuleEntry {
  const { tuple } = guest;
  const approvedModule = resolveApprovedModule(guest, specifier);

  if (approvedModule !== undefined) {
    return approvedModule;
  }

  if (
    guest.guestFlavor !== "effect" &&
    resolveApprovedModule({ tuple, guestFlavor: "effect" }, specifier) !== undefined
  ) {
    const effectVersion = getGuestPackageVersion({
      imageId: toGuestImageId({ ormVersion: tuple.ormVersion, kitVersion: tuple.kitVersion, guestFlavor: "effect" }),
      packageName: "effect",
    });

    throw new Error(
      `${specifier} needs Effect ${effectVersion}: pick the "with Effect" row in the Drizzle version picker`,
    );
  }

  if (tuple.releaseLine === "legacy" && /^(drizzle-orm\/(zod|valibot|arktype|typebox(?:-legacy)?))$/.test(specifier)) {
    throw new Error(`${specifier} is available only for verified Drizzle ORM 1.x tuples`);
  }

  if (tuple.releaseLine === "next" && /^(drizzle-(zod|valibot|arktype|typebox))$/.test(specifier)) {
    throw new Error(`${specifier} is not supported for Drizzle ORM 1.x tuples; use its drizzle-orm integration`);
  }

  if (specifier === "@electric-sql/pglite" || specifier === "@sqlite.org/sqlite-wasm") {
    throw new Error(`${specifier} is package-internal; use ${RUNTIME_CONTEXT_SPECIFIER}`);
  }

  throw new Error(`Unapproved module specifier: ${specifier}`);
}
