import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test.describe.configure({ mode: "serial", retries: 0 });
test.beforeEach(async ({ page }) => authenticatePage(page));

test("#72 在 390px 將遊戲移入資源回收區並還原", async ({ page }, testInfo) => {
  const name = `資源回收驗收-${Date.now()}`;
  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(name);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await expect(page).toHaveURL(/\/$/);
  const gameHref = await page.getByRole("link", { name: new RegExp(name) }).getAttribute("href");
  expect(gameHref).toMatch(/^\/games\/[0-9a-f-]+$/);

  await page.goto(gameHref!);
  const lifecycle = page.getByRole("region", { name: "資源回收區" });
  await lifecycle.getByRole("button", { name: "移入資源回收區" }).click();
  await expect(lifecycle.getByText("筆記：0")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("game-trash-confirmation-390.png"), fullPage: true });
  await lifecycle.getByRole("button", { name: "確認移入" }).click();
  await expect(page).toHaveURL(/\/trash\?focus=/);
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("game-trash-390.png"), fullPage: true });

  await page.getByRole("button", { name: "還原" }).click();
  await expect(page).toHaveURL(new RegExp(`${gameHref}$`));
  await expect(page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "移入資源回收區" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("game-trash-restored-390.png"), fullPage: true });
});

test("#72 清單、關聯與遊戲頁都能還原同一筆回收遊戲", async ({ page }, testInfo) => {
  const suffix = Date.now();
  const createManualGame = async (name: string) => {
    await page.goto("/games/new");
    await page.getByText("找不到？建立手動條目").click();
    await page.getByRole("textbox", { name: "遊戲名稱" }).fill(name);
    await page.getByRole("button", { name: "建立手動條目" }).click();
    await expect(page).toHaveURL(/\/$/);
    return page.getByRole("link", { name: new RegExp(name) }).getAttribute("href");
  };
  const leftName = `回收關聯主遊戲-${suffix}`;
  const trashedName = `回收關聯遊戲-${suffix}`;
  const leftHref = await createManualGame(leftName);
  const trashedHref = await createManualGame(trashedName);
  const trashedId = trashedHref!.split("/").at(-1)!;

  await page.goto(leftHref!);
  const relations = page.getByRole("region", { name: "關聯遊戲" });
  await relations.getByLabel("收藏庫遊戲").selectOption(trashedId);
  await relations.getByRole("button", { name: "新增關聯" }).click();
  await expect(relations.locator("li").filter({ hasText: trashedName })).toBeVisible();

  await page.goto("/lists/new");
  const listName = `回收清單-${suffix}`;
  await page.getByLabel("清單名稱").fill(listName);
  await page.getByRole("button", { name: trashedName, exact: true }).click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]+$/);
  const listHref = page.url();

  await page.goto(trashedHref!);
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "移入資源回收區" }).click();
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "確認移入" }).click();
  await expect(page).toHaveURL(/\/trash\?focus=/);

  await page.goto(leftHref!);
  const trashedRelation = page.getByRole("region", { name: "關聯遊戲" }).locator("li").filter({ hasText: trashedName });
  await expect(trashedRelation.getByText("已移入資源回收區")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await trashedRelation.getByRole("button", { name: "還原" }).click();
  await expect(page).toHaveURL(new RegExp(`${trashedHref}$`));

  await page.goto(trashedHref!);
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "移入資源回收區" }).click();
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "確認移入" }).click();
  await page.goto(listHref);
  const member = page.getByRole("region", { name: "清單成員" }).locator("li").filter({ hasText: trashedName });
  await expect(member.getByText("已移入資源回收區")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await member.getByRole("button", { name: "還原" }).click();
  await expect(page).toHaveURL(new RegExp(`${trashedHref}$`));

  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "移入資源回收區" }).click();
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "確認移入" }).click();
  await page.goto(trashedHref!);
  await expect(page.getByRole("link", { name: "← 資源回收區" })).toBeVisible();
  await expect(page.getByText("所有遊戲資料仍完整保留。還原後即可再次編輯、查看筆記與媒體。")).toBeVisible();
  await expect(page.getByRole("link", { name: "新增筆記" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "上傳照片或附件" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "移入資源回收區" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("trashed-game-detail-390.png"), fullPage: true });
  await page.getByRole("button", { name: "還原" }).click();
  await expect(page).toHaveURL(new RegExp(`${trashedHref}$`));
});

test("#72 來源唯一性碰撞會導向既有回收遊戲", async ({ page }) => {
  await page.goto("/games/new?q=範例桌遊");
  await page.getByRole("button", { name: "展開確認並加入" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  const existingHref = await page.getByRole("link", { name: /範例桌遊/ }).getAttribute("href");
  expect(existingHref).toMatch(/^\/games\/[0-9a-f-]+$/);

  await page.goto(existingHref!);
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "移入資源回收區" }).click();
  await page.getByRole("region", { name: "資源回收區" }).getByRole("button", { name: "確認移入" }).click();
  await expect(page).toHaveURL(/\/trash\?focus=/);

  await page.goto("/games/new?q=範例桌遊");
  await page.getByRole("button", { name: "展開確認並加入" }).first().click();
  await expect(page).toHaveURL(new RegExp(`${existingHref}$`));
  await expect(page.getByText("已移入資源回收區")).toBeVisible();
  await expect(page.getByRole("button", { name: "還原" })).toBeVisible();
});
