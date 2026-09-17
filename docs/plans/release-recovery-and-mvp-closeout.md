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
