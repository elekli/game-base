# Issue #58：release-smoke 授權邊界與固定 canary 計畫

## 範圍

本切片建立 production release smoke 所需的專用身分、內部 route、固定資料列、固定 Storage 物件操作與外部 runner。它不啟用 Vercel live mutation、不建立 production application workflow，也不宣稱已驗證 direct-origin denial、custom-domain routing 或 logical restore。這些外部前提未齊時，既有 `productionDeploymentEnabled=false` 與 repository binding 的 fail-closed barrier 維持不變。

## 意圖先行的不變式

| ID | 類型 | 永遠必須成立的條件 |
|---|---|---|
| S1 | Safety | 一般 owner JWT 永遠不能通過 release-smoke verifier；release-smoke service principal 永遠不能通過 `requireOwner` 或一般 private route。 |
| S2 | Safety | route 只信任 Cloudflare 注入的 `Cf-Access-Jwt-Assertion`；`CF-Access-Client-Id`／`CF-Access-Client-Secret` 或 request body 自報身分永遠不能授權。 |
| S3 | Safety | assertion 必須通過 RS256、非空 `kid`、issuer、audience、`type === "app"`、`sub === ""`、`iat`／`exp`、受 binding 固定的最大 token lifetime，以及 `common_name` SHA-256 allowlist。這些 service-token claims 依 Cloudflare application-token contract 與 owner JWT 明確分流。fingerprint 或最大 lifetime 尚未釘入 production repository binding 時，route 必須回 503 且零 adapter 呼叫。 |
| S4 | Safety | route 的 caller-controlled input 只有完整 40 字元小寫 commit SHA、由 runner 每次完整 smoke attempt 產生並在該 attempt 重用的 UUIDv4 fencing generation、單調遞增且受 CAS 驗證的 action sequence，以及封閉操作 discriminant；request body 最大 1 KiB，拒絕額外欄位。table、row ID、object path、owner、payload、URL 與 count 上限不能由 caller 指定。generation 與 action sequence 都不是授權憑證，只用來阻擋跨代或同代晚到動作。 |
| S5 | Safety | 所有 mutation 只能觸及固定 row `7355773e-c3b5-4e5d-9f07-55ac0e22f384` 與固定 private Storage path `release-smoke-v1/canary.json`；任何時刻各自最多 1 筆／1 個。 |
| S6 | Safety | 同一 attempt 的 transport retry 必須重用 execution identity、generation 與 deterministic payload hash；新的完整 attempt 必須使用新 generation。所有 state transition 同時核對 generation＋expected phase；舊 generation 永遠不能 mutation 或 cleanup 新 generation。不同 identity 的殘留不得自動覆寫或刪除，必須具名停止。 |
| S7 | Safety | cleanup 只可刪除固定位置且 generation、identity、payload hash 與 canonical object bytes 完全相符的 canary；object 另有 1 KiB 讀取上限。每個 Storage mutation 前先持久化 `*_pending` phase；結果不明時持久化／保留 `*_uncertain`，後續 attempt 不得自動覆寫、刪除或重建。未知、超限或不相符的資料／物件保持不動。 |
| S8 | Safety | route response 與 log 只含結果、具名錯誤與 request ID；不回傳 owner library 資料、Storage body、JWT、service-token headers、連線字串或 Supabase secret。 |
| S9 | Safety | direct-origin denial、custom-domain protection 與匿名 private Storage denial只能由外部 runner 觀測；內部 route 不得自行宣告這些檢查通過。 |
| L1 | Liveness | 無競爭且 adapter 正常時，同一 execution identity 的 `0/0 → 1/1 → 0/0` 流程可在固定步數內完成；mutation 失敗後仍進入有界 cleanup。 |
| L2 | Liveness | 同 generation 的 transport retry 可重入；相同或不同 identity 的正常 attempt 先由 workflow concurrency 序列化，再由 generation fencing 與每-operation 固定 advisory lock 防止晚到 request 跨代 mutation。若 Storage 結果不明，安全優先於自動 liveness：流程進入具名 uncertain 狀態並要求人工 reconciliation，不啟動新 generation。 |

## 信任邊界

```text
GitHub protected Environment
  │ service-token headers（只送往 Cloudflare）
  ▼
Cloudflare Access
  │ 驗證 service token，注入 Cf-Access-Jwt-Assertion
  ▼
/api/internal/release-smoke
  ├─ release-smoke verifier：JWT＋common_name fingerprint
  ├─ 固定 read checks：只回 pass／fail，不回 private payload
  └─ 固定 canary adapter：固定 row／path／payload

一般 /api/private/*
  └─ requireOwner：仍只接受固定 owner email＋sub
```

## Route 合約

`POST /api/internal/release-smoke` 固定 `runtime = "nodejs"`、`dynamic = "force-dynamic"`，且所有 runtime adapter 使用 `server-only` import。handler 在讀 body 或建立 adapter 前，先驗證 `VERCEL_ENV === "production"`、repository-owned Production Supabase binding、service fingerprint 與 token lifetime pin；任何缺失回 503 且零依賴呼叫。body 採 bounded stream reader，最多 1 KiB，只接受：

```json
{
  "executionSha": "<40-char-lowercase-git-sha>",
  "generation": "<uuid-v4-created-once-per-smoke-attempt>",
  "actionSequence": "<positive-monotonic-integer>",
  "operation": "inspect-baseline | run-fixed-read-checks | write-row | write-object | verify-round-trip | cleanup-exact | inspect-cleanup"
}
```

route 依既有 `production-smoke-canary.ts` 的常數推導 identity、row ID、object path 與 payload hash。不同 operation 的 response 只提供狀態機所需的 bounded counts、exact-identity comparison、具名 check 結果與 request ID；不提供原始 row／object／library 內容。

`run-fixed-read-checks` 的 application read target 固定為單一擁有者部署的 `app_private.games`：route 不接受 owner input，專用 Postgres adapter 只做固定 `SELECT EXISTS (... LIMIT 1)`。空收藏庫仍算成功；成功判準是受限 `app_runtime` 能完成有界查詢，response 只回 `authenticated-library-read: passed`，不回 exists、count、名稱、ID 或任何 game payload。這個 probe 不呼叫全量 `listLibraryGames()`，不把 service principal 傳給 `requireOwner`，也不取得一般 private route 能力。

## 資料模型與權限

- 新 migration 建立 `app_private.production_smoke_canaries`，只允許固定 UUID，欄位為 `id`、`identity`、`generation`、`payload_sha256`、`phase`、`created_at`、`updated_at`；以 CHECK constraints 固定格式與封閉 phase enum，以 primary key 保證最多 1 row。table 啟用並強制 RLS。
- 對 table 與 sequence 撤銷 `PUBLIC`、`anon`、`authenticated`、`service_role` 與 `app_runtime` 的直接權限。只由固定 `search_path`、不可由 runtime 修改且 `SECURITY DEFINER` 的 inspect／claim／cleanup functions 存取；`app_runtime` 只取得這些函式的 `EXECUTE`。pgTAP 固定完整 role／grant／RLS matrix。既有 owner table 與 Storage 權限不擴張。
- Storage 使用既有 private `game-media` bucket，但只允許專用 adapter 操作固定 `release-smoke-v1/canary.json`。不修改 browser upload capability，也不把 smoke namespace 納入一般媒體路徑。
- 每個 adapter operation 都在保留的 Postgres session 以 `pg_try_advisory_lock` 取得同一固定 lock，不排隊等待；每次受控函式呼叫各自提交，session lock 則跨越這些提交與 Storage 呼叫。正式 runtime 的 transaction-pooler URL 只作為經 repository 驗證的 credential／host 來源，smoke adapter 固定把 Supavisor port `6543` 轉為 session-pooler port `5432` 後才連線，且拒絕其他 hosted port；因此 advisory lock、提交與 unlock 必定落在同一 backend session。這使 mutation 前的 pending fence 與失敗後的 uncertain fence 不會隨 adapter 錯誤回滾。DB connection 與 statement 各有固定 deadline；row write 經受控函式採 generation＋expected-phase conditional transition，不同 generation、identity 或 hash 具名拒絕。
- object write body 是由固定欄位與 generation canonical serialization 產生的 deterministic JSON，最大 1 KiB；`payload_sha256` 仍依 contract 的穩定 release identity 欄位計算，另以 canonical byte digest 驗物件。既有物件必須 bounded readback 並逐 byte 比對 canonical bytes，再核對 digest。
- Storage upload／delete 各有硬性 abort deadline 與 route 總 deadline。開始前先提交 `object_write_pending`／`cleanup_pending`；成功後才提交下一 phase。timeout、network error 或被忽略的 abort 一律保留／轉為 `object_write_uncertain`／`cleanup_uncertain`，新 generation fail closed。cleanup 只有在 bounded readback 完全相符後才送 delete，成功後才以 generation＋identity＋hash＋phase 條件式刪除 DB claim。

## 路徑與交錯檢查

| 起始狀態／事件 | 決策 | 結果 |
|---|---|---|
| `0/0`＋合法 identity | 依序 read checks、write row、write object、verify、cleanup | `0/0 → 1/0 → 1/1 → 0/0`，符合 S5／L1。 |
| `1/1`＋相同 generation／identity／hash＋確定 phase | 視為同 attempt 可重入 residue，先 exact cleanup 再重跑 | 不累積資料，符合 S6。不同 generation 不自動接管。 |
| `1/0`＋相同 generation／identity／hash＋pre-Storage 確定 phase | 視為同 attempt partial residue，經受控函式清除後重跑 | production-smoke contract v3 的 `residuePolicy` 明載只允許此 partial case 與相同 generation 的完整 pair；state model 以 generation、phase、action sequence 與事件證據約束轉移。 |
| `0/1` | 正常 write／cleanup ordering 不應產生；即使 object bytes 相符也停止 | 沒有 DB claim 就不自動刪 object，符合 S7。 |
| `1/1`＋不同 identity 或 hash | 不覆寫、不清理 | 具名 residue mismatch，符合 S6／S7。 |
| 兩個相同 identity、不同 generation 交錯 | generation＋expected-phase fencing 先於 mutation；advisory try-lock 排除同時 critical section | 舊 generation 無法 mutation／cleanup 新 generation；只有 current generation 能前進。 |
| 兩個不同 identity 交錯 | 第一個固定 row claim 排除第二個 | 第二個停止；不接管第一個資料。workflow concurrency 另保證正常路徑序列化。 |
| row 成功、object 失敗 | 狀態機轉 cleanup-exact | row 回到 0；object 若不存在維持 0。 |
| object 成功、response 遺失 | 同 generation retry 取得 lock 後 bounded readback canonical bytes | 視為成功或進 exact cleanup，不建立第二個 path。 |
| Storage request timeout／abort 被忽略 | DB 保留對應 generation 的 `*_uncertain` | 禁止新 generation 與自動 cleanup；晚到 request 不會與新 object 發生 ABA。 |
| 匿名 private Storage denial 檢查失敗 | 將具名失敗送回狀態機，先執行 exact cleanup 與 `0/0` 驗證 | 清理完成後才回報 `failed-cleanup-complete`，避免 probe failure 留下固定 canary。 |
| allowlist 缺失／JWT 失敗 | authorization 前停止 | 零 DB／Storage／library 呼叫，符合 S1–S3。 |

這裡不聲稱 property-based tests 能窮舉跨 DB／Storage 的真實交錯。計畫層以 generation／phase 狀態表固定允許轉移；code 層另以雙 worker、可控 barrier、晚到 completion、request timeout／response loss、忽略 abort 的 Storage stub 驗 fencing 與 uncertain fail-closed。若未來允許多個 canary、跨 deployment lease 或自動接管 uncertain residue，再重新評估 TLA+。

## 實作順序（TDD）

1. 先寫 verifier 單元／整合測試：合法 service assertion、`type=app`／空 `sub`、最大 lifetime、owner／org assertion 交叉拒絕、錯 `common_name`、缺 fingerprint、錯 issuer／audience／`kid`／時間，以及 client headers spoof。
2. 寫 route boundary 測試：非 Production／binding 不符／未授權／設定缺失時 adapter 零呼叫；bounded parser 拒絕超過 1 KiB、額外欄位與所有 caller-controlled target。
3. 新增 migration 與 pgTAP：固定 UUID、generation／identity／hash／phase constraints、最大 row count、`ENABLE/FORCE RLS`、受控 transition functions、revoke 與完整角色 grant matrix。
4. 寫固定 Postgres／Storage adapter 與 unit／integration tests：同 generation retry、跨 generation fence、不同 identity residue、`1/0` partial residue、`0/1` refusal、canonical-byte mismatch、response loss、exact cleanup、lock／statement／transaction／Storage deadline、無界輸入拒絕，以及雙 worker barrier 下的晚到 write／cleanup 與忽略 abort。
5. 接上由 `ownerSub` binding 導出的固定 `LIMIT 1` library probe 與 runtime DB read，測空／非空 library 都只回 pass；外部網域檢查由 runner 執行。匿名 private Storage denial 必須排在 route 已驗證固定物件確實存在之後、exact cleanup 之前，避免不存在物件造成假陽性。
6. 更新 release contract hashes、runbook、schema derivation與 integrity allowlists；完整驗證後再判斷是否能移除 smoke runner barrier。

## 預計修改範圍

- `src/shared/auth/`：獨立 release-smoke verifier／provider，不修改 owner verifier 語意。
- `src/app/api/internal/release-smoke/`：production-only route 與封閉 request schema。
- `src/adapters/`：固定 Postgres／Supabase Storage canary adapter。
- `supabase/migrations/0015_*`、`supabase/tests/0015_*`：資料模型、grants 與 pgTAP。
- `tests/unit/`、`tests/integration/`：auth、route、adapter、interleaving／idempotency。
- `.github/production-release-contract.json`、checker／runbook：pin 新 artifact；live deployment 仍 disabled。

## 未決與外部阻擋

- 真實 Cloudflare service-token client ID 與 Access application session lifetime 尚未取得，因此 repository binding 先以 `null` 表示未核准；不使用 placeholder fingerprint／TTL，也不從 secret headers 推導授權。Cloudflare 官方 application-token contract 明載 service-token assertion 使用 `type: "app"`、`sub: ""` 與 `common_name` client ID，實作依此建立與 owner JWT 分離的 verifier。
- GitHub `Production` 尚缺 `VERCEL_TOKEN`、Cloudflare service-token credentials 與 `PRODUCTION_CUSTOM_DOMAIN`；Vercel 自動指派 Custom Production Domains 關閉的人工證據也尚缺。
- DB／private Storage adapter、route 接線與有界 runner 已實作，但 repository-owned Production principal fingerprint／最大 lifetime、短效 owner session、Cloudflare service credentials、自訂網域及 staged-domain safety evidence 仍未到位。這些外部前提未完成獨立核對前，binding 與 deployment workflow 繼續 fail closed。
