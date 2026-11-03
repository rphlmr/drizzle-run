# Contributing

Bug reports and ideas go through the [issue forms](https://github.com/rphlmr/drizzle-run/issues/new/choose).

**Pull requests are open to collaborators only.** To propose a change, open an issue describing it. If it fits, you
may be invited as a collaborator to make it.

## Contributor License Agreement

Every contribution needs the [Contributor License Agreement](CLA.md), accepted by ticking its box in the pull request.
It lets the maintainer license the project, your contribution included, under the AGPL and under other terms, such as
a commercial license. You keep the copyright of your work.

## Making a change

1. Set up the repository as the [README](README.md#run-it-locally) describes.
2. Make the change, with tests for the behavior it adds or fixes.
3. Run the checks for the parts you touched: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test`.
   For browser behavior, run `pnpm test:e2e` during development and `pnpm test:e2e:all` before submitting. Install the
   browsers first with `pnpm exec playwright install chromium firefox webkit`.
4. A change to a package others install (`core`, `runtime`, `orchestration`, `react`, `connect`) comes with a changeset: run
   `pnpm changeset` ([details](.changeset/README.md)). The release workflow publishes all five packages to npm.

Changes to the runtime or guest releases also need `pnpm build` followed by `pnpm test:runtime`. Schema changes need
`pnpm db:check`. Follow the [guide and recording instructions](apps/drizzle-run/README.md#official-examples-and-guides)
when changing an example or guide. Documentation-only changes need working links, valid commands, and
`pnpm format:check`; they do not need a fresh browser run.

Use your own GitHub App for local sign-in, as the [setup guide](docs/cloudflare.md#sign-in-with-github) describes.
Keep credentials in the ignored `apps/drizzle-run/.dev.vars` file, never in a commit, issue, or test recording.
Use placeholders in documentation examples. Self-hosting does not require access to the maintainer's accounts.

## License

Drizzle Run is licensed under the [GNU Affero General Public License v3.0](LICENSE). The maintainer may also offer
it under other terms, as the [Contributor License Agreement](CLA.md) allows.
