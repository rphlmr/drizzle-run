# Drizzle Run

A browser playground for [Drizzle ORM](https://orm.drizzle.team). Write a schema, a seed and queries, press Run, and
see the results, the SQL and what happened, against a real PostgreSQL or SQLite database running in your browser.

- **Real releases.** Each run uses unmodified `drizzle-orm` and `drizzle-kit` packages at exact versions, on a
  PostgreSQL ([PGlite](https://pglite.dev)) or SQLite ([SQLite Wasm](https://sqlite.org/wasm/)) database.
- **Your code runs in the browser.** Code runs in an isolated QuickJS-WASI guest, with a
  fresh database for every run.
- **Local or Cloud.** Keep projects in this browser, or sign in with GitHub and save them to your account.
- **Share and embed.** Sign in to publish a link, list it in Community, or embed a playground in any web page.

| Release line | Drizzle ORM | Drizzle Kit |
| ------------ | ----------- | ----------- |
| Legacy       | 0.45.4      | 0.31.11     |
| Next         | 1.0.0-rc.5  | 1.0.0-rc.5  |

## How it works

The app hands a project to `@drizzle-run/runtime`, which bundles it and runs the schema, Drizzle Kit, the seed and
the queries together in a QuickJS-WASI guest. A separate worker owns the database. A Cloudflare Worker serves the
app, stores shared projects in D1 and delivers the runtime files from R2.

**Read [docs/architecture.md](docs/architecture.md) for the full picture**, with diagrams of the pieces, a run, and
how versions are managed.

## Run it locally

You need:

- **Node 26.13.0 LTS**, pinned in `.node-version`.
- **pnpm 12.17.0**, pinned in `package.json`. Install it with `npm install --global pnpm@12.17.0`.

Clone your fork (or this repository), then run these commands from the cloned repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:4173. The first start installs the pinned guest dependencies and builds each dialect's
QuickJS bundle into `.cache`. Later starts reuse the build cache.

`pnpm dev` builds the packages and serves the app from Vite with hot reload. The
[Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/) runs the Worker beside it, with
local D1, local R2 buckets and the AI chat relay. Local projects and runs need no account. Publishing, Community
listing and Cloud sync need GitHub sign-in; reading existing shared links does not. Stop the server with Ctrl-C.

Optional extras:

- **Local settings:** copy [apps/drizzle-run/.dev.vars.example](apps/drizzle-run/.dev.vars.example) to
  `apps/drizzle-run/.dev.vars` and uncomment what you need. It documents GitHub credentials and the daily AI chat
  limit. Worker bindings and other deployment settings live in `apps/drizzle-run/wrangler.jsonc`.
- **Sample shares:** `pnpm db:seed` adds two shares built from the official examples, one listed in Community.
- **GitHub sign-in** (publishing, Community listing, Cloud sync): create your own GitHub App and put its Client ID and secret in
  `apps/drizzle-run/.dev.vars`. The [setup guide](docs/cloudflare.md#sign-in-with-github) covers local callbacks and
  self-hosted domains. `pnpm dev` has no mock GitHub; only `pnpm test:e2e` signs in against one.
- **AI chat:** run the local companion as [packages/connect](packages/connect/README.md#try-it-locally) describes.
- **iPhone testing over HTTPS:** see [apps/drizzle-run](apps/drizzle-run/README.md#local-https-for-iphone-testing).

## Self-hosting

Follow [First deployment](docs/cloudflare.md#first-deployment) to select your Cloudflare account, create D1 and R2
resources, and deploy your own Worker. [GitHub sign-in](docs/cloudflare.md#sign-in-with-github) is optional.
The manual setup does not require GitHub Actions or npm publishing.

## Where your projects go

Local projects stay in this browser's storage. Cloud projects are stored in your account on the instance you use.
Publishing creates a share that anyone with its link can read, including its source and synthetic environment
values. A playground's database stays in the browser and is recreated for each run.

Export projects as JSON for a separate backup. Clearing site data removes Local projects. See
[project storage and session behavior](apps/drizzle-run/README.md#cloud-sync) for the details.

## Commands

| Command                | What it does                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`             | Builds the packages and serves the app with hot reload on port 4173                       |
| `pnpm preview`         | Builds everything and serves the production build through Wrangler on the same port       |
| `pnpm build`           | Builds every package, the runtime assets and the app                                      |
| `pnpm typecheck`       | Typechecks every package, the Worker and the e2e suite                                    |
| `pnpm lint`            | Runs oxlint with type-aware rules                                                         |
| `pnpm format`          | Formats with oxfmt (`pnpm format:check` only checks)                                      |
| `pnpm test`            | Unit tests of every package, the app and the Worker                                       |
| `pnpm test:runtime`    | Runtime gates: QuickJS execution contracts and native Kit SQL parity (after a build)      |
| `pnpm test:e2e`        | Browser suite in Chromium, against a fresh production build                               |
| `pnpm test:e2e:all`    | Browser suite in Chromium, Firefox and WebKit, as CI does on a public repository          |
| `pnpm test:stress`     | WebKit memory stress, run on demand when a browser runs out of memory                     |
| `pnpm test:deployed`   | Runs a project on `DRIZZLE_RUN_DEPLOYED_URL`, from the checkout that built it             |
| `pnpm db:check`        | Checks the D1 and browser store migrations against their Drizzle schemas                  |
| `pnpm db:up`           | Upgrades the D1 and browser store snapshots to the pinned Kit's format (`drizzle-kit up`) |
| `pnpm guests:sync`     | Relocks and regenerates after a guest version change ([guests](guests/README.md))         |
| `pnpm record:official` | Records the official examples' runs, which embeds show where a browser cannot run         |

Install the browsers once before the e2e suite:

```bash
pnpm exec playwright install chromium firefox webkit
```

The e2e suite builds first, then serves the build on emptied local storage (`.cache/cloudflare-e2e`), so no run
reuses what an earlier one left.

## Ports and local state

The main checkout uses port 4173 for the app and 4311 for a plain blog page that the embed tests load. Each linked git
worktree gets its own stable pair, derived from its path, so several worktrees can run `pnpm dev` or `pnpm test:e2e`
at once; the servers print their URLs. `DRIZZLE_RUN_PORT` and `DRIZZLE_RUN_FIXTURE_PORT` override them, and
[`scripts/drizzle-run-ports.ts`](scripts/drizzle-run-ports.ts) holds the rule. A taken port stops the server with an
error instead of moving to another one.

Build and test output stays inside the checkout: `.cache` (local D1 and R2, runtime assets, the Vite cache),
`test-results` and `playwright-report`. `pnpm clean:all` deletes every git-ignored file, `node_modules` included,
except the local settings and secrets its script preserves, such as `.dev.vars`. It also removes the local D1 and
R2 data under `.cache`. Run `pnpm install` after it. Browser project storage belongs to the browser's origin and is
separate from these checkout files.

## Repository layout

| Path               | What it is                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/drizzle-run` | The web app and its Cloudflare Worker ([README](apps/drizzle-run/README.md))                                                     |
| `packages/core`    | Manifests (one version and side by side), release catalog, contracts and guides, no I/O                                          |
| `packages/runtime` | The browser runtime and its XState machines ([README](packages/runtime/README.md))                                               |
| `packages/react`   | React providers and hooks over the runtime machines                                                                              |
| `packages/connect` | The AI chat companion CLI ([README](packages/connect/README.md))                                                                 |
| `testing/`         | Private validation workspaces: shared fixtures, machine path testing, and runtime capability gates ([README](testing/README.md)) |
| `guests/`          | One npm package per guest image, where guest versions live ([README](guests/README.md))                                          |
| `docs/`            | [Architecture](docs/architecture.md) and [Cloudflare hosting](docs/cloudflare.md)                                                |

## Supported browsers

Chrome and Edge 136, Firefox 146 and Safari 26 or later. The app is built for ES2025, and these are the first versions
with every feature it uses, per [MDN browser compatibility data](https://github.com/mdn/browser-compat-data). The
connect CLI needs Node 22.4 or later.

## Contributing

Report a bug or ask for a feature through the [issue forms](https://github.com/rphlmr/drizzle-run/issues/new/choose),
and report a vulnerability privately as [SECURITY.md](SECURITY.md) describes. Pull requests are open to collaborators,
who accept the [Contributor License Agreement](CLA.md). [CONTRIBUTING.md](CONTRIBUTING.md) covers the checks to run
and the changeset a package others install (`core`, `runtime`, `orchestration`, `react`, `connect`) needs. CI runs the build,
typechecks, lint, unit tests, the packed package audits, the runtime gates, the guide replay, the migration checks
and the browser suite (`.github/workflows/ci.yml`).

## License

[GNU Affero General Public License v3.0](LICENSE). Running a modified Drizzle Run as a network service requires offering
its users the modified source. For a commercial license or other terms, contact [@rphlmr](https://x.com/rphlmr).

Drizzle, Drizzle ORM and Drizzle Kit are trademarks of Drizzle LLC, and their packages are licensed by their authors
under their own terms. The AGPL covers Drizzle Run's own code only.
