# 媒體上傳、縮圖與生命週期

本文件把 `CONTEXT.md` 已定義的封面、相簿圖片與附件規則落成可實作的資料模型與狀態機。它不是 migration 或程式碼；實作時 `supabase/migrations/` 仍是唯一 schema 真本。

## 裁決摘要

- 瀏覽器以每檔一個短效簽署權杖，透過 Supabase TUS 直接把原檔上傳到私有 Storage；所有大小都走同一條可續傳路徑，6 MiB 分塊、`upsert: false`。
- 每個 Storage 寫入先有 PostgreSQL 狀態帳。原檔直接寫入最終且不可覆寫的隨機路徑；是否出現在產品中由資料庫關聯決定，不另做非原子的 Storage move。
- 每個使用者選取的檔案有獨立冪等鍵。重試、double-click、連線中斷及成功回應遺失，都只能完成同一個 ingest 與同一個媒體資產。
- 原檔通過完成確認（finalize）並建立媒體關聯後即為成功；圖片縮圖另有 `pending`／`processing`／`ready`／`failed` 狀態，永不回滾已成功的原檔。
- Next.js Node.js 以 `after()` 觸發即時縮圖工作；資料庫狀態才是持久工作佇列。每個台北日第一次通過身分驗證的請求另啟動一次有界 reconcile，接回逾時工作與清理已知孤兒，不新增 Vercel Cron 或另一種機器身分。
- 相簿圖片、自訂封面與附件個別移除一律軟移除。一般介面隱藏，Storage 原檔與目前縮圖不動；遊戲移入資源回收區也不改媒體列或物件。

## 詞彙與邊界

| 詞彙 | 定義 |
|---|---|
| 媒體 ingest | 一次建立權威原檔的工作狀態帳；可來自瀏覽器上傳或伺服器抓取來源封面。 |
| 媒體資產 | 已通過 finalize、可被產品關聯的權威原檔。Storage 物件單獨存在不算媒體資產。 |
| 媒體用途 | `gallery_image`、`custom_cover`、`attachment` 或 `source_cover`；用途決定可否產生縮圖、可否成為封面及可否由擁有者移除。 |
| 縮圖 | 從圖片原檔產生、可重建的 `thumb_webp_v1` 衍生物。 |
| 人工封面選擇 | 遊戲對一筆未移除圖片資產的可空引用；空值表示自動使用目前來源封面。 |
| 已知孤兒 | 已有 ingest／derivative attempt 狀態帳，卻沒有成功媒體關聯或現行縮圖指標的 Storage 物件。只有這類物件可自動清理。 |

庫外清單引用只有本地 WebP 封面縮圖、沒有權威原檔，不符合「媒體資產」定義；其資料列與轉正關係由「將既有筆記、清單與刪除規則落成狀態機」定義，但可重用本文件的私有 Storage adapter 與短效讀取能力。

## 概念模型

```text
瀏覽器選取檔案                  BGG／IGDB 來源封面
       │                               │
       │ beginUpload                   │ beginSourceCoverIngest
       ▼                               ▼
┌─────────────────────────────────────────────┐
│ media_ingests                               │
│ 冪等鍵、保留的 asset id、最終 object path   │
│ issued → finalizing → finalized             │
│              └→ cleanup_pending → expired   │
└──────────────────────┬──────────────────────┘
                       │ finalize 後一對一
                       ▼
              ┌──────────────────┐
              │ media_assets     │
              │ 權威原檔與用途   │
              │ active／removed  │
              └───────┬──────────┘
                      │ 圖片恰有一個 v1 derivative
                      ▼
              ┌──────────────────┐
              │ media_derivatives│
              │ pending／ready   │
              │ processing／failed│
              └───────┬──────────┘
                      │ 每次物件寫入先登記
                      ▼
              derivative_attempts

games.manual_cover_asset_id ──► 未移除且屬同一遊戲的圖片
external_game_identities.source_cover_asset_id ──► 最新來源封面
```

## 資料模型

### `media_ingests`

每個原檔物件建立前先新增一筆狀態帳資料：

- `id`：ingest 主鍵。
- `idempotency_key`：全域唯一。瀏覽器每個選取檔案產生一個 UUID；伺服器來源封面流程由一次來源更新操作產生並在重試時沿用。
- `reserved_asset_id`：預先保留的媒體資產 UUID，亦用於建構物件路徑。
- `channel`：`browser_tus` 或 `source_fetch`。
- `purpose`：`gallery_image`、`custom_cover`、`attachment` 或 `source_cover`。
- `game_id`；來源封面另有 `external_game_identity_id`。用途不符時由資料庫約束拒絕。
- `original_object_path`：全域唯一、不可猜、不可由原始檔名衍生。
- 原始檔名、宣稱 MIME、宣稱 byte 數；finalize 後另存實際 MIME、byte 數與圖片寬高。
- `state`、`lease_token`、`lease_until`、`stale_after`、`last_error_code`、建立／完成時間。

狀態只能是 `issued`、`finalizing`、`finalized`、`cleanup_pending`、`expired`。一個 ingest 最多建立一個媒體資產，資料庫以 `media_assets.ingest_id UNIQUE` 保證。

### `media_assets`

- `id` 使用 ingest 預留的 UUID；`ingest_id` 唯一且不可空。
- `game_id`、`purpose`、`original_object_path`、原始檔名、實際 MIME、byte 數、圖片寬高、建立時間。
- 相簿圖片保存選填說明；附件保存原始檔名、可空顯示名稱與說明。用途不適用的欄位須為空。
- `removed_at`、`removed_reason`：只供相簿圖片、自訂封面與附件使用。來源封面不可由擁有者個別移除；來源更新時以 `superseded_at` 保留舊資產。
- 資料列沒有「原檔處理中」狀態：只有完成確認成功才建立，因此存在即代表權威原檔可用。

### `media_derivatives` 與 `media_derivative_attempts`

每筆圖片資產建立一筆 `(asset_id, spec)` 唯一的 derivative；附件不建立：

- `spec` 固定為 `thumb_webp_v1`。
- `state`：`pending`、`processing`、`ready`、`failed`。
- `current_object_path` 只有 `ready` 可非空；另存 width、height、byte 數與完成時間。
- `attempt_count`、`next_attempt_at`、`lease_token`、`lease_until`、`last_error_code`。

每次產生縮圖先新增 derivative attempt，為它保留新的隨機 object path。上傳成功後才以資料庫交易把 derivative 指向該路徑並標為 `ready`。工作若在 Storage 寫入後、資料庫提交前中斷，attempt 仍能識別該孤兒；重試不覆寫舊路徑。

### 封面指標與資料庫不變式

- `games.manual_cover_asset_id` 可空；非空時必須指向同一遊戲、未軟移除、用途為 `gallery_image` 或 `custom_cover` 的圖片。
- 空值時讀取端解析 `external_game_identities.source_cover_asset_id`；兩者都沒有時才是無封面。
- `custom_cover` 完成確認時，在建立 asset 的同一交易中把它設為人工封面；先前封面只失去「目前封面」身分，不因新上傳而自動移除。一般相簿圖片完成上傳時不會自動成為封面，須另行執行 `selectManualCover`。
- 移除目前人工封面時，同一交易先清空 `manual_cover_asset_id` 再寫 `removed_at`。還原只清除 `removed_at`，不重建人工封面指標。
- 遊戲移入資源回收區不改 `media_assets`、`media_derivatives` 或 Storage；一般查詢由遊戲的 `trashed_at` 隱藏整組資料。
- 所有產品資料表禁止對 Storage 採自動級聯刪除。MVP 沒有刪除已 finalize 原檔或現行縮圖的應用程式路徑。

## Storage 路徑與能力

所有物件都在單一 private bucket；bucket 的 file size limit 固定為 52,428,800 bytes。原始檔名只存資料庫供顯示，永不進入 path。

```text
originals/<reserved_asset_id>/<random_uuid>
thumbnails/<asset_id>/<generation_uuid>.webp
```

- 原檔路徑建立後永不覆寫，所有 browser TUS 與 server fetch 都使用 `upsert: false`。
- thumbnail generation 每次使用新路徑；不覆寫 CDN 可能仍快取的物件。
- 資料庫只保存 object path，不保存 signed URL、TUS URL 或 upload token。
- 列表、搜尋結果及相簿網格由伺服器批次核發約 5 分鐘的 thumbnail signed URL。
- 點開圖片或附件、下載原檔時才核發約 60 秒的 original signed URL；下載時設定原始檔名。signed URL 不進 log、分析事件或可分享 URL。
- 軟移除資產不核發一般讀取 URL；還原操作本身不需要 URL。
- 所有列出媒體或核發 signed URL 的回應沿用私人資料邊界，設定 `Cache-Control: private, no-store`；URL 到期後由新的已驗證請求重發，不寫入持久快取。

## 瀏覽器上傳流程

Supabase 建議檔案大於 6 MB、網路不穩或需要進度事件時使用 TUS。為避免批次內出現兩套重試語意，MVP 所有檔案均走 TUS，批次最多同時傳 3 檔。`tus-js-client` 的自訂 fingerprint 必須包含 ingest id 與 object path；不能只依檔名、大小或修改時間尋找舊上傳，避免同一檔案在兩次操作間接錯 TUS session。

```text
Browser                 Next.js／Media module       PostgreSQL          Supabase Storage
   │ 選檔；本機檢查 ≤50 MB     │                         │                      │
   │ beginUpload(key, metadata)│                         │                      │
   ├──────────────────────────►│ 驗 owner／用途／宣稱大小│                      │
   │                           ├── INSERT ingest ───────►│                      │
   │                           │ create signed token     ├─────────────────────►│
   │◄── path＋2h token ────────┤                         │                      │
   │                           │                         │                      │
   │ TUS：6 MiB chunks，x-signature，upsert false                               │
   ├───────────────────────────────────────────────────────────────────────────►│
   │◄── progress／resume URL（最長 24h）────────────────────────────────────────┤
   │                           │                         │                      │
   │ finalize(key)             │                         │                      │
   ├──────────────────────────►│ claim finalize lease    ├─────────────────────►│
   │                           │ 查 exact object metadata ├────────────────────►│
   │                           │ 驗實際大小／圖片 header  │◄────────────────────┤
   │                           │ create asset＋derivative├─────────────────────►│
   │◄── original_saved ────────┤ after(processThumbnail) │                      │
   │                           │                         │                      │
   │ 顯示成功；縮圖處理中       ├── claim derivative ────►│                      │
   │                           ├── stream original ────────────────────────────►│
   │                           ├── upload WebP ────────────────────────────────►│
   │                           ├── mark ready ──────────►│                      │
   │ polling／下一次讀取取得 ready 或 failed                                 │
```

### 三層驗證

1. 瀏覽器在建立 intent 前，以 `File.size` 拒絕空檔與超過 50 MB 的檔案；這只提供即時回饋。
2. `beginUpload` 重新驗證宣稱大小、用途、遊戲狀態及同一冪等鍵的參數一致性；bucket 以 50 MB 硬上限阻擋繞過應用程式的超限寫入。
3. `finalize` 以 server-only Storage adapter 查精確路徑的實際 byte 數，要求大於 0、不超過限制且與瀏覽器宣稱相同。圖片另以串流方式解析檔頭，驗證為可處理的點陣影像、尺寸非零且不超過 100 megapixels；SVG 不作為相簿圖片或封面接受。附件不信任 MIME 決定權限，非 PDF 一律以 attachment disposition 下載。

圖片說明、附件顯示名稱與說明都不參與 begin 或完成確認；原檔成為資產後才由獨立更新操作補充，留白不阻擋上傳。

不合格物件從未成為媒體資產，因此可進入 `cleanup_pending`；這不違反「成功原檔不得回滾」，因為成功邊界明確在完成確認之後。

## Ingest 狀態機

```text
                         begin（相同 key 重送回原結果）
                                     │
                                     ▼
                                  issued
                    object 缺少 ─────┼───── stale_after 到期
                   UploadIncomplete  │               │
                                     │ finalize claim│
                                     ▼               │
                                 finalizing          │
                         ┌───────────┼───────────┐    │
             lease 逾時  │           │           │    │
               重試 ─────┘     驗證不合格       DB commit
                                     │           │
                                     ▼           ▼
                              cleanup_pending  finalized
                                     │
                            Storage delete 成功
                            或確認物件不存在
                                     │
                                     ▼
                                  expired
```

- `finalize` 先以短交易取得列鎖並寫入有限租約，再到交易外查 Storage，最後以第二個短交易建立 asset。cleanup 只可 claim 已過 `stale_after` 的 `issued` 或租約已逾時的 `finalizing`，避免刪除仍在 finalize 的物件。
- 瀏覽器 ingest 的 `stale_after` 是最近一次成功核發或重發 upload grant 後 26 小時：長於 Supabase TUS upload URL 的最長 24 小時，避免清理仍可續傳的工作。每次重發須在同一交易更新期限；只更新權杖卻不延後期限是禁止狀態。
- Supabase 負責回收未完成 TUS session 的內部分塊；應用程式的孤兒清理只處理已出現在本 bucket 精確 object path、卻未完成關聯的物件，不猜測或直接操作供應商內部暫存。
- begin 已建立 ingest、但 createSignedUploadUrl 暫時失敗時，狀態仍是 `issued` 且不宣稱上傳已開始；同一冪等鍵重試只重發該 path 的 grant，不新增 ingest。
- `finalize` 成功回應遺失時，同一冪等鍵再次呼叫會直接回既有 asset；不得建立第二列或重新上傳。
- 同一鍵搭配不同 game、purpose、檔名或大小時回 `MediaUploadIdempotencyConflict`，不沿用舊權杖。

## 縮圖規格與狀態機

`thumb_webp_v1` 固定為：依 EXIF orientation 轉正、保留長寬比、長邊至多 640 px、不放大小圖、保留透明度、動圖取第一幀、移除 metadata，以 WebP quality 80 輸出。原檔不受任何轉換。

```text
             asset finalize
                   │
                   ▼
                pending ◄──────────── lease 逾時
                   │ claim                   │
                   ▼                         │
               processing ──────────────────┘
                 │      │
      upload＋DB 成功    └── 命名錯誤／重試耗盡
                 │                     │
                 ▼                     ▼
                ready                failed
                  │                     │
       遺失／損壞 │                     │ 擁有者重試
                  └────────► pending ◄──┘
```

- `after()` 只負責喚醒工作，不是完成證據。worker 必須以 compare-and-set 租約 claim derivative；同一 asset 同時最多一個有效 worker。
- transient Storage／network／function termination 以最多 3 次自動嘗試及有上限的退避處理；租約到期可被後續 reconcile 接回。
- 無法解碼、像素限制或可重現的內容錯誤直接標 `failed`；使用者按重試時建立新的 attempt，但不改原檔成功結果。
- `ready` 必須同時具有現行 object path、尺寸、byte 數與完成時間；資料庫不允許「ready 但無物件指標」。
- 已是 `ready` 的縮圖若讀取時確認遺失或損壞，修復操作須以交易清除現行指標並轉回 `pending`；舊路徑成為有狀態帳可追溯的 derivative orphan，新縮圖完成後才重新進入 `ready`。
- 網格遇到 `pending`／`processing`／`failed` 顯示有狀態與重試入口的占位，不以原檔冒充縮圖。只有明確點開資產才取得原檔 URL。

## 來源封面

來源 adapter 在資料庫交易外取得完整來源 snapshot；來源封面使用同一 ingest ledger，但由 server-only adapter 抓取並以 `upsert: false` 寫入私有 bucket：

1. 一次建立／連結／重新整理操作產生固定 idempotency key；該操作重試時沿用，日後新的重新整理使用新 key。
2. 驗證重新導向、逾時、50 MB、點陣影像檔頭與像素限制後才完成確認。
3. 新來源封面 asset 與來源快照在同一 PostgreSQL 交易中成為目前指標；失敗時保留舊快照與舊來源封面，不留下新舊混合狀態。
4. 被取代的來源封面寫 `superseded_at` 並從一般讀取隱藏，但 MVP 不刪除其原檔。新的 asset 另行產生縮圖。

外部來源失敗不得影響既有來源封面；人工封面選擇也不因來源重新整理而改變。

## 軟移除與資源回收

```text
active media ── remove ──► removed media
     ▲                          │
     └──────── restore ─────────┘

若 media == games.manual_cover_asset_id：
remove transaction = clear manual cover pointer ＋ set removed_at
restore transaction = clear removed_at（不恢復 pointer）

game active ── move to trash ──► game trashed ── restore ──► game active
                     媒體列、縮圖狀態、Storage 物件全部不變
```

- 軟移除後 caption、顯示名稱、建立時間與所有物件指標完整保留；立即復原以同一 asset id 完成。
- 來源封面沒有使用者 remove／restore 操作；「恢復來源封面」只清除人工封面指標。
- 已接受原檔與現行縮圖永不進入孤兒清理。只有未完成確認的 ingest、未成為現行衍生物的 attempt 物件可刪除。

## 重試與孤兒清理

### 即時與每日喚醒

- 每次 finalize 成功後，Route Handler／Server Action 以 Next.js `after()` 喚醒該 asset 的縮圖工作，回應不等待縮圖。
- 每個台北日第一次成功 `requireOwner()` 的請求，以 `media_reconciliation_runs(local_date UNIQUE)` claim 一次有界 reconcile，再用 `after()` 執行。它不增加外部可呼叫端點、Vercel Cron 或繞過 Cloudflare 的身分。
- reconcile 每輪限制筆數與執行時間：接回 expired lease、處理可自動重試 derivative、刪除 `cleanup_pending` 已知孤兒。未處理完保留可見 backlog，下一個擁有者請求或人工重試再續跑。

### 清理安全規則

1. 所有應用程式 Storage 寫入前必須先有狀態帳與精確 path；沒有狀態帳的未知物件只能報告，MVP 不自動刪除。
2. cleanup 先以資料庫租約 claim candidate，再重新證明沒有 `media_assets` 或現行 derivative 引用該 path，才呼叫 Storage delete。
3. delete 成功或 Storage 回報物件不存在後才標 `expired`／attempt cleaned；暫時失敗保留 `cleanup_pending` 並記命名錯誤。
4. 已 finalize 的原檔、目前縮圖、軟移除資產與資源回收遊戲的物件永不符合 cleanup predicate。

## 命名失敗與介面行為

| 錯誤 | 觸發與結果 | 可否重試 |
|---|---|---|
| `MediaFileTooLarge` | 前端、begin 或 bucket 發現超過 50 MB；該檔失敗，批次其餘檔案繼續。 | 換檔後才可。 |
| `MediaUploadIdempotencyConflict` | 同一鍵搭配不同不可變參數；不核發新能力。 | 以正確原檔或新鍵重建。 |
| `MediaUploadGrantExpired` | 2 小時簽署權杖尚未建立 TUS session 就到期；同 intent／path 可重發。 | 可。 |
| `MediaUploadInterrupted` | 網路中斷；TUS 以同一 upload URL／fingerprint 從已完成 chunk 續傳。 | 可。 |
| `MediaUploadIncomplete` | finalize 查不到完整物件；不建立 asset。 | 繼續上傳後重試。 |
| `MediaStoredObjectInvalid` | 實際大小不符、空檔、圖片 header／像素不合格；轉 cleanup。 | 修正檔案後以新 intent。 |
| `MediaFinalizeUnavailable` | Storage 查詢或 PostgreSQL commit 暫時失敗；原物件與 intent 保留。 | 同鍵 finalize。 |
| `MediaThumbnailUnsupported` | 原檔成功，但 thumbnail decode／格式無法處理；顯示警告。 | 手動重試；相同內容可能再失敗。 |
| `MediaThumbnailUnavailable` | 暫時性 Storage、network 或 function 錯誤；保留原檔與 job。 | 自動最多 3 次，之後手動。 |
| `MediaCleanupUnavailable` | 已知孤兒刪除失敗；保留清理狀態帳，不假裝清完。 | reconcile 重試。 |
| `MediaNotFoundOrRemoved` | 一般讀取要求不存在、已移除或屬於資源回收遊戲的資產。 | 還原後再取。 |

批次 UI 的每個檔案只對應自己的 idempotency key 與狀態。按「只重試失敗項目」不得重送 `finalized` 檔案；縮圖失敗顯示在已上傳成功項目之下，不混入上傳失敗清單。

## Module 介面

公開介面以使用者意圖為單位，不暴露 Storage path、Drizzle row 或 Supabase client：

```text
beginMediaUpload(context, command) -> UploadGrant
finalizeMediaUpload(context, command) -> MediaUploadResult
removeMedia(context, assetId) -> MediaRemovalResult
restoreMedia(context, assetId) -> MediaAsset
selectManualCover(context, gameId, assetId) -> CoverResult
useSourceCover(context, gameId) -> CoverResult
retryThumbnail(context, assetId) -> ThumbnailStatus
issueThumbnailReads(context, assetIds) -> ShortLivedReads
issueOriginalRead(context, assetId, disposition) -> ShortLivedRead
```

`ingestSourceCover`、`processThumbnail`、`reconcileMedia` 與 Storage adapter 是 module internal。所有公開入口先取得 `VerifiedOwner`；browser 永遠只取得單一路徑的 upload token 或短效讀取 URL，不取得 Storage secret、list 能力或任意 path builder。

## 實作前驗證目標

### PostgreSQL／pgTAP

- 同一 idempotency key 並行 begin 只得到一個 ingest、asset id 與 object path；不同參數重用會失敗。
- 同一 ingest 並行 finalize 最多建立一個 asset；成功回應遺失後重試回同一結果。
- ready derivative 必有現行 path；attachment 不得有 derivative；移除中的資產不得成為人工封面。
- 移除目前封面原子地清除指標；還原不重建指標。遊戲進出資源回收區不改媒體列。
- 清理條件無法選到已完成確認、已軟移除、遊戲在資源回收區或現行衍生物的 path。

### 本機 Supabase integration

- signed TUS token 只能寫指定 path、`upsert: false`；>6 MB 檔案實際分塊、暫停後續傳，成功後 finalize。
- browser、begin、bucket、finalize 四條 50 MB 邊界測試；宣稱與實際大小不一致不建立 asset。
- 模擬 Storage 成功／DB 失敗後重試 finalize；模擬 response loss、重複點擊與三檔批次部分失敗。
- 模擬 thumbnail upload 後 DB 失敗；現行指標不指向孤兒，reconcile 只刪該 attempt path。
- private object 無簽署不可讀；thumbnail 批次 URL 與 original URL 到期失效，removed／trashed 資產不核發一般 URL。

### Vitest／Playwright

- 狀態機轉移、租約逾時、退避、錯誤映射與 640 px WebP 規格。
- 手機批次逐檔進度、只重試失敗、original success＋thumbnail warning、移除／立即復原與封面 fallback。
- UI 在 thumbnail pending／failed 時顯示占位及重試，不偷載原檔；點開或下載才請求 original URL。

### 故障注入

```text
Storage upload 成功 → finalize DB 失敗 → 同鍵重試建立同一 asset
finalize 成功 → 回應遺失 → 重試只回既有 asset
thumbnail upload 成功 → DB pointer 失敗 → attempt 成為可證明孤兒
worker 被終止 → lease 到期 → 每日 reconcile 接回
cleanup delete 失敗 → cleanup_pending 保留並可見，不標完成
遊戲進資源回收區 → 所有 DB／Storage 媒體內容不變
```

## 平台查證

- [Supabase：Resumable Uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) — 大於 6 MB、網路不穩或需進度事件時建議 TUS；6 MiB chunk；signed token 可放在 `x-signature`；upload URL 最長 24 小時。
- [Supabase：createSignedUploadUrl](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl) — token 固定有效 2 小時。
- [Supabase：Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals) — private bucket 與 bucket file-size limit。
- [Next.js：`after`](https://nextjs.org/docs/app/api-reference/functions/after) — 回應送出後執行工作，受 route 的 `maxDuration` 限制。
- [Vercel：Function duration](https://vercel.com/docs/functions/configuring-functions/duration) — Fluid compute 下 Hobby 最長 300 秒；縮圖工作仍須以租約與重試承受 timeout。

## 不在本票內

- QNAP 備份、還原及已接受媒體的永久刪除。
- 多組 responsive thumbnails、Supabase 即時圖片轉換、影片轉碼或附件版本管理。
- 庫外引用轉正的資料列狀態；由清單票承接，但不得把 thumbnail-only 引用誤建模為具有權威原檔的媒體資產。
- 具體告警門檻、容量 dashboard 與 operator runbook；由「定稿 MVP 最低限度可觀測性與復原操作」承接本文件的 backlog、錯誤碼與 cleanup 狀態。
