import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { createServer, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serveDevGzipAssets } from "./dev-gzip-assets";

describe("serveDevGzipAssets", () => {
  let directory: string;
  let server: ViteDevServer;
  let archiveUrl: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "drizzle-dev-gzip-"));
    const archivePath = join(directory, "vector.tar.gz");
    await writeFile(archivePath, gzipSync("extension archive"));
    server = await createServer({
      configFile: false,
      root: directory,
      server: { host: "127.0.0.1", port: 0, fs: { allow: [directory] } },
      plugins: [
        serveDevGzipAssets(),
        {
          name: "decoded-asset-bridge",
          configureServer(vite) {
            vite.middlewares.use((_request, response) => {
              response.end("extension archive");
            });
          },
        },
      ],
    });
    await server.listen();
    const address = server.httpServer?.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected the test server to listen on a TCP port.");
    }

    archiveUrl = `http://127.0.0.1:${address.port}/@fs${archivePath}`;
  });

  afterEach(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("should serve original gzip bytes without HTTP content encoding", async () => {
    const response = await fetch(`${archiveUrl}?v=123`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(directory, "vector.tar.gz")));
  });

  it("should answer HEAD with the gzip size and no body", async () => {
    const response = await fetch(archiveUrl, { method: "HEAD" });

    expect(response.headers.get("content-length")).toBe(
      String((await readFile(join(directory, "vector.tar.gz"))).length),
    );
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("should preserve Vite file access restrictions", async () => {
    const response = await fetch(archiveUrl.replace("vector.tar.gz", "../outside.tar.gz"));

    expect(response.status).toBe(403);
  });

  it("should leave other assets to the existing middleware", async () => {
    const response = await fetch(archiveUrl.replace("vector.tar.gz", "module.js"));

    expect(await response.text()).toBe("extension archive");
  });
});
