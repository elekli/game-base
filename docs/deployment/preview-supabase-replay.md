# Hosted Preview Supabase 重播

本流程是 repository 端的固定 Preview 資料平面驗收入口。它只允許在 `main` 手動執行，使用 GitHub 的 `preview` Environment，並且只接受 repository-owned Preview binding 對應的 direct PostgreSQL 連線。Production 專案、Production direct URL 與正式資料不在這條路徑內。

```text
main + GitHub preview Environment
              │  非秘密 project ref ＋受保護 direct URL
              ▼
     preflight：binding 互斥／URL／確認字串／migration／SHA／path
              │  任一失敗 → 不執行 Supabase 命令、不產生成功 evidence
              ▼
  reset --no-seed → migration list → direct history → pgTAP security tests
              │  全部成功
              ▼
  allowlist JSON evidence（project ref、版本、結果、commit SHA、時間）
```

## repository 端已完成的邊界

- `supabase/migrations/` 是唯一 schema migration 真本。Replay 只會重播這個目錄中全部、去重且排序後的版本；`supabase db reset --no-seed` 明確停用 seed。
- `scripts/preview-replay.ts` 在任何 Supabase CLI 命令前驗證 Preview binding、Preview／Production 互斥、確認字串、commit SHA、evidence 路徑與 direct URL。URL 必須是 `postgres://` 或 `postgresql://`、使用者 `postgres`、有密碼、host 精確為 `db.<preview-ref>.supabase.co`、port `5432`、database `postgres`、且查詢字串精確為 `?sslmode=require`；pooler、Production URL 與其他變體都拒絕。
- reset、migration history 與 pgTAP 任一步失敗，都以具名錯誤停止；pgTAP 未成功不會寫入成功 evidence。重播開始時會清除舊 evidence，避免舊成功記錄誤導驗收。
- evidence 只包含固定 allowlist 欄位，綁定 `PREVIEW_REPLAY_COMMIT_SHA`／`GITHUB_SHA`，不包含 URL、密碼、token、資料內容或 CLI output。路徑 containment 使用 `path.relative` 判定。
- hosted runtime 拒絕 `DIRECT_DATABASE_URL`、`PREVIEW_DIRECT_DATABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD`、`SUPABASE_SERVICE_ROLE_KEY` 與 `PGPASSWORD`；`SUPABASE_SECRET_KEY` 仍可供 server-side 私有 Storage 使用。

## 首次啟用順序

`workflow_dispatch` 只有在 workflow 檔案已存在於 GitHub default branch 時才能觸發，因此第一次 Hosted replay 必須分成兩個明確階段；不能把第一次成功執行列為引入這個 workflow 的 PR 合併前條件。

```text
階段 A：PR 內驗證 workflow contract、preflight、測試與非秘密 binding
              │
              └──► 合併到 main（此時才建立可手動觸發的 workflow）
                            │
                            ▼
階段 B：從 main 輸入 RESET_PREVIEW_ONLY，執行真實 Hosted replay
              │
              └──► 保存 commit-bound artifact，才關閉 Hosted replay 驗收
```

- 合併前：CI 必須證明非 `main` ref 會拒絕、確認字串精確比對、Preview／Production binding 互斥、direct URL 目標受限、失敗不產生成功 evidence；review 另核對 repository 只含非秘密識別與指紋。
- 合併後：只從 `main` 手動執行真實 replay。成功 artifact 必須綁定實際 merge 後 commit；在此之前只能宣稱「replay 機制已進 `main`」，不能宣稱 Hosted schema 已重播或 #48 已完成。
- 後續修改：workflow 已存在於 `main` 後，可以用 `--ref` 選擇含修改的分支做非破壞性 contract 驗證；任何會執行 reset 的路徑仍只接受 `refs/heads/main`。

## 外部 provisioning（本票不執行）

實際 Hosted Preview project／ref 是外部前置條件，不得以 `preview-ref` fixture 冒充。主 session 或維運者必須在受保護平台完成下列設定，並以非秘密識別值更新 repository binding；本票不建立或修改 Hosted Supabase、GitHub、Vercel 資源。

Production Supabase project 的 Vercel integration 必須維持只注入 Production。不得在該 integration 開啟 Preview 或 Development credential sync：Supabase Branching 是每個 Git branch 對應一個獨立、預設短命的 Preview branch，且官方文件明載 PR 建立、branch provisioning、Vercel 變數同步與部署之間存在競速；在正確 branch credentials 尚未就緒時同步 Production credentials，會破壞本專案「Preview 永不取得 Production secret 或資料庫密碼」的不變式。

本專案不採每個 PR 一個 Supabase Preview branch。原定方案是讓所有 Vercel Preview deployment 使用另一個固定、可重設、只含假資料的 Supabase project；其 runtime variables 由 Vercel Preview scope 明確配置，不從 Production integration 複製。若未來要改採 Supabase Branching，必須先另行修訂環境模型、repository binding、資料重設語意與部署競速處理，不能直接切換 integration scope。

### 免費方案容量閘

Supabase 免費方案最多只能同時有兩個 active project，且不含 Branching。當帳號已占滿兩個 project 時，本流程沒有安全的 Hosted Preview 目標，因此必須維持未啟用狀態：不得設定 GitHub `preview` Environment 的真實連線、不得執行 Hosted reset，也不得讓 Vercel Preview 共用 Production project、schema、Storage 或憑證。額外 schema 或不同資料庫角色無法提供獨立的 Storage 與 project-level API key 邊界，不能視為等價替代。

解除容量阻塞只能走下列其中一條路，且都需要另行明確決策：

1. 暫停、刪除或重新指派現有 project，騰出一個免費方案名額，再依下方步驟建立固定 Preview project。
2. 升級至含 Branching 的付費方案，另開架構修訂票，先解決 branch lifecycle、repository binding、reset 語意與 Vercel 部署競速，再啟用 per-PR branch。

在上述任一路徑完成前，本 PR 只能證明 repository 端的 fail-closed workflow contract；不能宣稱 Hosted Preview 已建立、schema 已重播或 #48 已完成。本機 Supabase replay 與 CI fixture 仍可繼續驗證 migration，但不能冒充 Hosted 證據。

容量閘解除後：

1. 建立只供 Preview 使用的 Supabase project，確認不放 Production 資料；取得實際 project ref。
2. 在 `src/shared/config/deployment-bindings.ts` 填入實際 Preview 的 project ref、Supabase hostname、Supavisor runtime binding 與兩個 key fingerprint；確認不與 Production binding 重疊。不要提交任何 key 原文或角色密碼。
3. 在 GitHub `preview` Environment 設定 branch restriction 為 `main`，建立非秘密 variable `PREVIEW_SUPABASE_PROJECT_REF`，以及 secret `PREVIEW_DIRECT_DATABASE_URL`。secret 必須是同一 Preview project 的 direct URL，不能是 Supavisor pooler。
4. Vercel Preview 只設定 runtime 所需的 Supavisor transaction-pooler URL、publishable key、server-side `SUPABASE_SECRET_KEY` 與 Access 設定；不得設定上述 direct／維運變數。
5. 手動執行 `Preview Supabase Replay`，保留成功 workflow artifact。只有 artifact 的實際 project ref、commit SHA、完整 migration 版本與 `passed` 結果，才能作為 Hosted replay 證據。

## 操作與失敗處理

在 GitHub Actions 選 `main` 執行 `Preview Supabase Replay`，並在 required 的 `confirmation` 欄位手動輸入精確字串 `RESET_PREVIEW_ONLY`。任何錯字、大小寫差異或多餘空白都會在任何 Supabase 命令前被既有 preflight 拒絕。工作流程是 serial，`cancel-in-progress: false`，可安全重跑；每次會先清空再重播全部 migration，不能把 Production URL 當重試替代品。若 `migration reset`、`migration list`、migration history 或 `security tests` 任一步失敗，先修正同一 Preview Environment／binding，再重跑；失敗執行不應上傳 artifact。

非 `refs/heads/main` 的手動執行會由具名 `ref-guard` step 明確失敗；replay job 不會執行，也不會產生 evidence。

本機只可使用本機或明確受控的 Preview fixture 進行純單元測試。不要把 Hosted direct URL 放入 Vercel runtime，也不要在未確認 repository binding 與目標 project ref 前執行任何 reset。
