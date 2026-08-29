# 部署環境與負向驗證

## 三環境綁定

| 環境 | Web 保護 | Supabase | PostgreSQL 入口 |
|---|---|---|---|
| local | 應用程式 JWT 驗證；無 bypass | 本機 CLI stack | 本機 Supavisor transaction pooler 54329 |
| preview | Vercel Deployment Protection＋應用程式 JWT 驗證 | 固定測試專案／假資料 | 測試 Supavisor transaction pooler 6543 |
| production | Cloudflare Access＋應用程式 JWT 驗證 | 正式專案 | 正式 Supavisor transaction pooler 6543 |

每個環境各自設定 `.env.example` 列出的 variables。`EXPECTED_*` 與兩個 SHA-256 fingerprint 是部署綁定，不是動態猜測；`OWNER_EMAIL` 與 `OWNER_SUB` 必須取自該擁有者的 Cloudflare Access JWT。`pnpm environment:check` 會在任一欄位混用時以命名錯誤停止。`DIRECT_DATABASE_URL` 只供 migration／introspection，不得放入 Vercel runtime。

Hosted 環境另由 repository 內的 `src/shared/config/deployment-bindings.ts` 固定 project ref、Supavisor host／username 與 key fingerprint，避免整套 production variables 被複製到 preview 後仍能自洽。檔案目前是可重建的 fixture；建立真實 Supabase 專案後，必須以非 secret 識別與實際 key fingerprint 更新它，再設定 Vercel variables。兩邊不一致時應停止部署，不得改成動態接受。

Vercel 的 Build Command 維持 `pnpm build`；部署後 Node.js instrumentation 與每個 private route 都會再次驗證環境。CI 另直接測 `parseRuntimeConfig()` 的合法組合與跨環境混用。

## Preview 驗收

1. 在 Vercel project 的 Preview scope 設固定測試專案 variables，開啟 Standard Deployment Protection。
2. push feature branch，等待 Preview deployment Ready。
3. 未通過 Vercel Protection 時應在平台層被阻擋。
4. 通過平台保護後，直接呼叫 `/api/private/ping` 但不帶合法 Cloudflare JWT，應回 401、`private, no-store`，且沒有 DB／Storage side effect。
5. 以 390 × 844 查看 `/security-error`；只應看到通用繁中訊息與 request ID。

## Production 驗收

1. 自訂網域位於 Cloudflare Access application 後；Access audience、team issuer 與 owner email 必須和 production variables 完全一致。
2. 合法 owner JWT 才能到 private route；錯 claim、service token、JWK outage 都應回 401。
3. 從自動產生的 `.vercel.app`／origin URL 直接請求，不會有 Cloudflare JWT，應在資料 adapter 前失敗。
4. 將任一 preview project ref、Supavisor host／username、URL 或 key 混入 production，`environment:check`／啟動驗證必須失敗。

真實 preview／production 的 platform protection、Cloudflare claim 與 Supavisor credential 必須在對應帳號中實測；本機 fixture 不能替代這三項外部證據。
