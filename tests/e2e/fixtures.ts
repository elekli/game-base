import { test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

export const test = base;

export async function authenticatePage(page: Page) {
  const response = await page.request.get("http://127.0.0.1:8787/token");
  if (!response.ok()) throw new Error(`E2E auth server returned ${response.status()}.`);
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("E2E auth server returned no token.");
  await page.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": body.token });
}
