# Issue #64：thumbnail lease 實作與驗證基線

## 範圍

本切片完成 `thumb_webp_v1` 的持久工作、claim／takeover、有限自動重試、實際 WebP 轉換、Storage attempt 與現行 pointer 採用。#65 才負責相簿 UI；本切片提供 `pending`／`processing`／`ready`／`failed` 狀態，使 UI 不需以原檔冒充縮圖。

```text
finalized original
       │ 建立 pending derivative（同一交易）
       ▼
    pending ──claim＋新 attempt──► processing
       ▲                              │
       │ transient＋未滿 3 次         ├─ upload attempt ─ mark uploaded ─ adopt ─► ready
       │                              │
       └──────── bounded backoff ─────┤
                                      ├─ deterministic content error ─► failed
                                      └─ lease expired ─► 新 worker takeover＋新 attempt
```

## 獨立於實作的不變式

| ID | 種類 | 永遠必須成立 |
|---|---|---|
| S1 | safety | derivative 的任何狀態轉移、Storage 錯誤或 DB 錯誤都不得改寫／刪除 finalized original、asset 或 ingest。 |
| S2 | safety | 同一 derivative 同時最多一個未過期 lease；只有匹配 PostgreSQL 時鐘下仍有效的 lease token 才能完成當前 attempt。 |
| S3 | safety | attempt number 對 derivative 單調遞增；object path 唯一且永不覆寫。 |
| S4 | safety | 只有當前 attempt 可成為 `current_object_path`；takeover 前的 worker 即使晚到，也只能留下具名 orphan candidate。 |
| S5 | safety | `ready` 當且僅當 pointer、width、height、byte size、completed time 與 adopted attempt 同時存在；其它狀態不得保留現行 pointer。 |
| S6 | safety | 每個自動重試週期最多 3 次；手動 retry 明確開始新週期，但總 attempt number 不歸零。 |
| S7 | safety | decode／像素／可重現內容錯誤直接 `failed`；暫時 Storage／network／invocation 錯誤才進有界 backoff。 |
| S8 | safety | attachment 不建立、claim 或處理 thumbnail derivative。 |
| L1 | liveness | 到期的 `processing` lease 可由後續 worker 接手；未到期 worker 不被搶走。 |
| L2 | liveness | 未滿重試上限的暫時錯誤會回到可再次 claim 的 `pending`；耗盡或內容錯誤有單一手動 retry 入口。 |

## 風險交錯與序列化點

| 交錯 | 禁止結果 | 序列化點／證據 |
|---|---|---|
| W1、W2 同時 claim pending | 兩個有效 worker | derivative row `FOR UPDATE`；交易內建立 attempt 並設定唯一 lease。 |
| W1 upload 完成後 lease 到期，W2 takeover，W1 晚到 | W1 覆蓋 W2 pointer | adoption 比對 derivative lease token、未過期 DB clock 與 attempt number。 |
| Storage upload 成功，mark uploaded／pointer transaction 失敗 | 無帳可追的未知 object | attempt 在 upload 前已以精確 path 持久化；未 adopted attempt 不得成為 current。 |
| mark uploaded 成功，pointer transaction 失敗 | derivative 假裝 ready | `uploaded` 與 `adopted` 分開；只有 adopt transaction 同時設定 pointer 與 ready。 |
| 第 3 次 transient failure | 無界重試 | current cycle failure count 在同一交易遞增並轉 failed。 |
| failed 後手動 retry 與舊 worker 晚到 | 舊 attempt 被重新採用 | retry 清 lease、增加 retry cycle；舊 token／attempt 不再匹配。 |

## 架構決策

- PostgreSQL 時鐘判定 lease 與 backoff；application clock 只供純記憶體測試，不決定 Production ownership。
- `after()` 只在 authenticated finalize Route Handler 回應後喚醒 worker；持久 `pending` row 才是工作存在的證據。`after()` 遺失由 #66 reconcile 接手。
- Storage upload 採 `upsert: false` 且 path 含 asset id、spec、單調 attempt number 與 attempt id。
- 轉換使用明確 production dependency；自動 orientation、長邊至多 640 px、禁止放大、保留 alpha、動圖只取第一幀、移除 metadata、WebP quality 80、輸入像素至多 100,000,000。
- thumbnail failure 只改 derivative／attempt；original read contract 不看 derivative 狀態。

## 驗證對應

| 性質 | 最強證據 |
|---|---|
| S1、S5、S8 | migration constraint＋pgTAP＋真 PostgreSQL integration。 |
| S2、S4、L1 | 兩連線交錯測試：未過期排拒、逾時 takeover、舊 token 晚到。 |
| S3 | unique constraint＋並行 claim／attempt rows。 |
| S6、S7、L2 | model-based state transition test＋故障注入。 |
| 轉換規格 | 真實 raster fixtures 驗 dimensions、format、alpha、animation page count、metadata。 |
| Storage 成功／DB 失敗 | fake network seam＋真 DB，證明 original 保留且 attempt 可追。 |

## 尚待後續票

- #65：390 px 相簿占位、手動 retry 操作與批次 UI。
- #66：每日 reconcile、aged reserved／uploaded attempt cleanup 與 orphan Storage delete。
- #67：完整 Production media smoke 與資源回收不變性。

## Formal 驗證紀錄

本切片以 `src/modules/media/internal/thumbnail-state.test.ts` 做可執行的有限狀態模型，並由 `tests/database/media-service.test.ts` 的兩連線 row-lock、lease takeover、舊 token 晚到、三次封頂、manual retry 與 upload 後 pointer failure 交錯測試補強。

未執行 TLC：本機沒有 `tlc` 可執行檔，且專案未固定 TLA+／TLC 版本或可離線取得的工具鏈；為避免在本票任意加入未鎖定的 formal tooling，沒有宣稱 formal proof。上述 Vitest 與 pgTAP 是本票實際執行的證據，不等同形式化證明。
