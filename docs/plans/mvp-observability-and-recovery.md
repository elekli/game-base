# MVP 最低限度可觀測性與復原操作

本文件定稿 Puizeru Gamebase 在單人 MVP 的技術事件、持久化失敗摘要、Vercel log 與手動復原方式。目標是讓已被產品規格定義的失敗狀態不會在技術層靜默消失，同時不建立監控後台、外寄通知、RSS feed 或另一套 telemetry service。

本文件不改變 `CONTEXT.md` 的使用者可見行為。它只規定實作者如何把那些狀態接到可追查的技術證據與可重做的操作。

## 裁決摘要

- Vercel 的結構化 runtime logs 是 MVP 唯一的技術事件查閱處；不串接 Sentry、Logtail、email、RSS 或任何主動通知服務。
- 應用程式只顯示與目前擁有者可採取操作直接相關的持久化摘要，例如 BGG 每日更新失敗數、可重試縮圖及仍失敗的批次檔案；它不是通用監控面板。
- 領域資料與工作狀態保存命名錯誤碼和安全的關聯 ID，供重試與介面顯示；完整技術細節只寫入 Vercel log。不得另建通用事件表來複製 log。
- 任何尚未處理的「需要操作」狀態都維持可見，直到成功、被領域規則明確略過或擁有者執行既定的重試。沒有「忽略後自動消失」的路徑。
- 資料一致性由資料庫約束、交易及 module integration test 預防；MVP 不跑排程式掃描或自動修復。若操作資料顯示矛盾，擁有者依本文件的診斷查詢確認後才逐筆復原，絕不批次猜測修正。

## 範圍與非目標

涵蓋的流程：

- Cloudflare Access JWT 的伺服器驗證與拒絕。
- BGG／IGDB 搜尋、確認、建立、連結、手動重新整理及其 adapter cache。
- 每日 BGG 指標更新的 run、失敗項目、租約接手與重試。
- 私有 Storage 的上傳、原檔 ingest、縮圖產生、短效下載網址與部分成功。
- 筆記、清單、遊戲生命週期命令的版本衝突、冪等重送及資料庫約束失敗。
- migration、部署後與手動診斷時發現的資料一致性問題。

不涵蓋：

- 值班輪值、SLA、PagerDuty、email、RSS、行動推播、Webhook 或自動建立 issue。
- 使用者行為分析、追蹤像素、完整 request／response 錄製、例外追蹤 SaaS，或另一個管理後台。
- 背景 cron、全庫週期掃描、資料自動修復及 QNAP 備份／還原。
- 把 Vercel 的供應商保留期限複寫到 PostgreSQL；需要長期稽核留存時，應另開決策票並先定義隱私與成本邊界。

## 兩個可見面與責任邊界

```text
使用者操作／背景工作
        │
        ├─ 領域結果 ───────────────► 畫面狀態＋既定重試入口
        │                              （只顯示可操作的摘要）
        │
        └─ 結構化技術事件 ─────────► Vercel runtime logs
                                       （診斷、部署設定、根因）

資料庫約束、交易、工作狀態 ────────► 預防／保存可復原事實
                                       不複製完整 log
```

### 使用者可見的持久化摘要

既有產品規格已決定下列畫面行為；實作者不得用「已寫 log」取代它們。

| 流程 | 畫面必須顯示 | 可採取操作 | 何時不再顯示需要操作 |
|---|---|---|---|
| 外部來源 | 保留目前確認畫面與命名錯誤 | 重試；來源不可用時改建手動最小條目 | 新一次流程成功，或使用者離開未建立的確認畫面 |
| 手動重新整理 | 本次失敗，舊快照仍可用 | 重試 | 成功交易完成 |
| BGG 每日更新 | 完成數／總數、最後成功時間與失敗筆數 | 只重試失敗項目 | 對應 run 不再有 failed item |
| 批次上傳 | 每個檔案的等待、上傳中、成功或失敗原因 | 只重試失敗檔案 | 該檔 ingest 成功，或使用者放棄尚未建立的失敗項目 |
| 縮圖 | 原檔已保存、縮圖失敗 | 重試縮圖 | 衍生縮圖成功，或原檔依既定生命週期移除 |
| 筆記自動儲存 | 儲存中／已儲存／儲存失敗，且目前文字留在編輯器 | 重試，或依既定離開提示處理 | 伺服器確認最新內容，或使用者明確放棄未持久化草稿 |
| 版本衝突 | 明確顯示已衝突，不能假裝儲存成功 | 載入伺服器版本，或以最新版本明確重送 | 新意圖成功或使用者放棄本地草稿 |

安全拒絕、Vercel 內部例外、部署設定異常與不可能的資料狀態不向介面洩漏技術細節。它們只有通用的繁體中文失敗訊息，詳細根因只在 Vercel logs；安全拒絕也不得因為顯示失敗原因而透露 JWT、存取政策或存在的資源。

### Vercel 結構化 log 契約

每一筆由 application 寫出的 JSON log 至少有：

```text
event                 穩定的事件名稱
level                 info | warn | error
requestId             一次進入應用程式邊界的 UUID；背景工作可為 runId
operation             module 的使用者意圖或背景工作名
errorCode             命名領域／adapter 錯誤；成功事件為 null
resourceType          game | note | list | media | external_identity | refresh_run
resourceId            不透明 UUID 或非敏感來源身分；沒有則 null
attempt               本次受限重試的次數；沒有則 null
durationMs            已完成操作的耗時；沒有則 null
environment           preview | production
```

Vercel 既有的時間、deployment 與 function metadata 保持由平台附加；application 不手動偽造或覆寫。所有 server entrypoint 於請求一開始建立 `requestId`，並傳入 module 的 `RequestContext`。同一操作跨 module 時重用它；背景 BGG run、媒體 ingest 與縮圖工作另有自己的 ID，並同時記錄發起它的 `requestId`（若存在）。

禁止寫入 log、工作狀態或錯誤物件的資料：

- Cloudflare JWT、Authorization header、Cookie、Vercel／Supabase／BGG／IGDB secret、IGDB access token。
- Markdown 筆記、來源介紹、表單內容、檔名、圖片／附件內容、完整 request／response body。
- signed URL、完整使用者 IP、可直接識別個人的外部帳號資料。

需要引用外部項目時，只寫 provider 與來源 ID；需要引用媒體時，只寫資料庫 media UUID，不寫 Storage path。捕捉未知例外時，先轉成命名錯誤並只寫 allowlist 後的 error class、HTTP status 類別及 stack trace；不得直接序列化任意 `Error`、request 或第三方 SDK response。

## 事件目錄與保留範圍

事件名稱是實作 interface 的一部分。新增事件必須先有明確操作、資料遮蔽規則與復原指引，不能以任意字串臨時補上。

| 事件 | 等級 | 觸發條件 | 持久化的摘要 | Vercel 查閱後的下一步 |
|---|---|---|---|---|
| `access_jwt_rejected` | warn | 到達 Vercel 的請求未通過 Access JWT 驗證 | 無 | 檢查 Cloudflare Access audience、部署環境設定與受保護路由；不得放寬驗證繞過 |
| `request_unhandled_failure` | error | 已分類邊界外的例外 | 無 | 以 requestId 重現並先補命名錯誤與測試，再修正根因 |
| `source_operation_failed` | warn／error | BGG／IGDB 操作以命名錯誤結束 | 僅既有領域流程所需的 `errorCode` 與時間 | `source_authentication_failed` 先檢查 secret；其他錯誤依 retry 語意處理 |
| `source_cache_write_failed` | warn | 有效來源結果無法寫入 cache | 無 | 查 PostgreSQL 連線與 cache table；不可把 cache 故障當成來源或建立失敗 |
| `bgg_refresh_run_started` | info | 成功建立或接手每日 run | run state、租約與進度 | 只供追查；不是通知 |
| `bgg_refresh_run_completed` | info／warn | run 結束；有 failed item 時為 warn | run 計數、完成時間、每項非敏感 errorCode | 在應用程式以「只重試失敗項目」處理；不可另建第二個同日 run |
| `bgg_refresh_lease_recovered` | warn | 過期租約由新 invocation 接手 | run 的租約世代 | 檢查是否為偶發 Vercel 中止；反覆出現才調查 function 時限與 scheduler 等待 |
| `media_ingest_failed` | warn | 單一原檔 ingest 結束失敗 | media state、非敏感 errorCode、attempt | 從既有 media ID 重試；已成功的同批項目不重送 |
| `media_thumbnail_failed` | warn | 原檔成功但縮圖工作失敗 | thumbnail state、非敏感 errorCode、attempt | 重試縮圖，不刪原檔、不重新上傳 |
| `storage_signed_url_failed` | warn | 已存在的私有物件無法核發短效網址 | 無 | 檢查 Storage 設定與物件存在性；不把長效 URL 寫入資料庫 |
| `command_version_conflict` | info | 使用者意圖因 `expectedVersion` 過期被拒絕 | 無；領域回應含目前版本與狀態 | 用畫面的既定衝突處理；不是系統錯誤 |
| `command_idempotency_conflict` | warn | 同一 command ID 搭配不同 payload | command receipt 的既有 digest | 調查用戶端重送邏輯；不得覆寫第一個命令結果 |
| `database_constraint_rejected` | warn | 預期的唯一／檢查／外鍵約束被 module 轉譯 | 無 | 核對 module 是否正確映射為領域結果；不可把原始 SQL 錯誤回傳瀏覽器 |
| `integrity_check_failed` | error | 手動完整性檢查找到違反不變式的資料 | 檢查名稱與不透明資源 ID | 停止對該資源的修復性寫入，先依下列 runbook 逐筆判讀 |

`info` 只記重要狀態轉移，不記每一次成功讀取、搜尋輸入或畫面 render。`warn` 表示擁有者在下次開啟應用程式時可能有可採取操作，或部署設定值得查看。`error` 表示未分類例外、完整性問題或有安全含義的異常；MVP 仍不對外主動通知。

Vercel 平台所保存的 log 是唯一技術留存，期限依實際 Vercel 方案，不在產品內宣稱固定天數。資料庫則只保留領域本身已需要的資料：BGG run／item 與媒體工作狀態、命令 receipt、目前值與最後成功時間。它們不是可搜尋的事件歷史，也不得保存 stack trace 或 payload。

## 告警門檻

本 MVP 的「告警」是進入應用程式可見的需要操作狀態，不是推播：

| 條件 | 介面結果 | Vercel level | 自動行為 |
|---|---|---|---|
| 任一每日 BGG run 有 `failed_count > 0` | 背景更新選單保留失敗數與只重試失敗項目 | `warn` 於 run 結束時 | 不再自動重試 adapter 已用盡的項目 |
| 任一已保存原檔的縮圖為失敗 | 該圖片有明確縮圖失敗與重試入口 | `warn` | 不回滾原檔 |
| 任一批次檔案 ingest 失敗 | 批次列保留該檔失敗狀態與個別重試 | `warn` | 成功檔不受影響 |
| 本次手動來源／筆記／生命週期命令失敗 | 原畫面保留輸入與重試／衝突操作 | `warn`，未分類才 `error` | 不以舊 cache 或樂觀 UI 假裝成功 |
| JWT 被拒絕、設定錯誤、未分類例外或完整性問題 | 通用失敗畫面或拒絕；不暴露細節 | `warn`／`error` | 不重試安全拒絕；不自動修資料 |

一次成功的重試會解除它自己的需要操作狀態；不會清除同一 run、同一批次或其他資源的失敗。使用者看見的是現況，而不是被任意確認消除的紅點。

## 手動復原 runbook

所有操作先以 Vercel deployment、environment、`event`、`requestId`／`runId` 及非敏感 `resourceId` 縮小範圍。不要從 log 複製 secret、signed URL 或內容到 issue／commit／聊天訊息。

### Access JWT 被拒絕

1. 確認事件是否由預期使用者的有效登入觸發；未知來源的單次拒絕只保留 Vercel log，不採取放寬存取的行動。
2. 若有效使用者也被拒絕，核對 Cloudflare Access application audience、Vercel 正式／預覽環境變數及 route protection 是否一致。
3. 用有效 session 與無效／缺少 JWT 各測一次同一受保護 route。前者必須通過，後者必須拒絕。
4. 不可為了暫時恢復存取而略過伺服器 JWT 驗證或改用公開 `.vercel.app` URL。

### 來源操作與 credential

1. `source_unavailable`、`source_rate_limited` 或可恢復 timeout：保留畫面或舊 snapshot，依介面等待 `retryAfter` 後重試；不從 cache 宣稱 fresh 操作成功。
2. `source_authentication_failed`：在正確的 Vercel environment 確認 secret「存在且對應正確供應商」，不把值輸出到 shell 或 log；修正後重新部署，再手動重試一次操作。
3. `source_response_invalid`：保存 provider、operation、source ID、HTTP status 類別與 requestId；以去識別 fixture 重現並修 adapter contract。不得局部丟棄 malformed 白名單欄位後繼續寫入。
4. `source_cache_write_failed`：來源結果本身仍可繼續本次流程。另查 PostgreSQL／migration，不把 cache table 清空當成預設修法。

### BGG 每日更新卡住或有失敗項目

1. 先看應用程式的 run 進度、最後成功時間與失敗數，再以 runId 查 `bgg_refresh_*` 事件。
2. 若 run 正在租約期限內，等目前 worker 結束；不得手動另建同日 run 或同時多次按重試。
3. 租約已到期時，下一次已驗證進入應用程式或一次「只重試失敗項目」會依既有 lease 規則接手。確認接手後 `lease_generation` 有增加。
4. 已完成但有失敗項目時只重試失敗項目。成功、略過、固定目標快照與舊指標值都必須保持不變。
5. 若反覆有 `source_authentication_failed`、限流或 lease recovery，先修 credential、scheduler 或 Vercel 時限的根因，再重試；不可清空 run 表或將舊數值設為空。

### 上傳與縮圖

1. 批次 ingest 失敗時，以 media ID 和 `media_ingest_failed` 查原因，只重試該失敗檔。任何已成功原檔與其資料列不得被再次建立。
2. 原檔成功而縮圖失敗時，以 `media_thumbnail_failed` 重新排同一 media ID 的衍生工作。不可刪原檔、要求重新上傳，或把縮圖當作原檔。
3. 短效網址失敗時，先驗證資料列對應物件是否存在及 Storage policy／environment 是否正確；只重新核發短效 URL，不將 URL 持久化。
4. 若同一物件持續失敗，保留可下載原檔或清楚的無縮圖狀態，停止無界自動重試並用 Vercel log 調查。

### 命令衝突與資料一致性

1. `command_version_conflict` 按既定介面載入伺服器版本或明確重送；不以 retry 迴圈覆寫另一個成功操作。
2. `command_idempotency_conflict` 檢查 client command ID 的生成及重送邏輯，確定相同 ID 沒有被重用於不同 payload。
3. 部署 migration 後、處理 `integrity_check_failed` 時，執行受版本控制的唯讀 `pnpm integrity:check`。該指令在本機／CI 對下列不變式輸出通過或列出不透明 ID，並以非零結束碼失敗：
   - `external_game_identities(provider, source_id)` 對一般收藏庫與資源回收區仍全域唯一，且不會同時解析到兩個遊戲。
   - BGG run 計數等於其 item state 的實際計數；不存在未過期的重複 item lease。
   - 每個 media 原檔與縮圖 state 合法；縮圖失敗不會令原檔失去可存取的權威狀態。
   - 軟移除／封存／資源回收資料仍保留其既定關係；不會出現已移除資料的違法一般讀取。
   - command receipt 的 owner、target、kind、payload digest 一致，且不指向不存在的資源。
4. 檢查失敗後先停止對命中的資源做批次修正，備份查詢結果，判讀每筆權威來源。修復必須是新增的明確 domain command 或 migration，並附 regression test；不可直接以手動 SQL 猜測終態。

## 實作驗證要求

每個會寫事件的 module 至少通過以下測試：

1. 命名錯誤會產生正確 event、level、request／run correlation ID 與 allowlist 欄位；log fixture 不含 token、內容、檔名、header、signed URL 或完整第三方 body。
2. 使用者可重試的失敗不會只寫 log：相對應的畫面／工作資料仍保留可見狀態和既定的單一復原入口。
3. BGG、媒體與生命週期命令在成功重試後只清除自己的未解決狀態，不能清除其他失敗或重複寫入成功資料。
4. 未分類例外記為 `request_unhandled_failure`，介面只得到安全的一般錯誤，且 requestId 可在 Vercel 查到。
5. `pnpm integrity:check` 對每一類違反不變式都以非零結束碼與不透明 ID 失敗；完全通過才回零。它在 migration replay 後的 CI 及部署前驗證執行，不當成生產環境排程。

## 與既有決策的關係

- 使用者畫面狀態仍以 `CONTEXT.md` 的來源更新、BGG 背景更新、媒體、筆記與斷線規則為真本。
- BGG run 的租約、世代、重試範圍與 UI 計數以「BGG 每日指標更新的並行安全流程」為準；本文件只規定其 log 事件與復原觀測面。
- BGG／IGDB 的錯誤名稱、credential 邊界、cache 與遮蔽規則以「BGG／IGDB adapter 介面與錯誤語意」為準。
- 資料庫交易、命令 receipt、版本衝突與生命週期狀態機以「筆記、清單與資源回收狀態機」及「MVP 資料模型與不變式」為準。
- 這些技術事件不改變 Cloudflare Access、Vercel、Supabase PostgreSQL／Storage 的固定邊界；尤其不能藉由 log、RSS 或監控工具把資料帶到未經裁決的第三方服務。
