# BGG／IGDB adapter 介面與錯誤語意

本文件定稿 BoardGameGeek（BGG）與 IGDB 的伺服器端來源整合。它把供應商協定、欄位差異、cache、IGDB access token、速率限制與重試藏在 adapter seam 後方，讓遊戲 module 只處理使用者意圖與領域結果。

本文件是實作決策，不是程式碼或 migration。資料所有權與不變式仍以 `CONTEXT.md` 及「MVP 資料模型與不變式」為準；媒體下載／縮圖狀態、BGG 每日更新的批次並行，以及告警／runbook 分別由後續 Wayfinder ticket 定義。

## 範圍與非目標

本票涵蓋：

- 新增流程的外部搜尋、確認與建立。
- 手動最小條目第一次連結來源。
- 已連結條目的手動中繼資料重新整理。
- BGG／IGDB 欄位正規化、cache、憑證與 token lifecycle。
- 供應商速率限制、重試、timeout 與命名錯誤。
- 外部取得與 PostgreSQL 交易之間的邊界。

不涵蓋：

- 已連結條目更換來源。
- 來源封面下載、縮圖、Storage 補償與孤兒清理。
- BGG 每日背景更新的鎖、批次大小與重跑游標。
- 使用者介面的版面與搜尋輸入互動細節。
- 新增 BGG／IGDB 以外的供應商。

## 外部 seam 與遊戲 module interface

BGG 與 IGDB 是不可由本機替代的第三方系統，因此需要真實 adapter seam。production 有 `BggCatalogAdapter` 與 `IgdbCatalogAdapter`；測試使用固定 fixture 的 test adapter。第三方 SDK、XML／JSON 型別、HTTP status、token 與 cache 型別都不得越過 seam。

遊戲 module 只公開五個使用者意圖：

```ts
type Games = {
  searchExternalGames(input: SearchExternalGamesInput): Promise<SearchExternalGamesResult>
  getExternalGameConfirmation(input: GetExternalGameConfirmationInput): Promise<ExternalGameConfirmationResult>
  createGameFromExternalSource(input: CreateGameFromExternalSourceInput): Promise<CreateGameResult>
  linkExternalSource(input: LinkExternalSourceInput): Promise<LinkExternalSourceResult>
  refreshExternalMetadata(input: RefreshExternalMetadataInput): Promise<RefreshExternalMetadataResult>
}
```

每個 input 都接收既定的 `RequestContext`，由上層在呼叫前放入 `VerifiedOwner` 與 request ID。呼叫端不能直接取得或選擇 adapter，也不能傳入任意 `provider＋medium` 組合；來源 reference 使用封閉的 discriminated union：

```ts
type ExternalGameRef =
  | { provider: 'bgg'; medium: 'board_game'; sourceId: string }
  | { provider: 'igdb'; medium: 'video_game'; sourceId: string }
```

`sourceId` 在 adapter 入口正規化成不含前導零的十進位字串；空值、負數、非數字或超出供應商可表示範圍者在呼叫第三方前拒絕。

module implementation 內部依 `ExternalGameRef` 選擇 adapter。adapter port 維持兩個能力，不複製五個使用者意圖：

```ts
type SourceCatalogPort = {
  search(query: SourceSearchQuery): Promise<NormalizedSearchPage>
  fetchSnapshot(ref: ExternalGameRef, freshness: 'cache_ok' | 'fresh'): Promise<NormalizedSourceSnapshot>
}
```

這個 port 是 module 的 internal seam；Next.js page、Server Action 與一般測試不得直接使用。

## 正規化資料

### 搜尋候選

`NormalizedSearchCandidate` 只包含選擇候選所需的共同欄位：

- `ref`：封閉的來源 reference。
- `title`：供應商的主要名稱，保留原文內容，只移除前後空白並正規化 Unicode。
- `releaseYear`：最早發行年份；來源未知時為 `null`。
- `coverPreviewUrl`：來源有提供時保留為可空 HTTPS URL；搜尋候選不能因缺封面而失敗。

游標、offset、cache 狀態或供應商搜尋語法留在 adapter 內。module 只暴露穩定的 `items` 與可空 `nextCursor`；不暴露 BGG XML、IGDB query 語法或 cache implementation。

### 完整來源快照

`NormalizedSourceSnapshot` 是一次成功取得的完整白名單快照，包含：

- 共通：來源 reference、canonical source URL、主要名稱、在地化名稱與別名、來源介紹、最早發行年份、來源封面 URL。
- 來源分類：`provider＋kind＋sourceCategoryId＋name`；kind 只能是 `CONTEXT.md` 已列的固定白名單。
- 來源貢獻：`provider＋sourceContributorId＋name＋entityKind＋role`；role 只能是設計／開發、美術、發行。
- 來源人數：同地多人最小／最大值、單人支援；未知值使用 `null`，不得從純線上人數推測。
- 桌遊：遊戲時間、BGG 重度與 Strategy Game Rank。
- 電子遊戲：來源支援平台，以及 IGDB 明確提供的類型、題材、遊戲模式與玩家視角。

正規化遵守下列規則：

1. `null` 代表供應商沒有可判定的單一值；空陣列代表完整有效回應中該集合為空。兩者不得與「欄位未請求」混用。
2. 名稱與介紹保留來源內容；顯示名稱覆蓋、自由標籤與手動貢獻不進 snapshot。來源 HTML 保存為來源內容，進入 render DTO 前另經安全清理，絕不直接交給 Client Component 執行。
3. BGG 無語言標記的別名不猜測 locale；IGDB 只有明確 locale 資訊時才標記。
4. 分類只納入固定白名單。供應商回傳新種類時不猜測對應，記錄命名 warning 並忽略該種類；已知種類中的 malformed item 則使整份 snapshot 無效，不能靜默少匯一部分。
5. 貢獻者只依供應商身分去重；名字相同不合併。來源與手動貢獻關係是兩個集合，介面可合併顯示，來源重新整理只能替換來源集合。
6. URL 只接受 HTTPS，並在來源封面下載前再次套用供應商 CDN allowlist、redirect 限制與內容檢查；實際下載狀態由媒體 ticket 定義。
7. 數字須通過領域範圍驗證。無效的重度、人數或排名不裁切、不猜測，整份 snapshot 以 `source_response_invalid` 失敗。

## 確認版本與建立時重拉

開啟確認畫面時，module 以 `cache_ok` 取得完整快照，產生畫面 DTO 與 `confirmationFingerprint`。fingerprint 是排序、正規化後的 SHA-256 digest，不是身分驗證或授權能力；它只用來偵測使用者已確認的辨識內容是否改變。

fingerprint 欄位如下：

| 媒介 | 參與比較 | 不參與比較 |
|---|---|---|
| 共通 | 主要名稱、年份 | 封面、人數、介紹、別名、分類、動態指標 |
| 桌遊 | 設計師、出版社 | 美術及其他未列來源資料 |
| 電子遊戲 | 來源支援平台、開發公司、發行公司 | 美術及其他未列來源資料 |

集合先按來源 ID 排序；每個成員同時計入來源 ID 與顯示名稱，因此單純重新排序不算變更，但換人、改名或換來源身分都算變更。

按下「加入收藏庫」或「連結來源」時，module 必須以 `fresh` 重新取得相同來源 ID，且不能以過期 cache 降級：

```text
確認畫面快照＋fingerprint
             │
             ▼
按下建立／連結 ──► fresh fetch ──失敗──► 保留畫面＋命名錯誤＋重試／手動建立
             │
             ▼
    計算最新 fingerprint
       ┌─────┴─────┐
       │相同        │不同
       ▼            ▼
 使用完整最新快照   回傳 source_content_changed
 進入 DB 交易       更新確認畫面並要求再次確認
```

fingerprint 相同時仍使用 fresh fetch 的完整最新快照；未參與比較的欄位若已更新，直接保存最新值。fingerprint 不同時不得寫入任何遊戲、外部身分或來源關係。

## 建立、連結與重新整理的交易邊界

第三方 HTTP 呼叫、token 更新與退避一律在 PostgreSQL 交易外完成，避免等待外部系統時占用連線或 row lock。只有取得並完整驗證 snapshot 後才進入短交易。

### 從來源建立

1. fresh fetch、正規化並核對 fingerprint。
2. 交易內建立或鎖定 `external_game_identities(provider, source_id)`。
3. 若該身分已連到一般遊戲，回傳既有遊戲；若連到資源回收項目，回傳還原提示；兩者都不建立第二筆。
4. 若外部身分尚未連到遊戲，在同一交易內更新完整來源 snapshot、建立遊戲、連結外部身分，並建立來源分類、來源貢獻、來源人數、來源支援平台、系統連結與可用的 BGG 最新指標。
5. 交易成功後回傳遊戲 ID。來源封面下載狀態由媒體 module 接手，不把 Storage 網路操作放進本交易。

資料庫唯一約束是最終仲裁者。兩個並行建立請求都可以完成 fresh fetch，但只有一個能建立；另一個在衝突後讀回既有的一般／資源回收狀態，不能把唯一約束錯誤直接洩漏給介面。

### 手動最小條目第一次連結來源

流程沿用 fresh fetch 與 fingerprint。交易內先鎖定手動遊戲與外部身分，重新驗證遊戲仍未連結來源且媒介相符；若外部身分已連到其他一般／資源回收遊戲，整個交易不寫入，原手動條目保持不變。成功時才附加外部身分並寫入完整來源集合，不自動合併其他遊戲資料。

### 手動重新整理

重新整理不顯示差異確認。module fresh fetch 成功後，在單一短交易內鎖定該外部身分並以完整最新 snapshot 替換所有來源管理欄位與關係；有效 snapshot 中消失的舊成員一併移除，手動關係與其他使用者資料完全不動。

fetch、正規化或交易任一步驟失敗，舊 snapshot 與最後成功時間保持不變。交易完成後才更新 `last_successful_sync_at`；失敗只記錄 attempt 與命名錯誤，不能把失敗時間冒充成成功同步時間。

BGG 最新指標使用獨立資料列；手動完整重新整理與每日背景更新若並行，後續「將既定 BGG 每日更新規則落成並行安全流程」須以 row lock／版本條件保證較舊回應不能覆寫較新的成功值。

## Cache 策略

cache 是 adapter implementation，不是 module interface，也不是來源真本。為避免 Vercel 多 instance 的 process memory 造成不一致，搜尋與詳細快照 cache 使用 PostgreSQL 的內部 cache table；不新增 Redis、Supabase Realtime 或另一項 managed service。

cache key 至少包含：provider、operation、正規化 query 或 source ID、正規化 mapping version。value 保存已正規化結果、`fetched_at` 與 `expires_at`，不保存 credential、token、raw request header 或 signed URL。

- 搜尋成功結果：10 分鐘 TTL，用於重複輸入與返回搜尋畫面。
- 完整確認快照：5 分鐘 TTL，用於重開同一確認畫面。
- 建立、連結與手動重新整理：一律 `fresh`，不得使用過期 cache 或 stale-if-error。
- `not_found`：最多負向 cache 1 分鐘；auth、rate limit、timeout、5xx、parse／validation error 不 cache。
- cache 寫入失敗不使來源操作失敗，但必須記錄內部技術事件 `source_cache_write_failed`；呼叫仍使用剛取得的有效結果，該事件不越過 module interface。
- 過期資料由讀取時惰性刪除；每次成功 cache 寫入亦以固定筆數上限清除過期列。MVP 不為 cache 另建排程工作，清理失敗不影響領域資料。

cache table 只降低重複呼叫，不能取代 `external_game_identities` 的最後成功來源 snapshot。

## Credential 與 IGDB token lifecycle

- BGG Bearer token、IGDB Client ID／Client Secret 只存在 server-only、環境別分離的 secrets；瀏覽器、資料庫 cache、log、錯誤 payload 與測試 fixture 都不得包含。
- IGDB access token 由 adapter 內部的 token provider 以 client credentials 取得，依供應商回傳的 `expires_in` 記錄到期時間；在到期前 5 分鐘視為不可再用。
- access token 只保存在 Vercel instance 的 process memory，同一 instance 以 singleflight 合併並行 refresh。MVP 不為短效 token 新增持久 secret store；冷啟動或不同 instance 可各自取得 token。
- IGDB 回傳 authentication failure 時，adapter 清除記憶體 token、強制更新並重試一次；第二次仍失敗即回 `source_authentication_failed`，不無限更新。
- token endpoint timeout、rate limit 或 5xx 映射成 `source_authentication_unavailable`。Client Secret 設定錯誤與上游暫時不可用須能由 operator log 區分，但使用者介面不顯示 secret 或原始回應。
- BGG token 無自動 renewal；缺少、被撤銷或拒絕時回 `source_authentication_failed`，由部署設定修復。

若實測顯示 Vercel 冷啟動造成 token endpoint 負載或 Twitch 限制，才新增可跨 instance 的加密 token store；沒有證據前不把短效 bearer token寫入 PostgreSQL 或版本庫。

## 速率限制、timeout 與重試

adapter 共用一個 PostgreSQL-backed global scheduler，跨 Vercel instance 原子保留可呼叫時段；process-local limiter 只能作額外平滑，不能作唯一限制。

- IGDB 依既有研究守住每秒 4 次、最多 8 個並行請求；production 預設再保留安全餘裕，不把額度跑滿。
- BGG 未公布精確額度，MVP 採最多每秒 1 次、同時 1 次的保守預設；上游 `Retry-After` 或處理中回應可把下一個可呼叫時間往後延。
- 互動式搜尋／確認／建立／連結／重新整理優先於背景工作；後續 BGG 每日流程必須經同一 scheduler，不能另開一條繞過限制的呼叫路徑。
- 每次 HTTP attempt 都有明確 timeout。只有 network timeout、上游處理中、429 與 502／503／504 可自動重試；400、401／403、404 與 validation error 不以相同 credential／payload盲目重試。
- 最多 2 次自動重試，採 exponential backoff＋jitter 並優先遵守 `Retry-After`。互動請求若等待會超過 8 秒，立即回傳含 `retryAfter` 的命名錯誤，讓使用者稍後重試；不得讓 Server Action 無界等待。
- 所有來源讀取都是冪等操作；重試不得越過資料庫建立／連結交易。資料庫交易本身只針對已分類的 serialization／deadlock 錯誤作有限重試，不能重新使用未再次核對的舊確認版本。

## 命名錯誤與可見狀態

第三方原始錯誤先在 adapter seam 內映射，module 再加入領域衝突。Server Action 只看下列穩定錯誤：

| 錯誤名稱 | 可否重試 | 使用者語意 | 資料語意 |
|---|---|---|---|
| `source_query_invalid` | 修正輸入後 | 搜尋條件無效 | 未呼叫來源、未寫入 |
| `source_not_found` | 可重新搜尋 | 該來源項目不存在 | 建立／連結不寫入；重新整理保留舊 snapshot |
| `source_rate_limited` | `retryAfter` 後 | 來源忙碌，稍後重試 | 未寫入 |
| `source_unavailable` | 是 | 網路、timeout 或上游暫時故障 | 未寫入；既有資料照常可讀 |
| `source_authentication_failed` | 使用者重試無效 | 來源設定異常 | 未寫入；需要 operator 修復 |
| `source_authentication_unavailable` | 是 | token 端點暫時故障 | 未寫入 |
| `source_response_invalid` | 使用者重試通常無效 | 來源回應無法安全使用 | 未寫入；需要 adapter／來源調查 |
| `source_content_changed` | 再次確認後 | 辨識內容已更新 | 未寫入，回傳最新確認 DTO |
| `source_identity_conflict` | 否 | 已存在一般或資源回收遊戲 | 回傳既有 ID 與狀態，不建立第二筆 |
| `source_persistence_failed` | 是 | 最新資料取得成功但本地保存失敗 | 交易回滾，舊資料不變 |

所有失敗都保留目前畫面輸入。外部搜尋／確認失敗時可改建手動最小條目；建立、連結與重新整理不得因有舊 cache 而回報成功。

log 只記 request ID、provider、operation、非敏感 source ID、cache hit／miss、attempt 數、duration、HTTP status 類別與命名錯誤；禁止記錄 token、Client Secret、Authorization header、完整第三方 body、來源介紹或 signed URL。告警門檻與 runbook 交由「定稿 MVP 最低限度可觀測性與復原操作」。

## 驗證目標

### Adapter contract fixtures

每個 production adapter 都以去識別、無 credential 的固定 fixture 通過同一套 contract tests：

- 搜尋候選與完整 snapshot 型別一致，第三方 raw 型別不外洩。
- 缺漏選填欄位得到 `null`／空陣列；malformed 白名單欄位使整份 snapshot 失敗。
- 未知分類種類產生 warning 且不被猜測匯入。
- BGG／IGDB 同名來源保持不同 `ExternalGameRef`。
- HTTP auth、404、429、timeout、5xx、無效 XML／JSON 映射到正確命名錯誤。
- IGDB token 正常重用、提前失效、並行 singleflight、401 強制更新一次及第二次失敗都有測試。
- cache TTL、mapping version、負向 cache 與 `fresh` bypass 有測試。
- global scheduler 在並行測試中不超過 provider 上限，互動工作優先於背景工作。

### Module integration tests

透過遊戲 module interface 與本機 Supabase 驗證：

- 確認後辨識欄位未變，建立使用 fresh snapshot 的所有最新來源資料。
- 只改變封面、人數、介紹、分類或動態指標時不要求再次確認；改變名稱、年份或媒介對應的貢獻者／平台時回 `source_content_changed` 且零寫入。
- double-click 與並行建立最多產生一個外部身分及一個遊戲；另一請求解析為既有一般／資源回收結果。
- 手動條目連結命中既有來源身分時零寫入，原手動條目保持不變。
- 重新整理以完整來源集合替換，來源移除的設計師消失，手動設計師仍在；任一步驟失敗時舊 snapshot 完整保留。
- cache failure、來源 failure 與 persistence failure 都不會顯示成空結果或成功。

### 尚待外部條件

目前尚未以真實 BGG／IGDB credential 跑 production adapter。實作階段須以核准的非商業 BGG token 與 Twitch／IGDB confidential app，在本機或受保護 preview 驗證實際 payload、token 更新、限流回應與 timeout；只提交去識別 fixture，不提交 credential 或完整含敏感內容的 log。

## 端到端資料流

```text
Browser
  │ search／confirm／create／link／refresh
  ▼
Next.js adapter：requireOwner()＋Zod
  ▼
Games module interface
  │
  ├─ intent＋transaction rules
  │
  └─ internal SourceCatalogPort
       ├─ PostgreSQL cache／global scheduler
       ├─ BggCatalogAdapter ── Bearer ──► BGG XML API2
       ├─ IgdbCatalogAdapter ─ token provider ──► Twitch／IGDB
       └─ TestCatalogAdapter ─ fixtures
  │
  ▼
短 PostgreSQL transaction
  ├─ external identity／source snapshot
  ├─ game link／source relations／system link
  └─ last successful sync

來源封面 URL ──► 後續媒體 module（Storage／縮圖狀態）
BGG metrics ───► 後續每日更新流程（鎖／批次／重試）
命名技術事件 ──► 後續可觀測性規則（告警／runbook）
```
