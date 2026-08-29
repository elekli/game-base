# MVP 分批實作與驗證計畫
========

## 進度追蹤
--------

**整體進度：** 0% 🟢🟡🔴

### 步驟清單
- 🟢 實作前決策已收斂為本計畫的固定輸入。
- 🟢 第一個可用縱切已定義為「雙來源搜尋、確認後直接加入收藏庫與瀏覽」，包含使用者指定的 BGG／IGDB 搜尋。
- 🟢 計畫層不變式、失敗路徑、並行交錯與權限邊界已檢查。
- 🔴 依批次建立程式、migration、測試與部署設定。

## 目的與完成定義
--------

本計畫把既定的 MVP 決策交給一組可各自驗收的實作批次。完成時，單一擁有者能在受保護的 Vercel 正式環境以手機優先介面搜尋 BGG／IGDB、確認後加入並管理自己的遊戲、上傳私有媒體、寫筆記、建立清單與關聯遊戲，並安全地執行每日 BGG 指標更新。

本文件是實作順序、驗收證據與風險控制的唯一計畫資產；`CONTEXT.md` 仍是產品與領域語意的唯一真本，`supabase/migrations/` 則會是資料庫 schema 的唯一真本。

## 固定輸入與實作前置條件
--------

- 採 Next.js App Router、TypeScript、Node.js、單一 `pnpm` package、Tailwind CSS、shadcn/ui、Drizzle＋`postgres.js`，並在 Supavisor transaction pooler 使用 `prepare: false`。
- 正式環境固定為 Vercel＋Cloudflare Access＋Supabase PostgreSQL／私有 Storage。Supabase Auth、Realtime、Edge Functions、Vercel Cron、外部 queue 與另一個後端服務均不納入 MVP。
- 所有 Server Action、Route Handler 與內部資料入口都先驗 Cloudflare Access JWT、擁有者與 Zod 輸入；受限的 `app_runtime` DB role 與 private bucket 不得被瀏覽器直接繞過。
- BGG／IGDB production adapter 需要各自核准的非商業憑證；憑證只存在本機或 Vercel 的 server-only environment variable。沒有憑證時可完成 fixture 測試，但不得宣稱已驗證真正來源流程。
- 已關閉決策票的資產必須先成為同一實作基線。實作開始前，合併「[將既有媒體規則落成縮圖與上傳狀態機](https://github.com/elekli/game-base/issues/7)」與「[將既定 BGG 每日更新規則落成並行安全流程](https://github.com/elekli/game-base/issues/10)」的開放文件 PR；將「[驗證行動版核心流程](https://github.com/elekli/game-base/issues/9)」的 A／A1／A1a 裁決寫回 `CONTEXT.md` 與追溯表。未達成前不開實作票，避免 `main` 缺少權威規格。

## 非目標
--------

- 不實作 QNAP 異地備份、還原後永久刪除、來源更換、庫外貢獻者反查、人數手動編輯、貢獻者合併、BGG 指標歷史或 Vditor `ir`。
- 不把原型程式、Supabase Dashboard 的手動 schema 或 Drizzle migration 當成正式實作來源。
- 不為了取得完整來源結果而延遲手動最小條目；來源暫時失敗時仍必須保留此保底路徑。

## 批次依賴圖
--------

```text
批次 0：可重建基線、權限邊界與骨架
  │
  └──► 批次 1：雙來源新增遊戲＋收藏庫第一個縱切
          │
          ├──► 批次 2：收藏庫整理、重新整理與篩選
          ├──► 批次 3：私有媒體與縮圖
          │       │
          │       └──► 批次 4：筆記、清單、關聯遊戲與資源回收
          │
          └──► 批次 5：每日 BGG 指標、可觀測性收斂與正式上線驗收

每一批：本機驗證綠燈 → preview 實測 → PR 審查 → 合併
```

批次 2、3 可以在批次 1 合併後以獨立 worktree 並行；批次 4 需要批次 1 的遊戲與外部身分，也需要批次 3 的媒體介面來完成封面 fallback。批次 5 必須等來源 adapter、核心資料表、媒體及生命週期狀態都可用。

## 所有批次共同交付契約
--------

- 每次 schema 變動都新增不可變的 `supabase/migrations/<timestamp>_<name>.sql`，重播 `supabase db reset`，以 `drizzle-kit pull` 產生的 schema 差異檢查確保 migration 是唯一真本。不得使用 `drizzle-kit generate`、`migrate` 或 `push`。
- 每個 module 只有一個 `src/modules/<module>/index.ts` public interface；Next.js、Drizzle、Storage 與供應商型別留在 `internal/` 或 `src/adapters/`。
- 每個 Server Action／Route Handler 都以 `requireOwner()`、Origin 檢查與 Zod 開頭；所有私人回應都送出 `Cache-Control: private, no-store`。
- 每批至少新增：pgTAP schema／RLS 證據、Vitest module integration、該批關鍵 Playwright 流程，以及 390 px 寬觸控 viewport 的實際瀏覽器驗證。只有有實質 client 狀態時才加 Testing Library。
- 每個命名失敗都同時有安全的使用者可見狀態、單一既定重試或復原路徑，以及不含 secret、內容、檔名、header 或 signed URL 的 Vercel 結構化 log。
- 每個 PR 合併前跑 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm integrity:check`、`pnpm audit` 與 migration replay；實際指令名稱可在批次 0 建立，但不得省略等價檢查。

## 批次 0：可重建實作基線、權限邊界與骨架
--------

### 範圍

- 將前述尚未合併的決策資產納入 `main`，並以 `docs/plans/decision-traceability.md` 逐一連回決策票。
- 建立 Next.js 專案、固定 Node.js 與 `pnpm` 版本、型別／lint／Vitest／Playwright／pgTAP／Supabase CLI 的最小可重建設定。
- 建立 `src/app/`、`src/modules/`、`src/adapters/`、`src/shared/` 骨架；先實作 `requireOwner()`、設定驗證、request ID、命名錯誤與結構化 log，不建立通用 repository abstraction。
- 設定本機 Supabase、固定 preview 測試專案與 production 專案；建立 private Storage bucket，停用產品資料的 Data API，建立 migration 與 runtime 各自使用的受限角色／grants／RLS。
- 在所有 private 入口驗 Cloudflare Access RS256 JWT 的 `kid`、簽章、`iss`、`aud`、`type`、時間、擁有者 email 與 `sub`；JWK cache 無法驗證時 fail closed。preview 只依 Vercel Standard Protection，並固定指向假資料專案。
- 在啟動時檢查 `VERCEL_ENV`、Supabase project ref、Supavisor host／username 與 publishable／secret key fingerprint 的固定對照；不相符即失敗。

### 非目標

- 不建立遊戲、來源 adapter、媒體、筆記或清單的使用者功能。
- 不把「能由 Cloudflare 登入」誤當成應用程式已驗 JWT；不讓 local 或 preview 變成 production DB 的繞過路徑。

### 預計新增／修改檔案

- `package.json`、`pnpm-lock.yaml`、`.nvmrc` 或等價版本檔、`next.config.*`、`tailwind.config.*`、`vitest.config.*`、`playwright.config.*`、`drizzle.config.*`、`.env.example`。
- `src/app/layout.tsx`、`src/app/page.tsx`、`src/app/error.tsx`、`src/app/actions/*`；僅作為組裝 adapter，不承載領域規則。
- `src/shared/auth/*`、`src/shared/config/*`、`src/shared/observability/*`、`src/shared/errors/*`。
- `supabase/config.toml`、`supabase/migrations/0001_runtime_security.sql`、`supabase/tests/0001_runtime_security.pgtap.sql`、`supabase/seed.sql`、`scripts/check-integrity.ts`。
- `.github/workflows/ci.yml`、`README.md`、`docs/security/CHECKLIST.md`、`docs/security/SUPABASE.md`、部署環境設定說明。

### migration 與資料邊界

第一個 migration 建立必要 extension、`app_runtime`、migration role、最小 RLS／default privileges、private bucket 與 bucket size limit；沒有產品資料表就不預先創造空泛的 ACL 表。DB runtime role 不得是 table owner 或有 `BYPASSRLS`，migration 直接連線不走 Supavisor transaction pooler。

### 驗收證據

- `supabase db reset` 在空白本機環境完整重播；pgTAP 證明 runtime role、default privileges、RLS 與 Storage private bucket 的拒絕行為。
- auth integration 覆蓋缺 header、錯簽章、未知 `kid`、錯 `iss`／`aud`／`type`、過期、service token、錯 email／`sub`、JWK outage，並斷言 DB／Storage adapter 零呼叫。
- 反向部署測試刻意混用正式／測試 URL、Supavisor connection 與 key fingerprint，build 或啟動必須失敗。
- preview 未登入時由 Vercel 阻擋；正式自訂網域有合法 Access JWT 才可到 private route；直接 `.vercel.app`／origin 取不到私人資料。以 390 px viewport 確認安全錯誤畫面不洩漏技術細節。

### 主要風險與完成門檻

Cloudflare JWT claim 或 Supavisor 設定若與設計不符，先停在此批診斷並修正設定，不把匿名模式或 service role 當暫時繞過。此批合併後，任何後續功能都可在本機假資料、preview 測試資料及 production 三種環境重建與安全失敗。

## 批次 1：雙來源新增遊戲與收藏庫第一個縱切
--------

### 範圍

- 實作 `games` module 的 `searchExternalGames`、`getExternalGameConfirmation`、`createGameFromExternalSource` 與 `createManualGame` 意圖；BGG 與 IGDB 只在 `SourceCatalogPort` 後實作 adapter，測試使用 fixture adapter。
- 以手機 A／A1／A1a 流程實作：同時搜尋 BGG 與 IGDB、依來源分組、一個來源失敗不阻礙另一組、列內展開確認資訊，只有「加入收藏庫」才寫入。
- 建立時 fresh fetch 同一來源 ID、比較確認 fingerprint、以 `provider＋source_id` 唯一約束處理雙擊、並行和資源回收既有項目。內容改變時零寫入並要求重新確認；來源失敗時保留畫面，讓擁有者改建手動最小條目。
- 建立遊戲列表、詳情與最小搜尋。列表採封面書架，預設依顯示名稱排序；詳情保留清楚的返回路徑。先呈現來源快照、名稱、人數、來源貢獻與 BGG 目前值；媒體縮圖未 ready 時顯示可操作占位。
- 將來源封面以媒體狀態帳安全寫入 private Storage，建立原始封面與 thumbnail；這只支援建立與顯示來源封面，不提早開放使用者上傳。

### 非目標

- 不做自由標籤、實際平台選擇、手動貢獻、完整篩選器、手動重新整理或更換來源。
- 不把 BGG 每日工作、相簿批次上傳或附件混進首次建立流程。

### 預計新增／修改檔案

- `src/modules/games/index.ts`、`src/modules/games/internal/{commands,queries,confirmation-fingerprint,source-snapshot,errors}.ts`。
- `src/adapters/sources/{bgg,igdb,test-catalog-adapter,postgres-cache,postgres-scheduler}.ts` 與去識別 fixture。
- `src/modules/media/index.ts` 及 `internal/source-cover-ingest.ts`；瀏覽器不可呼叫此 internal 路徑。
- `src/app/(library)/page.tsx`、`src/app/games/[gameId]/page.tsx`、`src/app/games/new/page.tsx`、相應 Server Actions 與行動版 Client Components。
- `supabase/migrations/0002_games_and_source_identity.sql`、`0003_source_snapshot_and_source_cover.sql`、對應 pgTAP、Vitest、Playwright fixture 與 `tests/e2e/game-creation.spec.ts`。

### migration 與資料邊界

- 建立 `games`、`external_game_identities`、`game_names`、`source_categories`、`external_game_categories`、`contributors`、`source_contributions`、`external_player_profiles`、`bgg_current_metrics`、`media_ingests`、`media_assets`、`media_derivatives` 與必要索引。
- `external_game_identities(provider, source_id)` 全域唯一；`games.external_game_identity_id` 在非空時唯一；媒介由 check／trigger 保證 BGG 只連桌遊、IGDB 只連電子遊戲。
- snapshot 與來源關係只允許來源流程寫入；使用者資料欄位、後續筆記／清單與媒體關係不在來源 refresh／create transaction 的可寫集合中。

### 驗收證據

- pgTAP 與本機 Supabase integration 證明同一來源的並行建立最多一個外部身分與一個遊戲；資源回收遊戲仍佔用外部身分；名稱相似永遠不是硬去重鍵。
- Vitest contract fixture 覆蓋 BGG XML、IGDB JSON、白名單種類、`null`／空集合、content changed、not found、429、timeout、無效回應、cache TTL 與 `fresh` bypass。production adapter 的真實實測只用核准憑證，提交資料不得含 credential 或真實敏感 payload。
- Playwright 在 390 px 寬執行兩來源搜尋、單一來源失敗、列內確認、內容變更再確認、雙擊、手動最小條目與建立後返回書架；逐項截圖並檢查觸控操作。
- preview smoke test 以測試 Supabase 專案完成 fixture 建立與私有來源封面讀取；無 signed URL 時外部無法讀原檔，thumbnail URL 到期後失效。

### 主要風險與完成門檻

第三方 credential、實際 payload 或 rate limit 未驗證時，第一個縱切僅能稱作 fixture-complete，不能列為 MVP 可用。兩個 production adapter 都在受保護環境成功完成搜尋、fresh create 與錯誤重試後，才完成本批。

## 批次 2：收藏庫整理、重新整理與篩選
--------

### 範圍

- 新增／編輯自訂顯示名稱、實際平台、自由標籤、手動貢獻關係與人數說明；桌遊不顯示實際平台。每個共用名稱只去前後空白並以英文不分大小寫處理比較鍵。
- 實作 `linkExternalSource` 與 `refreshExternalMetadata`。第一次連結遵循來源唯一性並保留原手動條目；重新整理以單一短 DB transaction 替換完整來源快照與來源關係，絕不修改使用者資料。
- 實作本地即時部分字串搜尋、遊戲類型、實際平台、自由標籤、來源分類、貢獻者與 BGG 值的篩選／排序。相同維度 OR、不同維度 AND；來源分類只在選定單一遊戲類型時顯示，清除不相容條件。
- 將來源介紹安全清理並預設收合；來源／手動貢獻在畫面明確區分。手機詳情把平台、標籤及資料編輯放在次要操作區。

### 非目標

- 不實作更換來源、貢獻者合併、來源外貢獻者搜尋、模糊搜尋或手動結構化人數覆寫。

### 預計新增／修改檔案

- `src/modules/library/index.ts` 與 `internal/{platforms,tags,contributors,filters,search}.ts`。
- `src/modules/games/internal/{link-source,refresh-source,source-replacement}.ts`、相應 adapters 與 DTO。
- `src/app/(library)/filters/*`、`src/app/games/[gameId]/edit/*`、`src/app/games/[gameId]/refresh/*`。
- `supabase/migrations/0004_library_curation.sql`、`0005_source_refresh.sql`、對應 pgTAP、`tests/integration/library-curation.test.ts`、`tests/e2e/library-search-and-refresh.spec.ts`。

### migration 與資料邊界

- 建立 `platforms`、`game_platforms`、`tags`、`game_tags`、`manual_contributions`、`external_supported_platforms` 與搜尋所需索引。
- 以唯一比較鍵保護 tags／platforms；以引用檢查禁止刪除仍被一般或資源回收遊戲使用的自訂平台或 tag。來源貢獻與手動貢獻使用不同資料表，不能互相覆寫。
- refresh 成功時更新來源快照、來源分類、來源貢獻、來源支援平台、人數與來源封面；任一步失敗保留完整舊快照與舊封面。

### 驗收證據

- pgTAP 證明 source refresh 無法改寫 custom name、tag、actual platform 或 manual contribution；同名而來源 ID 不同的 contributor 可並存。
- integration 覆蓋來源成員消失、手動成員保留、手動條目連結命中既有外部身分時零寫入，以及 refresh 的網路／正規化／DB 失敗都保留舊值。
- Playwright 覆蓋不同篩選維度交集、同維度聯集、切換到多類型後清除來源分類、手機上編輯平台與 tag、來源介紹收合與重新整理錯誤重試。
- preview 以 production-like Supavisor 連線確認 `prepare: false`，並以真實憑證重測 refresh 的成功及命名失敗。

## 批次 3：私有媒體、縮圖與封面管理
--------

### 範圍

- 完成 `media` module 的 `beginMediaUpload`、`finalizeMediaUpload`、移除／還原、選取人工封面、恢復來源封面、重試縮圖與簽發短效讀取的 public interface。
- 所有瀏覽器檔案以 TUS、6 MiB chunks、`upsert: false`、每檔獨立冪等鍵與最多三檔並行上傳；四層守住 50 MB。
- finalize 後原檔即成功；thumbnail 以獨立 pending／processing／ready／failed 狀態、租約和有限重試處理。縮圖失敗不能回滾原檔，清理只處理有狀態帳且可證明的孤兒。
- 完成相簿照片、自訂封面、附件與說明欄位，並在手機實作逐檔狀態、個別重試、thumbnail 占位與原檔下載。

### 非目標

- 不自動刪除未知 Storage 物件、不把 signed URL 寫入資料庫、不用原檔假冒縮圖，也不引入 Cron 或外部工作 queue。

### 預計新增／修改檔案

- `src/modules/media/internal/{ingest,finalize,thumbnail,reconcile,cleanup,storage}.ts` 與 `src/adapters/storage/supabase-storage.ts`。
- `src/app/games/[gameId]/media/*`、TUS client、相簿／封面／附件元件。
- `supabase/migrations/0006_media_lifecycle.sql`、`0007_media_derivatives.sql`、對應 pgTAP、故障注入 integration test、`tests/e2e/media-upload.spec.ts`。

### migration 與資料邊界

- 擴充 `media_ingests` 的冪等鍵、精確 path、lease 與 cleanup state；在 `media_assets` 保存用途、soft removal 與原檔權威狀態；在 `media_derivatives`／attempts 保存現行 WebP pointer 與可追溯孤兒。
- `ready` derivative 必須有現行 object path；已 finalize 原檔、現行 derivative、soft-removed asset 與 resource-recycle 遊戲媒體不得滿足 cleanup predicate。

### 驗收證據

- 本機 Supabase 實測 >6 MB 分塊、暫停續傳、宣稱與實際大小不符、超過 50 MB、同鍵並行 begin／finalize、finalize response 遺失、Storage 成功但 DB 失敗，以及 thumbnail pointer 寫入失敗。
- pgTAP 證明一個 ingest 至多產生一個 asset、移除人工封面原子清 pointer、還原不自動重選封面、遊戲進出資源回收區不改媒體。
- Playwright 在 390 px viewport 驗證多檔部分成功、只重試失敗檔、原檔成功但縮圖失敗、相簿占位、短效 URL 到期與無權讀取的拒絕。
- preview 及 production smoke test 只使用 private bucket；Vercel log fixture 不含檔名、object path、signed URL 或檔案內容。

## 批次 4：筆記、清單、關聯遊戲與資源回收
--------

### 範圍

- 完成 `notes`、`lists`、`relations` 與 `lifecycle` module。新筆記／新清單保持用戶端草稿，空白筆記不建立資料，清單只在第一個成員加入時以單一交易持久化。
- 實作筆記自動儲存、可見狀態、離開未儲存確認、清空既有筆記的待確認 soft delete；採 Markdown 原始碼編輯器與可觸及工具列。
- 實作一般清單、庫外穩定引用、對稱關聯遊戲、庫外引用轉正與封存／還原入口；加入一律以外部身分而非複製來源 ID 表示。
- 實作遊戲移入／還原資源回收區；不改子資料、清單、媒體或 Storage。已連結外部身分的重複建立導向一般項目或還原項目。
- 所有既有狀態改寫要求 `expectedVersion`，可重試命令以 command ID 回放相同結果。

### 非目標

- 不做永久刪除、QNAP 備份、離線佇列、清單全域封存頁或 Vditor `ir`；不讓資源回收區釋放來源身分。

### 預計新增／修改檔案

- `src/modules/{notes,lists,relations,lifecycle}/index.ts` 與各自 `internal/` 狀態轉移、receipt、版本檢查與 DTO。
- `src/app/games/[gameId]/{notes,lists,relations,lifecycle}/*`、Markdown 工具列與行動版離開確認元件。
- `supabase/migrations/0008_notes_lists_relations.sql`、`0009_command_receipts_and_lifecycle.sql`、對應 pgTAP、`tests/integration/lifecycle.test.ts`、`tests/e2e/notes-lists-trash.spec.ts`。

### migration 與資料邊界

- 建立 `notes`、`lists`、`list_members`、`external_game_references`、`game_relations`、`command_receipts` 與版本欄位；以排序後成對 unique key 保證關聯無方向、非自我且不重複。
- `removed_at`、`archived_at`、`trashed_at` 分別表達筆記／成員、清單與遊戲生命週期；不以 cascade delete 或 Storage delete 實作任何一種。

### 驗收證據

- integration 覆蓋空白新筆記、直接關閉前伺服器舊文不變、兩個過期寫入衝突、同一 command 重送、不同 payload 重用 command ID、清單第一次成員交易失敗、庫外引用轉正零搬移，以及連結來源造成重複清單／關聯時全件拒絕。
- pgTAP 證明資源回收遊戲仍保留所有外部身分與子資料；封存清單只有庫外成員時可由建立同名清單直接還原。
- Playwright 在 390 px viewport 覆蓋筆記工具列與儲存狀態、未儲存離開提示、對稱關聯、資源回收與還原、媒體仍可在還原後讀取。

## 批次 5：每日 BGG 指標、可觀測性收斂與正式上線驗收
--------

### 範圍

- 實作 `ensureDailyBggMetricRefresh`、背景切片、租約接手、`FOR UPDATE SKIP LOCKED` 認領、每切片最多十項、每秒一次／同時一次 BGG scheduler、手動 refresh 優先與寫入世代 fence。
- 以 `Asia/Taipei` 日期建立唯一 run、固定目標快照與只重試 failed item；列表和詳情先讀快取，選單顯示完成數／總數、最後成功時間與失敗數。
- 將所有已完成 module 接到既定結構化 log、使用者可操作摘要、Vercel runbook 與 `pnpm integrity:check`；為 migration replay、preview 與 production 做端到端發布檢查。

### 非目標

- 不建立 BGG 歷史、趨勢圖、Cron、監控 SaaS、email／RSS／推播、全庫掃描或自動資料修復。

### 預計新增／修改檔案

- `src/modules/bgg-metrics/index.ts` 與 `internal/{runs,leases,items,fences,worker}.ts`。
- `src/app/(library)/bgg-refresh-status.tsx`、背景觸發 adapter 與只重試失敗項目的 Server Action。
- `supabase/migrations/0010_bgg_metric_runs.sql`、`supabase/tests/0010_bgg_metric_runs.pgtap.sql`、`tests/integration/bgg-refresh.test.ts`、`tests/e2e/recovery-and-release.spec.ts`。
- `scripts/check-integrity.ts`、`docs/operations/release-checklist.md`、`docs/operations/production-recovery.md`、CI 與 Vercel environment 文件。

### migration 與資料邊界

- 建立 `bgg_metric_refresh_runs`、`bgg_metric_refresh_items`、`bgg_metric_write_fences`；`taipei_date` 全域唯一，`(run_id, external_game_identity_id)` 唯一，run／item 都採 token、lease expiry 與 fencing generation。
- 背景工作只可寫 `bgg_current_metrics` 的重度、Strategy Game Rank 與最後成功時間；不寫任何來源 snapshot、資源回收項目、庫外引用或指標歷史。

### 驗收證據

- pgTAP 與 integration 故意交錯兩次登入、兩個 worker、逾時租約、慢 BGG 回應、手動完整 refresh、重複「只重試失敗」、rank `null` 與 adapter 失敗；舊 lease／舊世代永遠不能覆寫新值，失敗永遠保留舊快取。
- 跨 instance 測試記錄實際 BGG scheduler，證明不超過每秒一次、同時一次，且互動工作優先。所有 run 計數必須與 item state 一致。
- `pnpm integrity:check` 在外部身分、BGG run 計數、media state、軟移除／封存關係與 command receipt 任一不變式壞掉時以非零結束；正常資料回零。
- deployment smoke test 覆蓋 preview 假資料隔離、production 自訂網域 JWT、直接 origin 拒絕、私有 Storage、真實 BGG 指標操作、手機書架與主要拇指操作區。Vercel log 只保留允許欄位，所有需要操作狀態都有畫面上的單一復原入口。

### 完成門檻

只有所有批次已在本機、CI、preview 及 production 各留下可重現證據，且真實 BGG／IGDB 憑證完成受保護環境驗證後，才能宣布 MVP 已完成。未申請憑證、未合併決策資產或未實做 QNAP 備份時，最後一項分別是 MVP blocker、實作 blocker 與已知 MVP 後風險；三者不得混為同一狀態。

## 計畫層 gap-verification
--------

此計畫涉及跨狀態不變式、Vercel 多 invocation 並行與 Cloudflare／Supabase 信任邊界，因此依「gap-verification」在寫程式前抽出下列 properties。它們來自 `CONTEXT.md` 與已定稿決策，不從未來程式反推。

### 不變式與守法設計

| 不變式 | 類型 | 守法設計與驗證批次 |
|---|---|---|
| 一個 `provider＋source_id` 在一般與資源回收中都只對應一個外部身分與至多一個遊戲。 | safety | DB unique constraint、短交易與 identity conflict 回應；批次 1 pgTAP／並行 integration。 |
| 來源更新永遠不覆寫擁有者資料；失敗時完整保留上一份來源快照。 | safety | source／manual 資料表分離，完整 snapshot 原子替換；批次 2 故障注入。 |
| 未驗證的請求不能碰 DB 或 Storage，也不能由 preview／origin 取得 production 資料。 | safety | `requireOwner()`、fail-closed JWK、受限 role、project-ref fingerprint；批次 0 負向部署與 auth integration。 |
| 一個 media ingest 至多產生一個 asset；thumbnail 失敗不會撤銷已確認原檔。 | safety | 冪等鍵、finalize lease、asset／derivative 分離狀態；批次 3 並行與 response-loss 測試。 |
| soft delete、archive 與 trash 只改生命週期狀態，不遺失既有關係或 Storage 指標。 | safety | 無 cascade delete、生命週期狀態機與 integrity check；批次 4 pgTAP。 |
| 同一台北日只建立一個 BGG run；過期 worker 或舊手動／背景回應不能覆寫較新指標。 | safety | 日期 unique、lease token、fencing generation、寫入世代；批次 5 交錯 integration。 |
| 已保存的失敗狀態終究能由下一次擁有者請求或既定重試接手，不會因 invocation 終止而靜默消失。 | liveness（受登入觸發限制） | 有期限 lease、持久化工作列、reconcile 與可見重試入口；批次 3、5。 |

### 已檢查的風險路徑

| 交錯或失敗路徑 | 若不處理的根因 | 計畫中的阻擋點 |
|---|---|---|
| 兩次建立同一來源遊戲／雙擊確認 | 只有 UI 去重，沒有資料庫仲裁。 | 批次 1 unique constraint；衝突讀取既有項目。 |
| 使用者確認後來源資料變更 | 從 cache 寫入未確認的辨識內容。 | fresh fetch＋fingerprint；不同即零寫入、原列要求再確認。 |
| refresh 與使用者編輯重疊 | 同一欄位混放來源與手動資料。 | 批次 2 依資料所有權分表，來源 transaction 不接觸手動集合。 |
| Storage 成功而 DB finalize 或回應失敗 | 把 upload／DB 假設成同一交易。 | 批次 3 ingest ledger、同鍵 replay、可證明 orphan；不重傳。 |
| Vercel worker 在 BGG HTTP 等待中失效 | process lock 不能跨 invocation，舊回應仍可寫入。 | 批次 5 DB lease＋fence，write 時再檢查 token／generation。 |
| 手動 refresh 和每日 BGG 更新交錯 | 誰較新沒有持久化仲裁。 | 批次 5 手動 reservation 先取較新 write generation。 |
| `.vercel.app` 直接打到 Server Action | 把 Cloudflare 前置保護誤當成應用程式授權。 | 批次 0 每入口驗 JWT，origin／preview 各自負向測試。 |

### 尚不能由計畫保證的事項

計畫只完成 intent 到 properties 的 gap B 與設計審查。migration 與 module 完成後，必須以 pgTAP／integration 做 property-level conformance（gap A），再用本機 Supabase、真實 BGG／IGDB、preview、production、手機瀏覽器與 fault injection 驗證真實執行（gap C）。任何真實 credential、平台限制或 payload 與這份計畫矛盾時，先記錄根因並更新 ADR 或決策票，不得在 adapter 裡靜默偏離。

## 參考
--------

- `CONTEXT.md`、`TODOS.md`、`docs/plans/decision-traceability.md`。
- `docs/adr/0003-deploy-on-vercel-with-managed-storage.md`、`docs/adr/0004-use-supabase-postgres-and-storage.md`、`docs/adr/0005-use-nextjs-deep-modular-monolith.md`。
- `docs/plans/data-model-and-invariants.md`、`docs/plans/source-metadata-adapters.md`、`docs/plans/note-list-and-trash-state-machines.md`、`docs/plans/mvp-observability-and-recovery.md`。
- 「[將既有媒體規則落成縮圖與上傳狀態機](https://github.com/elekli/game-base/issues/7)」、「[驗證行動版核心流程](https://github.com/elekli/game-base/issues/9)」、「[將既定 BGG 每日更新規則落成並行安全流程](https://github.com/elekli/game-base/issues/10)」、「[落實身分驗證與伺服器資料存取邊界](https://github.com/elekli/game-base/issues/5)」與「[定稿 MVP 最低限度可觀測性與復原操作](https://github.com/elekli/game-base/issues/13)」。
