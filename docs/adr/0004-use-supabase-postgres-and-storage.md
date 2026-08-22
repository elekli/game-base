# ADR 0004：採用 Supabase PostgreSQL 與 Supabase Storage

- 狀態：已接受
- 日期：2026-08-21
- 修訂：ADR 0003 的儲存供應商決策

## 背景

Vercel 正式部署需要外部 PostgreSQL 與持久物件儲存。純技術比較下，Neon PostgreSQL＋Vercel Blob 的免費方案較適合低頻私人應用：Neon 閒置縮至零而不會因七日低活動暫停，且與 Vercel 預覽部署整合較完整。

擁有者另有一項明確效益：透過真實產品累積可用於求職的 Supabase 經驗。只把 Supabase 當代管 PostgreSQL，主要只會接觸連線字串與 Supavisor，不足以代表完整的 Supabase 實作經驗；本產品原本就需要私有圖片、PDF、權限控制、migration 與異地備份，因此 Supabase Storage、RLS 與 CLI 可以直接承擔真實需求。

比較研究見 [Neon 與 Supabase 選型調查](../research/neon-vs-supabase.md)。

## 決策

1. 結構化資料使用 Supabase PostgreSQL。
2. 封面、相簿圖片與遊戲附件使用私有 Supabase Storage bucket，不使用 Vercel Blob。
3. Vercel 執行環境經 Supavisor transaction pooler 使用受限 runtime role；migration 與備份使用 direct connection。
4. 資料表啟用 RLS 並移除不必要的 `anon`／`authenticated` grants；不得把 secret key 下傳瀏覽器。
5. 瀏覽器只透過伺服器核發的短效簽署網址或上傳權杖讀寫私有物件。
6. 本機開發使用 Supabase CLI，schema migration、seed、bucket 與 RLS 設定必須可從空環境重建。
7. Supabase Auth、Realtime 與 Edge Functions 不加入 MVP；Cloudflare Access 仍是唯一登入與人員准入層。
8. MVP 後的第一優先項目由 QNAP 定期保存 PostgreSQL logical dump、全部 Storage 原檔，以及含路徑、原始檔名、大小、雜湊與資料列關聯的 manifest；此備份功能不屬於 MVP。

## 理由

- PostgreSQL、Storage、RLS、CLI migration、Supavisor、簽署網址與實際還原都直接服務產品需求，不是為作品集額外增加功能。
- 完成上述範圍後，可以精確描述為「以 Supabase PostgreSQL、Supavisor、Storage、RLS 與 CLI migration 建置 Vercel 私有應用程式」，而不宣稱未使用的 Auth、Realtime 或 Edge Functions 經驗。
- 資料庫與物件儲存集中於 Supabase，較「Supabase PostgreSQL＋Vercel Blob」少一個線上資料供應商。

## 後果

優點：

- 開發、migration、RLS、私有物件與備份形成一套可實際展示的 Supabase 經驗。
- PostgreSQL 可使用標準 `pg_dump`／`pg_restore` 搬移；Storage 可經部分 S3 相容介面同步原檔。
- Cloudflare Access 與 Supabase Auth 不重疊，單一登入邊界較清楚。

代價：

- Supabase Free 專案低活動七日後可能暫停，且沒有可依賴的自動資料庫備份。
- Free 方案目前只有 500 MB 資料庫、1 GB Storage 與 50 MB 單檔上限；實作前必須用真實規則書及照片驗證。
- Supavisor transaction mode 不支援 prepared statements，ORM 需要相容設定與正式環境整合測試。
- Supabase secret／service key 會繞過 RLS；所有使用該憑證的伺服器路由都必須先驗證 Cloudflare JWT 與輸入。
- Supabase Storage 沒有物件版本管理；因此 MVP 不提供永久刪除，只保留可還原的資源回收區。

## 範圍調整

2026-08-21 決定不把 QNAP 自動備份、保留政策與還原演練納入 MVP。MVP 可以在尚無異地備份的情況下完成，但必須在文件與介面決策中承認資料不可復原風險；備份仍是 MVP 後的最高優先項目。永久刪除也移出 MVP，待備份與實際還原驗證完成後才可加入。

## 會推翻本決策的條件

- 必要附件超過 50 MB，且不接受升級、壓縮、拆檔或更換物件儲存。
- 圖片及附件很快超過免費容量，且沒有付費預算。
- 七日低活動暫停不可接受，且不願升級 Supabase Pro。
- 求職學習效益不再存在，或已從其他專案取得相同的 Supabase 實作證據。
- Supavisor、ORM 或 Vercel runtime 經實測存在無法合理解決的相容性問題。
