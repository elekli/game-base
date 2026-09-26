import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test.describe.configure({ mode: "serial", retries: 0 });

test.beforeEach(async ({ page }) => authenticatePage(page));

test("#70 keeps an empty list as a browser draft and completes list lifecycle at 390px", async ({ page }, testInfo) => {
  const draftName = `未建立清單-${Date.now()}`;
  const listName = `一般清單-${Date.now()}`;
  const ownedGameName = `清單成員-${Date.now()}`;

  await page.goto("/lists/new");
  await page.getByLabel("清單名稱").fill(draftName);
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto("/lists");
  await expect(page.getByText(draftName)).toHaveCount(0);

  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(ownedGameName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/lists/new");
  await page.getByLabel("清單名稱").fill(listName);
  await page.getByRole("button", { name: ownedGameName, exact: true }).click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]+$/);
  const listUrl = page.url();
  const memberSection = page.getByRole("region", { name: "清單成員" });
  await expect(memberSection.getByText(ownedGameName, { exact: true })).toBeVisible();
  const description = memberSection.getByLabel(`${ownedGameName}的描述`);
  await description.fill("適合週末開桌");
  await memberSection.getByRole("button", { name: "儲存描述" }).first().click();
  await expect(page.getByRole("status")).toContainText("描述已儲存");
  await description.fill("");
  await memberSection.getByRole("button", { name: "儲存描述" }).first().click();
  await expect(page.getByRole("status")).toContainText("描述已清除");

  await page.getByLabel("搜尋庫外遊戲").fill("範例桌遊");
  await page.getByRole("button", { name: "搜尋" }).click();
  await page.getByRole("button", { name: /範例桌遊/ }).first().click();
  await expect(memberSection.getByText("範例桌遊", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: listName })).toBeVisible();

  await page.getByLabel("搜尋庫外遊戲").fill("範例電子遊戲");
  await page.getByRole("button", { name: "搜尋" }).click();
  await page.getByRole("button", { name: /範例電子遊戲/ }).click();
  await expect(memberSection.getByText("範例電子遊戲", { exact: true })).toBeVisible();
  await expect(page.getByText("3 款遊戲")).toBeVisible();

  const firstMember = memberSection.locator("li").filter({ hasText: "範例桌遊" });
  await firstMember.getByRole("button", { name: "移除" }).click();
  await expect(firstMember.getByText("已移除")).toBeVisible();
  await firstMember.getByRole("button", { name: "立即復原" }).click();
  await expect(firstMember.getByText("已移除")).toHaveCount(0);

  await page.getByRole("button", { name: "封存清單" }).click();
  await expect(page.getByText("3 款遊戲，已封存")).toBeVisible();
  await expect(page.getByRole("heading", { name: "加入遊戲" })).toHaveCount(0);
  await memberSection.getByRole("link", { name: ownedGameName }).click();
  const archivedSection = page.getByRole("region", { name: "相關封存清單" });
  await expect(archivedSection.getByRole("link", { name: listName })).toBeVisible();
  await archivedSection.getByRole("button", { name: "還原" }).click();
  await expect(archivedSection).toHaveCount(0);
  await page.goto(listUrl);
  await expect(page.getByText("3 款遊戲", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("general-list-390.png"), fullPage: true });
});
