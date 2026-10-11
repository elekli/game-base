import { expect, test, type Page } from "@playwright/test";

const generation = process.env.PRODUCTION_CANARY_GENERATION;
const executionSha = process.env.PRODUCTION_CANARY_EXECUTION_SHA;
const screenshotPath = process.env.PRODUCTION_CANARY_SCREENSHOT_PATH;
const boardGameId = "21b1553c-bcc2-4d8b-9ccd-93b54e28ef1d";
const videoGameId = "c5e729ce-0c39-4ba2-a7d7-3edeb7e38e2c";
const boardGameName = "正式 canary 桌遊";
const videoGameName = "正式 canary 電子遊戲";

if (!generation || !executionSha || !/^[a-f0-9]{40}$/.test(executionSha)) {
  throw new Error("Production canary execution identity is incomplete");
}

async function assertExecutionSha(page: Page) {
  const ping = await page.evaluate(async () => {
    const response = await fetch("/api/private/ping", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json() as { executionSha?: unknown };
  });
  expect(ping?.executionSha).toBe(executionSha);
}

function watchOwnerActionResponses(page: Page) {
  const responses: Promise<boolean>[] = [];
  page.on("response", (response) => {
    if (response.request().method() !== "POST" || !response.request().headers()["next-action"]) return;
    responses.push(response.text().then((body) => response.ok() && body.includes(`"executionSha":"${executionSha}"`), () => false));
  });
  return async () => {
    await expect.poll(() => responses.length, { message: "owner action response was not observed" }).toBeGreaterThan(0);
    const observed = responses.splice(0);
    for (const shaMatched of await Promise.all(observed)) expect(shaMatched).toBe(true);
  };
}

test("正式環境 390 px canary：筆記、衝突、清單、雙向關聯、資源回收與還原", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Production canary base URL is unavailable");
  const ownerAccessJwt = process.env.PRODUCTION_SMOKE_OWNER_ACCESS_JWT;
  if (!ownerAccessJwt) throw new Error("Production canary owner session is unavailable");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "Cf-Access-Token": ownerAccessJwt },
  });
  await context.addCookies([{
    name: "production_canary_generation",
    value: generation,
    url: baseURL,
    httpOnly: true,
    secure: baseURL.startsWith("https://"),
    sameSite: "Lax",
  }]);
  await context.addCookies([{
    name: "production_canary_execution_sha",
    value: executionSha,
    url: baseURL,
    httpOnly: true,
    secure: baseURL.startsWith("https://"),
    sameSite: "Lax",
  }]);
  const page = await context.newPage();
  const assertOwnerActionSha = watchOwnerActionResponses(page);
  const gameUrl = `${baseURL}/games/${boardGameId}`;
  try {
    await page.goto(gameUrl);
    await expect(page.getByRole("heading", { name: boardGameName })).toBeVisible();
    await assertExecutionSha(page);

    await page.getByRole("button", { name: "新增筆記" }).click();
    const createEditor = page.getByRole("textbox", { name: "新增筆記內容" }).first();
    await createEditor.fill("合成 canary 筆記第一版");
    await expect(page.getByText("已儲存", { exact: true }).first()).toBeVisible();
    await assertOwnerActionSha();
    await assertExecutionSha(page);

    const noteEditor = page.getByRole("textbox", { name: "編輯筆記" }).first();
    const leaveDialogPromise = page.waitForEvent("dialog");
    await noteEditor.fill("只供離頁保護驗收的合成草稿");
    await page.getByRole("link", { name: "收藏庫" }).click();
    const leaveDialog = await leaveDialogPromise;
    expect(leaveDialog.message()).toContain("未儲存");
    await leaveDialog.dismiss();
    await expect(page).toHaveURL(gameUrl);
    await expect(noteEditor).toHaveValue("只供離頁保護驗收的合成草稿");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await assertExecutionSha(page);

    const stalePage = await context.newPage();
    const assertStaleActionSha = watchOwnerActionResponses(stalePage);
    await stalePage.goto(gameUrl);
    const staleEditor = stalePage.getByRole("textbox", { name: "編輯筆記" }).first();
    await noteEditor.fill("合成 canary 筆記由第一個分頁更新");
    await expect(noteEditor.locator("xpath=ancestor::article").getByText("已儲存", { exact: true })).toBeVisible();
    await assertOwnerActionSha();
    await assertExecutionSha(page);
    await staleEditor.fill("合成 canary 過期版本草稿");
    await expect(stalePage.getByText("版本衝突", { exact: true })).toBeVisible();
    await expect(staleEditor).toHaveValue("合成 canary 過期版本草稿");
    await assertStaleActionSha();
    await assertExecutionSha(stalePage);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "編輯筆記" }).first()).toHaveValue("合成 canary 筆記由第一個分頁更新");

    const fixedCommandId = "773b623a-6f23-4a08-baf0-c269207cf078";
    await page.evaluate((commandId) => {
      const original = window.crypto.randomUUID.bind(window.crypto);
      Object.defineProperty(window, "__productionCanaryOriginalRandomUUID", { configurable: true, value: original });
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: () => commandId });
    }, fixedCommandId);
    await page.getByRole("button", { name: "新增筆記" }).click();
    const idempotencyEditor = page.getByRole("textbox", { name: "新增筆記內容" }).first();
    await idempotencyEditor.fill("合成 canary 固定命令原始內容");
    await expect(page.getByText("已儲存", { exact: true }).last()).toBeVisible();
    await assertOwnerActionSha();
    await assertExecutionSha(page);
    await page.evaluate(() => {
      const original = (window as Window & { __productionCanaryOriginalRandomUUID?: Crypto["randomUUID"] }).__productionCanaryOriginalRandomUUID;
      if (!original) throw new Error("original UUID source is missing");
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: original });
      delete (window as Window & { __productionCanaryOriginalRandomUUID?: Crypto["randomUUID"] }).__productionCanaryOriginalRandomUUID;
    });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "編輯筆記" }).last()).toHaveValue("合成 canary 固定命令原始內容");

    await page.goto(`${baseURL}/lists/new`);
    await page.getByRole("textbox", { name: "清單名稱" }).fill("正式 canary 合成清單");
    await page.getByRole("button", { name: boardGameName }).click();
    await expect(page).toHaveURL(/\/lists\/[0-9a-f-]+$/);
    const createdListUrl = page.url();
    await expect(page.getByRole("heading", { name: "正式 canary 合成清單" })).toBeVisible();
    await assertOwnerActionSha();
    await assertExecutionSha(page);

    await page.goto(gameUrl);
    await page.getByLabel("收藏庫遊戲").selectOption(videoGameId);
    await page.getByRole("button", { name: "新增關聯" }).click();
    await expect(page.getByText(videoGameName, { exact: true })).toBeVisible();
    await assertOwnerActionSha();
    await assertExecutionSha(page);
    await page.goto(`${baseURL}/games/${videoGameId}`);
    await expect(page.getByText(boardGameName, { exact: true })).toBeVisible();

    await page.goto(gameUrl);
    await page.getByRole("button", { name: "移入資源回收區" }).click();
    await page.getByRole("button", { name: "確認移入" }).click();
    await expect(page).toHaveURL(new RegExp(`/trash\\?focus=${boardGameId}$`));
    await expect(page.getByText(boardGameName, { exact: true })).toBeVisible();
    await assertOwnerActionSha();
    await page.goto(`${baseURL}/lists/new`);
    await expect(page.getByRole("button", { name: boardGameName })).toHaveCount(0);
    await page.goto(`${baseURL}/trash?focus=${boardGameId}`);
    await page.getByRole("button", { name: "還原" }).first().click();
    await expect(page).toHaveURL(gameUrl);
    await expect(page.getByRole("textbox", { name: "編輯筆記" }).first()).toHaveValue("合成 canary 筆記由第一個分頁更新");
    await expect(page.getByText(videoGameName, { exact: true })).toBeVisible();
    await assertOwnerActionSha();
    await assertExecutionSha(page);

    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await page.goto(createdListUrl);
    await expect(page.getByRole("heading", { name: "正式 canary 合成清單" })).toBeVisible();
    await expect(page.getByText(boardGameName, { exact: true })).toBeVisible();
    await page.goto(gameUrl);
    await page.evaluate((commandId) => {
      const original = window.crypto.randomUUID.bind(window.crypto);
      Object.defineProperty(window, "__productionCanaryConflictOriginalRandomUUID", { configurable: true, value: original });
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: () => commandId });
    }, fixedCommandId);
    const createdEditor = page.getByRole("textbox", { name: "編輯筆記" }).last();
    await createdEditor.fill("合成 canary 同命令不同內容");
    await expect(page.getByText("這次操作的識別碼已用於不同內容，請重新操作。", { exact: true })).toBeVisible();
    await expect(createdEditor).toHaveValue("合成 canary 同命令不同內容");
    await assertOwnerActionSha();
    await assertExecutionSha(page);
    await page.evaluate(() => {
      const original = (window as Window & { __productionCanaryConflictOriginalRandomUUID?: Crypto["randomUUID"] }).__productionCanaryConflictOriginalRandomUUID;
      if (!original) throw new Error("conflict UUID source is missing");
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: original });
      delete (window as Window & { __productionCanaryConflictOriginalRandomUUID?: Crypto["randomUUID"] }).__productionCanaryConflictOriginalRandomUUID;
    });
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  } finally {
    await context.close();
  }
});
