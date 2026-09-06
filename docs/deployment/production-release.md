# Production 發布操作手冊

## 契約與現況

```text
feature branch → PR → required CI／verify → main
                                             │
                                             ▼
                               protected Production environment
                                             │
                         T02A／T02B／T03 完成前停止於唯讀 release gate
                                             │
                         指定同一 commit 的 Vercel CLI deployment
```

- `main` 只接受 PR 合併；`verify` 是 required check，管理員不得略過 branch protection。
- Vercel project `game-base` 不接受 Git 自動 deployment。`vercel.json` 也將 `git.deploymentEnabled` 固定為 `false`，避免重新連接 Git 後靜默恢復。
- `.github/workflows/production-release.yml` 是 repository 支援的唯一 production 發布入口。它要求完整 commit SHA、確認該 commit 屬於 `main`，且 `.github/workflows/ci.yml` 對同一 SHA 的 `main` push run 成功，並進入受保護的 `Production` Environment。
- Production job 必須先 checkout trusted `main` workflow 版本，再驗證指定 SHA 存在、屬於 `origin/main` 且 exact CI run 成功；只有全部成立後才可 `git checkout --detach` 該 SHA，之後才能執行其 `package.json`／repository scripts。不可把 candidate checkout 提前，否則未合併 commit 會在未來具 secrets 的 Production Environment 取得不必要執行面。
- GitHub `Production` Environment 使用 custom deployment branch policy，server-side allowlist 唯一項目是 `main`；job 的 `github.ref == 'refs/heads/main'` 只是縱深防禦，不能取代 Environment policy。這確保未來即使新增其他 protected branch，其修改過的 workflow 也不能進入 Production Environment。
- T02A、T02B、T03 尚未完成，因此 workflow 現在只做唯讀 gate 後明確停止，不呼叫 Vercel deploy、不套 migration。不得以手動 Dashboard deployment 繞過這個停發狀態。
- Production credentials 只可存在 GitHub `Production` Environment secrets 或 Vercel Production scope。Vercel Preview／Development、repository variables、workflow log 與 artifact 都不得包含這些值。

Vercel Hobby project 的 owner 仍可直接從 Dashboard 或本機 CLI 建立 production deployment；repository 無法在 Vercel 帳號層絕對撤銷這項 owner 能力。這是殘餘風險，不是第二條支援路徑：owner 不得手動部署，操作證據以 Vercel activity log 稽核。若未來 Vercel 提供適用方案的細緻 deployment policy，應把這項人工禁令改為平台強制。

Repository 內可公開核對的 binding 是 `.github/production-release-contract.json` 與 `src/shared/config/deployment-bindings.ts`：repository、branch、CI workflow／check、GitHub Environment、Vercel project ID／name、Supabase project ref／region／hostname、Supavisor host／username，以及 Hosted Preview 與 Git deployment 均為停用。publishable／secret key 只保存 SHA-256 fingerprint，不保存原值。

T01 只要求 Vercel Production scope 已有 `SUPABASE_PUBLISHABLE_KEY`（encrypted）與 `SUPABASE_SECRET_KEY`（sensitive），並以 `EXPECTED_SUPABASE_*_SHA256` 綁定 fingerprint。Vercel API 可安全讀回 publishable key並核對 fingerprint，但 sensitive secret 不允許解密讀回；T01 已用 Supabase CLI 當前 secret 覆寫該 Vercel variable，之後由 runtime `environment:check` 比對實值與 fingerprint。GitHub `Production` Environment 的 migration database URL、Vercel token 等 secrets 屬 T02A／T02B／T03，現在刻意不假裝已配置。

## 每次發布前

1. `gh api repos/elekli/game-base/branches/main/protection`：確認 required check 為 `verify`、PR required、`enforce_admins.enabled` 為 `true`。
2. `gh api repos/elekli/game-base/environments/Production`：確認 required reviewer、禁止管理員 bypass，以及只允許 protected branch。
3. `vercel project inspect game-base` 與 Vercel project API：確認 project ID 符合契約、Git integration 未連接；再執行 `pnpm release:settings:check` 核對 Production-only key scope、type 與可安全核對的 fingerprint。
4. 只列 Vercel environment variable 的 key、target 與 type；若任何 credential target 包含 Preview 或 Development，立即停止發布並移除錯誤 scope。禁止要求 API 回傳解密值。
5. 執行 `pnpm release:contract:check`。T02A 完成後再接 production preflight；在此之前任何 production release 都必須停止。

證據只能記錄 commit SHA、check 名稱／結論、environment 名稱、project ID、非秘密 variable key／scope、配額百分比、時間與具名結果。禁止記錄 JWT、key、token、database URL、密碼、私有 payload 或 production dump。

## Supabase Free 方案容量與暫停

2026-09-06 依 Supabase 官方文件核對：Free 方案最多兩個 active projects；每個 project 的 Database Size 為 500 MB，Storage Size 為 1 GB。低活動達七日的 Free project 可能被暫停；Pro 才保證不因閒置暫停。Free project 也沒有可下載的資料庫備份。應在每次 production smoke／媒體操作前後由 Dashboard Usage 頁記錄 database 與 storage 使用量，不用 production SQL 掃描私有資料。

本專案採以下操作門檻，以先到者為準：

| 狀態 | Database（500 MB） | Storage（1 GB） | 動作 |
|---|---:|---:|---|
| 正常 | < 70% | < 70% | 記錄用量後可繼續。 |
| 警告 | ≥ 70% | ≥ 70% | 暫停非必要媒體匯入；確認可清理的衍生物與匯出空間，建立升級決策。 |
| 停止發布 | ≥ 85% | ≥ 85% | 不部署會增加資料／Storage 寫入的版本；先升級 Pro 或以已驗證、非破壞性的方式降回 70% 以下。 |
| 平台停止 | project paused／unhealthy、quota exceeded，或無法取得用量 | 任一 | 所有發布停止；先在 Dashboard 恢復並確認 healthy，再重跑完整 preflight。 |

單檔上傳仍受 private bucket 的 50 MB 設定與應用程式驗證限制。接近容量時不可永久刪除擁有者內容；MVP 沒有已驗證的 Production restore 前，只能清理可重建衍生物或升級方案。

## 警告、停發與升級處置

1. 收到 inactivity／quota 電郵、Dashboard 警告或 project health 異常時，先將 production release 視為停止，不以一次成功 HTTP request 覆蓋平台訊號。
2. 記錄非秘密證據：project ref、health、Database／Storage 百分比、量測時間與來源頁面。
3. paused project 只從 Supabase Dashboard 恢復；恢復後確認 `ACTIVE_HEALTHY`，再執行 T02A 定義的唯讀 preflight。不得以 reset、重建 project 或 Preview credentials 測試 Production。
4. 達停止發布門檻、預期下一次發布會越過門檻，或七日暫停不可接受時，升級 project 所在 organization 至 Pro。Supabase 方案以 organization 計費，升級前確認同 organization 內所有 projects 的成本影響。
5. 無法安全降載且尚未核准升級時，維持舊 deployment，不發布；把阻擋原因與下一個人工決策寫入 issue。

官方依據：[Supabase Billing FAQ](https://supabase.com/docs/guides/platform/billing-on-supabase)、[Going into Prod](https://supabase.com/docs/guides/platform/going-into-prod)、[Storage Size usage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size)。
