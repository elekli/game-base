# Issue #58：Production application release 實作計畫

## 目標

把已完成的 release state machine、Vercel REST request contract、來源 manifest 與 production smoke runner 接成受保護的 GitHub workflow。流程只部署已通過 `main` CI、且 schema gate 已達精確目標的同一 commit；staged deployment 不接 production domain，只有 promote 後才執行固定 smoke。smoke 失敗且 cleanup 已證明回到 `0/0` 時，回復原 deployment；結果不明時停止並要求人工復原。

```text
main CI 成功＋schema strict／ledger
                │
                ▼
       建立精確來源 manifest
                │
       上傳 Git blob bytes
                │
       建立／重用 staged Production deployment
                │
       READY＋identity 再驗證
                │
       baseline alias 未漂移？──否──► 停止
                │是
                ▼
             promote
                │
       custom domain 指向 D1？──否──► 查明結果／有限重試
                │是
                ▼
      固定 production smoke＋cleanup
           │通過                 │失敗但回到 0/0
           ▼                     ▼
       保存證據            rollback D0＋保存證據
```

## 不變式

1. workflow 初始 checkout 必須是受信任的 `main`，候選 SHA 必須等於當下 `origin/main`，且該 SHA 的 `main` push CI 已成功。
2. migration-bearing release 必須已有對應 commit-bound ledger，且 Production strict schema 驗證通過；code-only release 仍須 strict-current-schema。
3. Vercel access token、Cloudflare service token、owner session、Supabase key／URL 與任何私有 payload 不得寫入 artifact、log、exception 或 git。
4. 來源只可來自候選 commit 的 Git tree；每個 blob 在上傳前逐 byte 核對 manifest 的 SHA-1 與 size。建立 deployment 時只引用這些已驗證 blobs。
5. staged Production deployment 必須在 Vercel 專案已關閉自動指派 custom production domains 後才能建立；repository contract 未固定此證據時，mutation adapter 必須拒絕啟動。
6. deployment identity 同時綁定 project、commit、`production:<sha>` 與 source manifest SHA-256；重試只可重用唯一精確匹配者。
7. promote 前重查 `main` 與 custom-domain alias 仍分別等於候選 SHA 與 baseline deployment。promotion／rollback 回應不作為成功證據，必須再讀 alias 驗證。
8. smoke 只能透過 Cloudflare custom domain；direct `.vercel.app` origin 必須由 Vercel Deployment Protection 拒絕。固定 canary 前後必須為 `0/0`。
9. promotion 與 rollback 各最多 2 次；任何模糊 mutation 結果先查現況，不可盲目重送。
10. database schema 永不跟隨 application rollback 回滾；不相容狀態只接受 forward-fix。
11. logical dump 對 Production 只執行 `pg_dump --data-only --schema=app_private`；Storage binary、平台 schema 與 Supabase secret-bearing tables 不進 dump。
12. restore target 固定為獨立 Supabase local project、`127.0.0.1:55432/postgres`；先重播候選 commit 的全部 migration、清掉 migration 內建 application rows，再 restore、查驗、停止並刪除私有 dump。
13. Production 的逐表筆數與雙 64-bit 內容摘要，必須和 `pg_dump --snapshot` 共用同一個 read-only exported snapshot；restore 後逐表精確比對，只在記憶體保存摘要，對外 evidence 不含資料內容。

```text
精確 main SHA＋成功 CI
          │
          ▼
Production environment 人工核准
          │
          ▼
唯讀 logical dump（app_private data only，0600）
          │
          ▼
啟動固定 5543x 隔離 Supabase local project
          │
          ▼
重播全部 migration → pg_restore --exit-on-error
          │
          ▼
核對 migration ledger／RLS／constraints／逐表筆數與內容摘要
          │
          ▼
停止 target → 刪除 dump → 僅上傳 allowlisted JSON 證據
```

## 修改範圍

- 擴充 Vercel REST transport，使其能安全執行 bounded GET、JSON POST 與 blob upload。
- 啟用 Vercel deployment adapter 的 create／reuse／READY／promote／rollback 操作，但由 repository contract 與執行設定雙重守門。
- 新增 application release runner，驅動既有純狀態機並產生符合 schema 的 sanitized evidence。
- 新增受保護的 `Production Application Release` workflow；candidate job 不讀 secrets，mutation job 才進 `Production` environment。
- 新增獨立的受保護 `Production Restore Drill` workflow；它不依賴尚未補齊的 Vercel／Cloudflare credentials，可先完成 logical restore 驗證。
- 更新 production release contract、hash pins、runbook 與 package scripts。

## 非目標

- 不恢復 Vercel Git deployment、Hosted Preview 或 Supabase Preview／Development credential sync。
- 不使用 Vercel CLI、不讓 workflow 建立或修改 Cloudflare Access application／service token。
- 不做 schema rollback、不自動處理 uncertain canary residue、不把 owner session 持久化到 repository。

## TDD 與驗證

1. Transport 單元測試先覆蓋 JSON／binary POST、timeout、非 2xx、bounded response、unsafe path，以及錯誤不得含 token／body。
2. Adapter 單元測試覆蓋 canonical create body、精確 file refs、mutation gate、reuse pagination、READY identity、promote／rollback request。
3. Runner 測試以 fake transport 驅動完整成功、create response loss、promotion ambiguity、smoke failure rollback、rollback ambiguity、main／alias drift、evidence write failure與 manual recovery。
4. Workflow contract 測試確認 secret-free candidate job、Production environment、最小 secrets／variables、精確 SHA／CI／schema gate、artifact allowlist 與 concurrency。
5. 完整執行 typecheck、unit、integration、database、pgTAP、lint、build、E2E、release contract 與 migration lint。
6. restore executor 測試覆蓋密碼不進 argv／序列化資料、既存 target 拒絕、啟動中途失敗清理、dump mode／digest、真實 target 完整性輸出與所有失敗後清理。
7. 合併後以既有 Production database URL／CA 先執行同 commit logical restore evidence；Vercel／Cloudflare credentials 齊備後，再跑 settings／schema preflight 與 application deployment／smoke。

## 外部啟用閘

- Vercel：有效且 team-scoped 的 Access Token；Production custom domain 已加入；自動指派 custom production domains 已關閉並由操作者記錄證據。
- Cloudflare：custom domain 的 self-hosted Access application、owner policy、只容許 release-smoke service token 的 `Service Auth` policy；repository 固定 application audience、service Client ID fingerprint 與最大 application-token lifetime。
- GitHub `Production` environment：只保存 `VERCEL_TOKEN`、Cloudflare service-token pair 與短效 owner session；variables 固定 project／team／domain。Preview／Development 不取得這些值。

官方依據：

- [Vercel：Create a new deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
- [Vercel：Promoting Deployments](https://vercel.com/docs/deployments/promoting-a-deployment)
- [Cloudflare：Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare：Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
