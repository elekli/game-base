import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

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

  await expect(page.getByText("範例桌遊")).toBeVisible();
  await page.getByRole("button", { name: "展開確認並加入" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("範例桌遊")).toBeVisible();
});
