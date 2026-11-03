import { parentPort } from "node:worker_threads";

import { serveDatabase } from "./database-service.ts";

if (parentPort === null) {
  throw new Error("Database worker requires its parent port");
}

const port = parentPort;
serveDatabase({
  addEventListener: (_type, listener) => port.on("message", (data) => listener(new MessageEvent("message", { data }))),
  postMessage: (message) => port.postMessage(message),
  close: () => port.close(),
});
