import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createActor } from "xstate";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports.ts";
import { appServerMachine } from "./app-server-machine.ts";
import { handleGitHubMock } from "./github-oauth-mock.ts";

// Serves Drizzle Run locally with a blog fixture that embeds it. --vite runs the Vite dev server with hot reload;
// --e2e uses wrangler.jsonc's e2e environment.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const rootDir = resolve(appDir, "../..");
const embedDist = resolve(appDir, ".cache/embed");
const blogFixtureDir = resolve(appDir, "e2e/blog");
const wranglerConfig = resolve(appDir, "wrangler.jsonc");
const e2e = process.argv.includes("--e2e");
// DRIZZLE_RUN_STATE_DIR (relative to the repository) gives a second server in the same checkout its own storage.
const e2eState = e2e && process.env.DRIZZLE_RUN_STATE_DIR === undefined;
const localState = resolve(
  rootDir,
  process.env.DRIZZLE_RUN_STATE_DIR ?? (e2eState ? ".cache/cloudflare-e2e" : ".cache/cloudflare"),
);

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const wrangler = resolve(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);
const appRequire = createRequire(resolve(appDir, "package.json"));
const vitePackage = appRequire.resolve("vite/package.json");
const viteCli = resolve(dirname(vitePackage), appRequire(vitePackage).bin.vite);

const childEnvironment = { ...process.env, CLOUDFLARE_SEND_METRICS: "false", DRIZZLE_RUN_STATE_DIR: localState };
const viteDevServer = process.argv.includes("--vite");
const ports = resolveDrizzleRunPorts();
// An empty env file keeps a local .dev.vars out of the e2e Worker, so it signs in against the mock GitHub only.
const mockGitHubOrigin = `${toLocalOrigin(ports.fixture)}/github`;
const environmentArgs = e2e
  ? [
      "--env",
      "e2e",
      "--env-file",
      resolve(appDir, "e2e/wrangler-e2e.env"),
      "--var",
      `GITHUB_OAUTH_URL:${mockGitHubOrigin}`,
      "--var",
      `GITHUB_API_URL:${mockGitHubOrigin}/api`,
    ]
  : [];

const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function runProcess(command: string, args: string[]) {
  return new Promise<void>((resolveProcess, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: childEnvironment, cwd: appDir });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }

      reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

/**
 * Maps a request path to a file of the blog fixture: `/embed/*` comes from the embed build, everything else
 * from `e2e/blog`. Returns undefined for a path that escapes its folder.
 */
function resolveBlogFixtureFile(pathname: string) {
  const isEmbed = pathname.startsWith("/embed/");
  const base = isEmbed ? embedDist : blogFixtureDir;
  const relative = isEmbed ? pathname.slice("/embed/".length) : pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(base, relative);

  if (!file.startsWith(`${base}/`)) {
    return undefined;
  }

  return file;
}

function contentTypeOf(file: string) {
  const extension = Object.keys(contentTypes).find((candidate) => file.endsWith(candidate));

  return extension === undefined ? "application/octet-stream" : contentTypes[extension];
}

function toPortInUseError(port: number, server: string, cause: Error) {
  return new Error(
    `Port ${port} (${server}) is already in use on 127.0.0.1. Stop what listens there, or set DRIZZLE_RUN_PORT and ` +
      "DRIZZLE_RUN_FIXTURE_PORT to free ports (see scripts/drizzle-run-ports.ts).",
    { cause },
  );
}

/**
 * Throws a clear error when another process already listens on the port, before any slow setup runs.
 * Only binds and releases the port; it never touches the other process.
 */
async function assertPortFree(port: number, server: string) {
  const probe = createServer();

  await new Promise<void>((listening, reject) => {
    probe.once("error", (cause: NodeJS.ErrnoException) =>
      reject(cause.code === "EADDRINUSE" ? toPortInUseError(port, server, cause) : cause),
    );
    probe.listen(port, "127.0.0.1", listening);
  });
  await new Promise((closed) => probe.close(closed));
}

// Fail fast on a taken port.
await assertPortFree(ports.app, "Drizzle Run app");
await assertPortFree(ports.fixture, "blog fixture");

// Prepare local storage
if (e2eState) {
  await rm(localState, { recursive: true, force: true });
}

await mkdir(localState, { recursive: true });
await runProcess(process.execPath, [resolve(appDir, "scripts/migrate-d1.ts"), ...(e2e ? ["--e2e"] : [])]);

if (viteDevServer) {
  await runProcess("pnpm", ["run", "build:embed"]);
  await runProcess(process.execPath, [resolve(appDir, "scripts/build-guides.ts")]);
}

await runProcess(process.execPath, [
  "--experimental-strip-types",
  resolve(appDir, "scripts/upload-runtime-assets.ts"),
  "--local",
]);

async function serveBlogFixtureFile(request: IncomingMessage, response: ServerResponse) {
  try {
    if (e2e && (await handleGitHubMock(request, response))) {
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const file = resolveBlogFixtureFile(url.pathname);

    if (file === undefined || !(await stat(file)).isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.setHeader("Content-Type", contentTypeOf(file));

    if (url.searchParams.get("isolated") === "1") {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }

    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}

const blogFixture = createServer((request, response) => {
  // Every failure answers 404 inside, so this promise never rejects.
  void serveBlogFixtureFile(request, response);
});

await new Promise<void>((resolveListening, reject) => {
  blogFixture.once("error", (cause: NodeJS.ErrnoException) => {
    reject(cause.code === "EADDRINUSE" ? toPortInUseError(ports.fixture, "blog fixture", cause) : cause);
  });
  blogFixture.listen(ports.fixture, "127.0.0.1", resolveListening);
});
console.log(`Blog fixture: ${toLocalOrigin(ports.fixture)}`);

// Its own process group, so stopping reaches workerd too. The source config, not the build's, so --env e2e applies.
const wranglerDevArgs = [
  wrangler,
  "dev",
  "--config",
  wranglerConfig,
  ...environmentArgs,
  "--ip",
  "127.0.0.1",
  "--port",
  String(ports.app),
  ...(ports.inspector === undefined ? [] : ["--inspector-port", String(ports.inspector)]),
  "--local",
  "--persist-to",
  localState,
  "--show-interactive-dev-session=false",
];
const viteDevArgs = [viteCli, "--host", "127.0.0.1", "--port", String(ports.app), "--strictPort"];
const appServer = spawn(process.execPath, viteDevServer ? viteDevArgs : wranglerDevArgs, {
  stdio: "inherit",
  env: childEnvironment,
  cwd: appDir,
  detached: true,
});

function signalAppServer(signal: NodeJS.Signals) {
  if (appServer.pid === undefined) {
    return;
  }

  try {
    process.kill(-appServer.pid, signal);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
      throw cause;
    }
  }
}

const appServerLifetime = createActor(
  appServerMachine.provide({
    actions: {
      stopServer: () => {
        signalAppServer("SIGTERM");
        blogFixture.closeAllConnections();
        blogFixture.close();

        // Wrangler and the Vite plugin each own workerd children. Bound the complete group.
        setTimeout(() => signalAppServer("SIGKILL"), 1_500);
      },
    },
  }),
);

appServerLifetime.subscribe((snapshot) => {
  if (snapshot.status === "done") {
    process.exitCode = snapshot.context.exitCode ?? undefined;
  }
});
appServerLifetime.start();

process.once("SIGINT", () => appServerLifetime.send({ type: "stop.request" }));
process.once("SIGTERM", () => appServerLifetime.send({ type: "stop.request" }));

appServer.once("exit", (code) => appServerLifetime.send({ type: "server.exited", code }));
appServer.once("error", (cause) => {
  console.error(cause.message);
  appServerLifetime.send({ type: "server.failed" });
});
