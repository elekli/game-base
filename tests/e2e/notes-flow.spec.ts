import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test("#69 390px 筆記：空白草稿、自動儲存、衝突與可復原移除", async ({ browser, page }, testInfo) => {
  await authenticatePage(page);
  const gameName = `#69 筆記驗收 ${Date.now()}`;

  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(gameName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await page.getByRole("link", { name: gameName }).click();
  await expect(page).toHaveURL(/\/games\/[0-9a-f-]+$/);
  const gameUrl = page.url();

  await page.getByRole("link", { name: "新增筆記" }).click();
  await expect(page.getByRole("textbox", { name: "新增筆記內容" })).toBeVisible();
  await page.getByRole("link", { name: "收藏庫" }).click();
  await page.goto(gameUrl);
  await expect(page.getByText("尚無筆記。", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增筆記" }).click();
  await page.getByRole("textbox", { name: "新增筆記內容" }).fill("**第一版**\n\n保留 Markdown 原文");
  await expect(page.getByText("已儲存", { exact: true })).toBeVisible();

  const other = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await authenticatePage(other);
  await other.goto(gameUrl);
  const firstEditor = page.getByRole("textbox", { name: "新增筆記內容" });
  const otherEditor = other.getByRole("textbox", { name: "編輯筆記" });
  await expect(otherEditor).toHaveValue("**第一版**\n\n保留 Markdown 原文");

  await firstEditor.fill("分頁 A 的內容");
  await expect(page.getByText("等待儲存", { exact: true })).toBeVisible();
  await expect(page.getByText("已儲存", { exact: true })).toBeVisible();
  await otherEditor.fill("分頁 B 的本地內容");
  await expect(other.getByText("等待儲存", { exact: true })).toBeVisible();
  await expect(other.getByText("版本衝突", { exact: true })).toBeVisible();
  await expect(otherEditor).toHaveValue("分頁 B 的本地內容");
  await expect(other.getByText("分頁 A 的內容", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "保留我的內容並重送" }).click();
  await expect(other.getByText("已儲存", { exact: true })).toBeVisible();

  await otherEditor.fill("");
  await expect(other.getByText("待確認移除", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "確認移除" }).click();
  await expect(other.getByText("筆記已移除，原文仍安全保留。", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "立即復原" }).click();
  await expect(otherEditor).toHaveValue("分頁 B 的本地內容");
  await expect(other.getByText("已儲存", { exact: true })).toBeVisible();

  expect(await other.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await other.screenshot({ path: testInfo.outputPath("notes-conflict-and-recovery-390.png"), fullPage: true });

  await otherEditor.fill("尚未送出的內容");
  await expect(other.getByText("等待儲存", { exact: true })).toBeVisible();
  const warning = new Promise<string>((resolve) => other.once("dialog", async (dialog) => {
    resolve(dialog.message());
    await dialog.accept();
  }));
  await other.getByRole("link", { name: "收藏庫" }).click();
  await expect(warning).resolves.toBe("筆記仍有未儲存內容。仍要離開嗎？");
  await expect(other).toHaveURL(/\/$/);
  await other.close();
});
