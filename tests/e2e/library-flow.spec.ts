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

test("#36 owner data keeps source platforms read-only and hides platform editing for board games", async ({ page }, testInfo) => {
  const videoName = "#36 電子遊戲驗收";
  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(videoName);
  await page.getByRole("combobox").last().selectOption("video_game");
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { name: videoName }).click();
  await page.getByText("首次連結外部來源").click();
  await page.getByLabel("名稱搜尋").fill("範例電子遊戲");
  await page.getByRole("button", { name: "搜尋來源" }).click();
  await page.getByRole("button", { name: "取得並確認" }).click();
  await page.getByRole("button", { name: "連結此來源" }).click();
  await expect(page.getByText("來源支援平台（僅供參考）")).toBeVisible();
  await expect(page.getByText("PC", { exact: true })).toBeVisible();
  await page.getByText("編輯擁有者資料").click();
  await expect(page.locator('input[name="actualPlatforms"]:checked')).toHaveCount(0);
  await page.getByLabel("自訂顯示名稱").fill("#36 自訂顯示名稱");
  await page.locator('input[name="actualPlatforms"][value="Steam"]').check();
  await page.getByLabel("自由標籤（以逗號分隔）").fill("合作, 收藏");
  await page.getByLabel("人數說明（選填）").fill("兩人時採輪流模式");
  await page.getByRole("button", { name: "儲存資料" }).click();
  await expect(page.getByRole("heading", { name: "#36 自訂顯示名稱" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "Steam" })).toBeVisible();
  await expect(page.getByText("合作、收藏", { exact: true })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "兩人時採輪流模式" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const boardName = "#36 桌遊無平台欄";
  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(boardName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await page.getByRole("link", { name: boardName }).click();
  await page.getByText("編輯擁有者資料").click();
  await expect(page.locator("legend", { hasText: "實際平台" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("owner-data-390.png"), fullPage: true });
});

test("#39 refresh failure keeps safe source data and retry succeeds once per click", async ({ page }, testInfo) => {
  await page.goto("/games/new");
  await page.getByLabel("搜尋遊戲").fill("刷新驗收遊戲");
  await page.getByRole("button", { name: "同時搜尋" }).click();
  await page.getByRole("button", { name: "展開確認並加入" }).click();
  await page.getByRole("link", { name: "刷新驗收遊戲" }).click();
  const description = page.locator("details").filter({ hasText: "來源介紹" });
  await expect(description).not.toHaveAttribute("open", "");
  await description.locator("summary").click();
  await expect(page.getByText("A & B", { exact: true })).toBeVisible();
  await expect(page.getByText("alert(1)", { exact: true })).toHaveCount(0);
  await page.getByText("編輯擁有者資料").click();
  await expect(page.getByLabel("自訂顯示名稱")).toBeVisible();
  let refreshRequests = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.headers()["next-action"]) refreshRequests += 1; });
  const refreshButton = page.getByRole("button", { name: "重新整理來源資料" });
  await refreshButton.evaluate((element) => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await expect(page.getByRole("status")).toContainText("來源暫時無法使用");
  expect(refreshRequests).toBe(1);
  await expect(refreshButton).toBeEnabled();
  await refreshButton.click();
  await expect(page.getByRole("button", { name: "重新整理來源資料" })).toBeVisible();
  expect(refreshRequests).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("refresh-retry-390.png"), fullPage: true });
});

test("#40 board-only facets apply OR／AND and clear when switching to multiple media", async ({ page }, testInfo) => {
  for (const title of ["篩選驗收合作", "篩選驗收策略", "篩選驗收另一機制"]) {
    await page.goto("/games/new");
    await page.getByLabel("搜尋遊戲").fill(title);
    await page.getByRole("button", { name: "同時搜尋" }).click();
    await page.getByRole("button", { name: "展開確認並加入" }).click();
    await expect(page).toHaveURL(/\/$/);
  }
  await page.goto("/");
  await page.getByLabel("桌遊").check();
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page).toHaveURL(/medium=board_game/);
  await expect(page.getByText("合作", { exact: true })).toBeVisible();
  await expect(page.getByText("策略", { exact: true })).toBeVisible();
  await page.getByLabel("合作", { exact: true }).check();
  await page.getByLabel("策略", { exact: true }).check();
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "篩選驗收合作" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收策略" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收另一機制" })).toBeVisible();
  await page.getByLabel("共用機制", { exact: true }).check();
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "篩選驗收合作" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收策略" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收另一機制" })).toHaveCount(0);
  await page.getByLabel("最低重度").fill("2.5");
  await page.getByLabel("最高重度").fill("4");
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "篩選驗收合作" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "篩選驗收策略" })).toHaveCount(0);
  await page.getByLabel("最低重度").fill("");
  await page.getByLabel("最高重度").fill("");
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "篩選驗收合作" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收策略" })).toBeVisible();
  await page.locator("#library-sort").selectOption("weight_asc");
  await page.getByRole("button", { name: "套用篩選" }).click();
  expect(await page.locator("main > ul h2").allTextContents()).toEqual(["篩選驗收策略", "篩選驗收合作"]);
  await page.locator("#library-sort").selectOption("weight_desc");
  await page.getByRole("button", { name: "套用篩選" }).click();
  expect(await page.locator("main > ul h2").allTextContents()).toEqual(["篩選驗收合作", "篩選驗收策略"]);
  await page.locator("#library-sort").selectOption("strategy_rank");
  await page.getByRole("button", { name: "套用篩選" }).click();
  expect(await page.locator("main > ul h2").allTextContents()).toEqual(["篩選驗收策略", "篩選驗收合作"]);
  await page.getByLabel("電子遊戲").check();
  await expect(page.getByText("來源分類", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page).toHaveURL(/medium=board_game&medium=video_game&sort=name/);
  expect(new URL(page.url()).searchParams.has("category")).toBe(false);
  expect(new URL(page.url()).searchParams.has("weightMin")).toBe(false);
  expect(new URL(page.url()).searchParams.get("sort")).toBe("name");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("library-filters-390.png"), fullPage: true });
});
