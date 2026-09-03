import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await authenticatePage(page);
});

test("owner can search a source fixture and add it to the library", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "我的收藏庫" })).toBeVisible();

  await page.getByRole("link", { name: "新增遊戲" }).click();
  await expect(page.getByRole("heading", { name: "新增遊戲" })).toBeVisible();
  await page.getByLabel("搜尋遊戲").fill("範例");
  await page.getByRole("button", { name: "同時搜尋" }).click();

  await expect(page.getByText("範例桌遊", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "展開確認並加入" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("範例桌遊", { exact: true })).toBeVisible();
});

test("owner can link a manual board game to a distinct BGG fixture on mobile", async ({ page }, testInfo) => {
  const manualName = "連結前自訂名稱";

  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(manualName);
  await page.getByRole("button", { name: "建立手動條目" }).click();

  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { name: manualName }).click();
  await expect(page).toHaveURL(/\/games\/[^/]+$/);
  await page.getByText("首次連結外部來源").click();
  await page.getByLabel("名稱搜尋").fill("連結範例桌遊");
  await page.getByRole("button", { name: "搜尋來源" }).click();
  await expect(page.getByText("連結範例桌遊")).toBeVisible();
  const confirmationRequest = page.waitForRequest((request) => request.url().endsWith("/api/private/games/confirm") && request.method() === "POST");
  await page.getByRole("button", { name: "取得並確認" }).click();
  expect((await confirmationRequest).postDataJSON()).toMatchObject({ provider: "bgg", sourceId: "3" });
  await expect(page.getByText("來源已取得，請確認資料後連結。")).toBeVisible();
  await expect(page.getByText("請確認這是要連結的遊戲。").locator("..").getByText("來源：BGG")).toBeVisible();
  await page.getByRole("button", { name: "連結此來源" }).click();

  await expect(page).toHaveURL(/\/games\/[^/]+$/);
  await expect(page.getByRole("heading", { name: manualName })).toBeVisible();
  await expect(page.locator("dt").filter({ hasText: "來源" }).locator("..").getByText("BGG", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("manual-link-source-390.png"), fullPage: true });
});

test("owner can confirm reuse and creation of same-name contributors on mobile", async ({ page }, testInfo) => {
  const manualName = "貢獻確認手動遊戲";
  const contributorName = "同名測試作者";

  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(manualName);
  await page.getByRole("button", { name: "建立手動條目" }).click();

  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { name: manualName }).click();
  await page.getByText("貢獻關係").click();
  const contributionForm = page.getByRole("heading", { name: "手動貢獻" }).locator("..");
  await contributionForm.getByPlaceholder("人物或組織名稱").fill(contributorName);
  await contributionForm.getByRole("combobox").last().selectOption("design");
  await contributionForm.getByRole("button", { name: "新增手動貢獻" }).click();
  await page.getByText("貢獻關係").click();
  await expect(page.getByText(`${contributorName} · 設計／開發`)).toBeVisible();
  await contributionForm.getByPlaceholder("人物或組織名稱").fill(contributorName);
  await contributionForm.getByRole("combobox").last().selectOption("art");
  await contributionForm.getByRole("button", { name: "新增手動貢獻" }).click();
  await expect(page.getByText("尚未建立任何新資料")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("contributor-confirmation-390.png"), fullPage: true });
  await page.getByRole("button", { name: "重用此貢獻者" }).click();

  await page.getByText("貢獻關係").click();
  await expect(page.getByText(`${contributorName} · 設計／開發`)).toBeVisible();
  await expect(page.getByText(`${contributorName} · 美術`)).toBeVisible();
  await contributionForm.getByPlaceholder("人物或組織名稱").fill(contributorName);
  await contributionForm.getByRole("combobox").last().selectOption("publisher");
  await contributionForm.getByRole("button", { name: "新增手動貢獻" }).click();
  await expect(page.getByText("仍建立新的同名貢獻者")).toBeVisible();
  await page.getByRole("button", { name: "仍建立新的同名貢獻者" }).click();
  await page.getByText("貢獻關係").click();
  await expect(page.getByText(`${contributorName} · 發行`)).toBeVisible();
});
