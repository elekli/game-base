import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test.describe.configure({ mode: "serial", retries: 0 });
test.beforeEach(async ({ page }) => authenticatePage(page));

test("#71 displays and removes the same game relation from either page at 390px", async ({ page }, testInfo) => {
  const leftName = `關聯遊戲-${Date.now()}`;
  const rightName = `關聯遊戲-${Date.now()}-另一款`;

  const createManualGame = async (name: string) => {
    await page.goto("/games/new");
    await page.getByText("找不到？建立手動條目").click();
    await page.getByRole("textbox", { name: "遊戲名稱" }).fill(name);
    await page.getByRole("button", { name: "建立手動條目" }).click();
    await expect(page).toHaveURL(/\/$/);
    const gameLink = page.getByRole("link", { name: new RegExp(name) });
    await expect(gameLink).toBeVisible();
    return gameLink.getAttribute("href");
  };

  const leftHref = await createManualGame(leftName);
  const rightHref = await createManualGame(rightName);
  expect(leftHref).toMatch(/^\/games\/[0-9a-f-]+$/);
  expect(rightHref).toMatch(/^\/games\/[0-9a-f-]+$/);
  const rightId = rightHref!.split("/").at(-1)!;

  await page.goto(leftHref!);
  const leftSection = page.getByRole("region", { name: "關聯遊戲" });
  await leftSection.getByLabel("收藏庫遊戲").selectOption(rightId);
  await leftSection.getByRole("button", { name: "新增關聯" }).click();
  await expect(leftSection.locator("ul > li").filter({ hasText: rightName })).toBeVisible();

  await page.goto(rightHref!);
  const rightSection = page.getByRole("region", { name: "關聯遊戲" });
  await expect(rightSection.locator("ul > li").filter({ hasText: leftName })).toBeVisible();
  const rightItem = rightSection.locator("li").filter({ hasText: leftName });
  await page.screenshot({ path: testInfo.outputPath("symmetric-relations-active-390.png"), fullPage: true });
  await rightItem.getByRole("button", { name: "解除" }).click();
  await expect(rightSection.getByRole("status")).toContainText("已解除關聯");
  await rightSection.getByRole("button", { name: "立即復原" }).click();
  await expect(rightSection.locator("ul > li").filter({ hasText: leftName })).toBeVisible();

  await rightItem.getByRole("button", { name: "解除" }).click();
  await page.goto(leftHref!);
  await expect(page.getByRole("region", { name: "關聯遊戲" }).getByText("尚無關聯遊戲。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("symmetric-relations-390.png"), fullPage: true });
});
