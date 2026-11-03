import { appOrigin, expect, test } from "./fixtures";
import { groupDisplaysByLabel, runStoredProject } from "./run-project";

const PROBE_QUERY = `
const attempts = {};

async function attempt(label, action) {
  try {
    await action();
    attempts[label] = "reached";
  } catch (error) {
    attempts[label] = "blocked: " + String(error?.message ?? error);
  }
}

// A computed name: the bundler refuses a literal "node:net" import before the guest ever runs.
const netModule = ["node", "net"].join(":");

function connect(port, host) {
  return import(netModule).then((net) => new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      socket.end();
      resolve();
    });

    socket.on("error", reject);
    setTimeout(() => reject(new Error("no connection after 5 s")), 5_000);
  }));
}

await attempt("fetch the page's origin", () => fetch("${appOrigin}/guest-probe"));
await attempt("fetch another site", () => fetch("https://guest-probe.example/beacon"));
await attempt("socket to the page's server", () => connect(${new URL(appOrigin).port}, "127.0.0.1"));
await attempt("socket to another site", () => connect(443, "guest-probe.example"));
await attempt("WebSocket to the page's server", () => new Promise((resolve, reject) => {
  const socket = new WebSocket("${appOrigin.replace("http:", "ws:")}/guest-probe");

  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error("WebSocket error"));
  setTimeout(() => reject(new Error("no connection after 5 s")), 5_000);
}));
$.display("Network attempts", attempts);
`;

test("should keep a project's guest off the network: fetch and sockets fail and no request leaves the page", async ({
  page,
  context,
}, testInfo) => {
  const probes: string[] = [];

  await context.route(/guest-probe/, (route) => {
    probes.push(route.request().url());
    void route.fulfill({ status: 200, body: "reached" });
  });
  await page.goto("/projects");

  const result = await runStoredProject(page, "Guest network probe", {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "query.ts": PROBE_QUERY,
    },
  });
  const [attempts] = groupDisplaysByLabel(result)["Network attempts"] ?? [];

  await testInfo.attach("guest network attempts", {
    body: JSON.stringify(attempts, null, 2),
    contentType: "application/json",
  });
  console.log(`[${testInfo.project.name}] guest network attempts: ${JSON.stringify(attempts)}`);

  expect(attempts, JSON.stringify(result.error ?? null)).toBeDefined();
  expect(JSON.stringify(attempts)).not.toContain("reached");
  expect(probes).toEqual([]);
});
