# 安全檢查表

## 每個 private 入口

- [ ] 在任何 DB／Storage 呼叫前執行 `requireOwner()`。
- [ ] 只接受 `Cf-Access-Jwt-Assertion` 的 RS256 token，驗 `kid`、簽章、`iss`、`aud`、`type`、`iat`／`exp`、owner email 與固定 `sub`。
- [ ] 未知 `kid`、JWK outage、service token 與 claim 不符一律 fail closed；不得加入 local／preview bypass。
- [ ] 成功與失敗回應皆為 `Cache-Control: private, no-store`。
- [ ] 使用者只看見通用繁中訊息與 UUID request ID；JWT、email、header、policy、secret 與技術例外不得進回應。
- [ ] log 只用 `serializeLogEvent()` 的 allowlist；不得序列化任意 `Error`、request 或第三方 response。
- [ ] Server Action／Route Handler 的輸入另以 Zod 驗證；TypeScript 型別不算 runtime validation。

## 資料與部署

- [ ] `pnpm environment:check` 對當前部署綁定全數通過；project ref、Supavisor host／port／username、database URL 與 key fingerprint 不可跨環境混用。
- [ ] PostgreSQL runtime 經 Supavisor transaction mode，`postgres.js` 使用 `prepare: false`；migration 使用 direct connection。
- [ ] 新產品 table 位於 `app_private`、由 `app_migrator` 建立、啟用 RLS，並以 pgTAP 證明無 policy 時拒絕 runtime 寫入。
- [ ] `anon`、`authenticated`、`service_role` 無 `app_private` schema usage；Data API 不暴露產品 schema。
- [ ] Storage bucket 必須 private；瀏覽器只取得短效 signed URL／upload token，永不取得 Supabase secret key。
- [ ] preview 只連固定測試 Supabase 專案；production 只連正式專案。兩者的 Vercel variables 分開設定。
- [ ] preview 啟用 Vercel Deployment Protection；production 自訂網域啟用 Cloudflare Access。
- [ ] 直接 `.vercel.app`／origin 呼叫 private route 在任何資料操作前回 401。
