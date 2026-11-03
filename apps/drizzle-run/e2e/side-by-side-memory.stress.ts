import { test } from "./fixtures";
import { verifySecondSideDisposal } from "./side-by-side-project";

test("should free the second side's runtime after each of 5 side-by-side visits", async ({ page }) => {
  test.setTimeout(900_000);

  await verifySecondSideDisposal(page, { visits: 5 });
});
