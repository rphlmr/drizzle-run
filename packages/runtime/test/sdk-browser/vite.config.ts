import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    headers: {
      "Content-Encoding": "identity",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: { format: "es" as const },
};
