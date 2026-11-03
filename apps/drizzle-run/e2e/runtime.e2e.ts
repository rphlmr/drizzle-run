import { turnOnDebug } from "./debug";
import { appOrigin, expect, test } from "./fixtures";
import { postSnapshot } from "./publish";

interface RuntimeMetricsWindow extends Window {
  __drizzleRunMetrics?: { created: number; terminated: number; active: number };
}

for (const dialect of ["postgresql", "sqlite"] as const) {
  for (const [ormVersion, kitVersion] of [
    ["0.45.4", "0.31.11"],
    ["1.0.0-rc.5", "1.0.0-rc.5"],
  ]) {
    test(`should run ${dialect} ${ormVersion}/${kitVersion} with transactions, fresh realms and local assets`, async ({
      page,
      request,
    }, testInfo) => {
      const external: string[] = [];
      const heavy: string[] = [];
      const runtimeRequests: { url: string; resourceType: string }[] = [];
      const pageErrors: string[] = [];
      const persistenceWorkerRequests: string[] = [];
      await page.addInitScript(() => {
        const metrics = { created: 0, terminated: 0, active: 0 };
        (window as RuntimeMetricsWindow).__drizzleRunMetrics = metrics;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          private executionHost: boolean;

          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.executionHost = new URL(url, location.href).pathname.endsWith("/quickjs/execution-worker.js");

            if (this.executionHost) {
              metrics.created += 1;
              metrics.active += 1;
            }
          }

          override terminate() {
            super.terminate();

            if (this.executionHost) {
              metrics.terminated += 1;
              metrics.active -= 1;
              this.executionHost = false;
            }
          }
        };
      });
      page.on("request", (pageRequest) => {
        const url = new URL(pageRequest.url());

        if (url.protocol.startsWith("http") && url.origin !== appOrigin) {
          external.push(pageRequest.url());
        }

        if (url.pathname.startsWith("/runtime-assets/") || /\/(?:execution|database)\.worker-/.test(url.pathname)) {
          heavy.push(pageRequest.url());
        }

        if (url.pathname.startsWith("/runtime-assets/")) {
          runtimeRequests.push({ url: pageRequest.url(), resourceType: pageRequest.resourceType() });
        }

        if (url.pathname.includes("sqlite3-opfs-async-proxy")) {
          persistenceWorkerRequests.push(pageRequest.url());
        }
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const core = dialect === "postgresql" ? "pg" : "sqlite";
      const response = await postSnapshot(request, {
        data: {
          snapshotVersion: 1,
          name: "Browser runtime acceptance",
          manifest: {
            kind: "drizzle-run",
            manifestVersion: 1,
            target: { dialect },
            dependencies: { "drizzle-orm": ormVersion, "drizzle-kit": kitVersion },
            entrypoints: { schema: "schema.ts", run: "query.ts" },
            files: {
              "schema.ts": `import { ${core}Table, integer, text } from "drizzle-orm/${core}-core";
                globalThis.schemaEvaluations = (globalThis.schemaEvaluations ?? 0) + 1;
                export const users = ${core}Table("users", { id: integer("id").primaryKey(), name: text("name").notNull() });`,
              "query.ts": `import { db } from "@drizzle-run/runtime/context";
                import { users } from "./schema";
                if (globalThis.schemaEvaluations !== 1 || globalThis.guestPreviouslyUsed) { throw new Error("Guest realm was reused or schema evaluated twice"); }
                globalThis.guestPreviouslyUsed = true;
                await db.transaction(async (tx) => {
                  await tx.insert(users).values({ id: 1, name: "Ada" });
                  try { await tx.transaction(async (nested) => {
                    await nested.insert(users).values({ id: 2, name: "Rolled back" });
                    throw new Error("rollback savepoint");
                  }); } catch (error) { if (error.message !== "rollback savepoint") { throw error; } }
                });
                const rows = await db.select().from(users);
                if (rows.length !== 1 || rows[0].name !== "Ada") { throw new Error("Transaction/savepoint result differs"); }
                $.display("Browser transaction result", rows);`,
            },
          },
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const published: { id: string } = await response.json();
      const preparationStarted = Date.now();
      await page.goto(`/s/${published.id}`);

      const run = page.getByRole("button", { name: "Run", exact: true });
      const incompatible = page.getByText(/can't run in this browser/);
      const ready = async () => (await run.count()) > 0 && (await run.isEnabled());
      await expect
        .poll(async () => (await ready()) || (await incompatible.isVisible()), { timeout: 120_000 })
        .toBe(true);

      if (await incompatible.isVisible()) {
        expect(heavy, "An incompatible browser must fail before heavy runtime loading").toEqual([]);
        expect(pageErrors).toEqual([]);
        await testInfo.attach("browser-capability-result", {
          body: await incompatible.innerText(),
          contentType: "text/plain",
        });
        return;
      }

      await expect(run).toBeEnabled({ timeout: 120_000 });
      await testInfo.attach("cold-preparation-elapsed-ms", {
        body: String(Date.now() - preparationStarted),
        contentType: "text/plain",
      });

      let acquired: { downloads: Set<string>; modules: Set<string> } | undefined;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt === 3) {
          await turnOnDebug(page);
        }

        const started = Date.now();
        await run.click();
        await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(
          /^Succeeded/,
          { timeout: 120_000 },
        );
        await expect(page.getByRole("region", { name: "Browser transaction result" })).toContainText("Ada");
        await expect
          .poll(() => page.evaluate(() => (window as RuntimeMetricsWindow).__drizzleRunMetrics))
          .toEqual({ created: attempt + 1, terminated: attempt + 1, active: 0 });
        await testInfo.attach(`run-${attempt + 1}-elapsed-ms`, {
          body: String(Date.now() - started),
          contentType: "text/plain",
        });

        // Fresh database workers may fetch the same WASM again; their asset closure must stay unchanged.
        const downloads = new Set(
          runtimeRequests.filter((entry) => entry.resourceType === "fetch").map((entry) => entry.url),
        );
        const modules = new Set(
          runtimeRequests.filter((entry) => entry.resourceType !== "fetch").map((entry) => entry.url),
        );

        if (acquired === undefined) {
          expect(downloads.size, "The first run downloads verified runtime assets").toBeGreaterThan(0);
          acquired = { downloads, modules };
        } else {
          expect(downloads, "Fresh hosts use the same verified runtime assets").toEqual(acquired.downloads);
          const known = acquired.modules;
          expect(
            [...modules].filter((url) => !known.has(url)),
            "Reruns load no new runtime modules",
          ).toEqual([]);
        }
      }

      await page.getByRole("tab", { name: "Debug", exact: true }).click();
      const report = JSON.parse(
        (await page
          .getByRole("region", { name: "Execution output" })
          .getByRole("tabpanel", { name: "Debug" })
          .locator("pre")
          .textContent()) ?? "",
      ) as { timings: Record<string, number> };
      expect(
        report.timings["load_artifacts"],
        "Prepared reruns should not charge the original engine initialization time",
      ).toBeLessThan(1_000);
      await testInfo.attach("prepared-debug-timings", {
        body: JSON.stringify(report.timings),
        contentType: "application/json",
      });
      expect(external, "Runtime package closure must stay on the application origin").toEqual([]);
      expect(
        persistenceWorkerRequests,
        "Fresh playground databases must not initialize persistent storage workers",
      ).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}
