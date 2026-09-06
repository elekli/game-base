# 部署環境與負向驗證

## 目前啟用的環境綁定

| 環境 | Web 保護 | Supabase | PostgreSQL 入口 |
|---|---|---|---|
| local | 應用程式 JWT 驗證；無 bypass | 本機 CLI stack | 本機 Supavisor transaction pooler 54329 |
| production | Cloudflare Access＋應用程式 JWT 驗證 | 正式專案 | 正式 Supavisor transaction pooler 6543 |

每個環境各自設定 `.env.example` 列出的 variables。`EXPECTED_*` 與兩個 SHA-256 fingerprint 是部署綁定，不是動態猜測；`OWNER_EMAIL` 與 `OWNER_SUB` 必須取自該擁有者的 Cloudflare Access JWT。`pnpm environment:check` 會在任一欄位混用時以命名錯誤停止。`DIRECT_DATABASE_URL` 只供 migration／introspection，不得放入 Vercel runtime。

Hosted 環境另由 repository 內的 `src/shared/config/deployment-bindings.ts` 固定 project ref、Supavisor host／username 與 key fingerprint，避免整套 variables 被複製後仍能自洽。production binding 已依 Supabase Management API／CLI 與 Vercel Production variables 核對為真實 project ref、hostname、pooler host、runtime username 及 key fingerprint；preview binding 只保留不可連線的測試 fixture。兩邊不一致時應停止部署，不得改成動態接受。

目前 Supabase Free 方案的兩個 active project 名額都已使用，沒有隔離的第三個 Hosted Preview data plane。Vercel Preview 與 Development scope 必須保持沒有 production credentials；CI 的 preview binding 僅是 repository-owned fixture，搭配本機 Supabase，不代表 Hosted Preview。取得真正隔離的 Supabase project 或 Branching 前，不得恢復 Git Preview deployment。

Vercel 的 Build Command 維持 `pnpm build`；部署後 Node.js instrumentation 與每個 private route 都會再次驗證環境。CI 另直接測 `parseRuntimeConfig()` 的合法組合與跨環境混用。production 發布契約與停發條件見 [Production 發布操作手冊](production-release.md)。

## CI fixture 驗收

1. CI 只從 `scripts/export-preview-environment.ts` 載入假 binding，且只連 workflow 內啟動的本機 Supabase。
2. fixture 不得含 production project ref、credential、連線字串或可用的 Hosted endpoint。
3. 未帶合法 Cloudflare JWT 呼叫 private route，應在 DB／Storage adapter 前回 401、`private, no-store`。
4. 以 390 × 844 驗證 `/security-error`；只應看到通用繁中訊息與 request ID。

## Production 驗收

1. 自訂網域位於 Cloudflare Access application 後；Access audience、team issuer 與 owner email 必須和 production variables 完全一致。
2. 合法 owner JWT 才能到 private route；錯 claim、service token、JWK outage 都應回 401。
3. 從自動產生的 `.vercel.app`／origin URL 直接請求，不會有 Cloudflare JWT，應在資料 adapter 前失敗。
4. 將任一 preview project ref、Supavisor host／username、URL 或 key 混入 production，`environment:check`／啟動驗證必須失敗。

真實 preview／production 的 platform protection、Cloudflare claim 與 Supavisor credential 必須在對應帳號中實測；本機 fixture 不能替代這三項外部證據。
