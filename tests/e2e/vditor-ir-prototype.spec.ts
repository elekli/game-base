import { expect, test } from "@playwright/test";

test.describe("Vditor ir 行動版隔離原型", () => {
  test("renders an ir editor with a pinned toolbar and preserves Markdown output", async ({ page }) => {
    await page.goto("/prototype/vditor-ir");

    const editor = page.locator('.vditor-ir pre[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await expect(page.locator(".vditor-ir")).toHaveCount(1);
    await expect(page.locator(".vditor-toolbar--pin")).toHaveCount(1);
    expect(await page.locator(".vditor-toolbar__item").count()).toBeGreaterThan(10);
    const heading = page.getByRole("heading", { name: "海邊電台：第一次遊玩" });
    await expect(heading).toBeVisible();
    await page.locator(".prototype-editor").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/vditor-ir-editor-390px.png" });
    await heading.click();
    await expect(page.locator(".vditor-ir__marker--heading").first()).toBeVisible();
    await page.locator('.vditor-ir__node[data-type="em"]').click();
    await expect(page.locator(".vditor-ir__marker--bi").first()).toBeVisible();
    await page.screenshot({ path: "test-results/vditor-ir-syntax-390px.png" });

    const toolbarPosition = await page.locator(".vditor-toolbar--pin").evaluate((element) => getComputedStyle(element).position);
    expect(toolbarPosition).toBe("sticky");

    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("\n\n自動化輸入保留在編輯器內。");
    await expect(page.getByTestId("input-count")).not.toHaveText("0");

    await page.getByRole("button", { name: "取得 Markdown" }).click();
    await expect(page.getByTestId("roundtrip-result")).toHaveText("保留一致");
    await expect(page.getByTestId("markdown-export")).toContainText("# 海邊電台：第一次遊玩");
    await expect(page.getByTestId("markdown-export")).toContainText("[外部連結](https://example.com)");
    await page.screenshot({ path: "test-results/vditor-ir-390px.png", fullPage: true });
  });

  test("keeps the state contract visible for blank notes, failures, and composition events", async ({ page }) => {
    await page.goto("/prototype/vditor-ir");
    const editor = page.locator('.vditor-ir pre[contenteditable="true"]');

    await page.getByRole("button", { name: "以新筆記驗證空白不建立" }).click();
    await page.getByRole("button", { name: "清空目前內容" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("空白新筆記不建立");

    await page.getByRole("button", { name: "以既有筆記驗證清空待確認" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("清空後待確認移除");

    await page.getByRole("button", { name: "還原儲存值" }).click();
    await page.getByLabel("模擬下一次儲存失敗").check();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" 失敗測試");
    await expect(page.getByTestId("save-status")).toHaveText("儲存失敗，文字仍保留", { timeout: 3000 });
    await expect(editor).toContainText("失敗測試");

    await editor.dispatchEvent("compositionstart");
    await expect(page.getByTestId("composition-state")).toHaveText("組字中");
    await editor.dispatchEvent("compositionend");
    await expect(page.getByTestId("composition-state")).toHaveText("組字完成");
  });
});
