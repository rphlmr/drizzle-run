import { expect, test } from "./fixtures";
import { makeStoredRecord } from "./retired-pair";
import { callStore } from "./store";

test.skip(({ browserName }) => browserName !== "chromium", "Trusted touch swipes use Chromium's input protocol.");

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
});

test("should scroll the editor with a finger on mobile", async ({ page, context }) => {
  const id = "00000000-0000-4000-9000-000000000901";
  const record = makeStoredRecord(id, "Touch scrolling", {
    "drizzle-orm": "1.0.0-rc.5",
    "drizzle-kit": "1.0.0-rc.5",
  });
  record.manifest.files["query.ts"] = Array.from(
    { length: 150 },
    (_, i) => `// Line ${i + 1} ${"long content ".repeat(12)}`,
  ).join("\n");
  await callStore(page, "saveProjects", [record], []);
  await page.goto(`/p/${id}`);
  const editor = page.locator(".monaco-editor");
  await expect(editor.locator(".view-lines")).toContainText("Line 1");
  const box = await editor.boundingBox();
  if (!box) throw new Error("Editor is not visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.75;
  await page.touchscreen.tap(x, y);
  const session = await context.newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - step * 20 }],
    });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => Number(await editor.locator(".line-numbers").first().textContent())).toBeGreaterThan(1);
});

test("should keep guide code above the sheet and support swiping its header", async ({ page, context }) => {
  await page.goto("/examples/drizzle-in-five-minutes?step=2");
  const sheet = page.getByRole("region", { name: "Guide", exact: true });
  const editor = page.locator(".monaco-editor").first();
  await expect(sheet.getByRole("heading", { name: "Publish Ada's next post" })).toBeVisible();
  await expect(editor.locator(".view-lines")).toBeVisible();
  const editorBox = await editor.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!editorBox || !sheetBox) throw new Error("Guide layout is missing");
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(sheetBox.y + 1);

  const session = await context.newCDPSession(page);
  const swipe = async (x: number, from: number, to: number) => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
    for (let step = 1; step <= 10; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: from + ((to - from) * step) / 10 }],
      });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const initialLine = Number(await editor.locator(".line-numbers").first().textContent());
  await swipe(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height - 15, editorBox.y + 15);
  await expect
    .poll(async () => Number(await editor.locator(".line-numbers").first().textContent()))
    .toBeGreaterThan(initialLine);

  const collapse = sheet.getByRole("button", { name: "Collapse guide" });
  await expect(collapse).toContainText("Hide guide steps");
  const header = await collapse.boundingBox();
  if (!header) throw new Error("Guide header is missing");
  await swipe(header.x + header.width / 2, header.y + header.height / 2, header.y + header.height / 2 + 100);
  const expand = sheet.getByRole("button", { name: "Expand guide" });
  await expect(expand).toBeVisible();
  await expect(expand).toContainText("Show guide steps");
  const collapsedHeader = await expand.boundingBox();
  if (!collapsedHeader) throw new Error("Collapsed guide header is missing");
  await swipe(
    collapsedHeader.x + collapsedHeader.width / 2,
    collapsedHeader.y + collapsedHeader.height / 2,
    collapsedHeader.y - 100,
  );
  await expect(collapse).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Publish Ada's next post" })).toBeVisible();
});
