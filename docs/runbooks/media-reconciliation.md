# 媒體 reconcile、孤兒清理與容量

## 安全邊界

reconcile 只在已驗證的媒體入口回應送出後執行，且每天台北日期最多 claim 一個 5 分鐘 run。每個 run 最多喚醒 10 個到期縮圖及 claim 10 個 cleanup job；下一次已驗證請求會接手過期 run。PostgreSQL `clock_timestamp()` 與列鎖是租約的唯一時間權威，未到期 lease 一律跳過。

cleanup 的輸入只能是 `media_derivative_attempts` 的 immutable `object_path`。它不列舉、比對或刪除 Storage 中未知物件；finalized original、現行 derivative、active attempt 與 adopted attempt 都不符合 predicate。Storage delete 成功後才把 attempt／job 標為 cleaned；失敗保持 failed，下一次有界 reconcile 可重試。

## Retention

MVP 不永久刪除 owner content。finalized original、資產、軟移除資產、資源回收遊戲與現行縮圖不設自動 retention。只處理已有 attempt ledger 證據、非 active／adopted 的衍生物孤兒；ledger row 永不刪除，以保留診斷與重試依據。完成或失敗 cleanup job 也保留到另有經核准的資料保留 migration，不能以維運便利直接清空。

## 容量判讀與門檻

目前單檔上限為 50 MiB（52,428,800 bytes）。本文件以 ADR 0004／既有規格記錄的 Supabase Free Storage 1 GiB 為明示規劃假設，不宣稱它是供應商永久保證。每次 media smoke 或大量上傳前後記錄 Storage usage 與剩餘 headroom；不得把 signed URL、token、物件路徑或檔名寫入記錄。

| 使用率（以 1 GiB 假設） | Headroom | 動作 |
| --- | --- | --- |
| < 75% | > 256 MiB | 正常寫入；仍保留每次量測證據。 |
| 75%～< 90% | 102～256 MiB | 發出 `media_quota_warning`；先完成已知 orphan cleanup、停止大量 smoke fixture，安排 export 或升級方案。 |
| ≥ 90% | ≤ 102 MiB | 發出 `media_quota_stop_writes`；停止新的 media write capability，先取得備份／usage 證據並決定 cleanup、export 或方案升級。 |

50 MiB 單檔代表在 90% 門檻下最多只剩約兩個最大檔的緩衝，因此不能在 warning 後繼續無界批次上傳。恢復寫入前，重新量測並確認已回到 75% 以下。

## 事件與復原

以 `media_reconcile_completed`、`media_reconcile_skipped`、`media_reconcile_failed`、`media_cleanup_completed`、`media_cleanup_failed` 與 quota 事件查 Vercel log。事件只含 request ID、計數、命名 error code 與環境；禁止複製 Authorization、Cookie、secret、signed URL、檔名或 Storage path。

遇到 `media_cleanup_failed` 時，不手動掃描／刪除 bucket。先確認對應 job 仍為 failed、attempt 仍為 `cleanup_pending`，等待下一次受驗證 reconcile 重試。若反覆失敗，先修 Storage binding 或容量根因，再重試；不可改寫 attempt identity 或刪除 ledger。
## 容量快照

部署必須注入 `MEDIA_STORAGE_USED_BYTES` 與 `MEDIA_STORAGE_CAPACITY_BYTES`，兩者均為非負整數 byte，且容量必須大於 0。這是經營者核對 Supabase 用量後更新的已驗證快照；任一欄缺漏、格式無效或讀取失敗時，新上傳一律 fail closed。使用率達 75% 產生 warning，達 90% 暫停新寫入；既有讀取、reconcile 與 cleanup 繼續運作。
