# Guest packages

Each folder here pins one QuickJS guest composition: a release pair's slim guest (`orm-<orm>__kit-<kit>`) or one of its
flavors (`orm-<orm>__kit-<kit>+<flavor>`). Its `package.json` and `package-lock.json` are the only place a guest
library version is written. The core catalog, approved modules, editor type artifacts, guest images and the capability
harness are all generated from them. How they fit in is in
[`docs/architecture.md`](../docs/architecture.md#release-pairs-and-guests).

## Rules the check enforces

- Every pin is exact. A flavor guest pins everything its slim guest pins, at the same versions, plus its own packages.
- The slim guest's `drizzleRun` holds `flavor`, `releaseLine`, `recommended`, `ormApi` and `kitApi`. A flavor guest's
  holds only `flavor`.
- Exactly one pair is recommended, and exactly one pair is on the Legacy line.
- The lock root lists the same `dependencies` and `devDependencies` as `package.json`.
- A companion library (effect, zod, valibot, arktype, typebox, drizzle-seed) is pinned by each guest alone. Bumping it
  in one guest touches no other guest and no workspace package.

## Commands

Run these commands from the repository root.

| Command             | What it does                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm guests:new`   | Scaffolds a pair's guest folders from an existing pair (flags below). Locks nothing.           |
| `pnpm guests:sync`  | Relocks every guest whose lock is stale, installs, regenerates the catalog, then checks drift. |
| `pnpm guests:check` | Fails when the committed catalog differs from what the guest folders generate. CI runs it.     |

`pnpm guests:new` flags:

| Flag                                 | Meaning                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `--orm <version>`, `--kit <version>` | The new pair's exact drizzle-orm and drizzle-kit versions. Required.                                                |
| `--from <pair id>`                   | The pair to copy pins and flavors from. Required. drizzle-seed follows the ORM when the source pins it in lockstep. |
| `--flavor <flavor>`                  | Adds a flavor the source does not have; it starts from the slim pins. Repeatable.                                   |
| `--pin <name>@<version>`             | Pins a package in the slim guest and every flavor. Repeatable.                                                      |
| `--pin <flavor>:<name>@<version>`    | Pins a package in that flavor only, such as `effect:effect@4.0.5`. Repeatable.                                      |
| `--orm-api v<n>`, `--kit-api v<n>`   | The API generations, when they differ from the source's.                                                            |
| `--replace`                          | The Legacy in-place bump: keeps the source's metadata, recommendation included, and deletes its folders.            |

The release line follows the ORM version (0.x is Legacy, 1.x is Next). A new pair is never recommended: move
`"recommended": true` by hand, from the old pair's slim `package.json` to the new one's, when it should be.

## Runbook: add a Next pair

1. Scaffold it from the current Next pair, pinning the effect release the new ORM ships with:

   ```bash
   pnpm guests:new --orm 1.0.0-rc.6 --kit 1.0.0-rc.6 --from orm-1.0.0-rc.5__kit-1.0.0-rc.5 --pin effect:effect@<version> --pin effect:@effect/sql-pg@<version> --pin effect:@effect/sql-libsql@<version>
   ```

2. If a companion changes its exported subpaths, list that version's specifiers in `specifiersByVersion` of its policy in
   `packages/core/src/registry/package-policies.ts`. Type artifact generation fails on a specifier the pinned version
   does not export, so a miss cannot ship.
3. `pnpm guests:sync`, then `pnpm guests:check`. The catalog lists one approved module per published file, so check
   the `ORM_EXPORT_INVENTORY` diff for new families.
4. `pnpm exec turbo run test:runtime` builds the runtime and guest assets before running the gates. The ORM corpus
   gate fails on every new user-facing function or builder method until the corpus calls it or `uncoveredExports` /
   `uncoveredMethods` records why it is not user API.
5. Move `"recommended": true` if the new pair should be the default.
6. Retire the old pair when it should no longer be offered (runbook below), or keep it beside the new one.
7. Record the official recordings that should run on the new pair: `pnpm record:official`.
8. Commit the guest folders, `packages/core/src/releases/guest-catalog.generated.ts` and the recordings, then release
   (last runbook).

## Runbook: move the app itself to a new Next release

The Worker, the local store and the D1 tooling use their own `drizzle-orm` and `drizzle-kit`, pinned in
`apps/drizzle-run/package.json`, apart from the guests users run.

1. Bump both pins, then `pnpm install`.
2. `pnpm typecheck`, `pnpm test` and `pnpm db:check`. The store applies its migrations through the internal
   `migrateAsync` of `drizzle-orm/sqlite-core/async/session`, which a release may move.
3. `pnpm db:up` when the new Kit writes a newer snapshot version: it runs `drizzle-kit up` with both configs
   (`drizzle.config.ts`, `drizzle.store.config.ts`).

## Runbook: bump Legacy in place

Legacy has one pair, and a new Legacy release replaces it. Saved manifests on the old Legacy versions follow it when
they open (`followInPlaceRelease` in `packages/core/src/manifest/retired-pair.ts`), so no project needs a move.

1. Scaffold the new pair over the old one; `--replace` deletes the old folders and keeps the recommendation:

   ```bash
   pnpm guests:new --orm 0.45.5 --kit 0.31.12 --from orm-0.45.4__kit-0.31.11 --replace
   ```

2. Bump any companion that should move with it, with `--pin` above or by editing the new `package.json` files.
3. `pnpm guests:sync`, then `pnpm guests:check`.
4. Re-record the official recordings on Legacy: `pnpm record:official`.
5. Commit and release (last runbook).

## Runbook: refresh a pair's companions in place

For a companion fix on any pair, such as an effect patch during rc5 or a zod fix on Legacy. The pair id stays, so
saved projects open on the refreshed pair because their manifests pin only ORM and Kit.

1. Edit the pins in each of the pair's guests: `guests/<pair>/package.json` and every `guests/<pair>+<flavor>/package.json`.
   A shared pin must change in the slim guest and in every flavor together.
2. Relock, install, regenerate and check drift in one step:

   ```bash
   pnpm guests:sync
   ```

   It relocks only the guests whose lock no longer lists their `package.json` pins.

3. Check the committed catalog matches:

   ```bash
   pnpm guests:check
   ```

4. Re-record the official recordings made on that pair:

   ```bash
   pnpm record:official
   ```

   No manifest changed, so the snapshot digest cannot flag them. Each recording stores the guest it ran on (image id
   and `lockDigest`); the official recordings test fails for every recording whose `lockDigest` differs from the
   catalog's and names its embed, and `record:official` re-records exactly those. Shared recordings made on the old
   guest are no longer shown; their embeds offer a new tab that runs them live.

5. Commit the guest folders, `packages/core/src/releases/guest-catalog.generated.ts` and the recordings.
6. Release (next runbook).

## Runbook: retire a pair

1. Delete the pair's folders: `guests/<pair>` and every `guests/<pair>+<flavor>`.
2. `pnpm guests:sync`, then `pnpm guests:check`.
3. Re-record or remove the official recordings that ran on it.
4. Commit and release. Saved projects on the retired pair open with a move offer (`retired-pair.ts`).

## Release

Run the release command from the commit to release, after the first deployment steps in
[`docs/cloudflare.md`](../docs/cloudflare.md#first-deployment):

```bash
pnpm --filter @drizzle-run/app run release --bucket <bucket> --account-id <account-id> --url <https origin>
```

It builds, uploads the runtime assets (guest images included), deploys the Worker and verifies the deployment. After
a verified deploy, it deletes from R2 the runtime assets no kept deployment needs, so a replaced guest leaves R2 with
this release. A rollback is the same command on the older commit, which uploads its assets again. The steps and the
prune rules are in [`docs/cloudflare.md`](../docs/cloudflare.md#release).
