# Issue #66：媒體 reconcile、孤兒清理與可觀測性基線

## 範圍與既定測試 seam

本票補足 #64 留下的持久媒體工作復原：有界 reconcile 喚醒已到期的 thumbnail 工作，且只對狀態帳能證明的衍生物件建立可重試清理工作。它不掃描或刪除未知 Storage 物件，不改變原檔、資產或 ingest 的可用性，也不增加常駐 worker、cron 或新的機器身分。

本票已授權的外部 seam 是：

1. `MediaService` 的 reconcile 命令與其可觀測結果。
2. `MediaStore` 的 PostgreSQL claim／狀態帳操作。
3. `MediaObjectStore` 的衍生物刪除邊界。
4. 已驗證的 private media entrypoint；它只觸發命令並回安全結果。
5. `serializeLogEvent()` 的結構化事件輸出。

## 從意圖導出的不變式

| ID | 類別 | 永遠必須成立 |
|---|---|---|
| R1 | safety | reconcile 每次處理的 thumbnail 與 cleanup 工作數均有明確上限；一次呼叫不做全庫掃描。 |
| R2 | safety | 未到期 lease 的 derivative 不被 reconcile claim、改寫或清理；lease 判斷以取得 row lock 後的 PostgreSQL `clock_timestamp()` 為準。 |
| R3 | safety | reconcile 不建立第二個有效 worker；同一 derivative 的 worker ownership 仍由 #64 的 row lock、attempt number 與 lease token 仲裁。 |
| R4 | safety | 只有 immutable attempt ledger 明確記錄的 object path 才可能進入 cleanup；Storage 列舉結果、未知 path 與原檔永遠不能成為刪除目標。 |
| R5 | safety | cleanup 在刪除前重驗 attempt 並非 active／adopted pointer；不可能刪除 current derivative 或仍可由有效 lease 採用的物件。 |
| R6 | safety | Storage delete 與 PostgreSQL 不共享交易；cleanup job 必須以 durable state 表示 pending、processing、cleaned 或 failed，失敗不會抹掉 ledger 或假裝已清理。 |
| R7 | safety | 結構化事件只含 allowlist 的 UUID、計數、命名 error code 與環境；不得含 token、signed URL、Authorization、Cookie、原始 secret、檔名或 Storage path。 |
| R8 | safety | cleanup、reconcile 或 quota 觀測永不改寫 finalized original、asset、ingest，亦不刪 immutable attempt ledger row。 |
| L1 | liveness | 下一次受驗證的有界 reconcile 終會重新嘗試已到期 pending／processing derivative；未滿既定 retry 規則的工作可再被 worker claim。 |
| L2 | liveness | 已知且可證明的 orphan cleanup 在 Storage 暫時失敗後保留 failed job，並有受限的重試入口；unknown object 不因無法證明而被清理。 |

## 合法狀態與序列化點

```text
finalized original ─────► pending derivative ── claim ─► processing
                                  ▲                         │
                                  │                         │ lease 到期
                                  └──── reconcile 選出 ──────┘
                                                            │
                         active／adopted 不可清理           ▼
attempt ledger ──────────────────────────────────► orphan candidate
                                                     │ ledger path only
                                                     ▼
cleanup job: pending ── claim ──► processing ── delete OK ─► cleaned
                     ▲                 │
                     └──── retry ──────┴── delete／驗證失敗 ─► failed
```

| 操作 | 合法條件 | 序列化點 |
|---|---|---|
| derivative reconcile 選取 | `pending` 已到期，或 `processing` lease 已到期 | derivative row `FOR UPDATE SKIP LOCKED`；鎖後重新比較 DB clock。 |
| worker claim／takeover | 沿用 #64 狀態機及 attempt ledger | derivative row lock、attempt insert、lease token。 |
| 建立 cleanup job | attempt path 已在 ledger；attempt 不是 active／adopted pointer | 先鎖 derivative，再鎖 attempt，鎖後重驗；唯一 attempt→job 關係去重。 |
| cleanup claim | `pending`／`failed` job，或 lease 已到期的 `processing` job；有效 cleanup lease 不可碰 | job row `FOR UPDATE SKIP LOCKED`，鎖後用 DB clock 以新的 fencing token 接手。 |
| delete 後標記 | 僅匹配 claim token 的 job 可完成或失敗 | job row lock＋fencing token；Storage 成功但 DB 失敗留在可診斷狀態，不推論未知成功。 |

## 必須抵抗的交錯與反例

| 交錯／反例 | 若沒有保護會發生什麼 | 設計防線與下游證據 |
|---|---|---|
| reconcile 在 lease 到期前開始、等待 derivative row lock 後才取得鎖 | 交易快照先判定過期或有效，錯誤偷取／跳過 | 鎖後第二次 `clock_timestamp()`；雙連線真 DB 測試。 |
| reconcile 與 worker 同時處理同一到期 derivative | 重複 attempt 或舊 worker 覆寫新 pointer | `FOR UPDATE SKIP LOCKED` 選取，再由既有 claim token／attempt number 仲裁。 |
| cleanup 選到 uploaded attempt 時，worker 正要 adopt | 刪除即將成為 current pointer 的 object | derivative→attempt 固定鎖序，鎖後確認 active／adopted；不安全時 skip，不呼叫 Storage delete。 |
| Storage delete 成功、更新 job 失敗 | 再次 delete 被誤當未知物件或把 ledger 移除 | job 保留 processing／具名失敗，後續以同一 ledger path 重試或判讀；不刪 ledger。 |
| Storage 出現未列入任何 attempt 的 object | reconciliation 誤把 list 結果當孤兒 | 不呼叫 list-as-delete；刪除輸入只能由 ledger join 產生。 |
| event 帶入 adapter error／request | token、URL、path 或 cookie 外洩 | 類別化錯誤＋allowlist serializer 的負向測試。 |

## 架構決策與未決邊界

- PostgreSQL 是 lease 與 cleanup ownership 的時間權威；Node／瀏覽器時鐘只可用於測試等待，不可決定 Production owner。
- reconcile 只是在受驗證入口或既有 worker wake 之後執行的有界 recovery sweep；持久 rows 是工作存在證據，`after()` 遺失不會遺失工作。
- cleanup 不以 Storage list 判定孤兒。它只處理 attempt ledger 可追溯、且當下非 active／adopted 的 derivative path。
- 50 MiB 是現有單檔限制（`supabase/config.toml` 與 private bucket）。Supabase Free 的已記錄容量為 500 MB database／1 GB Storage（ADR 0004）；runbook 因此以實測 Storage usage 為準，warning、stop-write threshold 必須清楚標為此 1 GB 假設的比例，而非供應商保證。
- 本票不加入自動永久刪除 owner content。已軟移除原檔與目前 derivative 都不是 cleanup 對象；備份與永久刪除仍等待 MVP 後的 QNAP 還原驗證。
- 本文件不宣稱形式化證明。程式碼階段以有限狀態轉移／pgTAP、真 DB row-lock 交錯、Storage fault injection 與 serializer 負向測試跨越實作與真實排程的 gap。

## 驗證對應

| 性質 | 主要證據 |
|---|---|
| R1、R2、R3、L1 | 真 PostgreSQL 兩連線測試：鎖後 DB clock、有效 lease 不動、到期 worker 可收斂。 |
| R4、R5、R6、R8、L2 | pgTAP job／trigger約束＋MediaService fault injection：未知 object 沒有 delete call、已知 orphan 的 delete 成功／失敗／重試。 |
| R7 | structured log 單元與 private entrypoint 整合測試，對 token、URL、header、cookie、path 的負向斷言。 |
| 狀態機完整性 | 有限 transition table 對 reconcile／cleanup 合法與非法狀態窮舉，並由 schema drift 與 migration replay 保護。 |
