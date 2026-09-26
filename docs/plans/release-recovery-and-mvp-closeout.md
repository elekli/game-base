# 發布復原與 MVP 收尾

更新：2026-09-12。使用者已授權依序執行；正式發布仍沿用既有受保護流程。

## 固定順序

1. 修復發布診斷、確認正式部署與固定 canary 現況，完成一次具有效證據的正式發布。
2. 完成收藏庫、媒體正式驗收（#61、#67），核對 #53、#30、#31 的完成證據。
3. 完成清單、對稱關聯、資源回收與批次驗收（#70–#73）。
4. 完成 BGG 使用日更新、lease／fence、失敗重試、完整性檢查與 MVP 驗收（#74–#78）。

本次不擴充 MVP；TODOS.md 的延後項目維持延後。每階段完成後更新本文件與交接紀錄，以真實證據收尾。

## 第一階段：發布故障

已知：run 34668052211 在 `manual-recovery-required:smoke-execution-crash` 停止，缺少 application-release.json。正式 alias 仍指向候選 1921b26 的 READY deployment。未證明 canary 清理完成，不能自動回滾或重跑寫入。

最小重現：`pnpm exec vitest run tests/unit/production-application-release-runner.test.ts -t 'requires manual recovery when smoke execution crashes'`。現有測試只檢查終態；唯讀重現證明 evidenceActions=0，原始例外消失。

Vercel runtime logs 已定位直接失敗為兩次 `401 / release_smoke_access_denied`，request IDs 為 `15b84c52-abf5-4730-a632-f1518f4e56d6`、`ef5f10c0-374a-42d1-8ac6-1b34f61ed10c`。拒絕發生在 canary dependency 建立之前；尚未知具體 JWT 拒絕條件，因此加上不改授權判準的內部列舉式原因診斷。

正式唯讀查證：alias 指向候選 1921b26 的 `dpl_AcEsLVTf8c1EGve3VpDh3jq6qnX1`，狀態 READY；沒有自動回滾。經官方 Supabase CA、hostname 驗證及 READ ONLY 交易，固定 canary row count=0、固定兩個 Storage path 的 object record count=0。直接 Vercel origin 回 302 到 Vercel 登入；未授權正式入口由 Cloudflare 回 403。

```text
唯讀現況／canary 檢查 → 完整基線 → 失敗回歸測試 → 修正診斷及證據
                                                        ↓
受保護發布 ← PR／獨立審查／CI ← 回讀與故障路徑驗證
    ↓
正式 smoke／清理證據 → 既有功能驗收 → 下一階段
```

### 修正範圍與不變式

- 修改 application runner、deployment state model、evidence builder/schema、smoke transport 診斷、workflow 與契約 pins，以及相應單元／整合測試及發布手冊。release-smoke verifier／handler 增加只寫內部 log 的封閉 denialReason；外部 401、授權條件與拒絕前零資料存取維持不變。
- 保存有界且列舉化的 action、failure code、HTTP status／安全 request ID；不保存任意 message、stack、cause、body、URL、header 或機密。
- 本批先涵蓋驗收 crash／timeout 的人工復原終態，保存合法失敗證據，不能冒充 passed／rolled-back。保存失敗不遮蔽原始失敗。其餘人工復原／發布前失敗的統一證據由 TODOS.md 追蹤，不能宣稱所有失敗分支已涵蓋。
- 不因增加證據而重送 mutation、清理未知歸屬物件或回滾未驗證 canary。
- 能在發版前以唯讀方式驗證的憑證與存取前提先驗；無真實證據不能聲稱可發布。

### 驗收

- 已知安全錯誤可診斷；未知機密哨兵不出現在 log／artifact。
- crash、timeout、route denial、evidence write failure 都有明確結果；成功與 rollback 路徑不退步。
- lint、typecheck、unit、integration、release contract、build 與完整 CI 綠燈；新增測試先紅後綠。
- 正式 exact commit、owner／origin 邊界、DB／Storage、固定 canary 及清理證據通過。

### 基線與風險

- 1921b26：Node 24＋CI preview fixture 的 lint、typecheck、unit、integration、environment、integrity、release contract、build 均已通過。
- 複製的本機 .env 缺 runtime bindings，直接 dev 起不來；改用既有 CI fixture 環境後 dev 與 HTTP 200 通過，未修改正式環境或放寬檢查。
- Supabase CA 已從官方 Studio 原始碼固定的下載位置取得，通過憑證有效期檢查，實際 TLS／hostname 驗證連線成功。以既有 postgres 角色直接唯讀查詢固定 canary table（它有 SELECT 與 bypass-RLS）成功；不要 SET ROLE app_migrator，正式角色的 SET option 不允許該操作。
- Cloudflare 應用程式 audience 與 service client_id 指紋皆匹配；組織設定 API 回 403，不能據此推論 issuer 不匹配。短效 owner session 可能需要更新，不能把過期 session 當程式缺陷。

### 2026-09-20：非同步切換確認

根因證據：35369026291 在 16:34:58.0707116Z 宣告 promotion attempts exhausted；Vercel aliasAssignedAt 在同秒 .102，晚約 31 毫秒。成功接受切換要求不等於 alias 已收斂，原流程兩次立即 GET 耗盡 mutation 次數。

範圍：僅在 runner ports 的 verify-promotion／verify-rollback 輪詢既有 GET；最多 30 次、相隔 1 秒，action 有 60 秒硬截止且沿用可取消的 HTTP transport。只有仍觀察到切換前部署才等待。目標部署立即交回狀態機，第三部署立即交回既有拒絕分支。次數耗盡拋具名錯誤終止，不再增加 mutation。其他 inspection 維持單次。

```text
切換要求 → GET alias → 目標部署 → 既有驗收／回滾證據
                │── 第三部署 → 既有拒絕分支
                └── 舊部署 → 有界等待 → GET alias
                              └── 耗盡／取消／錯誤 → 停止
```

非目標：不修改授權、部署 mutation、驗收條件、workflow 或其他功能。驗收：實際 ports seam 假時鐘證明延遲成功只送一次 promotion、永不收斂有界停止、取消不再查詢、第三部署立即停止、rollback 延遲確認；契約 SHA 同步且回歸全綠。60 秒後仍未收斂需人工確認，不能自動宣稱回復或驗收成功。

### 2026-09-22：服務憑證有效期綁定

正式發布 35676647740 已完成候選部署與 alias 收斂，smoke route 以 `release_smoke_access_denied`／`invalid_lifetime` 回 401。Cloudflare 的服務 assertion 契約包含 `type: "app"`、空 `sub`、`iat`、`exp` 與 `common_name`；原 production binding 把擁有者 application session 的 24 小時期限當成服務 assertion 的上限。現有證據顯示正式 assertion 的時間欄位或 lifetime 未通過該上限，是否確為 lifetime 超限仍以正式 smoke 驗收。Cloudflare 服務憑證預設有效一年，因此 repository 採一年（31,536,000 秒）作為安全上限；這是本專案的接受政策，不宣稱每張 assertion 的 `exp - iat` 都等於一年。精確邊界測試證明一年可接受、一年加一秒仍拒絕。

此修正不更換 service token，不放寬簽章、issuer、audience、主體型別、空 `sub` 或 `common_name` 指紋檢查，也不改動發布 mutation。合併後以同一受保護流程重新發布，並以正式 smoke artifact、alias、資料庫與 Storage 清理證據驗收。

正式重跑前以原生 `curl` 對同一 owner token 實測，`CF_Authorization` cookie 與 Cloudflare CLI 契約的 `Cf-Access-Token` header 都回 200；先前 Python `urllib` 的 403 是 client-specific 行為，不能據此判定 cookie 無效。runner 的 owner boundary probe 採用官方 CLI token header；service-principal headers、private route 本身與短效 secret 清除政策不變。

2026-09-22 受保護發布 run 35710482016 已跨過 Cloudflare 驗證、alias 收斂、資料庫與固定讀取檢查，於 `write-object` 回滾。Vercel 六次 route 時序將失敗定位在第四步；Supabase Storage 正式日誌顯示固定原圖 POST 回 400，內部為 `AccessDenied`／`Invalid Compact JWS`，角色落為 `anon`。根因是 `@supabase/supabase-js 2.112.4` 對 Storage 仍把 opaque `sb_secret_…` 同時當作 Bearer JWT 傳送。修正限定於 release-smoke 的服務端 Storage transport：保留 `apikey` 並移除只等於該 secret 的 SDK Bearer fallback；真實 session Bearer 不受影響。發布證據 schema v3 另保存清理完成後的受控 failure name／safe detail，避免再把可診斷失敗投影成 `unknown-error`。

## 2026-09-23 發布診斷補充

- Release run `35805546663` 已建立並 promote exact-main deployment `dpl_7EoZRrGUoNdaLvYsLQR2hQT78PCc`，但第一個 owner boundary check 從 GitHub runner 收到 Cloudflare 302，尚未進入資料或 Storage mutation。
- Artifact schema v3 正確保存 `manual-recovery-required`、已知基線 `dpl_4RUaXf42ZxSmJiEAF5d43qyS9ky7` 與 `boundary-owner-auth-denied`。短效 GitHub secret 已立即刪除。
- Vercel rollback endpoint 對該基線回 402，原因是它只允許有限的 production 歷史深度；以 exact baseline promotion 完成復原，正式 alias 已重新核對為 D0。
- 下一次發布前先合併兩項流程修正：GitHub runner 在任何 deployment mutation 前驗 owner session；自動復原以 exact baseline promotion 取代 rollback endpoint。
- PR #145 合併後的 release run `35859278282` 已在 GitHub runner 通過 owner preflight，建立並 promote `dpl_6chF9NETBjn3BJHm86dtrWJfKiqx`；smoke 於固定 Storage 原圖寫入失敗，artifact schema v3 保存 `ProductionCanaryResidueMismatchError`／`Storage original write failed`，並以 1 次 exact baseline promotion 自動復原。正式 alias 已獨立核對回 `dpl_4RUaXf42ZxSmJiEAF5d43qyS9ky7`，canary 清理為 `0/0`。
- Supabase 管理面確認專案目前只有 1 把啟用中的 `sb_secret_` 金鑰。本機使用該 active key、相同 SDK、相同 header 修正與相同 upload 參數可寫入並完整刪除隨機診斷物件；active key 與本機一致，但不符合 repository／Vercel 原綁定指紋。根因是 Vercel Production 留著已撤銷的舊 secret，而 expected fingerprint 與 repository 也共同固定在舊值，因此靜態一致性檢查無法單獨證明金鑰仍為 Supabase active key。
- Vercel Production 的 `SUPABASE_SECRET_KEY` 與 `EXPECTED_SUPABASE_SECRET_KEY_SHA256` 已更新到 active key；repository Production binding 與測試同步新指紋。受保護發布在部署變更前核對 Supabase active key 指紋、Vercel 可讀變數與 repository binding；Vercel sensitive secret 的實值只能由新部署的執行期綁定檢查與正式 smoke 驗證。
