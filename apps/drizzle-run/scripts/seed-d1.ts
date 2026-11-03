import { readdir, readFile } from "node:fs/promises";

import { resolveGuestFlavor } from "@drizzle-run/core/catalog";
import { parsePublishedPlaygroundSnapshot } from "@drizzle-run/core/contracts";
import { inArray } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { AnySQLiteInsert } from "drizzle-orm/sqlite-core";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports.ts";
import { communityListings, playgroundLinks, recordedRuns, users } from "../worker/schema.ts";
import { toSnapshotSummaryJson } from "../worker/snapshot-summary.ts";
import { openLocalD1 } from "./local-d1.ts";

// Seeds the local PLAYGROUNDS D1 with one Community share and one link-only share. Run it with `pnpm db:seed`.

const examplesRoot = new URL("../examples/", import.meta.url);

/**
 * The seed's GitHub account, which owns both shares
 *
 * The e2e GitHub mock's default account: its avatar resolves, and a local sign-in through the mock reuses this row.
 */
const seedOwner = {
  id: "5eed0000-0000-4000-8000-000000000000",
  githubId: 583231,
  login: "octocat",
  name: "The Octocat",
};

const seedShares = [
  {
    linkId: "5eed0000-0000-4000-8000-000000000001",
    label: "Community",
    example: "quick-start-postgresql",
    listed: true,
  },
  {
    linkId: "5eed0000-0000-4000-8000-000000000002",
    label: "Link only",
    example: "quick-start-sqlite",
    listed: false,
  },
];

/**
 * Read an official example as a playground snapshot
 *
 * Builds the manifest the way src/examples/catalog.ts does, then runs it through the same parsing, canonical JSON and
 * digest as a publish, so the stored row is one the Worker would have written.
 */
async function readExampleSnapshot(slug: string) {
  const exampleRoot = new URL(`${slug}/`, examplesRoot);
  const metadata = JSON.parse(await readFile(new URL("example.json", exampleRoot), "utf8"));
  const pair = /^orm-(.+)__kit-(.+)$/.exec(metadata.releasePair ?? "");

  if (pair === null) {
    throw new Error(`Expected examples/${slug}/example.json releasePair to look like "orm-<version>__kit-<version>".`);
  }

  const files: Record<string, string> = {};

  for (const fileName of (await readdir(new URL("files/", exampleRoot))).toSorted()) {
    files[fileName] = await readFile(new URL(`files/${fileName}`, exampleRoot), "utf8");
  }

  const published = parsePublishedPlaygroundSnapshot({
    snapshotVersion: 1,
    name: metadata.title,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: metadata.dialect },
      dependencies: { "drizzle-orm": pair[1], "drizzle-kit": pair[2] },
      entrypoints: {
        schema: "schema.ts",
        ...(Object.hasOwn(files, "seed.ts") ? { seed: "seed.ts" } : {}),
        run: "query.ts",
      },
      files,
      ...(metadata.randomSeed === undefined ? {} : { randomSeed: metadata.randomSeed }),
    },
  });

  if (published.snapshot.manifest.kind !== "drizzle-run") {
    throw new Error(`Expected the seed example ${slug} to contain one run manifest.`);
  }

  return {
    snapshot: { ...published.snapshot, manifest: published.snapshot.manifest },
    description: metadata.description,
    payloadJson: published.canonicalJson,
    contentDigest: published.digest,
    summaryJson: await toSnapshotSummaryJson(published.snapshot),
  };
}

/**
 * Write the seed's account and shares to a PLAYGROUNDS D1, replacing an earlier seed
 *
 * @returns The seeded shares, with the snapshot each one stores
 */
export async function seedPlaygrounds(db: DrizzleD1Database, { now }: { now: string }) {
  const prepared = await Promise.all(
    seedShares.map(async (share) => ({ ...share, ...(await readExampleSnapshot(share.example)) })),
  );
  const linkIds = prepared.map((share) => share.linkId);

  const owner = await db
    .insert(users)
    .values({ ...seedOwner, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: users.githubId, set: { updatedAt: now } })
    .returning({ id: users.id })
    .get();

  // Children before their links, for the foreign keys.
  await db.batch([
    db.delete(communityListings).where(inArray(communityListings.linkId, linkIds)),
    db.delete(recordedRuns).where(inArray(recordedRuns.linkId, linkIds)),
    db.delete(playgroundLinks).where(inArray(playgroundLinks.id, linkIds)),
    ...prepared.flatMap((share) => {
      const manifest = share.snapshot.manifest;
      const statements: AnySQLiteInsert[] = [
        db.insert(playgroundLinks).values({
          id: share.linkId,
          ownerUserId: owner.id,
          snapshotVersion: share.snapshot.snapshotVersion,
          payloadJson: share.payloadJson,
          contentDigest: share.contentDigest,
          description: share.description,
          summaryJson: share.summaryJson,
          idempotencyKey: `drizzle-run-seed-${share.linkId}`,
          createdAt: now,
          updatedAt: now,
        }),
      ];

      if (share.listed) {
        statements.push(
          db.insert(communityListings).values({
            linkId: share.linkId,
            ownerUserId: owner.id,
            state: "listed",
            title: share.snapshot.name,
            description: share.description,
            topic: "playground",
            dialect: manifest.target.dialect,
            ormVersion: manifest.dependencies["drizzle-orm"],
            kitVersion: manifest.dependencies["drizzle-kit"],
            guestFlavor: resolveGuestFlavor(manifest),
            fileNames: JSON.stringify(Object.keys(manifest.files).toSorted()),
            listedAt: now,
          }),
        );
      }

      return statements;
    }),
  ]);

  return prepared;
}

async function seedLocalD1() {
  const localD1 = await openLocalD1();

  try {
    const prepared = await seedPlaygrounds(drizzle(localD1.database), { now: new Date().toISOString() });
    const origin = toLocalOrigin(resolveDrizzleRunPorts().app);

    console.log("Seeded the local D1:");

    for (const share of prepared) {
      console.log(`- ${share.label} share "${share.snapshot.name}": ${origin}/s/${share.linkId}`);
    }

    console.log(`Community lists the first one as @${seedOwner.login}: ${origin}/community`);
  } finally {
    await localD1.dispose();
  }
}

if (import.meta.main) {
  await seedLocalD1();
}
