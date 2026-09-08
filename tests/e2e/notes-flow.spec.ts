import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test("#69 390px 筆記：空白草稿、自動儲存、衝突與可復原移除", async ({ browser, page }, testInfo) => {
  testInfo.setTimeout(60_000);
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

  await page.getByRole("button", { name: "新增筆記" }).click();
  await page.getByRole("textbox", { name: "新增筆記內容" }).fill("第二則筆記");
  await expect(page.getByText("已儲存", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "編輯筆記" })).toHaveCount(2);

  const other = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await authenticatePage(other);
  await other.goto(gameUrl);
  const firstEditor = page.getByRole("textbox", { name: "編輯筆記" }).first();
  const otherEditor = other.getByRole("textbox", { name: "編輯筆記" }).first();
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

  await firstEditor.fill("");
  await expect(page.getByText("待確認移除", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "確認移除" }).click();
  await expect(page.getByRole("button", { name: "以最新版本確認移除" })).toBeVisible();
  await page.getByRole("button", { name: "以最新版本確認移除" }).click();
  await expect(page.getByText("筆記已移除，原文仍安全保留。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "立即復原" }).click();
  await expect(page.getByRole("textbox", { name: "編輯筆記" }).first()).toHaveValue("分頁 B 的本地內容");
  await expect(page.getByText("已儲存", { exact: true }).first()).toBeVisible();

  await page.reload();
  await other.reload();
  const currentEditor = page.getByRole("textbox", { name: "編輯筆記" }).first();
  const locallyEdited = other.getByRole("textbox", { name: "編輯筆記" }).first();
  await locallyEdited.fill("遠端移除時仍要保留的本地內容");
  await currentEditor.fill("");
  await page.getByRole("button", { name: "確認移除" }).click();
  await expect(page.getByText("筆記已移除，原文仍安全保留。", { exact: true })).toBeVisible();
  await expect(other.getByText("版本衝突", { exact: true })).toBeVisible();
  await other.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let dropped = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      if (!dropped && request.headers.has("Next-Action")) {
        dropped = true;
        throw new TypeError("simulated restore response loss");
      }
      return response;
    };
  });
  await other.getByRole("button", { name: "保留我的內容並重送" }).click();
  await expect(other.getByText("儲存失敗", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "重試", exact: true }).click();
  const recoveredEditor = other.getByRole("textbox", { name: "編輯筆記" }).first();
  await expect(recoveredEditor).toHaveValue("遠端移除時仍要保留的本地內容");
  await expect(recoveredEditor.locator("xpath=ancestor::article").getByText("已儲存", { exact: true })).toBeVisible();
  await other.reload();
  await expect(other.getByRole("textbox", { name: "編輯筆記" }).first()).toHaveValue("遠端移除時仍要保留的本地內容");

  await page.reload();
  const serverEditor = page.getByRole("textbox", { name: "編輯筆記" }).first();
  const secondLocalEdit = other.getByRole("textbox", { name: "編輯筆記" }).first();
  await secondLocalEdit.fill("還原再次衝突時保留的本地內容");
  await serverEditor.fill("");
  await page.getByRole("button", { name: "確認移除" }).click();
  await expect(other.getByText("版本衝突", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "立即復原" }).click();
  await expect(page.getByText("已儲存", { exact: true }).first()).toBeVisible();
  await other.getByRole("button", { name: "保留我的內容並重送" }).click();
  await expect(other.getByRole("button", { name: "以最新版本再次還原" })).toBeVisible();
  await other.getByRole("button", { name: "以最新版本再次還原" }).click();
  await expect(secondLocalEdit.locator("xpath=ancestor::article").getByText("已儲存", { exact: true })).toBeVisible();
  await other.reload();
  await expect(other.getByRole("textbox", { name: "編輯筆記" }).first()).toHaveValue("還原再次衝突時保留的本地內容");

  expect(await other.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await other.screenshot({ path: testInfo.outputPath("notes-conflict-and-recovery-390.png"), fullPage: true });

  await other.getByRole("link", { name: "收藏庫" }).click();
  await other.getByRole("link", { name: gameName }).click();
  await expect(other).toHaveURL(gameUrl);
  const historyEditor = other.getByRole("textbox", { name: "編輯筆記" }).first();
  await historyEditor.fill("尚未儲存的上一頁警告");
  await expect(other.getByText("等待儲存", { exact: true })).toBeVisible();
  const dialog = other.waitForEvent("dialog");
  const back = other.evaluate(() => window.history.back());
  const warning = await dialog;
  expect(warning.message()).toContain("未儲存");
  await warning.dismiss();
  await back;
  await expect(other).toHaveURL(gameUrl);
  await expect(historyEditor).toHaveValue("尚未儲存的上一頁警告");
  await other.close();
});

test("#69 無 Navigation API 時，取消前進與返回都保留本地文字", async ({ browser }, testInfo) => {
  testInfo.setTimeout(45_000);
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as Window & { __disableNavigationApiForTests?: boolean }).__disableNavigationApiForTests = true;
  });
  await authenticatePage(page);
  const gameName = `#69 歷史導覽 ${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(gameName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await page.getByRole("link", { name: gameName }).click();
  await expect(page).toHaveURL(/\/games\/[0-9a-f-]+$/);
  const gameUrl = page.url();
  await page.getByRole("link", { name: "新增筆記" }).click();
  await expect(page).toHaveURL(`${gameUrl}#notes-heading`);
  await page.getByRole("textbox", { name: "新增筆記內容" }).fill("歷史導覽原文");
  await expect(page.getByText("已儲存", { exact: true })).toBeVisible();

  const editor = page.getByRole("textbox", { name: "編輯筆記" });
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let dropped = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      if (!dropped && request.headers.has("Next-Action")) {
        dropped = true;
        throw new TypeError("keep navigation guard unsettled");
      }
      return response;
    };
  });
  await editor.fill("取消導覽後仍保留");
  await expect(page.getByText("儲存失敗", { exact: true })).toBeVisible();

  const nativeDialogMessages: string[] = [];
  page.on("dialog", async (nativeDialog) => {
    nativeDialogMessages.push(nativeDialog.message());
    await nativeDialog.dismiss();
  });
  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(`${gameUrl}#notes-heading`);
  await expect(editor).toHaveValue("取消導覽後仍保留");
  await page.waitForTimeout(700);
  await page.evaluate((urlWithoutHash) => {
    window.history.replaceState({ ...window.history.state, __NA: true }, "", urlWithoutHash);
  }, gameUrl);
  await expect(page).toHaveURL(`${gameUrl}#notes-heading`);
  await page.waitForTimeout(700);
  await page.evaluate((urlWithoutHash) => {
    window.history.replaceState({ ...window.history.state, __NA: true }, "", urlWithoutHash);
  }, gameUrl);
  await expect(page).toHaveURL(`${gameUrl}#notes-heading`);
  await page.evaluate(() => window.history.pushState(window.history.state, "", "#after-compensation"));
  await page.waitForTimeout(300);
  expect(nativeDialogMessages).toEqual(["筆記仍有未儲存內容。仍要離開嗎？"]);
  await expect(page).toHaveURL(`${gameUrl}#after-compensation`);
  await page.close();

  const historyPage = await browser.newPage();
  await historyPage.addInitScript(() => {
    (window as Window & { __disableNavigationApiForTests?: boolean }).__disableNavigationApiForTests = true;
  });
  await authenticatePage(historyPage);
  await historyPage.goto(gameUrl);
  const historyEditor = historyPage.getByRole("textbox", { name: "編輯筆記" });
  await expect(historyEditor).toBeVisible();
  await expect.poll(() => historyPage.evaluate(() => {
    const guardedWindow = window as Window & { __puizeruNavigationGuardState?: { installed?: boolean } };
    return guardedWindow.__puizeruNavigationGuardState?.installed === true
      && typeof window.history.state?.__puizeruHistoryPosition === "number";
  })).toBe(true);
  await historyPage.evaluate(() => {
    window.history.pushState(window.history.state, "", "#history-one");
    window.history.pushState(window.history.state, "", "#history-two");
    window.history.pushState(window.history.state, "", "#history-three");
    window.history.pushState(window.history.state, "", "#history-four");
    window.history.back();
  });
  await expect(historyPage).toHaveURL(`${gameUrl}#history-three`);
  await historyPage.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let dropped = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      if (!dropped && request.headers.has("Next-Action")) {
        dropped = true;
        throw new TypeError("keep multi-step navigation guard unsettled");
      }
      return response;
    };
  });
  await historyEditor.fill("多步取消後仍保留");
  await expect(historyPage.getByText("儲存失敗", { exact: true })).toBeVisible();

  let dialog = historyPage.waitForEvent("dialog");
  let traversal = historyPage.evaluate(() => window.history.go(-2));
  let warning = await dialog;
  await warning.dismiss();
  await traversal;
  await expect(historyPage).toHaveURL(`${gameUrl}#history-three`);
  await expect(historyEditor).toHaveValue("多步取消後仍保留");
  await historyPage.waitForTimeout(300);
  await expect(historyPage).toHaveURL(`${gameUrl}#history-three`);

  dialog = historyPage.waitForEvent("dialog");
  traversal = historyPage.evaluate(() => window.history.go(-2));
  warning = await dialog;
  await warning.accept();
  await traversal;
  await expect(historyPage).toHaveURL(`${gameUrl}#history-one`);
  await historyPage.close();

  const forwardPage = await browser.newPage();
  await forwardPage.addInitScript(() => {
    (window as Window & { __disableNavigationApiForTests?: boolean }).__disableNavigationApiForTests = true;
  });
  await authenticatePage(forwardPage);
  await forwardPage.goto(gameUrl);
  const forwardEditor = forwardPage.getByRole("textbox", { name: "編輯筆記" });
  await expect(forwardEditor).toBeVisible();
  await expect.poll(() => forwardPage.evaluate(() => typeof window.history.state?.__puizeruHistoryPosition)).toBe("number");
  await forwardPage.evaluate(() => {
    window.history.pushState(window.history.state, "", "#history-forward");
  });
  await expect(forwardPage).toHaveURL(`${gameUrl}#history-forward`);
  await forwardPage.evaluate(() => window.history.back());
  await expect(forwardPage).toHaveURL(gameUrl);
  await forwardPage.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let dropped = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      if (!dropped && request.headers.has("Next-Action")) {
        dropped = true;
        throw new TypeError("keep forward guard unsettled");
      }
      return response;
    };
  });
  await forwardEditor.fill("取消前進後仍保留");
  await expect(forwardPage.getByText("儲存失敗", { exact: true })).toBeVisible();
  dialog = forwardPage.waitForEvent("dialog");
  traversal = forwardPage.evaluate(() => window.history.forward());
  warning = await dialog;
  await warning.dismiss();
  await traversal;
  await expect(forwardPage).toHaveURL(gameUrl);
  await expect(forwardEditor).toHaveValue("取消前進後仍保留");
  await forwardPage.close();

  const routePage = await browser.newPage();
  await routePage.addInitScript(() => {
    (window as Window & { __disableNavigationApiForTests?: boolean }).__disableNavigationApiForTests = true;
  });
  await authenticatePage(routePage);
  await routePage.goto("/");
  await routePage.getByRole("link", { name: new RegExp(gameName) }).click();
  await expect(routePage).toHaveURL(gameUrl);
  const routeEditor = routePage.getByRole("textbox", { name: "編輯筆記" });
  await routePage.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let rejected = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!rejected && request.headers.has("Next-Action")) {
        rejected = true;
        throw new TypeError("simulated request failure before send");
      }
      return originalFetch(input, init);
    };
  });
  await routeEditor.fill("請求未送出時的跨頁本地內容");
  await expect(routePage.getByText("儲存失敗", { exact: true })).toBeVisible();
  dialog = routePage.waitForEvent("dialog");
  traversal = routePage.evaluate(() => window.history.back());
  warning = await dialog;
  await warning.dismiss();
  await traversal;
  await expect(routePage).toHaveURL(gameUrl);
  await expect(routeEditor).toHaveValue("請求未送出時的跨頁本地內容");
  await routePage.close();
});

test("#69 明確拒絕的草稿可修正後重送", async ({ page }, testInfo) => {
  testInfo.setTimeout(45_000);
  await authenticatePage(page);
  const gameName = `#69 草稿修正 ${Date.now()}`;
  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(gameName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await page.getByRole("link", { name: gameName }).click();
  await page.getByRole("button", { name: "新增筆記" }).click();
  const draft = page.getByRole("textbox", { name: "新增筆記內容" });
  await draft.fill("字".repeat(100_001));
  await expect(page.getByText("儲存失敗", { exact: true })).toBeVisible();
  await expect(draft).toBeEnabled();
  await draft.fill("修正後可儲存的內容");
  await expect(page.getByText("已儲存", { exact: true })).toBeVisible();
});

test("#69 更新回應遺失後改回舊文，會先確認未決命令再儲存", async ({ page }, testInfo) => {
  testInfo.setTimeout(45_000);
  await authenticatePage(page);
  const gameName = `#69 回應遺失 ${Date.now()}`;
  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(gameName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await page.getByRole("link", { name: gameName }).click();
  await page.getByRole("button", { name: "新增筆記" }).click();
  await page.getByRole("textbox", { name: "新增筆記內容" }).fill("原文 A");
  await expect(page.getByText("已儲存", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let dropped = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      if (!dropped && request.headers.has("Next-Action")) {
        dropped = true;
        throw new TypeError("simulated response loss");
      }
      return response;
    };
  });

  const editor = page.getByRole("textbox", { name: "編輯筆記" });
  await editor.fill("已送達但回應遺失的 B");
  await expect(page.getByText("儲存失敗", { exact: true })).toBeVisible();
  await editor.fill("原文 A");
  await expect(editor.locator("xpath=ancestor::article").getByText("已儲存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "編輯筆記" })).toHaveValue("原文 A");

  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let dropped = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      if (!dropped && request.headers.has("Next-Action")) {
        dropped = true;
        throw new TypeError("simulated response loss before clearing");
      }
      return response;
    };
  });
  const reloadedEditor = page.getByRole("textbox", { name: "編輯筆記" });
  await reloadedEditor.fill("第二個未決版本 B");
  await expect(page.getByText("儲存失敗", { exact: true })).toBeVisible();
  await reloadedEditor.fill("");
  await reloadedEditor.fill("清空後重新輸入的 C");
  await expect(reloadedEditor.locator("xpath=ancestor::article").getByText("已儲存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "編輯筆記" })).toHaveValue("清空後重新輸入的 C");
});
