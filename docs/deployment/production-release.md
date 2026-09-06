# Production 發布操作手冊

## 契約與現況

```text
feature branch → PR → required CI／verify → main
                                             │
                                             ▼
                               protected Production environment
                                             │
                                  migration release state machine
                                             │
                                      不執行 app deploy
                                             │
                         指定同一 commit 的 Vercel CLI deployment
```

- `main` 只接受 PR 合併；`verify` 是 required check，管理員不得略過 branch protection。
- Vercel project `game-base` 不接受 Git 自動 deployment。`vercel.json` 也將 `git.deploymentEnabled` 固定為 `false`，避免重新連接 Git 後靜默恢復。
- `.github/workflows/production-release.yml` 是 repository 支援的唯一 production 發布入口。它要求完整 commit SHA、確認該 commit 屬於 `main`，且 `.github/workflows/ci.yml` 對同一 SHA 的 `main` push run 成功，並進入受保護的 `Production` Environment。
- Production job 必須先 checkout trusted `main` workflow 版本，再驗證指定 SHA 存在、屬於 `origin/main` 且 exact CI run 成功；只有全部成立後才可 `git checkout --detach` 該 SHA，之後才能執行其 `package.json`／repository scripts。不可把 candidate checkout 提前，否則未合併 commit 會在未來具 secrets 的 Production Environment 取得不必要執行面。
- GitHub `Production` Environment 使用 custom deployment branch policy，server-side allowlist 唯一項目是 `main`；job 的 `github.ref == 'refs/heads/main'` 只是縱深防禦，不能取代 Environment policy。這確保未來即使新增其他 protected branch，其修改過的 workflow 也不能進入 Production Environment。
- T02A 唯讀 preflight 與 T02B migration apply／strict／ledger gate 已接入受保護的 `Production` Environment；T03 app deployment 尚未完成，因此此 workflow 只管理 migration，不呼叫 Vercel deploy。`PRODUCTION_MIGRATION_DATABASE_URL` 必須使用 `sslmode=verify-full`，並搭配 Supabase Dashboard 下載的 `PRODUCTION_MIGRATION_CA_CERT`；任一缺失都 fail closed。不得以手動 Dashboard deployment 繞過停發狀態。
- Production credentials 只可存在 GitHub `Production` Environment secrets 或 Vercel Production scope。Vercel Preview／Development、repository variables、workflow log 與 artifact 都不得包含這些值。

Vercel Hobby project 的 owner 仍可直接從 Dashboard 或本機 CLI 建立 production deployment；repository 無法在 Vercel 帳號層絕對撤銷這項 owner 能力。這是殘餘風險，不是第二條支援路徑：owner 不得手動部署，操作證據以 Vercel activity log 稽核。若未來 Vercel 提供適用方案的細緻 deployment policy，應把這項人工禁令改為平台強制。

Repository 內可公開核對的 binding 是 `.github/production-release-contract.json` 與 `src/shared/config/deployment-bindings.ts`：repository、branch、CI workflow／check、GitHub Environment、Vercel project ID／name、Supabase project ref／region／hostname、Supavisor host／username，以及 Hosted Preview 與 Git deployment 均為停用。publishable／secret key 只保存 SHA-256 fingerprint，不保存原值。

T01 只要求 Vercel Production scope 已有 `SUPABASE_PUBLISHABLE_KEY`（encrypted）與 `SUPABASE_SECRET_KEY`（sensitive），並以 `EXPECTED_SUPABASE_*_SHA256` 綁定 fingerprint。Vercel API 可安全讀回 publishable key並核對 fingerprint，但 sensitive secret 不允許解密讀回；T01 已用 Supabase CLI 當前 secret 覆寫該 Vercel variable，之後由 runtime `environment:check` 比對實值與 fingerprint。T02A 使用 GitHub `Production` Environment 的 `PRODUCTION_MIGRATION_DATABASE_URL` 與 `PRODUCTION_MIGRATION_CA_CERT` secrets；連線只能指向正式專案的 direct endpoint 或 port 5432 session pooler，不能指向 port 6543 transaction pooler，且必須以 `verify-full` 同時驗證 CA 與 hostname。Vercel token 等 secrets 仍屬 T02B／T03。憑證設定依 [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)；憑證本身不提交 repository 或 artifact。

## 每次發布前

1. `gh api repos/elekli/game-base/branches/main/protection`：確認 required check 為 `verify`、PR required、`enforce_admins.enabled` 為 `true`。
2. `gh api repos/elekli/game-base/environments/Production`：確認 required reviewer、禁止管理員 bypass，以及只允許 protected branch。
3. `vercel project inspect game-base` 與 Vercel project API：確認 project ID 符合契約、Git integration 未連接；再執行 `pnpm release:settings:check` 核對 Production-only key scope、type 與可安全核對的 fingerprint。
4. 只列 Vercel environment variable 的 key、target 與 type；若任何 credential target 包含 Preview 或 Development，立即停止發布並移除錯誤 scope。禁止要求 API 回傳解密值。
5. 執行 `pnpm release:contract:check`，並由受保護 workflow 的 orchestrator 執行 production migration preflight。Preflight 先以 `BEGIN TRANSACTION READ ONLY` 鎖定唯讀交易，再核對 repository migration history、角色、grants、RLS、private bucket 與正式專案 binding；無論成功或失敗都 rollback。RLS 必須與 `.github/production-rls-policy-manifest.json` 對 `app_private` 聲明的 policy name、permissiveness、command、roles、`USING`、`WITH CHECK` 完全相同；缺少、額外或條件漂移都停止發布。每個政策 revision 以 `validFrom` 與 `validUntilExclusive` 表示生效區間：新增政策時建立末端為 `null` 的 revision；替換既有政策時，在同一支 migration 把舊 revision 的末端與新 revision 的起點設成該版本。相同 table／name 的 revision 不得重疊或留空檔。套用前只比對 production 已套用 tail 當時有效的 revision，strict verification 則比對目標 commit 最新 tail，避免 pending 政策變更卡死套用流程。`storage` schema 不納入應用政策固定清單，僅由獨立的 bucket 與 `storage.objects` RLS 檢查覆蓋，避免把 Supabase 管理的系統政策誤判成應用漂移。T03 完成前不可把 migration 成功誤當成 app 已部署。

`app_runtime` 可經 membership-level `INHERIT`、`SET ROLE` 或 `ADMIN OPTION` 遞迴到達的角色，必須與 `.github/production-runtime-role-reachability-allowlist.json` 的 `appRuntimeReachableRoles` 完全相同；目前固定清單為空。PostgreSQL 17 的 membership-level `INHERIT TRUE` 即使搭配 role-level `NOINHERIT`，仍視為權限可達；任何未核准角色都必須停止發布。固定清單將來若因平台必要條件新增角色，仍不得容許 `app_migrator`、superuser、`BYPASSRLS`、`CREATEROLE` 或 `CREATEDB`；應只提交角色名稱，不記錄密碼或其他秘密。

Membership graph 也必須反向檢查：只容許 PostgreSQL 建立角色時自動留下的兩條直接 `postgres` role-creator membership，且必須精確為 `ADMIN TRUE`、`INHERIT FALSE`、`SET FALSE`，分別指向 `app_runtime` 與 `app_migrator`。這兩條不授予應用角色權限，並讓既有 `postgres` migration principal 管理其建立的角色。除此以外，任何角色都不得直接或遞迴到達 `app_runtime`／`app_migrator`；額外 membership、兩條既定 membership 缺失或 option 漂移都停止發布。`app_migrator` 本身固定為 `NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`。

`app_private` schema 內的 tables、partitioned tables、sequences、views、materialized views、foreign tables、composite types、standalone types 與 routines，都必須由 `app_migrator` 擁有。preflight 也辨識 extension-owned objects；目前不允許 extension 在 `app_private` 建立例外物件，發現時一律停止發布。這項檢查只讀 schema metadata，不讀取資料列或 routine body；目前 repository 的正常基線為 18 張 table 與 `app_private.prevent_system_platform_mutation()`，未建立 sequence、view 或 standalone type。

Schema、relation、sequence、routine、type 與 column ACL 採精確 grantee／privilege allowlist；runtime grant 不得帶 grant option。每張 runtime table 的 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 與每條 sequence 的 `USAGE`、`SELECT` 都逐項檢查，不使用 PostgreSQL 逗號 privilege 查詢的 ANY 語意。`app_migrator` 在 `app_private` 的 default privileges 也必須精確維持 table CRUD 與 sequence USAGE／SELECT 六項 runtime grant，不能出現其他 grantee 或 privilege。

### 已知 grant 漂移的一次性修復

T02A 首次唯讀檢查確認：`app_private.prevent_system_platform_mutation()` 尚有一項授予 `PUBLIC` 的 `EXECUTE`。這不是允許忽略的永久基線。一般 preflight 只在下列條件全部成立時回報 `known-drift-remediation-required`，讓後續 T02B apply 流程得以前進：

1. 唯一的不安全 grant 正是上述 function 對 `PUBLIC` 的一項 `EXECUTE`，沒有其他 grant 漂移。
2. `app_runtime` 沒有直接 `EXECUTE`；它不需要建立或直接呼叫 trigger function，既有 table trigger 仍負責阻止 system platform mutation。PostgreSQL 的 [`CREATE TRIGGER`](https://www.postgresql.org/docs/current/sql-createtrigger.html) 權限檢查發生在建立 trigger 時，不是要求每個修改資料列的 runtime role 都保有 function 的直接呼叫權。
3. 精確 repository migration suffix 內存在具名 migration `*_revoke_public_platform_trigger_execute.sql`，且檔案內容逐 byte 只能是 `revoke execute on function app_private.prevent_system_platform_mutation() from public;` 加最後換行。
4. 執行的是已通過 exact-main-commit CI 且取得 `Production` Environment 人工核准的 release job；不得接受 workflow input、手動貼上的 SQL 或其他 function／grantee。

T02B 套用 repository 的 versioned pending migrations 後，必須在 deploy 前執行 `pnpm release:migration:verify`。Strict verification 要求 migration history 與該 commit 完全相同、上述 `PUBLIC` 與 `app_runtime` 的直接 `EXECUTE` 都不存在，且其餘 role／grant／RLS／bucket 全部通過。未通過時留在舊 deployment，以新的 forward migration 修復；不可 reset、改舊 migration 或放寬 allowlist。

CI 另執行 `pnpm release:migrations:lint -- --baseline-ref origin/main`，拒絕把 drop、truncate、欄位型別變更、constraint／domain 收緊、收緊 `NOT NULL` 或 rename 混入一般 migration，也拒絕未具名核准的 `CREATE／ALTER ROLE`、`CREATE／ALTER USER`、`GRANT`、`REVOKE`，以及同一 PR 新增或修改 legacy hash baseline。唯一現有例外是具名且逐 byte 相同的 PUBLIC trigger EXECUTE 修復。任何可執行 SQL 的 `RENAME` action 都一律拒絕，不依 table、view、sequence、index、type 或其他物件種類列舉；comment、string literal 內的文字仍由 lexer 排除。首次建立的 baseline 只能等於程式內固定的 `0001`–`0006` 精確 hash；合併後一律以 trusted `origin/main` 為準。除此之外，trusted main 已追蹤的每一支 migration 都必須逐 byte 保持不變且不得刪除；CI 與 production preflight 都在開啟 DB 連線前檢查。baseline 真的需要變更時，必須先有獨立受控流程與人工裁決，不能與被豁免的 DDL 同一 PR。新 `CREATE FUNCTION／PROCEDURE` 的 `AS` body 只接受單一 dollar-quoted literal；standard、`E''`、`U&''`、bit／hex 或相鄰 literal 一律拒絕，dollar body 仍遞迴拒絕 dynamic `EXECUTE`。作者應改寫為單一具名 dollar quote，不由 linter 猜測 PostgreSQL 的 escape／串接語意。這些相容性破壞必須先規劃 expand／migrate／contract 發布，不得以註解、`DO`／dynamic `EXECUTE` 或直接在 Production 執行 SQL 繞過。

新 migration 若需由 `app_migrator` 擁有 schema 物件，只容許以下最外層且順序精確的 envelope；`GRANT` 不得帶 option，且只有 wrapper 本身可使用 `SET LOCAL ROLE`／`RESET ROLE`。Body 內任何頂層 `SET`／`RESET` statement，以及任何可執行的 `set_config(...)` 呼叫（含 `pg_catalog.set_config` 與 quoted `"set_config"`）一律拒絕。所有可執行的 `U&"..."` Unicode escaped identifier 也採 fail-closed 拒絕，不嘗試局部解碼；comment、string 與單純 dollar literal 中的同名文字不算可執行呼叫，routine dollar body 則遞迴檢查。中間仍套用全部 destructive DDL 與 dynamic SQL 規則。新建於 `app_private` 的 FUNCTION／PROCEDURE 可在 body 尾端逐支撤銷預設 EXECUTE，但 object kind、完整名稱與參數型別 signature 必須對應同檔較早建立的 routine，角色與順序必須精確為 `public, anon, authenticated, service_role`。不接受 `ALL FUNCTIONS`、既有或未知 routine、其他 schema、重複撤銷、額外角色或 body 中段的撤銷。

```text
grant app_migrator to postgres
        │
set local role app_migrator
        │
migration body ──► 新建 app_private routine ──► 尾端逐支精確 REVOKE EXECUTE
        │
reset role
        │
revoke app_migrator from postgres
```

### Production migration ledger

`production-release.yml` 的 `apply` 模式只接受當下 `origin/main` 的完整小寫 SHA，以及按檔名排序、無空白的 canonical JSON pending filename array。無 secrets 的 candidate job 先驗 SHA、main push CI、release contract 與輸入語法；通過後才進入 `Production` Environment 等待人工核准。Mutation job 由可注入、具動態狀態測試的 TypeScript orchestrator 執行兩次 read-only preflight：第一次產生並上傳包含固定來源 actor／requestedAt 的 canonical plan；upload 成功後，唯一的 `Authorize exact migration attempt` step 以零 DB 存取核對 plan 與 source release identity，形成該次 run／attempt 已獲核准並進入嘗試邊界的 marker；第二次 preflight 才在 apply 緊鄰前重讀 Production，與該 plan 精確比對 migration identities、bytes 與 pending-set hash，再重查 `origin/main`。Artifact upload 期間只要 DB pending set 或 main 漂移，就必須在 Supabase CLI 零呼叫前停止。CLI 固定為 `2.116.0` 且只開放 migration up；CA 寫入權限 `0600` 的 runner temp file，透過 `PGSSLROOTCERT` 傳入，連線仍須由 URL 維持 `sslmode=verify-full`。

GitHub workflow concurrency 只能序列化 release runs，無法鎖住合併到 `main`，也無法讓 GitHub 與 PostgreSQL 成為原子交易。因此，帶 migration 的 PR 在最後一次 preflight／apply 臨界區必須依 repository 操作程序全域序列化；workflow 的最後 main recheck 是縱深防禦，不宣稱消除跨系統 TOCTOU。

Apply 命令即使回傳失敗也可能已部分或全部前進，因此 orchestrator 無條件執行 strict read-only diagnosis，並以 strict exact-target 結果為權威：strict 通過時，CLI 正常退出分類為 `applied-and-verified`，CLI throw 則分類為 `verified-after-ambiguous-apply`，兩者都可進入 record；strict 失敗時，不論 CLI outcome 都停止且不得產生成功 ledger。唯一具名的 `Apply and strict-verify exact migration suffix` step 只負責 mutation 與 strict，確認目標後即退出；下一個 `Create sanitized evidence and ledger` step 才從固定來源 plan 產生 record／state。如此 apply 已 commit 後 process 被終止，或後續本機寫檔、evidence upload、PR 失敗時，仍可安全 recovery。本 workflow 不含 Vercel deploy、database reset、db push 或 migration repair。

Git-tracked ledger 與 evidence 都包含 commit、migration identities 與 pending-set hash、來源 operator、來源 UTC time、source release run／attempt、`strict-exact-target` success basis、result，以及固定 recovery action：成功後帳本缺失使用 `ledger-recovery`，資料庫不相容只能 `forward-fix`，且 `never-reset`。它只宣稱 strict 已確認目標狀態，不宣稱 Supabase CLI 的 exit outcome。Ledger 的 `evidenceSha256` 是實際上傳 `evidenceText` 完整 bytes 的 SHA-256；evidence artifact 保存 90 天。Ledger 由 workflow 建立獨立 branch 與 PR，不直推 `main`。

若已進入 attempt boundary，但 mutation step 因 failure／cancelled／process kill 或後續 record、evidence artifact、ledger PR 失敗而缺帳，改用 `ledger-recovery` 並提供原 workflow run ID 與 run attempt。恢復候選由該來源 run 推導，可為 current main 的祖先，不要求仍等於 current main。流程精確核對 repository、workflow path、event、head SHA、attempt、job API 的 `run_attempt`、唯一 mutation job、唯一成功 attempt marker，以及不重複且 conclusion 為 success／failure／cancelled／skipped 的 mutation step；它不靠 mutation step conclusion 宣稱資料庫成功，而是再驗 GitHub artifact archive digest、source commit 與 current main 的 migration bytes、pending-set hash、Production history 已包含來源 migration set 的 prefix，並保持 role／grant／RLS／private bucket 的 strict 安全檢查。若 mutation 根本未使 DB 達到目標，prefix／strict 必須 fail。Ledger identity 固定由來源 release run＋attempt、candidate 與 pending-set hash 組成，evidence 的 actor／time 只取自來源 plan，normal 與 recovery 重建的 record 及同一 source identity 的重跑都逐 byte 相同；deterministic branch／file 已存在時必須 fetch 並逐 byte 核對。OPEN PR 必須非 draft、base／head／title 契約相同，且 branch ledger 逐 byte 相同；MERGED PR 必須在 main 找到相同 ledger；CLOSED 未合併一律停止；無 PR 時 main 已有 ledger 也因缺 canonical publication evidence 而停止，且禁止 force push。Recovery 只重建 evidence／ledger，不再次執行 migration。

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
