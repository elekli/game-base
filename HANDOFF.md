# Puizeru Gamebase — HANDOFF

**Last session:** 2026-08-22（Batch 1 complete：產品範圍與領域規格定稿）
**For next session:** This file stands alone. You should not need the original conversation or a parent plan to proceed.

---

## Current Status

**Batch 1（complete）：**

- `/Users/elek/puizeru-gamebase/CONTEXT.md`（382 行）是目前產品與領域規格的唯一主文件：詞彙、建立流程、搜尋／篩選、媒體、筆記、貢獻者、清單、刪除、部署、安全、備份及行動版要求均已定稿。
- `/Users/elek/puizeru-gamebase/TODOS.md`（95 行）記錄所有明確延後項目及驗收條件；不得把其中項目默默塞回 MVP。
- `/Users/elek/puizeru-gamebase/docs/research/game-metadata-api-survey.md`（78 行）記錄 BoardGameGeek 與 IGDB 的 API、憑證、限制與費用調查。
- `/Users/elek/puizeru-gamebase/docs/research/neon-vs-supabase.md`（257 行）記錄 Neon／Supabase 比較；因真實產品經驗與求職目標，決定採 Supabase PostgreSQL＋Storage。
- `/Users/elek/puizeru-gamebase/docs/adr/` 有 4 份 ADR。ADR 0001 已被 0003／0004 取代；現行正式方向是 Vercel＋Cloudflare Access＋Supabase，QNAP 只在 MVP 後做異地備份。
- 已完成一次跨文件矛盾檢查並修正：一般中繼資料與每日 BGG 指標更新的例外、遊戲條目刪除與其他低風險刪除的主詞、線上應用程式與「離線瀏覽」誤寫、只有庫外引用之封存清單的還原入口。
- 尚未建立應用程式、資料庫 migration、UI 原型或測試；目前目錄不是 Git repository，也沒有套件設定。

---

## Verification Checklist（Batch 1）

- [x] 檔案與行數已回讀：`wc -l CONTEXT.md TODOS.md docs/research/*.md docs/adr/*.md`，Batch 1 規格與研究合計 997 行（不含本 HANDOFF）。
- [x] 文件結構已檢查：`rg -n '^#{1,3} ' CONTEXT.md TODOS.md docs/adr/*.md`，主要章節與待辦驗收段落存在。
- [x] 風險詞交叉檢查已執行：`rg -n '不做定期|每日|永久刪除|封存清單|空清單|資源回收|線上|來源介紹|Strategy Game Rank|Avg\. Game Weight|供應商＋來源 ID' CONTEXT.md TODOS.md`。
- [x] 部署／離線／備份交叉檢查已執行：`rg -n 'Docker|QNAP|Vercel|Cloudflare|Supabase Auth|備份|永久刪除|離線|PWA' CONTEXT.md docs/adr/*.md TODOS.md`。
- [x] 最後的封存清單不可達狀態已封閉：有庫內成員時從遊戲頁還原；只有庫外引用時，在建立同名清單時直接還原。
- [ ] **下一個 Batch 才能驗證：** 尚無 code，因此沒有 typecheck、測試、build、實際瀏覽器、手機或部署證據。
- [ ] **需外部帳號條件：** 實作 API 串接前確認 BoardGameGeek 與 Twitch／IGDB 憑證已申請；不得把憑證送到瀏覽器。

---

## Next Actions（Batch 2：實作規劃）

Batch 2 要把已定稿的產品規格轉成可分批執行的工程計畫；現在不應重新進行產品逼問，也不應從 382 行需求直接跳到 coding。

1. 讀 `/Users/elek/puizeru-gamebase/CONTEXT.md`、`TODOS.md`、ADR 0003／0004 與兩份研究文件；把 ADR 0001 視為已取代的歷史背景。
2. 決定並記錄 Web 技術棧。預設應評估適合 Vercel 的 TypeScript 框架、Supabase PostgreSQL／Storage、migration、RLS、Supavisor transaction pooler、Cloudflare Access JWT 驗證及 Vercel Deployment Protection；不要把 Supabase Auth、Realtime 或 Edge Functions 加回 MVP。
3. 產出資料模型與狀態機，至少涵蓋：遊戲與來源唯一性、一般／來源欄位分離、貢獻者三分類、遊戲人數、筆記軟刪除、媒體／縮圖狀態、一般清單／對稱關聯、庫外引用轉正、資源回收區、每日 BGG 指標更新及並行去重。
4. 每個非平凡流程畫 ASCII 圖：新增遊戲、外部來源連結、批次圖片上傳、筆記自動儲存／清空確認、清單封存／還原、庫外引用轉成庫內遊戲、每日 BGG 更新、Cloudflare Access 請求邊界。
5. 產出頁面／路由與手機流程：收藏庫網格、搜尋／篩選、新增確認、遊戲詳細頁、照片、筆記、附件、清單、資源回收區及背景更新狀態。
6. 把實作拆成可驗收批次，逐批列出檔案、migration、測試、風險及部署驗證。先建立最小縱切，再加入媒體、筆記、清單與動態指標；不要用單次大批實作。
7. 規劃完成後，因本產品含唯一約束、並行重試、軟刪除、權限邊界與衍生縮圖，套用 `gap-verification` 檢查不變式與交錯路徑，再開始 code。
8. 若要正式初始化 Git，依個人 GitHub 身分設定 per-repo `user.name`／`user.email` 與正確 SSH host alias；功能實作不可直接在 `main` 進行。

**判斷分支：**

- 若現有開源專案能涵蓋大部分已定規格，先做逐項差距表；只有能保留三分類貢獻者、照片／附件、清單、繁體中文、Supabase 學習目標與資料可攜性時才考慮採用或改造。
- 若資料模型顯示目前 MVP 過大，先把不影響「新增遊戲、照片、筆記、搜尋／篩選」的功能移入 `TODOS.md`，並向 elek 說明取捨；不得自行刪除已定義的核心資料或改變既有語意。
- 若 BoardGameGeek／IGDB 實際回應缺少某個唯讀欄位，保留「未知」狀態並記錄來源缺口；不得猜值或用文字解析冒充結構化資料。

**Alternative outcome：**若技術調查證明某個 API、Vercel 限制或 Supabase Free 額度使既定路徑不可行，成功結果是附官方證據的 ADR 修訂與可行替代方案，不是繞過安全、資料保存或可復原性要求。

---

## Design Decisions（carried from Batch 1, still valid）

- **產品與使用者。** 單一擁有者、繁體中文響應式 Web；桌面與手機完成完整流程，不做原生 App、PWA、離線佇列、多使用者或分享。
- **MVP 資料核心。** 一個可辨識遊戲標題是一筆遊戲條目；不建立逐次遊玩紀錄。同遊戲跨 Steam／PS5 等平台仍是一筆，平台可複選。
- **建立與來源。** 新增時先選桌遊／電子遊戲，分別只查 BoardGameGeek／IGDB；搜尋結果經確認才建立。來源身分 `provider + source_id` 在一般與資源回收資料中全域唯一，由資料庫約束守住。
- **來源失敗與手動條目。** 外部找不到時可只填名稱建立；未連結條目可第一次連結來源。已連結來源的更換延後，不能自動合併兩筆遊戲資料。
- **本地搜尋與分類。** 收藏庫搜尋只查本地顯示名稱、原文名及別名。遊戲類型、實際平台、來源分類、自由標籤與貢獻者是分開的篩選維度；同維度 OR、不同維度 AND。
- **中繼資料。** 一般來源資料只在建立與手動重新整理時更新，且不得覆寫擁有者內容。來源介紹唯讀、安全清理且預設收合。
- **BGG 主要指標。** 重度（Avg. Game Weight）是主要指標，Strategy Game Rank 是次要動態指標；建立時抓取，之後每個台北日第一次登入背景更新一次，只保存最新值與時間。
- **人數。** 桌遊與電子遊戲共用「同地多人範圍＋單人支援」；不納入純線上互動。結構化值在 MVP 唯讀，來源缺漏顯示未知。
- **貢獻者。** 全庫共用人物／組織，只分「設計／開發、美術、發行」三類。來源關係唯讀，手動關係可增刪；只按來源身分自動去重，不按名字合併。
- **筆記。** 多則 Markdown 純文字筆記；自動儲存與狀態可見。空白新筆記不建立；清空既有筆記待離開確認後軟刪除，意外關閉保留伺服器舊值。
- **編輯器。** MVP 保底為 Markdown 原始碼編輯器＋工具列；Vditor `ir` 手機原型並行驗證，不能阻塞主線。
- **圖片與附件。** 私有 Supabase Storage；單檔 50 MB。圖片保存原檔並預產一份 WebP 縮圖，批次逐檔成功／失敗，縮圖失敗不能回滾原檔。
- **清單。** 一般命名清單與對稱的關聯遊戲皆屬 MVP；可含庫內遊戲或具穩定來源身分的庫外引用。庫外只存名稱、年份與本地封面縮圖，轉成正式條目時保留清單關係。
- **刪除。** 遊戲只進永久保留的資源回收區；筆記與清單關係軟刪除；一般清單封存。永久刪除遊戲與 Storage 檔案必須等 QNAP 備份及實際還原驗證完成。
- **部署與存取。** 正式環境只支援 Vercel；Cloudflare Access 是唯一登入層，伺服器仍驗 JWT 防止 `.vercel.app` 繞過。預覽用 Vercel Deployment Protection，正式與測試 Supabase 專案及 secrets 分離。
- **Supabase 範圍。** PostgreSQL、私有 Storage、CLI migration、RLS、Supavisor 屬 MVP；Auth、Realtime、Edge Functions不屬於 MVP。
- **備份。** QNAP 自動備份／還原是 MVP 後 P0，不是 MVP 驗收條件；完成前明確接受沒有異地復原保障。

## Design Decisions（Batch 1）

- **來源分類依 API 欄位白名單。** BGG 只納入 category／mechanic；IGDB 納入 genre／theme／game mode／player perspective，不從文字猜分類，也不匯入 IGDB keywords／彙整 tags。
- **庫外 contributor 探索延後。** 現有 BGG／IGDB 無法一致提供個人製作名單反查；MVP 只查收藏庫內，後續另找合法來源或索引。
- **封存清單不設全域頁。** 有庫內成員時從遊戲頁還原；只有庫外引用時，建立同名清單會顯示原清單並直接還原。
- **首頁優先可瀏覽性。** 預設封面網格按顯示名稱排序；桌遊卡片顯示重度，電子遊戲顯示實際平台。搜尋／篩選不永久保留到下次開啟。

---

## Relevant Files

**Modified／Created（Batch 1）：**

- `/Users/elek/puizeru-gamebase/CONTEXT.md` — 產品與領域主規格。
- `/Users/elek/puizeru-gamebase/TODOS.md` — 延後項目與驗收條件。
- `/Users/elek/puizeru-gamebase/docs/research/game-metadata-api-survey.md` — BGG／IGDB 調查。
- `/Users/elek/puizeru-gamebase/docs/research/neon-vs-supabase.md` — 儲存方案比較。
- `/Users/elek/puizeru-gamebase/docs/adr/0001-store-binary-assets-as-ordinary-files.md` — 已取代的 QNAP 一般檔案方案。
- `/Users/elek/puizeru-gamebase/docs/adr/0002-retain-external-cover-images-for-private-use.md` — 私人情境保存來源封面。
- `/Users/elek/puizeru-gamebase/docs/adr/0003-deploy-on-vercel-with-managed-storage.md` — Vercel、Cloudflare Access 與 QNAP 邊界。
- `/Users/elek/puizeru-gamebase/docs/adr/0004-use-supabase-postgres-and-storage.md` — Supabase PostgreSQL／Storage 決策。
- `/Users/elek/puizeru-gamebase/HANDOFF.md` — 本接力文件。

**Reference（do not casually modify）：**

- `CONTEXT.md` 與 ADR 0002／0003／0004 是已確認決策；若實作證據要求改變，先說明矛盾並以新的／修訂 ADR 記錄，而不是靜默偏離。
- `TODOS.md` 內的延後項目包含 Vditor 原型、QNAP 備份、來源更換、庫外貢獻者探索、人數編輯、貢獻者合併與 BGG 指標歷史。

---

## When Batch 2 is complete

Update this HANDOFF with：

- 實作計畫的檔案路徑、批次切分與每批驗收條件。
- 資料模型、狀態機與 ASCII 流程圖已覆蓋哪些不變式。
- 技術棧與任何新增／修訂 ADR。
- 哪些 API 憑證與本機／預覽環境已實測，哪些仍需外部條件。
- 是否已可進入 Batch 3 實作，或仍有需要 elek 裁決的產品／成本問題。
