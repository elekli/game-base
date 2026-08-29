# BGG 每日指標更新的並行安全流程

本文件定稿「每個台北日第一次登入」所觸發的 BoardGameGeek（BGG）重度與 Strategy Game Rank 背景更新。它只處理每日流程的排程、持久化狀態、並行與呈現；不改變既有來源 adapter 的 HTTP、cache、憑證或全域限流決策，也不建立指標歷史。

設計依據：Vercel Functions 會自動擴縮且可有同 instance 的並行 invocation；Supavisor transaction pooler 是 serverless runtime 的連線模式；PostgreSQL 的 transaction-level lock 會在交易結束時釋放。因此，跨 invocation 的正確性以短資料庫交易、持久化租約與 fencing 世代實現，而不是 process 記憶體或 session-level lock。

- [Vercel Functions](https://vercel.com/docs/functions)
- [Supabase：連接 PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [PostgreSQL：Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)

## 裁決摘要

- 每個台北日只有一個持久化的 `bgg_metric_refresh_runs` 執行紀錄；唯一鍵是該日期。第一次已驗證登入以 `Asia/Taipei` 計算日期，原子建立該紀錄及當時符合資格的目標快照。衝突即讀取既有紀錄，不能再建立第二批。
- 執行者以資料庫租約而非 Vercel process state 或 session-level advisory lock 取得工作權。租約失效可由後續登入或「重試失敗項目」接手；接手沿用同一日、同一批目標，不重算資格與總數。
- 每次工作切片只認領 10 個目標。每一個 BGG 呼叫仍必須經既有跨 instance PostgreSQL scheduler，守住每秒最多一次、同時最多一個請求，且互動式手動重新整理優先於背景項目。
- 每個項目僅讓 adapter 執行其既定的最多兩次可恢復 HTTP 重試。仍失敗就保留舊快照，標為失敗；使用者只能重試失敗項目，重試不會重跑當日已成功或尚未失敗的項目。
- 手動完整重新整理在開始抓取前取得較新的寫入世代；每日工作會尊重此世代。任何持有過期租約或較舊世代的回應都不得寫入 `bgg_current_metrics`。

## 領域詞彙與持久化模型

這些名稱是實作資料模型中的技術概念，不新增產品詞彙，也不改寫 `CONTEXT.md` 的領域定義。

| 名稱 | 意義 | 關鍵限制 |
|---|---|---|
| 每日執行紀錄 | 一個台北日期的一次背景更新工作 | `taipei_date` 全域唯一；同日不建立第二筆 |
| 目標快照 | 啟動時符合資格的 BGG 遊戲身分集合 | 只含一般收藏庫、未進資源回收區且已連結 BGG 的遊戲；建立後不重算 |
| 項目 | 一個每日執行紀錄中的一個 BGG 遊戲身分 | `(run_id, external_game_identity_id)` 唯一 |
| 執行租約 | 讓一個短命 Vercel invocation 暫時驅動某執行紀錄的權利 | 含不可重複的 token、到期時間與遞增 fencing 世代 |
| 寫入世代 | 每個 BGG 身分在抓取前取得的單調遞增號碼 | 只有仍是最新世代的成功回應可以寫入最新指標 |

新增的 migration 至少包含下列資料；欄位型別、索引與 RLS 由實作階段定義，但本文件的唯一性與轉移不可省略。

```text
bgg_metric_refresh_runs
  id, taipei_date UNIQUE, state,
  total_count, succeeded_count, failed_count,
  lease_token, lease_generation, lease_expires_at,
  started_at, last_successful_item_at, completed_at

bgg_metric_refresh_items
  id, run_id, external_game_identity_id,
  state, next_attempt_at, attempt_token, attempt_generation,
  item_lease_expires_at, last_error_code, finished_at,
  UNIQUE(run_id, external_game_identity_id)

bgg_metric_write_fences
  external_game_identity_id PRIMARY KEY,
  latest_generation, active_manual_token, manual_lease_expires_at
```

`bgg_current_metrics` 仍是一個以 BGG 外部遊戲身分為鍵、只保存最新重度、排名與最後成功更新時間的資料列。它不是歷史表；每日執行紀錄與項目只是流程可復原性資料。排名的 `null` 仍表示「未排名」，不得寫入 0。

## 觸發、stale 判定與租約

通過 Cloudflare Access JWT 驗證的首頁或任何應用程式入口，在讀取收藏庫快取後，呼叫 `ensureDailyBggMetricRefresh()`。入口回應永遠不等待 BGG；它只取得一個狀態 DTO，並以 `waitUntil` 啟動短背景切片。Vercel 可同時執行多個 invocation，或在背景切片中止後縮到零，因此所有正確性狀態都在 PostgreSQL。

1. 在短交易中用 `now() AT TIME ZONE 'Asia/Taipei'` 算出 `taipei_date`。
2. 以 `INSERT ... ON CONFLICT DO NOTHING` 建立每日執行紀錄；只有插入成功者在同一交易選出資格目標並建立項目，接著寫入不變的 `total_count`。
3. 已有同日紀錄時只讀回狀態，不重新列舉目標。這就是「同一天最多啟動一次」的資料庫仲裁。
4. 背景切片以單一 `UPDATE ... WHERE lease_expires_at < now()`（首次為空）取得 90 秒租約並遞增 `lease_generation`。沒有取得租約的 invocation 立即結束。
5. 租約持有人在每個工作切片開始、認領下一批前，以及每完成一個 BGG 呼叫後延長租約。若距離 Vercel function 的設定時限不足 20 秒，停止認領新項目並正常放棄租約；未完成項目保持可接手。

「stale」只用於租約與項目的 `lease_expires_at < now()`：過期的執行者已失去寫入權，不代表 BGG 數值過期或應清空。每日更新失敗時既有 `last_successful_at` 保持原值。

```text
登入 A                     PostgreSQL                       登入 B
  │                             │                              │
  ├─ ensure(台北日 D) ─────────►│ INSERT run(D) 成功            │
  │                             │ 建立目標快照                  │
  │◄─ 更新中／總數 ─────────────┤                              │
  ├─ 背景切片：取 90 秒租約 ───►│ token=A, generation=1         │
  │                             │                              ├─ ensure(D)
  │                             │◄─────────────────────────────┤ UNIQUE 衝突，讀既有 run
  │                             │─────────────────────────────►├─ 顯示相同進度；不啟動第二批
  │
  └─ 逐項經全域 BGG scheduler 更新
```

## 認領、限流與完成

取得執行租約後，worker 在短交易內以 `FOR UPDATE SKIP LOCKED` 選擇至多 10 個可做項目：`pending`，或可恢復的過期 `in_progress`。交易把它們標為 `in_progress`，寫入新的項目 token、遞增項目世代與 90 秒項目租約；選取交易不做任何網路呼叫。

對每一個項目：

1. 在開始 fetch 前向 `bgg_metric_write_fences` 取得新的背景寫入世代；若有未過期的手動寫入保留，項目回到 `pending` 並在該手動工作結束後再排程，不能和手動重新整理爭搶。
2. 向既有的 BGG scheduler 請求一個背景優先權時段。scheduler 已固定為跨 instance 的每秒最多一個、同時最多一個 BGG 請求；互動操作可排到等待中的背景工作之前。每日流程不得另設 in-memory limiter 或繞過該 scheduler。
3. 透過 adapter 取得並驗證只有重度與 Strategy Game Rank 的快照。adapter 只對既定可恢復錯誤重試，最多兩次；不在每日流程外層再包一層自動重試。
4. 成功時在短交易中同時檢查 run token／世代、項目 token／世代，以及寫入世代仍等於該身分的 `latest_generation`。全都成立才以單一 UPSERT 更新 `bgg_current_metrics` 的兩個值與最後成功更新時間，並把項目標為 `succeeded`、原子遞增 run 成功數與更新 `last_successful_item_at`。
5. 任一檢查失敗代表 worker 已過期或回應已被較新的手動操作取代：不得寫入數值；該項目回到 `pending`（若仍在本日 run）或由手動結果完成，不可把它記為成功。
6. adapter 的可恢復重試仍失敗、或回傳其他命名錯誤時，交易只把項目標為 `failed` 並保存非敏感 `last_error_code`、遞增 run 失敗數；舊 `bgg_current_metrics` 完全不動。下一個項目繼續處理。

每個切片在沒有可認領項目後，交易檢查計數：沒有 `pending`／`in_progress` 時，零失敗為 `completed`，否則為 `completed_with_failures`，寫入 `completed_at` 並清除 run 租約。工作途中掉線則讓租約自然過期；下一次已驗證入口或使用者重試可接手，不能把它誤標為完成。

BGG token 被撤銷、設定缺漏或上游持續拒絕時，各項目會失敗但不會無限重試。這些情況仍保留舊值，並以命名錯誤供後續可觀測性與部署設定處理；不把 token、HTTP body 或 Authorization header 存入資料庫。

## 手動重新整理的交錯規則

手動的完整中繼資料重新整理仍依既有規則：fresh fetch 成功後在短交易原子替換來源管理資料。為了和每日流程互斥，它在 **開始 fetch 前** 先為相同 BGG 身分建立一個手動寫入保留並遞增 `latest_generation`；保留的有效期同樣為 90 秒，且在網路等待期間延長。

- 每日工作較早開始、手動重新整理隨後開始：手動取得較新世代，舊的每日回應在寫入檢查時被拒絕。手動的完整快照寫入其指標，因而成為最新值。
- 手動重新整理先開始：每日 worker 看見有效手動保留，延後該項目，不發 BGG 請求。手動成功或失敗後釋放保留；失敗時每日項目仍是 pending，可在同日續跑。
- 手動操作與每日 worker 都因中止失去租約：任何帶舊 token 或舊世代的回應都不能寫入；下一個接手者以新 token／世代重新抓取。

```text
每日 worker                         DB fence                         手動重新整理
  │ claim generation=41               │                                  │
  ├─ BGG fetch（慢） ────────────────►│                                  │
  │                                    │◄─ reserve manual generation=42 ──┤
  │                                    │                                  ├─ fresh fetch
  │◄─ 舊回應                           │                                  │
  ├─ write if generation=latest ─────►│ 41 ≠ 42：拒絕                   │
  │                                    │◄─ 原子完整 snapshot＋指標 ──────┤
  └─ 回到 pending；不得覆寫            │                                  │
```

這個 fence 是資料正確性的唯一仲裁者；row lock 只保護短交易，不能跨越 HTTP 等待。Supavisor transaction pooler 適合短交易，故不使用 session-level advisory lock。

## 重試與使用者可見狀態

選單的背景更新狀態由每日執行紀錄讀出，不從 Vercel instance 推測：

- 執行中：顯示「已更新 `succeeded_count`／`total_count`」、目前失敗數與最近一筆成功時間。
- 全部完成：顯示最後成功時間與 `total_count`；若有失敗，明確顯示失敗筆數及「只重試失敗項目」。
- 尚未取得任何成功值的遊戲，卡片／詳細頁仍依既有規則顯示未知或未排名；絕不用載入中的空值覆寫快取。
- BGG 不可用時只在背景狀態呈現摘要性錯誤，不逐筆通知、不阻擋收藏庫、搜尋、筆記或媒體操作。

「只重試失敗項目」只接受已完成且 `failed_count > 0` 的本日 run。它在交易中將失敗項目重設為 `pending`、清除舊項目租約與錯誤碼、保留成功項目及固定的目標快照，然後由相同 run 取得新的租約執行。若使用者重複點擊，唯一的 run 與項目列加上 `FOR UPDATE SKIP LOCKED` 使其成為同一個接手，而非兩批重試。

## 必守不變式與驗證目標

實作前後至少要以 pgTAP 與 module integration tests 證明：

1. 同一台北日的並行登入只能建立一筆 run，`total_count` 與目標集合不會被第二個登入改寫。
2. 不同 Vercel invocation 同時認領時，任一項目同一時刻最多屬於一個未過期 token；過期租約可被接手。
3. worker 在 HTTP 等待期間失效後，即使後來收到成功回應，也無法以舊 token 或世代更新指標。
4. 實際 BGG 呼叫在跨 instance 併發測試中仍不超過既有 scheduler 的每秒一次、同時一次上限；互動請求優先於等待的背景項目。
5. 正常回傳的空排名寫成 `null`，不寫 0；無效數值不改動舊快照。
6. 可恢復與不可恢復錯誤都保留舊重度、排名及最後成功時間；每日流程不做 adapter 之外的隱性重試。
7. 手動重新整理與每日更新交錯時，較舊世代永遠無法覆寫較新世代；手動失敗不抹除每日的 pending 項目。
8. 重試只重新處理失敗項目，不能重設成功項目、擴大目標集合或建立第二個同日 run。

## 實作邊界

- 不新增 cron、外部 queue、Redis、Supabase Realtime 或 Edge Function。沒有新的登入請求而 worker 又逾時時，run 會停留可接手狀態；這是以單人、登入觸發的 MVP 範圍換取可恢復性，而非靜默宣稱常駐背景服務。
- 不記錄 BGG 指標歷史、不新增趨勢圖，也不把每日流程擴及 IGDB、資源回收項目、庫外引用或完整來源資料。
- 本文件不替代真實 BGG credential 的實測。正式 adapter 可用後，仍須驗證批次量、timeout 與 BGG 實際處理中／限流回應；若實測顯示既有每秒一次上限不足以保護上游，應調低 scheduler 設定並記錄原因，不改變本流程的資料正確性規則。
