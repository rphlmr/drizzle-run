# Cloudflare hosting

Drizzle Run is one Cloudflare Worker with static assets. `apps/drizzle-run/wrangler.jsonc` declares its bindings:

| Binding                          | Kind                     | Holds                                                        |
| -------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `ASSETS`                         | Static assets            | The built app                                                |
| `PLAYGROUNDS`                    | D1                       | Shares, recorded runs, Community, accounts, cloud sync index |
| `RUNTIME_ASSETS`                 | R2                       | QuickJS, guest bundles, database engines, and types          |
| `CLOUD_PROJECTS`                 | R2                       | Cloud sync copies of projects                                |
| `PUBLISH_RATE_LIMIT`             | Rate limit               | Publishing, recordings and reports                           |
| `AUTH_RATE_LIMIT`                | Rate limit               | Sign-ins started, per address                                |
| `CONNECT_RATE_LIMIT`             | Rate limit               | AI chat relay connections, per room and address              |
| `CONNECT_ADDRESS_RATE_LIMIT`     | Rate limit               | AI chat relay connections, per address across rooms          |
| `CLOUD_SYNC_RATE_LIMIT`          | Rate limit               | Cloud sync saves, per account                                |
| `CONNECT_ROOMS`, `CONNECT_QUOTA` | Durable Objects (SQLite) | The AI chat relay and its daily quota                        |

`wrangler.jsonc` names the production resources of the hosted Drizzle Run. Local servers keep their own copies of
them under the same names in `.cache`, and never reach the account. To host your own, create the resources below and
put your D1 id and bucket names in its top-level bindings. Link preview images are drawn at build time, and the
Durable Objects use the SQLite backend available on the Workers Free plan. Traffic and stored projects still count
against your account's limits; check the current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) when sizing an instance.

For local development, follow the [root README](../README.md#run-it-locally). For self-hosting, start at
[First deployment](#first-deployment), then configure [GitHub sign-in](#sign-in-with-github) if needed.

## Local servers

```bash
pnpm dev
```

```bash
pnpm preview
```

Both apply the D1 migrations, upload the runtime assets to the local R2 bucket the same way a release does, and
serve on port 4173 (a linked worktree uses its own port, see [Ports](../README.md#ports-and-local-state)). `pnpm dev`
runs the Vite dev server with the Worker in workerd through the Cloudflare Vite plugin; `pnpm preview` serves the
production build through `wrangler dev`. Both keep their state in `.cache/cloudflare`. The e2e suite uses its own
state in `.cache/cloudflare-e2e`, emptied on every start.

## First deployment

D1 databases and R2 buckets belong to a **Cloudflare account**. They are created independently of the Worker, then
attached to it through the bindings in `apps/drizzle-run/wrangler.jsonc`. There is no Cloudflare Pages project to
select: this app deploys as a Worker, whose name comes from that file's top-level `name`.

### Choose the account

From the repository root, enter the app directory and authenticate:

```bash
cd apps/drizzle-run
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Find the account you intend to host in and copy its **Account ID** (32 hexadecimal characters, not a zone ID).
Pin it for every command in this terminal:

```bash
export CLOUDFLARE_ACCOUNT_ID="<your-cloudflare-account-id>"
```

Replace the placeholder before running it. If you open another terminal, export the same value there.
[Wrangler supports this account variable](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
for resource creation, deployment, and secret commands. Without an explicit account, Wrangler may infer one from
your login or prompt you to choose. `wrangler whoami` identifies your login and accessible accounts; the export selects
the target for the following commands. For automation, authenticate with a `CLOUDFLARE_API_TOKEN` scoped to that account
instead of interactive login; the required permissions are listed under [Setup, once](#setup-once).

Enable **R2 Object Storage** in that account's dashboard before creating the buckets. Open **Workers & Pages** in
the same account to set up its workers.dev subdomain if it has none.

### Create your database and buckets

Still in `apps/drizzle-run`, with `CLOUDFLARE_ACCOUNT_ID` set:

```bash
pnpm exec wrangler d1 create my-drizzle-run
pnpm exec wrangler r2 bucket create my-drizzle-run-assets
pnpm exec wrangler r2 bucket create my-drizzle-run-cloud-projects
```

These commands create remote resources in the selected account. Choose your own names if needed, and use those same
names in the configuration below. Copy the `database_id` printed by `d1 create`. You can check the resources with:

```bash
pnpm exec wrangler d1 list
pnpm exec wrangler r2 bucket list
```

### Bind them to your Worker

Update the following **top-level fields** in `apps/drizzle-run/wrangler.jsonc`. Merge them into the existing file,
keeping its entrypoint, assets, Durable Objects, migrations, variables, rate limits, and local `env.e2e` configuration:

```jsonc
{
  "name": "my-drizzle-run",
  "account_id": "<your-cloudflare-account-id>",
  "d1_databases": [
    {
      "binding": "PLAYGROUNDS",
      "database_name": "my-drizzle-run",
      "database_id": "<database-id-returned-by-d1-create>",
    },
  ],
  "r2_buckets": [
    {
      "binding": "RUNTIME_ASSETS",
      "bucket_name": "my-drizzle-run-assets",
    },
    {
      "binding": "CLOUD_PROJECTS",
      "bucket_name": "my-drizzle-run-cloud-projects",
    },
  ],
}
```

Replace both IDs with your own, including the D1 ID already checked into this repository. Keep `account_id` and
`CLOUDFLARE_ACCOUNT_ID` identical. Keep the binding names `PLAYGROUNDS`, `RUNTIME_ASSETS`, and `CLOUD_PROJECTS` unchanged:
the Worker code reads those names. The resource names and database ID identify your actual database and buckets;
changing the Worker's `name` alone does not select or create them. Cloudflare's
[binding reference](https://developers.cloudflare.com/workers/wrangler/configuration/) describes these fields.

Keep both R2 buckets private. The Worker serves runtime assets and controls access to cloud projects; public bucket
access and S3 access keys are not needed for this setup.

### Initialize and deploy

Creating the resources does not initialize the D1 schema or populate the runtime bucket. From `apps/drizzle-run`,
run the release with the same account and runtime bucket:

```bash
pnpm run release --bucket my-drizzle-run-assets --account-id "$CLOUDFLARE_ACCOUNT_ID" --url https://my-drizzle-run.my-account.workers.dev
```

Replace `my-account` with your account's workers.dev subdomain, and use the Worker and bucket names you configured.
The command builds the app, uploads runtime assets to `RUNTIME_ASSETS`, applies D1 migrations to `PLAYGROUNDS`, and
deploys the Worker named by `wrangler.jsonc`. The `CLOUD_PROJECTS` bucket starts empty and fills as signed-in users
sync projects. No seed data is required. The [release steps](#release) also explain verification and asset pruning.

Open that URL after the release succeeds, then optionally configure [GitHub sign-in](#sign-in-with-github) for that
exact origin. A custom domain can be configured later; update its GitHub callback when you start using it.

## Release

A release, including a QuickJS, SDK or guest bump, is one command from the commit to deploy:

```bash
pnpm --filter @drizzle-run/app run release --bucket <runtime assets bucket> --account-id <account id> --url https://<origin>
```

It uses Wrangler's credentials (`wrangler login` or `CLOUDFLARE_API_TOKEN`) for every step. `--account-id` selects the
account for the upload, migrations, deployment, and prune; `wrangler.jsonc` selects the Worker and its resource bindings.
Use the same account ID you configured in [First deployment](#first-deployment). The script checks that `--bucket`
matches the `RUNTIME_ASSETS` binding and rejects a missing or all-zero D1 ID. It cannot identify a copied upstream D1
ID as yours, so replace that ID with the one returned when you created your database.

1. **Build:** `pnpm run build`, which also prepares the runtime assets and their inventory.
2. **Upload:** stores the missing runtime assets in R2, then the inventory's deployment record,
   `deployments/<inventory id>.json` (the commit, the upload time and the inventory's keys). A pull request preview's
   upload (`--preview pr-<number>`) names it `deployments/<inventory id>.pr-<number>.json` instead.
3. **Migrate:** `scripts/migrate-d1.ts --remote` applies the pending migrations to the D1 database `wrangler.jsonc`
   binds to `PLAYGROUNDS`, through a Wrangler remote binding and drizzle-orm's D1 migrator. It runs before the deploy, so the new Worker never meets an older schema, but the previous Worker
   still serves during it: a migration must keep working for it. Add tables and columns in one release, and drop
   what the code no longer reads in a later one.
4. **Deploy:** `wrangler deploy`.
5. **Verify:** fetches every inventory asset through `--url` and requires 200, the inventory's `Content-Digest` and
   the same bytes. While the deployment propagates, the previous Worker answers 404 for new assets, so those are
   retried every 5 seconds within one 30 second deadline. A 200 with the wrong bytes fails at once.
6. **Prune:** deletes the runtime assets no kept deployment references, then the older records.

**Any failure stops the release before the prune**, so the previous deployment's objects stay in R2 until a new
Worker has served its own.

**A rollback is the same command on the older commit.** It rebuilds the older source, uploads the resulting inventory's
assets, then switches the Worker with `wrangler deploy`. A fresh PostgreSQL template can change the build's content
hash, so these assets can differ from that commit's previous build. Migrations only move forward: the
older commit has no newer migration to apply, and its Worker runs on the newer schema, as step 3 requires. Do not use `wrangler rollback`
alone: the older Worker would request assets that are no longer in R2.

### How the upload and the prune decide

The uploader asks the bucket, through a [`getPlatformProxy`](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy)
R2 binding, which inventory assets it already holds with the expected size and MD5, and skips them. For each missing
asset it checks the local file's size, SHA-256 and MD5 against the inventory, then runs
[`wrangler r2 object put`](https://developers.cloudflare.com/workers/wrangler/commands/r2/#r2-object-put). Wrangler
login or `CLOUDFLARE_API_TOKEN` supplies credentials.

The prune keeps the checkout's current inventory, every asset of the newest `--keep` records (default 1, by upload
time), the newest record of each preview `--open-previews` names, and every asset stored after the latest record or in
the last day (an upload still running, or one that failed before its record). It never touches keys outside
`<sha256>/` and `deployments/`, stops on a record it cannot parse, and deletes nothing while the bucket holds fewer
records than `--keep`. Alone, it is a dry run that prints each key and the
total bytes:

```bash
node --experimental-strip-types apps/drizzle-run/scripts/prune-runtime-assets.ts --remote --bucket <bucket> --account-id <account id>
```

`--local` prunes the bucket `pnpm dev` uses, which records every local start.

### Build output

The Cloudflare Vite plugin writes the static files to `apps/drizzle-run/dist/client` and the Worker to
`apps/drizzle-run/dist/drizzle_run`, and points `wrangler deploy` at its generated config in
`apps/drizzle-run/.wrangler/deploy/config.json`. The build copies `apps/drizzle-run/.cache/embed` into
`apps/drizzle-run/dist/client/embed` to serve `/embed/index.js`. `DRIZZLE_RUN_WRANGLER_CONFIG` builds from another
Wrangler config, as the release's `--config` does.

## Previews, next and production in CI

This section describes the **upstream repository's release infrastructure**. Manual self-hosting uses
[First deployment](#first-deployment) and does not require these workflows or npm publishing.

To adapt this CI pipeline for a fork:

- Set the production runtime bucket in `.github/workflows/release.yml` to your `RUNTIME_ASSETS` bucket; the workflow
  currently passes `drizzle-run-assets` to the release command.
- Change `nextReleaseDomain` in `apps/drizzle-run/scripts/deploy-environment.ts` to a staging domain you control.
- If you intend to publish your own companion package, use an npm package name you own and update its workspace
  references, publishing configuration, and the app's companion command. Otherwise, keep npm publishing disabled.
- Configure your own accounts, domains, tokens, and GitHub environments using the checklist below.

```text
pull request ──▶ Preview workflow ──▶ pr-<n>.<subdomain>.workers.dev   (deleted when it closes)
push to main ──▶ Release workflow ─┬▶ Version Packages pull request ──▶ next.drizzle.run
                                   └▶ it merges ──▶ npm publish, app version bump ──▶ production
```

`next` is a deployment environment, not a Git branch. Both next and production deploy from `main`, through
[the Release workflow](../.github/workflows/release.yml). Pending changesets send the build to next. Merging the
Version Packages pull request consumes those changesets and makes the version eligible for production.

**Pull request previews run in a Cloudflare account of their own.** A preview runs the pull request's code with a
token that creates and deletes Workers and D1 databases and writes R2 objects. Keep that account separate from
production. next and production share the account that holds the `drizzle.run` zone, since a custom domain must
live there, and their tokens only reach jobs on `main`.

| Environment  | Worker             | D1                 | R2 buckets                                                   | Companion in Ask AI                 |
| ------------ | ------------------ | ------------------ | ------------------------------------------------------------ | ----------------------------------- |
| Pull request | `pr-<n>`           | `pr-<n>`           | `assets`, `cloud-projects`, shared                           | pkg.pr.new, the pull request's head |
| next         | `drizzle-run-next` | `drizzle-run-next` | `drizzle-run-next-assets`, `drizzle-run-next-cloud-projects` | pkg.pr.new, the main commit         |
| Production   | `drizzle-run`      | `drizzle-run`      | `drizzle-run-assets`, `drizzle-run-cloud-projects`           | npm                                 |

Production names and its D1 ID come from the top-level bindings in `apps/drizzle-run/wrangler.jsonc`.

**Each open pull request holds one D1 database.** The [Workers Free plan allows 10 per account](https://developers.cloudflare.com/d1/platform/limits/), so at most 10 previews
run at once in the preview account; the next one fails at `prepare` until a pull request closes. The Workers Paid plan
raises the limit far beyond that.

`scripts/manage-deploy-environment.ts prepare` creates the missing D1 and buckets through the Cloudflare API and
writes `wrangler.deploy.json` from `wrangler.jsonc`, with the environment's own resources and rate limit namespaces;
the release takes it with `--config`. Previews prune the shared bucket with `--keep 10` and
`--open-previews`, the open pull requests that `gh pr list` returns: the prune keeps the newest 10 records and the newest
record of every open preview, so an open pull request keeps its runtime assets however many others deploy, and a closed
one's go once 10 newer records were uploaded. Deploy environments verify with `--verify-timeout 180`, since a new workers.dev host can take minutes to
answer. Then `pnpm test:deployed` opens the deployed preview, next or production in Chromium, creates a project and
runs it, so the runtime is proven to load from R2 through the real Worker. It writes nothing to D1 or R2: the project
stays in the test browser. It runs from the checkout that built the deploy, since the store worker's file name is a
hash of that build. It expects noindex on workers.dev and wherever `DRIZZLE_RUN_DEPLOYED_SEARCH_INDEXING` is `off`,
as previews and next set it, and an indexed page only from production on its own domain. next is also checked on
next.drizzle.run, where only `SEARCH_INDEXING` hides it. `delete` removes a closed pull request's Worker and D1.
Every deploy environment sets `SEARCH_INDEXING` to `off` and keeps its workers.dev address, where the release verifies
it; the Worker answers `noindex` there and on any workers.dev host. Those sites have no sitemap. Their robots.txt allows
search engines to read the `noindex` headers and disallows the AI crawlers `GPTBot`, `OAI-SearchBot`, `Google-Extended`,
`ClaudeBot`, `Claude-SearchBot`, and `PerplexityBot`. These are crawler preferences, not access controls; user-requested
fetches and crawlers that ignore these rules can still read public pages. Production keeps its public pages and sitemap
available to search and AI crawlers. See the [OpenAI](https://developers.openai.com/api/docs/bots),
[Google](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers#google-extended),
[Anthropic](https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler),
and [Perplexity](https://docs.perplexity.ai/docs/resources/perplexity-crawlers) crawler documentation.
next gets its GitHub sign-in secrets once by hand, and previews
have no sign-in ([Sign in with GitHub](#sign-in-with-github)). The companion they show is built with `VITE_CONNECT_PACKAGE`, its pkg.pr.new address, so its own rejoin
hint runs that build again.

**Production deploys while the app's version has no `drizzle-run-app@<version>` tag and no changeset is pending**, and
the workflow tags it after a verified release. The app gets a new version from its own changesets, and from any
package it depends on (`.changeset/README.md`). A failed deploy, or a run GitHub drops from its queue, deploys again
on the next push without a changeset, at the latest when the next Version Packages pull request merges: never with
work still meant for next. The Version Packages pull request is opened with the
workflow's own token, so GitHub runs no workflow on it: next is deployed by the Release workflow from main instead.

### Setup, once

1. **Cloudflare accounts:** use the account containing the `drizzle.run` zone for next and production. Create a
   separate account for pull request previews. In both accounts, open Workers & Pages to configure a
   `<subdomain>.workers.dev` address, and enable R2.
2. **Cloudflare API tokens:** create a separate token for each deployment environment, scoped to its account.
   Grant D1 Edit and Workers R2 Storage Edit, since releases migrate databases and upload and prune objects directly.
   For Workers, use the permissions below.

   | Operation                                      | Workers permission                                    | Zone permission                               |
   | ---------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
   | Create a Worker, including each new PR preview | Admin at the Workers product scope                    | None for workers.dev                          |
   | Deploy or set secrets on an existing Worker    | Editor                                                | None if its routes and domains stay unchanged |
   | Add, change or remove a route or custom domain | Editor, plus Admin if the Worker must also be created | Workers Routes Write on the affected zone     |

   The next workflow attaches `next.drizzle.run`, so its token needs **Zone → Workers Routes → Write** on
   `drizzle.run`. Production needs that zone permission when its deployment changes a domain or route too.
   Existing Workers Scripts Edit tokens are legacy permissions. For new tokens, follow
   [Cloudflare's Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/),
   including the Admin requirement for first deployment. Preview tokens must retain permission to create Workers
   because every new pull request gets one.

3. **GitHub environments:** in the repository's **Settings → Environments**, create `preview`, `next`, `production`
   and `npm`. Under **Deployment branches and tags**, restrict `next`, `production` and `npm` to the branch `main`.
   Leave `preview` available to pull requests. Add the secrets and variables from the table below inside each
   environment. See [GitHub's environment setup](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
4. **Repository variable:** under **Settings → Secrets and variables → Actions → Variables**, add
   `PRODUCTION_URL` with your production HTTPS origin, such as `https://drizzle.run`. This is the URL the release
   verifies, not a command to create a domain binding.
5. **pkg.pr.new:** install its [GitHub App](https://github.com/apps/pkg-pr-new) on the repository. Both previews and
   next publish the companion through it.
6. **npm:** create the initial publication of any package that does not exist yet, then configure each released
   package: `@drizzle-run/core`, `@drizzle-run/runtime`,
   `@drizzle-run/orchestration`, `@drizzle-run/react`, and `@drizzle-run/connect`.
   In each package's Settings > Trusted Publisher, add GitHub Actions
   with this repository, workflow `release.yml`, environment `npm`, and permission for direct `npm publish`.
   Then require trusted publishing and disallow tokens. See [npm's trusted-publishing setup](https://docs.npmjs.com/trusted-publishers/).
   The workflow audits and packs the SDK with its runtime assets, then publishes the exact tarballs in dependency
   order. Existing versions are skipped, so rerunning a partially completed release publishes only missing versions.
   Authentication uses OIDC, so the `npm` environment needs no `NPM_TOKEN` or other secret.
7. **Pull requests from Actions:** in Settings > Actions > General, allow GitHub Actions to create and approve pull
   requests, or Changesets cannot open the Version Packages pull request.
8. **Deployment tags:** for a first production release, let the workflow create `drizzle-run-app@<version>` after
   deployment succeeds. Do not create a tag claiming an undeployed version is live. Only when adopting this workflow
   for an existing production deployment, tag the exact version and commit already running there:

   ```bash
   git tag "drizzle-run-app@<deployed-version>" "<deployed-commit>"
   git push origin "refs/tags/drizzle-run-app@<deployed-version>"
   ```

### Set GitHub secrets and variables

Use **Environment secrets → Add secret** for tokens and **Environment variables → Add variable** for identifiers.
Replace the placeholders in this table in GitHub's settings, not in a committed file.

| Location                     | Type     | Name                    | Value                               |
| ---------------------------- | -------- | ----------------------- | ----------------------------------- |
| `preview` environment        | Secret   | `CLOUDFLARE_API_TOKEN`  | `<preview-cloudflare-api-token>`    |
| `preview` environment        | Variable | `CLOUDFLARE_ACCOUNT_ID` | `<preview-account-id>`              |
| `preview` environment        | Variable | `WORKERS_SUBDOMAIN`     | `<preview-workers-subdomain>`       |
| `next` environment           | Secret   | `CLOUDFLARE_API_TOKEN`  | `<next-cloudflare-api-token>`       |
| `next` environment           | Variable | `CLOUDFLARE_ACCOUNT_ID` | `<production-account-id>`           |
| `next` environment           | Variable | `WORKERS_SUBDOMAIN`     | `<production-workers-subdomain>`    |
| `production` environment     | Secret   | `CLOUDFLARE_API_TOKEN`  | `<production-cloudflare-api-token>` |
| `production` environment     | Variable | `CLOUDFLARE_ACCOUNT_ID` | `<production-account-id>`           |
| Repository Actions variables | Variable | `PRODUCTION_URL`        | `https://<production-domain>`       |

`WORKERS_SUBDOMAIN` is just the account subdomain, without `https://` or `.workers.dev`. The production job does not
read it because it verifies `PRODUCTION_URL` directly.

Deployment tokens belong in GitHub environment secrets. The GitHub App's `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` belong on each Cloudflare Worker, as described below. The workflow does not copy sign-in
credentials from GitHub Actions. Never commit token values, client secrets, private keys, session cookies or
populated `.dev.vars` files.

### Deploy and verify next

Once the account, GitHub environment and pkg.pr.new setup are ready, merge the intended changes and their changesets
into `main`. The Release workflow opens or updates the Version Packages pull request and deploys next.

The prepare step creates missing `drizzle-run-next` D1 and both `drizzle-run-next-*` buckets, then writes
`apps/drizzle-run/wrangler.deploy.json`. The release uses that generated config to select next's resources. This
is not a Wrangler `--env next` deployment.

The workflow uploads runtime assets, migrates next's database, deploys `drizzle-run-next`, and verifies it on
workers.dev before checking `next.drizzle.run`. A new domain's certificate can take a few minutes. It also checks
that next stays out of search indexes.

After the first deploy, configure a separate GitHub App for next using
`https://next.drizzle.run/api/auth/github/callback`, then set its credentials on `drizzle-run-next` using
[the Worker secret commands](#configure-your-deployed-worker). Run the
[account, cloud sync and sharing checks](#verify-your-deployment) before promoting the release.

### Prepare and deploy production

Production uses `apps/drizzle-run/wrangler.jsonc` directly. Unlike next, its workflow does not create the D1 database
or R2 buckets. Before the first release:

1. Check that the D1 database `drizzle-run` and R2 buckets `drizzle-run-assets` and `drizzle-run-cloud-projects`
   exist in the intended account.
   Create missing resources using [First deployment](#first-deployment), with those production names. Verify that
   `PLAYGROUNDS.database_id` is the actual ID of that D1 database. Keep both buckets private.
2. Configure the production domain on the `drizzle-run` Worker. The checked-in config does not declare a production
   custom domain. Set up the Worker and domain before CI verifies `PRODUCTION_URL`, or declare the domain in the
   production config for the first deployment. Setting the GitHub variable alone does not attach it.
3. Complete the `production` and npm settings above. The production job waits for package packing and any required
   npm publication to succeed.
4. Register a separate production GitHub App. For `https://drizzle.run`, its callback is
   `https://drizzle.run/api/auth/github/callback`. Set its credentials on `drizzle-run` after the Worker exists.

Once next is verified, merge the Version Packages pull request. With no pending changesets and no deployment tag
for that app version, the workflow deploys production and tags the commit after verifying its runtime assets. It
then runs the deployed browser checks. A browser-check failure occurs after deployment and tagging, so inspect
that failure rather than assuming production stayed on the previous release.

Verify real sign-in, cloud sync and sharing on the production origin too. The deployed automated tests exercise
the runtime but do not authorize your real GitHub App.

## D1 schema and migrations

The Worker reads and writes D1 through Drizzle ORM (`drizzle-orm/d1`). The schema is `apps/drizzle-run/worker/schema.ts`.
Migrations are Drizzle Kit folders in `apps/drizzle-run/drizzle/`, one `<timestamp>_<name>/` with its `migration.sql`
and `snapshot.json`; Drizzle records applied ones in `__drizzle_migrations`. Wrangler's `d1 migrations` commands are
not used.

Every release follows **build → upload runtime assets → migrate D1 → deploy Worker → verify assets → prune**.
Production selects D1 through `wrangler.jsonc`. next and previews select their own D1 through the generated
`wrangler.deploy.json`. They apply the same committed SQL to separate databases, without copying data between them.
A fresh D1 receives the initial schema automatically and needs no seed data. Later deployments apply pending
migrations. If migration fails, the release stops before deploying the new Worker.

After a migration has been deployed, preserve it and add forward migrations. The previous Worker can still serve
requests while D1 is migrating, so schema changes must remain compatible with that version. See
[Release](#release) for the deployment order and rollback behavior.

The browser store has separate migrations in `apps/drizzle-run/src/store/migrations`. They ship with the app and
run automatically before local store operations in each browser. CI does not migrate users' browser storage.
Durable Object migrations are separate again: Wrangler applies the `migrations` entries in its configuration when
deploying the Worker.

- **Production:** every [release](#release) applies the pending migrations. To apply them alone, with Wrangler's
  credentials:

  ```bash
  pnpm --filter @drizzle-run/app run db:migrate --remote --account-id "<account-id>"
  ```

  Not `drizzle-kit migrate`: its `d1-http` driver reads the migrations table's rows as objects where the migrator
  expects arrays, so it fails on any database it already migrated once.

- **next and previews:** the release runs the same migrator with `--config` pointing at that deployment's generated
  config. No separate manual migration command is needed for a normal deployment.
- **Locally:** `pnpm db:migrate` runs drizzle-orm's D1 migrator on the local state. Every local server runs it first.
- **Sample data:** `pnpm db:seed` migrates the local D1, then writes two shares built from official examples, one
  owned by `@octocat` and one of them listed in Community. It prints their links.
- **Studio:** `pnpm studio` opens Drizzle Studio on the local D1 (run `pnpm dev` once first). With
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID` and `CLOUDFLARE_D1_TOKEN` (an API token with **D1 Edit**) set,
  it opens the production D1.

To change the schema:

1. Edit `worker/schema.ts`.
2. Run `pnpm db:generate` and read the new `migration.sql`. Kit drops `NOT NULL` from TEXT primary keys in SQLite;
   add it back by hand. A table SQLite has to rebuild comes with `PRAGMA foreign_keys=OFF`, which D1 ignores inside a
   migration's transaction: use `PRAGMA defer_foreign_keys = true` instead.
3. Run `pnpm db:check`, which fails on a schema change without a migration, then `pnpm db:migrate` (or restart
   `pnpm dev`).

## Sign in with GitHub

GitHub sign-in enables publishing, managing shared links, Community listing, and Cloud sync. Without its credentials,
local projects, runs, examples, and reading existing shares still work, but publishing and Cloud sync are unavailable.
`/api/auth/github/login` answers 503.

A fork or self-hosted instance needs **its own GitHub App and credentials**. The apps and domains used by
`drizzle.run` are not shared with forks. Create separate GitHub Apps for production, staging (if you use it), and
local development. You do not need to reproduce this repository's `next` environment to self-host.

### Register your GitHub App

Create a **GitHub App, not an OAuth App**. Follow [GitHub's registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
under your personal or organization settings: **Developer settings → GitHub Apps → New GitHub App**.

- Give it a unique name for your instance, such as `Your team Drizzle Run`.
- Set **Homepage URL** to your instance's origin, such as `https://run.example.com` (or `http://127.0.0.1:4173` locally).
- Add the complete **Callback URL** for every origin where you will sign in, using the examples below. Leave wildcard
  matching disabled.
- Leave **Expire user authorization tokens** enabled. Leave **Request user authorization (OAuth) during installation**
  and **Enable Device Flow** disabled; leave **Setup URL** empty and uncheck the webhook's **Active** option.
- Request no repository, organization, or account permissions. Sign-in only reads the user's public profile.
- For a public instance, select **Any account** under **Where can this GitHub App be installed?**.

Create the app, copy its **Client ID**, and generate a **client secret**. Use the Client ID, not the numeric App ID.
This sign-in flow does not need a GitHub App private key or a personal access token. Users
[authorize the app without installing it](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user).

### Register callback URLs

The Worker builds its callback from the origin used to start sign-in, followed by `/api/auth/github/callback`.
There is no callback environment variable to set. Register that full URL in the GitHub App's **Callback URL** field,
not in **Homepage URL** or **Setup URL**.

| Where you open the app                                             | Callback URL to register                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Self-hosted custom domain `https://run.example.com`                | `https://run.example.com/api/auth/github/callback`                       |
| Self-hosted Worker `https://my-drizzle-run.my-account.workers.dev` | `https://my-drizzle-run.my-account.workers.dev/api/auth/github/callback` |
| Local `http://127.0.0.1:4173`                                      | `http://127.0.0.1:4173/api/auth/github/callback`                         |
| Local `http://localhost:4173`                                      | `http://localhost:4173/api/auth/github/callback`                         |

Replace the example domain, Worker name and account subdomain with your own. The local URLs can be copied as written
when the server uses port 4173. For a linked worktree or a custom port, use the port printed by the server. For local
HTTPS, use the same HTTPS origin you open in the browser.

Register the exact URL for the origin you use, including its port. `localhost` and `127.0.0.1` need separate callbacks.
GitHub supports up to 10 callbacks per app; see its
[callback matching rules](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).

Use `localhost` or `127.0.0.1` for local HTTP development, and HTTPS for a deployed instance. If a proxy sits in
front of the Worker, ensure requests reach it with the public HTTPS origin, since that origin determines the callback.

### Configure local development

Copy `apps/drizzle-run/.dev.vars.example` to `apps/drizzle-run/.dev.vars`, uncomment these settings, and paste the
**development** GitHub App's values:

```dotenv
GITHUB_CLIENT_ID=your-development-app-client-id
GITHUB_CLIENT_SECRET=your-development-app-client-secret
```

The values above are placeholders. Keep `.dev.vars` out of Git and restart `pnpm dev` after changing it. Local
sign-in uses real GitHub. Leave `GITHUB_OAUTH_URL` and `GITHUB_API_URL` unset; only the e2e suite uses those mock endpoints.

### Configure your deployed Worker

After [First deployment](#first-deployment), store your GitHub App's credentials on the deployed Worker. From
`apps/drizzle-run`, with the same `CLOUDFLARE_ACCOUNT_ID` set, run:

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID --name my-drizzle-run
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --name my-drizzle-run
```

Replace `my-drizzle-run` with your configured Worker name. Each command prompts for the corresponding value, which
persists across deployments. For staging, repeat with its own Worker and GitHub App.

For the upstream next and production Workers, use the corresponding commands below. Authenticate to their
Cloudflare account and set `CLOUDFLARE_ACCOUNT_ID` to `<production-account-id>` first. Enter each GitHub App's
Client ID and client secret only at the prompts, never as committed command arguments.

```bash
# Credentials from the next GitHub App.
pnpm exec wrangler secret put GITHUB_CLIENT_ID --name drizzle-run-next
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --name drizzle-run-next

# Credentials from the production GitHub App.
pnpm exec wrangler secret put GITHUB_CLIENT_ID --name drizzle-run
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --name drizzle-run
```

If you move to a custom domain, point it at the Worker and register the new full callback URL before signing in
there. Keep the workers.dev callback only if you also use that host. Sessions do not move between hosts, so users
sign in again on the new domain.

### Verify sign-in

Open your instance at a registered origin, choose **Sign in with GitHub**, authorize your app, and check that you
return signed in. Repeat for any other origin you intend to support.

- **503 from `/api/auth/github/login`:** check that both credentials are set on the Worker you are visiting, or in
  `.dev.vars` locally; restart the local server after editing that file.
- **GitHub rejects the redirect:** compare the authorization request's `redirect_uri` with the registered callback.
  Check the scheme, hostname, port, and `/api/auth/github/callback` path; remove any trailing slash.
- **Sign-in does not complete after consent:** check that the Client ID and secret belong to the same GitHub App,
  and retry from the same browser and origin where you started.

The supplied pull-request preview workflow has no sign-in credentials. `pnpm test:e2e` uses
`scripts/github-oauth-mock.ts` and fixed test credentials, so it does not verify your GitHub App registration. Test
your own app manually on its registered domain before relying on sign-in.

### Session lifetime and cookies

The Worker stores only the SHA-256 of a random session token in D1. On HTTPS, the cookie is named
`__Host-drizzle-run-session` and has `Path=/`, `HttpOnly`, `Secure`, and `SameSite=Lax`. Loopback HTTP development
uses `drizzle-run-session` without `Secure`; non-loopback HTTP does not support sign-in.

A session lasts 30 days from issuance or its latest renewal. `/api/auth/session` renews an active session at most
once per day and aligns the browser cookie's expiry with D1. The app checks at most hourly during visible-page
activity, including returning to the page. An unattended tab and network reconnection alone do not keep a session
alive. With daily renewal, expiry falls between 29 and 30 days after the last successful check. Expired or revoked
sessions require sign-in again.

Signing out deletes that session and clears its cookie. Browser cleanup removes saved Cloud copies, while account
copies remain available on the next sign-in. Automatic expiry preserves unsynced edits as Local; pending edits in
another tab become new Local copies. See [Cloud sync behavior](../apps/drizzle-run/README.md#cloud-sync) for explicit
sign-out and deletion choices.

## Cloud sync

Point the `CLOUD_PROJECTS` binding at its own bucket, apart from the runtime assets. Without the binding, `/api/cloud`
answers 503 and the app hides cloud sync.

The per-account limits are in [apps/drizzle-run](../apps/drizzle-run/README.md#cloud-sync).

### Verify your deployment

Use a test account and disposable projects on your own instance:

1. Sign in through the real GitHub App and confirm that HTTPS sets the host-only session cookie described above.
2. Create one Local project and one Cloud project. Sign in from another browser and confirm that only the Cloud
   project arrives. Edit it there and return to the first browser to check sync.
3. Sign out in the first browser. Its Local project stays, its Cloud copy leaves, and signing back in restores the
   account copy.
4. Publish a test share, open its link while signed out, and confirm that the author can push changes after
   signing in. Stop sharing the test link when finished.

The local browser tests use mock GitHub credentials. They cover renewal, expiry, and concurrent-tab recovery, but
do not validate your real OAuth registration or Cloudflare bindings. `pnpm test:deployed` checks the deployed
runtime; it does not replace these account and sharing checks.

## Publishing budget

`PUBLISH_MAX_STORED_BYTES` in `vars` (default `"400000000"`, 400 MB) caps the bytes shared snapshots and recorded runs
keep in D1 in total. Past it, everyone gets 503 `publish_storage_full` until the cap is raised. `"0"` pauses publishing
everywhere.

The cap reserves space below the Free plan's [500 MB database limit](https://developers.cloudflare.com/d1/platform/limits/)
for accounts, Community listings, and Cloud sync records. Monitor the total database size too: the publishing
budget does not count every table or index. Nothing is deleted to make room: shared links keep working, and only new publishes and recorded runs wait. On
the Paid plan, raise it with the database's limit. Override it for one deploy with
`pnpm exec wrangler deploy --var PUBLISH_MAX_STORED_BYTES:800000000`. The per-request size caps and
`PUBLISH_RATE_LIMIT` keep one publisher from filling it quickly.

## Community moderation

**Report** only counts reports; nothing is hidden automatically. To list reported shares and remove one:

```bash
pnpm exec wrangler d1 execute PLAYGROUNDS --remote --command "SELECT link_id, title, report_count, last_reported_at FROM community_listings WHERE report_count > 0 AND state <> 'removed' ORDER BY report_count DESC"
```

```bash
pnpm exec wrangler d1 execute PLAYGROUNDS --remote --command "UPDATE community_listings SET state = 'removed' WHERE link_id = '<link id>'"
```

A removed share leaves Community and its owner cannot list it again; the link itself keeps working.

## API and response policies

- `POST /api/playgrounds` needs a signed-in session (401 `sign_in_required` otherwise) and validates the whole
  snapshot, the origin, the 1 MiB JSON limit and an idempotency key. Identical retries return the same snapshot;
  changed content under the same key returns 409. Thirty publishes per minute per account; past it, 429
  `rate_limited` with `Retry-After`. Pushing changes, recording a run, listing and stopping a share need the owner's
  session (403 `not_link_owner` for another account).
- `GET /api/auth/github/login` starts at most 60 sign-ins per minute per address, so a classroom behind one address
  can sign in at once. The callback is not rate limited: its state, PKCE verifier and single-use cookie refuse a
  sign-in the login step did not start.
- `GET /api/playgrounds/:id` returns the link's current snapshot and its digest, revalidating on every load.
  Snapshots never expire. `PUT /api/playgrounds/:id` replaces the stored snapshot with the owner's changes.
- `PUT /api/playgrounds/:id/recording` stores the author's recorded run of the link's current snapshot, with the
  owner's session. At most 256 KiB, and its digest must match the snapshot. The link keeps its first recording
  until a push changes the snapshot digest. `GET` on the same path returns it with revalidation, or 404 if none
  matches the current snapshot.
- `/runtime-assets/:digest/:name` serves only the deployed inventory. It checks R2's MD5 and the size before
  streaming, with immutable caching, a content digest and an ETag, and no ranges. Gzip payloads are sent as stored;
  the runtime verifies and decompresses them.

App pages send COOP `same-origin` and COEP `require-corp`, which the runtime's `SharedArrayBuffer` needs. Embed pages,
shared links' and official examples' alike, send COEP plus `Document-Isolation-Policy` where supported.

Vite's build files under `/assets/` skip the Worker (`run_worker_first` in `wrangler.jsonc`). Their COEP comes from
[`public/_headers`](../apps/drizzle-run/public/_headers), the only headers Cloudflare applies to files it serves
without the Worker, along with `frame-ancestors 'self'` for the app shell a missing file falls back to.

## AI chat relay

`GET /api/connect/rooms/:roomId?role=tab|companion` upgrades to a WebSocket in a `ConnectRoom` Durable Object, one
room per pairing. The tab and `npx @drizzle-run/connect` derive the room id and an AES-GCM key separately from the
pairing code, so the relay sees only the room id, roles, sizes and timing, and counts messages per client, never the
code or the messages.

- A tab must send its own origin; a companion sends none, and offers the subprotocol `drizzle-run-companion` then its
  proof, a value derived from the pairing code whose SHA-256 is the room id. The room refuses a companion without it
  (403), so knowing a room id is not enough to replace the user's companion. Connections are rate limited to 60 a minute per room and
  address (an IPv6 address by its /64), so a classroom behind one address does not share one budget, and to 300 a
  minute per address across rooms, since the client picks the room id and fresh ids must not bypass the room limit
  (`CONNECT_ADDRESS_RATE_LIMIT`, checked first). A limited
  connection opens and closes at once with code 4005: the tab shows "Too many connections" and the companion says so,
  and both retry with a backoff that only a welcomed connection resets.
- A room takes 8 tabs and one companion (a newer one replaces the older). Frames are capped at 512 KiB, with a burst
  of 60 messages, then 20 per second. Refused frames, including those sent with no peer in the room, count as strikes,
  forgiven at one per second; past 50 the socket is closed. The companion paces what it sends under that rate and
  merges streamed text that waits, and batches agent text every 250 ms.
- Each room forwards at most 20,000 messages a day, each client 100,000 across its rooms, and all rooms together
  `CONNECT_DAILY_MESSAGES` (400,000 in `wrangler.jsonc` `vars`, the same as the code fallback). Past a limit, the relay
  answers `busy` with the next UTC midnight and keeps the sockets open.
- A client is a signed-in user, read from the session cookie of the tab's upgrade, or else an address (an IPv6 address
  counts by its /64). The companion has no session: while a signed-in tab is in the room, every message there counts
  for that user, the companion's included.
- Rooms reserve the shared quota in blocks the size of their own count so far, from 10 to 500 messages, and never give
  back what they do not use. A room that forwards a few frames holds 10 messages, and a busier one at most about as
  many as it has forwarded. The quota object keeps each client's count for the current UTC day only.
- The relay sends a tab its client's share, `{ t: "quota", per, used, limit, resetAt }`, after `welcome` and after each
  reservation, and never another client's. The chat shows it under the composer as a percent of today's AI chat.
- A room idle for 24 hours closes and clears its storage.

## After a first release

Check by hand what local servers cannot prove: publishing and reading a share at once, a run with no request to npm
or a CDN, an embed on an ordinary page, conditional R2 responses, and the edge rate limit.
