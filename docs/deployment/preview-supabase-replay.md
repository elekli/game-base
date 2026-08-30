# Hosted Preview Supabase 重播

本文件定義固定 Preview 專案的重播入口。它只處理 Preview；Production 專案、Production direct URL 與 Production 資料不在這個流程內。

```text
GitHub Actions preview environment
        │  PREVIEW_DIRECT_DATABASE_URL（只在此步驟存在）
        ▼
受保護的 direct PostgreSQL 連線（postgres／TLS）
        │
        ├── reset：重播版本庫內全部 migration，不載入 seed
        ├── migration list：確認遠端 migration history 可讀
        └── pgTAP：確認角色、RLS 與 private Storage 邊界
        │
        ▼
不含秘密的 JSON 證據 artifact
```

## 一次性設定

1. 在 `src/shared/config/deployment-bindings.ts` 的 `preview` 綁定填入真正的 Preview project ref、Supavisor host、runtime username 與 key fingerprint。這些值是 repository-owned 的非秘密部署識別，不可改成由環境變數自行接受。
2. 在 GitHub 的 `preview` Environment 建立非秘密 variable `PREVIEW_SUPABASE_PROJECT_REF`，其值必須與 repository binding 完全相同。
3. 在同一個 GitHub Environment 建立 secret `PREVIEW_DIRECT_DATABASE_URL`。它必須是該 Preview 專案的 direct URL，格式為 `postgres://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require`。密碼只能存在 GitHub secret 或受控的本機維運環境。
4. Vercel 的 Preview variables 只放應用程式 runtime 所需設定；不要放 `DIRECT_DATABASE_URL`、`PREVIEW_DIRECT_DATABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD`、`SUPABASE_SERVICE_ROLE_KEY` 或 `PGPASSWORD`。

若尚未取得真正的 Hosted Preview project ref，版本庫內的 `preview-ref` 只是測試 fixture，不是 Hosted 驗收證據。完成一次真正重播後，將工作流程產生的 JSON artifact 保留為該次驗收記錄；不得手寫一份看似成功的記錄。

## 重播與安全閘

在 GitHub Actions 手動執行 `Preview Supabase Replay`。這個工作流程只接受 `main` ref，且 GitHub `preview` Environment 必須設定 deployment branch restriction 為 `main`，必要時啟用 required reviewer。工作流程只從 `preview` Environment 讀取 direct URL，並固定傳入 `RESET_PREVIEW_ONLY`。`pnpm preview:replay` 在執行任何 CLI 前會確認：

- project ref 等於 repository 的 Preview binding；
- direct URL 使用 `postgres`、`db.<project-ref>.supabase.co`、5432 與 `sslmode=require`；
- direct URL 不是 Supavisor pooler，也不是 Production binding；
- migration 目錄至少有一個、且每個版本名稱格式正確；
- 重設確認字串完全相符。

重播步驟是 `supabase db reset --db-url ... --no-seed --yes`、`supabase migration list --db-url ...` 及 `supabase test db --db-url ...`。CLI 的輸出不會寫入證據；失敗只回報命名錯誤。成功 JSON 只保存 environment、project ref、migration versions、重播結果、pgTAP 結果與時間，不保存 URL、密碼、token、資料內容或完整錯誤。

應用程式的 `parseRuntimeConfig()` 對 hosted 環境拒絕所有 direct database／維運憑證變數；因此重播工作流程與 Vercel runtime 是兩條不可混用的路徑。runtime 仍只經 Supavisor transaction pooler 使用 `app_runtime`。

## 重設後驗收

成功 artifact 的 `migrationVersions` 必須涵蓋當次版本庫內所有 migration，且 `migrationReplay` 與 `securityTests` 都是 `passed`。若任何一步失敗，不得把 Preview 當成可用，也不得改用 Production URL 重試；先修正 Preview Environment 或 repository binding，再重新執行同一個工作流程。
