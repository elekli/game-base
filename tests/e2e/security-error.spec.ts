import { expect, test } from "@playwright/test";

test("390 px 安全錯誤畫面不洩漏技術細節", async ({ page }) => {
  await page.goto(
    "/security-error?requestId=36b8f84d-df4e-4d49-b662-bcde71a8764f&error=invalid-signature&token=secret",
  );

  await expect(page.getByRole("heading", { name: "目前無法開啟私人內容" })).toBeVisible();
  await expect(page.getByText("請求編號：36b8f84d-df4e-4d49-b662-bcde71a8764f")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("invalid-signature");
  await expect(page.locator("body")).not.toContainText("secret");
  await expect(page.locator("body")).not.toContainText("JWT");
  await page.screenshot({ path: "test-results/security-error-390.png", fullPage: true });
});
