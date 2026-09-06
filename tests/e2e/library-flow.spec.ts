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
  const sourceCategoryFilters = page.getByRole("group", { name: "來源分類" });
  await expect(sourceCategoryFilters.getByText("合作", { exact: true })).toBeVisible();
  await expect(sourceCategoryFilters.getByText("策略", { exact: true })).toBeVisible();
  await sourceCategoryFilters.getByLabel("合作", { exact: true }).check();
  await sourceCategoryFilters.getByLabel("策略", { exact: true }).check();
  await page.getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "篩選驗收合作" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收策略" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "篩選驗收另一機制" })).toBeVisible();
  await sourceCategoryFilters.getByLabel("共用機制", { exact: true }).check();
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

test("#41 owner searches and combines actual-platform and free-tag filters on mobile", async ({ page }, testInfo) => {
  const fixtures = [
    { name: "#41 Switch 劇情驗收", medium: "video_game", platform: "Nintendo Switch", tags: "#41 共用, #41 劇情向" },
    { name: "#41 Steam 動作驗收", medium: "video_game", platform: "Steam", tags: "#41 共用, #41 動作" },
    { name: "#41 派對桌遊驗收", medium: "board_game", platform: null, tags: "#41 派對" },
  ] as const;
  for (const fixture of fixtures) {
    await page.goto("/games/new");
    await page.getByText("找不到？建立手動條目").click();
    await page.getByRole("textbox", { name: "遊戲名稱" }).fill(fixture.name);
    await page.getByRole("combobox").last().selectOption(fixture.medium);
    await page.getByRole("button", { name: "建立手動條目" }).click();
    await page.getByRole("link", { name: fixture.name }).last().click();
    await page.getByText("編輯擁有者資料").click();
    if (fixture.platform) await page.locator(`input[name="actualPlatforms"][value="${fixture.platform}"]`).check();
    await page.getByLabel("自由標籤（以逗號分隔）").fill(fixture.tags);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "儲存資料" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: fixture.name })).toBeVisible();
  }

  await page.goto("/?platform=steam&tag=%2341%20%E5%85%B1%E7%94%A8");
  await expect(page.getByRole("search").getByLabel("Steam")).toBeChecked();
  await expect(page.getByRole("search").getByLabel("#41 共用")).toBeChecked();
  await page.getByRole("search").getByRole("button", { name: "套用篩選" }).click();
  expect(new URL(page.url()).searchParams.get("platform")).toBe("Steam");
  expect(new URL(page.url()).searchParams.get("tag")).toBe("#41 共用");
  await page.goto("/");
  const filters = page.getByRole("search");
  await filters.getByLabel("Nintendo Switch").check();
  await filters.getByLabel("Steam").check();
  await filters.getByLabel("#41 共用").check();
  await filters.getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "#41 Switch 劇情驗收" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#41 Steam 動作驗收" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#41 派對桌遊驗收" })).toHaveCount(0);

  await page.getByRole("search").getByLabel("#41 共用").uncheck();
  await page.getByRole("search").getByLabel("#41 動作").check();
  await page.getByRole("search").getByRole("button", { name: "套用篩選" }).click();
  await expect(page.getByRole("heading", { name: "#41 Switch 劇情驗收" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "#41 Steam 動作驗收" })).toBeVisible();

  await page.getByRole("search").getByLabel("#41 動作").uncheck();
  await page.getByRole("search").getByLabel("搜尋收藏庫").fill("switch 劇情");
  await expect(page.getByRole("heading", { name: "#41 Switch 劇情驗收" })).toBeVisible();
  await expect(page).toHaveURL(/search=switch\+%E5%8A%87%E6%83%85/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("library-owner-filters-390.png"), fullPage: true });

  await page.getByRole("link", { name: "清除全部條件" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "#41 派對桌遊驗收" })).toBeVisible();
  await expect(page.getByRole("search").getByLabel("搜尋收藏庫")).toHaveValue("");
  await expect(page.getByRole("search").locator('input[type="checkbox"]:checked')).toHaveCount(0);

  let releaseFirstSearch!: () => void;
  let markFirstSearchRequested!: () => void;
  const firstSearchRequested = new Promise<void>((resolve) => { markFirstSearchRequested = resolve; });
  const firstSearchCanFinish = new Promise<void>((resolve) => { releaseFirstSearch = resolve; });
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get("search") === "#41 Steam" && route.request().headers().rsc === "1") {
      markFirstSearchRequested();
      await firstSearchCanFinish;
    }
    await route.continue();
  });
  await page.getByRole("search").getByLabel("搜尋收藏庫").fill("#41 Steam");
  await firstSearchRequested;
  await page.getByRole("search").getByLabel("搜尋收藏庫").fill("#41 Switch");
  releaseFirstSearch();
  await expect(page).toHaveURL(/search=%2341\+Switch/);
  await expect(page.getByRole("search").getByLabel("搜尋收藏庫")).toHaveValue("#41 Switch");
  await expect(page.getByRole("heading", { name: "#41 Switch 劇情驗收" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#41 Steam 動作驗收" })).toHaveCount(0);
  await page.unroute("**/*");

  await page.getByRole("link", { name: "清除全部條件" }).click();
  await page.getByRole("search").getByLabel("搜尋收藏庫").fill("#41");
  await page.getByRole("search").getByLabel("Steam").check();
  await expect(page).toHaveURL(/search=%2341/);
  expect(new URL(page.url()).searchParams.get("platform")).toBe("Steam");
  await expect(page.getByRole("heading", { name: "#41 Steam 動作驗收" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#41 Switch 劇情驗收" })).toHaveCount(0);

  await page.getByRole("link", { name: "清除全部條件" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.getByRole("search").getByLabel("搜尋收藏庫")).toHaveValue("#41");
  await expect(page.getByRole("search").getByLabel("Steam")).toBeChecked();
  await expect(page.getByRole("heading", { name: "#41 Steam 動作驗收" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("search").getByLabel("搜尋收藏庫")).toHaveValue("");
  await expect(page.getByRole("search").locator('input[type="checkbox"]:checked')).toHaveCount(0);

  await page.getByRole("search").getByLabel("Steam").check();
  await page.getByRole("search").getByRole("button", { name: "套用篩選" }).click();
  await page.getByRole("search").getByLabel("搜尋收藏庫").fill("不應完成的搜尋");
  await page.getByRole("link", { name: "清除全部條件" }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "#41 派對桌遊驗收" })).toBeVisible();
  await expect(page.getByRole("search").getByLabel("搜尋收藏庫")).toHaveValue("");
  await expect(page.getByRole("search").locator('input[type="checkbox"]:checked')).toHaveCount(0);
});

test("#59 owner opens a contributor-scoped local library and combines another filter on mobile", async ({ page }, testInfo) => {
  const contributorName = "#59 同名導航作者";
  const firstGame = "#59 貢獻者遊戲一";
  const secondGame = "#59 貢獻者遊戲二";

  async function createGameWithContributor(name: string, allowSameName: boolean) {
    await page.goto("/games/new");
    await page.getByText("找不到？建立手動條目").click();
    await page.getByRole("textbox", { name: "遊戲名稱" }).fill(name);
    await page.getByRole("button", { name: "建立手動條目" }).click();
    await page.getByRole("link", { name }).last().click();
    await page.getByText("編輯擁有者資料").click();
    await page.getByLabel("自由標籤（以逗號分隔）").fill("#59 組合條件");
    await page.getByRole("button", { name: "儲存資料" }).click();
    await page.getByText("貢獻關係").click();
    const form = page.getByRole("heading", { name: "手動貢獻" }).locator("..");
    await form.getByPlaceholder("人物或組織名稱").fill(contributorName);
    if (allowSameName) {
      await form.getByRole("button", { name: "新增手動貢獻" }).click();
      await expect(page.getByRole("button", { name: "仍建立新的同名貢獻者" })).toBeVisible();
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "仍建立新的同名貢獻者" }).click()]);
    } else {
      await Promise.all([page.waitForEvent("load"), form.getByRole("button", { name: "新增手動貢獻" }).click()]);
    }
    await page.getByText("貢獻關係").click();
    await expect(page.getByRole("link", { name: `查看 ${contributorName} 的收藏庫遊戲` })).toBeVisible();
  }

  await createGameWithContributor(firstGame, false);
  await createGameWithContributor(secondGame, true);
  await page.goto("/");
  await page.getByRole("link", { name: firstGame }).click();
  await page.getByText("貢獻關係").click();
  await page.getByRole("link", { name: `查看 ${contributorName} 的收藏庫遊戲` }).click();

  await expect(page).toHaveURL(/\?contributor-design=/);
  const contributorId = new URL(page.url()).searchParams.get("contributor-design");
  expect(contributorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(page.url()).not.toContain(encodeURIComponent(contributorName));
  await expect(page.getByText("已依貢獻者篩選收藏庫；可繼續組合其他條件。")).toBeVisible();
  await expect(page.getByRole("heading", { name: firstGame })).toBeVisible();
  await expect(page.getByRole("heading", { name: secondGame })).toHaveCount(0);
  const contributorFilters = page.getByRole("search").locator(`input[name="contributor-design"][aria-label^="${contributorName}（手動／人物／設計／開發"]`);
  await expect(contributorFilters).toHaveCount(2);
  const labels = await contributorFilters.evaluateAll((inputs) => inputs.map((input) => input.getAttribute("aria-label")));
  expect(new Set(labels).size).toBe(2);
  const contributorIds = await contributorFilters.evaluateAll((inputs) => inputs.map((input) => input.getAttribute("value")));
  const selectedContributor = page.getByRole("search").locator(`input[name="contributor-design"][value="${contributorId}"]`);
  const otherContributorId = contributorIds.find((value) => value !== contributorId) ?? null;
  expect(otherContributorId).toMatch(/^[0-9a-f-]{36}$/);
  const otherContributor = page.getByRole("search").locator(`input[name="contributor-design"][value="${otherContributorId}"]`);
  await expect(selectedContributor.locator("..")).toContainText(contributorId?.slice(0, 8) ?? "missing");
  await selectedContributor.uncheck();
  await otherContributor.check();
  await page.getByRole("search").getByRole("button", { name: "套用篩選" }).click();
  expect(new URL(page.url()).searchParams.get("contributor-design")).toBe(otherContributorId);
  await expect(page.getByRole("heading", { name: firstGame })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: secondGame })).toBeVisible();
  await otherContributor.uncheck();
  await selectedContributor.check();
  await page.getByRole("search").getByRole("button", { name: "套用篩選" }).click();
  await page.getByRole("search").getByLabel("#59 組合條件").check();
  await page.getByRole("search").getByRole("button", { name: "套用篩選" }).click();
  expect(new URL(page.url()).searchParams.get("contributor-design")).toBe(contributorId);
  await expect(page.getByRole("heading", { name: firstGame })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("contributor-library-filter-390.png"), fullPage: true });
});

test("#60 owner combines contributor roles with every compatible local filter on mobile", async ({ page }, testInfo) => {
  const designerA = "#60 設計者甲";
  const designerB = "#60 設計者乙";
  const artist = "#60 美術者";
  const publisher = "#60 發行者";
  const fixtures = [
    { name: "#60 組合一", designer: designerA, withArtist: true, withPublisher: true },
    { name: "#60 組合二", designer: designerB, withArtist: true, withPublisher: true },
    { name: "#60 僅設計", designer: designerA, withArtist: false, withPublisher: false },
  ] as const;

  async function addContributor(name: string, role: "design" | "art" | "publisher", reuseExisting: boolean) {
    await page.getByText("貢獻關係").click();
    const form = page.getByRole("heading", { name: "手動貢獻" }).locator("..");
    await form.getByPlaceholder("人物或組織名稱").fill(name);
    await form.locator('select[name="role"]').selectOption(role);
    const add = form.getByRole("button", { name: "新增手動貢獻" });
    if (!reuseExisting) {
      await Promise.all([page.waitForEvent("load"), add.click()]);
      return;
    }
    await add.click();
    const reuse = page.getByRole("button", { name: "重用此貢獻者" });
    await expect(reuse).toBeVisible();
    await Promise.all([page.waitForEvent("load"), reuse.click()]);
  }

  for (const fixture of fixtures) {
    await page.goto("/games/new");
    await page.getByText("找不到？建立手動條目").click();
    await page.getByRole("textbox", { name: "遊戲名稱" }).fill(fixture.name);
    await page.locator('select[name="medium"]').selectOption("video_game");
    await page.getByRole("button", { name: "建立手動條目" }).click();
    await page.getByRole("link", { name: fixture.name }).last().click();
    await page.getByText("編輯擁有者資料").click();
    await page.locator('input[name="actualPlatforms"][value="Steam"]').check();
    await page.getByLabel("自由標籤（以逗號分隔）").fill("#60 組合標籤");
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "儲存資料" }).click()]);
    await addContributor(fixture.designer, "design", fixture.designer === designerA && fixture.name !== "#60 組合一");
    if (fixture.withArtist) await addContributor(artist, "art", fixture.name !== "#60 組合一");
    if (fixture.withPublisher) await addContributor(publisher, "publisher", fixture.name !== "#60 組合一");
  }

  await page.goto("/");
  const filters = page.getByRole("search");
  await filters.getByLabel(`${designerA}（手動／人物／設計／開發）`).check();
  await filters.getByLabel(`${designerB}（手動／人物／設計／開發）`).check();
  await filters.getByLabel(`${artist}（手動／人物／美術）`).check();
  await filters.getByLabel(`${publisher}（手動／人物／發行）`).check();
  await filters.getByLabel("電子遊戲").check();
  await filters.getByLabel("Steam").check();
  await filters.getByLabel("#60 組合標籤").check();
  await filters.getByLabel("搜尋收藏庫").fill("#60 組合");
  await filters.getByRole("button", { name: "套用篩選" }).click();

  const url = new URL(page.url());
  expect(url.searchParams.getAll("contributor-design")).toHaveLength(2);
  expect(url.searchParams.getAll("contributor-art")).toHaveLength(1);
  expect(url.searchParams.getAll("contributor-publisher")).toHaveLength(1);
  expect(url.searchParams.get("medium")).toBe("video_game");
  expect(url.searchParams.get("platform")).toBe("Steam");
  expect(url.searchParams.get("tag")).toBe("#60 組合標籤");
  await expect(page.getByRole("heading", { name: "#60 組合一" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#60 組合二" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#60 僅設計" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("contributor-role-filters-390.png"), fullPage: true });

  await page.getByRole("link", { name: "清除全部條件" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(filters.getByLabel(`${designerA}（手動／人物／設計／開發）`)).toBeChecked();
  await expect(filters.getByLabel(`${designerB}（手動／人物／設計／開發）`)).toBeChecked();
  await expect(filters.getByLabel(`${artist}（手動／人物／美術）`)).toBeChecked();
  await expect(filters.getByLabel(`${publisher}（手動／人物／發行）`)).toBeChecked();
  await page.goForward();
  await expect(page.getByRole("search").locator('input[type="checkbox"]:checked')).toHaveCount(0);
});
