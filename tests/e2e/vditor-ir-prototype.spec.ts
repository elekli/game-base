import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const independentRoundTripFixture = `# 海邊電台：第一次遊玩

這是一則代表性筆記：保留 *斜體*、**粗體**、[外部連結](https://example.com) 與清單語法。

- 先觀察每個人的起始資源

- [ ]  記下第一輪的節奏
- [X]  回合結束後整理感想

> 手機上要能看見內容變化，也要能回到 Markdown 原文。

~~~text
保留未裁決的細節，不把原文交給另一種格式。
~~~

%% VDITOR_IR_UNSUPPORTED_MARKER: keep-this-line %%
`;

async function hideNextDevIndicator(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((portal) => portal.remove());
  });
}

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
    const prototypeEditor = page.getByTestId("vditor-host");
    await prototypeEditor.scrollIntoViewIfNeeded();
    await hideNextDevIndicator(page);
    await page.screenshot({ path: "test-results/vditor-ir-editor-390px.png" });
    await heading.click();
    await expect(page.locator(".vditor-ir__marker--heading").first()).toBeVisible();
    await page.locator('.vditor-ir__node[data-type="em"]').click();
    await expect(page.locator(".vditor-ir__marker--bi").first()).toBeVisible();
    await hideNextDevIndicator(page);
    await page.screenshot({ path: "test-results/vditor-ir-syntax-390px.png" });

    const toolbar = page.locator(".vditor-toolbar--pin");
    const topbar = page.locator("header");
    const contentNode = heading;
    const editorBoxBeforeScroll = await prototypeEditor.boundingBox();
    expect(editorBoxBeforeScroll).not.toBeNull();
    await page.evaluate((distance) => window.scrollBy(0, distance), Math.max(editorBoxBeforeScroll!.y - 58, 0));
    const boxes = await Promise.all([toolbar.boundingBox(), topbar.boundingBox(), contentNode.boundingBox()]);
    expect(boxes[0]).not.toBeNull();
    expect(boxes[1]).not.toBeNull();
    expect(boxes[2]).not.toBeNull();
    expect(boxes[0]!.y).toBeGreaterThanOrEqual(boxes[1]!.y + boxes[1]!.height - 1);
    expect(boxes[0]!.y).toBeLessThanOrEqual(boxes[1]!.y + boxes[1]!.height + 2);
    expect(boxes[2]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height);
    const toolbarPosition = await toolbar.evaluate((element) => getComputedStyle(element).position);
    expect(toolbarPosition).toBe("sticky");

    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("\n\n自動化輸入保留在編輯器內。");
    await expect(page.getByTestId("input-count")).not.toHaveText("0");

    await page.getByRole("button", { name: "還原儲存值" }).click();
    await page.getByRole("button", { name: "取得 Markdown" }).click();
    await expect(page.getByTestId("roundtrip-result")).toHaveText("保留一致");
    await expect(page.getByTestId("markdown-export")).toHaveText(independentRoundTripFixture);
    await expect(page.getByTestId("markdown-export")).toContainText("%% VDITOR_IR_UNSUPPORTED_MARKER: keep-this-line %%");
    await hideNextDevIndicator(page);
    await page.screenshot({ path: "test-results/vditor-ir-390px.png", fullPage: true });
  });

  test("keeps the state contract visible for blank notes, failures, and composition events", async ({ page }) => {
    await page.goto("/prototype/vditor-ir");
    const editor = page.locator('.vditor-ir pre[contenteditable="true"]');

    await page.getByRole("button", { name: "以新筆記驗證空白不建立" }).click();
    await page.getByRole("button", { name: "清空目前內容" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("空白新筆記不建立");

    await page.getByRole("button", { name: "以既有筆記驗證清空待確認" }).click();
    await page.getByRole("button", { name: "清空目前內容" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("清空後待確認移除");

    await page.reload();
    await expect(editor).toContainText("海邊電台：第一次遊玩");

    await page.getByRole("button", { name: "清空目前內容" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("清空後待確認移除");
    await editor.click();
    await page.keyboard.insertText("恢復後重新自動儲存");
    await expect(page.getByTestId("save-status")).toHaveText("已儲存至原型草稿", { timeout: 3000 });
    await page.reload();
    await expect(editor).toContainText("恢復後重新自動儲存");

    await page.getByRole("button", { name: "還原儲存值" }).click();
    await page.getByLabel("模擬下一次儲存失敗").check();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" 失敗測試");
    await expect(page.getByTestId("save-status")).toHaveText("儲存失敗，文字仍保留", { timeout: 3000 });
    await expect(editor).toContainText("失敗測試");

    await page.getByLabel("模擬下一次儲存失敗").uncheck();
    await page.getByRole("button", { name: "重試儲存" }).click();
    await expect(page.getByTestId("save-status")).toHaveText("已儲存至原型草稿", { timeout: 3000 });
    await page.reload();
    await expect(editor).toContainText("失敗測試");

    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Object.defineProperty(window, "__prototypeOriginalSetItem", { configurable: true, value: original });
      Storage.prototype.setItem = function setItemThatFails() {
        throw new Error("prototype storage failure");
      };
    });
    await editor.click();
    await page.keyboard.insertText(" 實際儲存例外");
    await expect(page.getByTestId("save-status")).toHaveText("儲存失敗，文字仍保留", { timeout: 3000 });
    await expect(editor).toContainText("實際儲存例外");
    await page.evaluate(() => {
      const original = (window as Window & { __prototypeOriginalSetItem?: Storage["setItem"] }).__prototypeOriginalSetItem;
      if (original) Storage.prototype.setItem = original;
    });

    await editor.dispatchEvent("compositionstart");
    await expect(page.getByTestId("composition-state")).toHaveText("組字中");
    await editor.dispatchEvent("compositionend");
    await expect(page.getByTestId("composition-state")).toHaveText("組字完成");
  });
});
