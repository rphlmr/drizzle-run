import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import { isFileServingAllowed, type Plugin } from "vite";

async function sendGzipAsset({
  filePath,
  request,
  response,
  next,
}: {
  filePath: string;
  request: IncomingMessage;
  response: ServerResponse;
  next: (cause?: unknown) => void;
}): Promise<void> {
  try {
    const bytes = await readFile(filePath);
    response.setHeader("Content-Type", "application/gzip");
    response.setHeader("Content-Length", bytes.byteLength);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (cause) {
    next(cause);
  }
}

/** Serve gzip files before the Cloudflare dev bridge can decode their bodies. */
export function serveDevGzipAssets(): Plugin {
  return {
    name: "drizzle-run-serve-dev-gzip-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?")[0];

        if (!pathname?.startsWith("/@fs/") || !pathname.endsWith(".gz")) {
          next();
          return;
        }

        try {
          const filePath = resolve("/", decodeURI(pathname).slice("/@fs/".length));

          if (!isFileServingAllowed(filePath, server)) {
            response.statusCode = 403;
            response.end();
            return;
          }

          if (request.method !== "GET" && request.method !== "HEAD") {
            response.statusCode = 405;
            response.setHeader("Allow", "GET, HEAD");
            response.end();
            return;
          }

          void sendGzipAsset({ filePath, request, response, next });
        } catch (cause) {
          next(cause);
        }
      });
    },
  };
}
