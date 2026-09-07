import { expect } from "@playwright/test";
import { authenticatePage, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => authenticatePage(page));

test("#65 390px 相簿 fixture：附件短效下載請求與回應", async ({ page }, testInfo) => {
  const gameName = "#65 手機媒體驗收";
  const gameIdPattern = /\/games\/([^/]+)$/;
  let failedOnce = false;
  let originalReadCount = 0;
  const image = (id: string, state: "pending" | "failed" | "ready", caption: string) => ({
    asset: { id, gameId: "11111111-1111-4111-8111-111111111111", purpose: "gallery_image", originalFileName: `${caption}.png`, actualMimeType: "image/png", byteSize: 100, width: 640, height: 480, removedAt: null, createdAt: "2026-09-07T00:00:00.000Z", caption, displayName: null, description: null },
    thumbnail: { assetId: id, spec: "thumb_webp_v1", state },
    thumbnailUrl: state === "ready" ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='480'%3E%3Crect width='640' height='480' fill='%23065f46'/%3E%3C/svg%3E" : null,
    thumbnailExpiresAt: state === "ready" ? "2099-01-01T00:00:00.000Z" : null,
  });
  const items = [
    image("11111111-1111-4111-8111-111111111111", "ready", "桌遊夜"),
    image("22222222-2222-4222-8222-222222222222", "pending", "等待縮圖"),
    image("33333333-3333-4333-8333-333333333333", "failed", "失敗縮圖"),
    { asset: { id: "44444444-4444-4444-8444-444444444444", gameId: "11111111-1111-4111-8111-111111111111", purpose: "attachment", originalFileName: "rules.pdf", actualMimeType: "application/pdf", byteSize: 200, width: null, height: null, removedAt: null, createdAt: "2026-09-07T00:00:00.000Z", caption: null, displayName: "規則書", description: "中文版規則" }, thumbnail: null, thumbnailUrl: null, thumbnailExpiresAt: null },
  ];

  await page.route("**/api/private/media/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && /\/media\/games\//.test(path)) return route.fulfill({ json: { gameId: path.split("/").at(-1), manualCoverAssetId: null, sourceCover: null, items } });
    if (path.endsWith("/uploads/begin")) {
      const body = request.postDataJSON() as { originalFileName: string };
      if (body.originalFileName === "broken.png" && !failedOnce) { failedOnce = true; return route.fulfill({ status: 503, json: { message: "模擬網路中斷" } }); }
      return route.fulfill({ json: { status: "already_finalized", result: { asset: { id: crypto.randomUUID() }, thumbnail: { state: "pending" } } } });
    }
    if (path.endsWith("/original")) { originalReadCount += 1; return route.fulfill({ json: { url: "data:text/plain,fixture-download", expiresAt: "2099-01-01T00:01:00.000Z", disposition: "attachment" } }); }
    return route.fulfill({ json: {} });
  });

  await page.goto("/games/new");
  await page.getByText("找不到？建立手動條目").click();
  await page.getByRole("textbox", { name: "遊戲名稱" }).fill(gameName);
  await page.getByRole("button", { name: "建立手動條目" }).click();
  await page.getByRole("link", { name: gameName }).click();
  await expect(page).toHaveURL(gameIdPattern);
  await expect(page.getByRole("heading", { name: "照片與遊戲附件" })).toBeVisible();
  await expect(page.getByText("縮圖處理中", { exact: true })).toBeVisible();
  await expect(page.getByText("縮圖處理失敗", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重試縮圖" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "說明", exact: true })).toHaveValue("中文版規則");
  const originalRequest = page.waitForRequest((request) => request.url().includes("/assets/44444444-4444-4444-8444-444444444444/original"));
  await page.getByRole("button", { name: "短效下載" }).click();
  await originalRequest;
  await expect.poll(() => originalReadCount).toBe(1);

  const chooser = page.getByLabel(/選取多個檔案/);
  await chooser.setInputFiles([
    { name: "good.png", mimeType: "image/png", buffer: Buffer.from("good") },
    { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("broken") },
  ]);
  await expect(page.getByText("上傳失敗", { exact: true })).toBeVisible();
  await expect(page.getByText("原檔已保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /只重試 1 個失敗檔案/ }).click();
  await expect(page.getByText("原檔已保存", { exact: true })).toHaveCount(2);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("media-gallery-390.png"), fullPage: true });
});
