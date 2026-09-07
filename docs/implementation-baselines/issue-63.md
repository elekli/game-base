# Issue #63 實作基線

## 已由 repository 內自動驗證

- 瀏覽器上傳使用官方 `tus-js-client@4.3.1`，不是自行實作部分 TUS 協定。
- 本機假 TUS server 已實際收到大於 6 MiB 檔案的 6 MiB creation chunk 與尾段 `PATCH`；測試不是只檢查 options DTO。
- creation response 缺少 `Location` 時，client 會依固定 retry policy 重試 `POST`。
- client 已取得 upload URL 後若遺失 `PATCH` response，會對同一 URL 發 `HEAD` 取得 server offset，而非從零重傳已被接受的內容。
- 相同 ingest fingerprint、檔案大小、metadata 與 endpoint 子路徑的既有 upload URL 會先經 `findPreviousUploads()` 找回，再以 `resumeFromPreviousUpload()` 續傳。
- client 只送 server grant 內的 `x-signature` 與固定 metadata，不送 `x-upsert`；成功後才移除 URL storage 內的 fingerprint。
- `SupabaseMediaObjectStore` 對含明確 port 的本機 `SUPABASE_URL` 所產生之 endpoint，可不經改寫直接交給 browser client，並完成上述 TUS 流程。

## 真實 Supabase 驗證

2026-09-07 以 repository migration 重播後的隔離環境實測：

- Supabase CLI `2.116.0`，Storage API `v1.70.3`。
- `/storage/v1/upload/resumable/sign` 可接受同一個本機 Storage stack 核發的 signed upload token。
- 建立 session、`PATCH`、60 秒 signed read 與測試物件清理均成功。

同日以 Production private `game-media` bucket 與隨機 object path 實測：

- 正式 `tus-js-client` 可透過 direct Storage hostname 完成 signed TUS upload。
- CORS preflight 允許測試 origin、TUS headers 與 `x-signature`。
- 錯誤 signature 與 capability 以外的 object path 均被拒絕。
- 中斷點後以 `HEAD` 取回精確 offset，再從該 offset 完成 `PATCH`。
- `upsert: false` 在物件存在時拒絕核發第二個 grant，未覆寫原物件。
- 60 秒 signed read 回傳精確 bytes 與 attachment disposition。
- 所有隨機測試 path 均已清理。

## Endpoint 漂移診斷

Supabase 公開 Storage 原始碼以 `SIGNED_URL_SUFFIX = '/sign'` 分流 signed TUS，驗收測試也把 signed upload 指向 `tusEndpoint/sign`：

- [signed TUS request 驗證分支](https://github.com/supabase/storage/blob/c015666ee13ee29faab50cf76ac513d73bdb6bfc/src/http/routes/tus/lifecycle.ts)
- [signed TUS acceptance test](https://github.com/supabase/storage/blob/c015666ee13ee29faab50cf76ac513d73bdb6bfc/acceptance/specs/tus.test.ts)

官方 Resumable Uploads 文件仍把一般 bearer TUS endpoint 寫為 `/storage/v1/upload/resumable`，但沒有在 signed token 範例中明載 `/sign` suffix。把 `x-signature` 送到未帶 suffix 的一般 endpoint，會得到 `AccessDenied`／`Invalid Compact JWS`；這是路由錯置，不是 token 結構損壞。

先前把相同錯誤對應到 [supabase/storage#1268](https://github.com/supabase/storage/issues/1268) 是 false positive；本專案改用現行 signed endpoint 後，本機與 hosted smoke 均通過。
