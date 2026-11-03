import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ports of a local Drizzle Run: the app (Vite dev or `wrangler dev`, with its Worker and relay rooms) and the
 * blog fixture, the stand-in third-party page that embeds it. This module is the one place that decides them,
 * so several git worktrees can run `pnpm dev` or `pnpm test:e2e` at the same time.
 *
 * The rule, first match wins, for each port on its own:
 * 1. `DRIZZLE_RUN_PORT` (app) and `DRIZZLE_RUN_FIXTURE_PORT` (blog fixture) set explicitly.
 * 2. The main checkout (its git common dir is `<toplevel>/.git`) keeps 4173 and 4311.
 * 3. A linked worktree hashes its git top-level path into a slot from 20000 to 29990, in steps of 10: the app
 *    takes the slot's port and the blog fixture the next one. The pair stays the same for the life of the folder.
 * 4. Outside a git checkout, the main checkout's pair.
 *
 * The Worker's DevTools inspector follows the app: on the main checkout's 4173 it keeps Wrangler's default (the
 * first free port from 9229, where debuggers look); on any other app port it takes the app port + 2, since two
 * servers starting together could both pick the same free port.
 *
 * Two worktrees can land on the same slot (1 in 1000 per pair). Each server then stops with a "port in use"
 * error; set `DRIZZLE_RUN_PORT` and `DRIZZLE_RUN_FIXTURE_PORT` for one of them.
 */
export type DrizzleRunPorts = {
  app: number;
  fixture: number;
  /** Undefined leaves the inspector port to Wrangler and the Cloudflare Vite plugin. */
  inspector: number | undefined;
};

const MAIN_CHECKOUT_PORTS = { app: 4173, fixture: 4311 };
const WORKTREE_PORT_FIRST = 20_000;
const WORKTREE_SLOT_COUNT = 1_000;
const WORKTREE_SLOT_SIZE = 10;

const repositoryDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Resolve the local Drizzle Run ports by the rule above.
 *
 * Throws when `DRIZZLE_RUN_PORT` or `DRIZZLE_RUN_FIXTURE_PORT` is not a port number, or when the blog fixture
 * would share a port with the app or its inspector.
 */
export function resolveDrizzleRunPorts(environment: NodeJS.ProcessEnv = process.env): DrizzleRunPorts {
  const checkoutPorts = getCheckoutPorts();
  const app = readPortVariable(environment, "DRIZZLE_RUN_PORT") ?? checkoutPorts.app;
  const fixture = readPortVariable(environment, "DRIZZLE_RUN_FIXTURE_PORT") ?? checkoutPorts.fixture;
  const inspector = app === MAIN_CHECKOUT_PORTS.app ? undefined : app + 2;

  if (fixture === app || fixture === inspector) {
    throw new Error(
      `Expected the blog fixture port to differ from the app (${app}) and its inspector (${inspector}), but got ${fixture}`,
    );
  }

  return { app, fixture, inspector };
}

/**
 * The `http://127.0.0.1:<port>` origin every local server listens on.
 */
export function toLocalOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function readPortVariable(environment: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = environment[name];

  if (value === undefined || value === "") {
    return undefined;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Expected ${name} to be a port from 1 to 65535, but got '${value}'`);
  }

  return port;
}

function getCheckoutPorts(): { app: number; fixture: number } {
  const checkout = readGitCheckout();

  if (checkout === null || resolve(checkout.commonDir) === resolve(checkout.toplevel, ".git")) {
    return MAIN_CHECKOUT_PORTS;
  }

  const slot = createHash("sha256").update(checkout.toplevel).digest().readUInt32BE(0) % WORKTREE_SLOT_COUNT;
  const app = WORKTREE_PORT_FIRST + slot * WORKTREE_SLOT_SIZE;

  return { app, fixture: app + 1 };
}

function readGitCheckout(): { toplevel: string; commonDir: string } | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      cwd: repositoryDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [toplevel, commonDir] = output.trim().split("\n");

    return toplevel && commonDir ? { toplevel, commonDir } : null;
  } catch {
    return null;
  }
}
