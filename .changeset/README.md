# Changesets

Every change to a package someone installs (`@drizzle-run/core`, `runtime`, `orchestration`, `react`, `connect`) comes with a changeset: run `pnpm changeset`, pick the packages and the bump, and describe the change for the people who use the package. `pnpm version-packages` turns the pending changesets into versions and changelogs.

The Release workflow builds and audits all five packages, then packs exact versions missing from npm. It publishes those tarballs in dependency order through npm trusted publishing. The runtime tarball includes its QuickJS engine, exact ORM/Kit guest bundles, workers, database/compiler binaries, and declaration assets. The publish job uses those files without rebuilding them. Each package needs its own npm trusted-publisher configuration (see [deployment setup](../docs/cloudflare.md#setup-once)).

After npm publication succeeds, the workflow creates a GitHub Release for each public package version, tagged `<package-name>@<version>`. After production deployment succeeds, it creates the app release, tagged `drizzle-run-app@<version>`. Release notes come from that version's Changesets entry in each workspace's `CHANGELOG.md`. Existing releases are left unchanged on reruns; later pushes with no pending changesets can finish missing releases. Only stable app releases are marked as the repository's latest release.

Testing workspaces stay private, and the capability harness is ignored. The app is private too, but its version is what deploys production (see docs/cloudflare.md): `updateInternalDependents: "always"` bumps it whenever a package it depends on is bumped, so a change to core, runtime or react deploys too. Changes to the embed loader belong to the app and need an app changeset to deploy. The companion only bundles `@drizzle-run/core` as a dev dependency, which Changesets never follows: a core change that reaches the companion (the connect protocol, its tools) needs a changeset for `@drizzle-run/connect` too, or npm keeps the old bundle. While a package is below 1.0, a breaking change is a `minor` bump.

See the [Changesets documentation](https://github.com/changesets/changesets) for the format.
