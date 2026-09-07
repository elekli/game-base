# Issue #63 實作基線

## 已由 repository 內自動驗證

- 瀏覽器上傳使用官方 `tus-js-client@4.3.1`，不是自行實作部分 TUS 協定。
- 本機假 TUS server 已實際收到大於 6 MiB 檔案的 6 MiB creation chunk 與尾段 `PATCH`；測試不是只檢查 options DTO。
- creation response 缺少 `Location` 時，client 會依固定 retry policy 重試 `POST`。
- client 已取得 upload URL 後若遺失 `PATCH` response，會對同一 URL 發 `HEAD` 取得 server offset，而非從零重傳已被接受的內容。
- 相同 ingest fingerprint、檔案大小、metadata 與 endpoint 子路徑的既有 upload URL 會先經 `findPreviousUploads()` 找回，再以 `resumeFromPreviousUpload()` 續傳。
- client 只送 server grant 內的 `x-signature` 與固定 metadata，不送 `x-upsert`；成功後才移除 URL storage 內的 fingerprint。
- `SupabaseMediaObjectStore` 對含明確 port 的本機 `SUPABASE_URL` 所產生之 endpoint，可不經改寫直接交給 browser client，並完成上述 TUS 流程。

## 尚未由真實 Supabase 證明

假 TUS server 只能驗證 client 的 request 與狀態轉移，不能代表 Supabase Storage 的授權及 CORS 行為。下列項目仍須以本機 Supabase 或受保護的 Production smoke 驗收：

- 真實 Supabase 是否拒絕錯誤或過期的 `x-signature`。
- 真實 Supabase 是否拒絕 capability 以外的 object path，以及在未送 `x-upsert` 時拒絕覆寫既有物件。
- Storage TUS endpoint 的實際 CORS preflight、允許的 request headers 與瀏覽器跨來源上傳。
- Production direct Storage hostname、簽署 token 與 private `game-media` bucket 的完整串接。

在這些 smoke 完成前，不得用假 server 測試宣稱真實 Supabase 的供應商授權、路徑隔離、覆寫保護或 CORS 已驗收。

## 本機 Supabase 阻擋證據

2026-09-07 以 repository migration 重播後的隔離環境實測：

- Supabase CLI `2.116.0`，Storage API `v1.70.3`。
- 同一個本機 Storage stack 可成功核發 signed upload token。
- CORS preflight 允許測試 origin、TUS headers 與 `x-signature`。
- 錯誤 signature 與 capability 以外的 object path 均回 4xx。
- 但合法 token 建立 TUS session 時回 HTTP 400、`AccessDenied`、`Invalid Compact JWS`，因此沒有 session 可供 PATCH／HEAD／finalize 驗收。

此結果符合上游仍開啟的 [supabase/storage#1268](https://github.com/supabase/storage/issues/1268)。該上游問題只證明本機 stack 受阻，不代表 hosted Supabase 同樣失敗。#63 的供應商邊界須改由 Production Storage smoke 完成；在成功前 issue 維持開啟。
