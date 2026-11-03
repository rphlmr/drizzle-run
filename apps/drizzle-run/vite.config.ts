import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { resolveDrizzleRunPorts } from "../../scripts/drizzle-run-ports.ts";
import { serveDevGzipAssets } from "./scripts/dev-gzip-assets.ts";

// The loader is the one embed module a page loads.
const embedModulePath = /^\/embed\/(index\.js)$/;

/**
 * Serve the embed build in dev
 *
 * Production serves `/embed/index.js` from the copy `scripts/finalize-build.ts` puts in the static files. The dev
 * server has no such copy, so this reads `apps/drizzle-run/.cache/embed` directly, with the cross-origin headers the Worker
 * gives these modules. Run the embed build first (`pnpm dev` does).
 */
function serveEmbedBuild(): Plugin {
  const embedDist = new URL("./.cache/embed/", import.meta.url);

  /**
   * Sends the module with the Worker's cross-origin headers. Never rejects: a missing file answers 404 and any other
   * read failure 500, with the cause in the dev server's log.
   */
  async function sendEmbedModule(fileName: string, response: ServerResponse): Promise<void> {
    let source: Buffer;

    try {
      source = await readFile(new URL(fileName, embedDist));
    } catch (cause) {
      const missing = cause instanceof Error && "code" in cause && cause.code === "ENOENT";

      if (!missing) {
        console.error(`Cannot read the embed build file: ${fileName}`, cause);
      }

      response.statusCode = missing ? 404 : 500;
      response.end();
      return;
    }

    response.setHeader("Content-Type", "application/javascript");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.end(source);
  }

  return {
    name: "drizzle-run-serve-embed-build",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const fileName = embedModulePath.exec(request.url?.split("?")[0] ?? "")?.[1];

        if (fileName === undefined) {
          next();
          return;
        }

        void sendEmbedModule(fileName, response);
      });
    },
  };
}

/**
 * Serve every dev response uncached
 *
 * A dev server's modules change under the browser, so a cached copy only ever shows stale code. WebKit also refuses a
 * module under COEP when a dev worker, and above all a nested one (the runtime's database worker), reuses the copy
 * the page or another worker cached. Without a cached copy, each request fetches the current module with the dev
 * headers. Builds keep their caching, so this is dev only.
 */
function serveUncached(): Plugin {
  return {
    name: "drizzle-run-uncached-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        delete request.headers["if-none-match"];
        delete request.headers["if-modified-since"];
        const setHeader = response.setHeader.bind(response);
        response.setHeader = (name, value) =>
          setHeader(name, name.toLowerCase() === "cache-control" ? "no-store" : value);
        response.setHeader("Cache-Control", "no-store");
        next();
      });
    },
  };
}

const jsonImportAttributes = /,\s*\{\s*with:\s*\{\s*type:\s*["']json["']\s*\}\s*\}/g;

/**
 * Drop JSON import attributes in dev
 *
 * The dev server serves a JSON import as a JavaScript module (`?import`) but keeps `{ with: { type: "json" } }` on
 * dynamic imports, so the browser rejects it: the runtime's declaration loaders failed and aborted project
 * preparation. Without the attribute Vite resolves them as plain JSON imports. Builds handle them already.
 */
function dropJsonImportAttributes(): Plugin {
  return {
    name: "drizzle-run-drop-json-import-attributes",
    apply: "serve",
    transform(code) {
      const withoutAttributes = code.replace(jsonImportAttributes, "");

      return withoutAttributes === code ? null : { code: withoutAttributes, map: null };
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    ...(command === "serve" && mode === "local-https"
      ? {
          https: {
            key: readFileSync(new URL("../../.cache/local-https/dev-key.pem", import.meta.url)),
            cert: readFileSync(new URL("../../.cache/local-https/dev.pem", import.meta.url)),
          },
        }
      : {}),
  },
  cacheDir: process.env.DRIZZLE_RUN_VITE_CACHE_DIR ?? "../../.cache/vite/drizzle-run",
  plugins: [
    tailwindcss(),
    react(),
    // Before the Cloudflare plugin, whose middleware would hand `/embed/*` to the Worker and its SPA fallback.
    serveEmbedBuild(),
    serveDevGzipAssets(),
    serveUncached(),
    dropJsonImportAttributes(),
    // The Worker, D1, R2 and the relay rooms run in workerd beside the dev server, with the local state
    // `wrangler dev` and the R2 upload use, and this checkout's inspector port. A preview deploy builds from the
    // config scripts/manage-deploy-environment.ts writes (DRIZZLE_RUN_WRANGLER_CONFIG), so `wrangler deploy` ships that.
    cloudflare({
      configPath: process.env.DRIZZLE_RUN_WRANGLER_CONFIG,
      // serve-drizzle-run.ts passes DRIZZLE_RUN_STATE_DIR as an absolute path.
      persistState: { path: process.env.DRIZZLE_RUN_STATE_DIR ?? "../../.cache/cloudflare" },
      inspectorPort: resolveDrizzleRunPorts().inspector,
    }),
  ],
  optimizeDeps: {
    entries: ["index.html", "src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
    // The local project store loads its WASM next to the package module.
    exclude: ["@sqlite.org/sqlite-wasm"],
    include: [
      "@base-ui/react/button",
      "@base-ui/react/dialog",
      "@base-ui/react/drawer",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/merge-props",
      "@base-ui/react/switch",
      "@base-ui/react/tabs",
      "@base-ui/react/use-render",
      "@xstate/react",
      "react",
      "react-dom/client",
      "react/jsx-dev-runtime",
      "xstate",
    ],
  },
  build: { emptyOutDir: true, target: "es2025" },
}));
