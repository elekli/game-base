# ADR 0003：以 Vercel 與受管理儲存作為 MVP 正式環境

- 狀態：已接受，儲存供應商由 ADR 0004 修訂
- 日期：2026-08-20
- 取代：ADR 0001

## 背景

原方案把 QNAP Docker 視為唯一正式部署方式，圖片與附件直接存入 NAS 掛載目錄。這有利於本地檔案救援，但每次介面審查與發行都需要自行建立、傳送及重啟容器；在外部手機網路使用時也需額外維護 VPN、Tunnel 或反向代理。

Vercel 可在每次 Git 推送時建立具有 HTTPS 的預覽部署，並簡化正式發行與版本回復，但執行環境不能作為持久檔案系統，且自動產生的網址會形成 Cloudflare Access 之外的入口。

## 決策

1. Vercel 是 MVP 唯一正式部署及驗收目標；MVP 不交付 QNAP Docker 正式部署。
2. 結構化資料存放於透過 Vercel Marketplace 連接的外部 PostgreSQL。
3. 封面、相簿圖片與遊戲附件存放於私有 Vercel Blob；瀏覽器不得取得 Blob 讀寫 token。
4. 正式自訂網域由 Cloudflare Access 管理登入；應用程式伺服器端仍須驗證 Cloudflare Access JWT，拒絕未經 Cloudflare 的直接請求。
5. 預覽部署使用 Vercel Deployment Protection，不與正式環境共用公開入口。
6. QNAP 只作備份目的地。備份包含 PostgreSQL 可攜匯出、全部 Blob 原檔與可核對其關聯及雜湊的清單。
7. 還原驗收必須實際建立新的資料庫與 Blob 儲存區，不能只確認備份檔存在。

## 理由

- 預覽網址使桌面與手機介面審查不需等待 NAS 容器更新。
- Git 整合、自動 HTTPS、部署記錄與版本回復降低單人維運成本。
- PostgreSQL 與私有 Blob 適合條目、標籤、筆記、相片及 PDF 的資料形態。
- 把 QNAP 留在非同步備份路徑，可保留資料自主性而不讓家庭網路成為正式服務的單點故障。

## 後果

優點：

- 每次變更都有可從手機直接開啟的隔離預覽版本。
- 不必維護公開 QNAP、VPN 或容器發行流程。
- 正式環境自動取得 HTTPS，部署與回復步驟較短。

代價：

- 線上資料分布於 Vercel、PostgreSQL 供應商與 Blob，備份及還原比單一 NAS 資料夾複雜。
- 必須處理資料庫連線池、Blob 存取權、Cloudflare JWT 驗證、`.vercel.app` 繞過及各服務額度。
- Vercel、資料庫與 Blob 的方案或價格變更可能影響營運成本。
- 若未來要回到 QNAP，必須新增正式 Docker 打包與物件儲存轉接層，不能宣稱 MVP 已驗證該路徑。

## 不採用的方案

- **QNAP Docker 作為唯一正式環境**：資料集中且易救援，但發行、外部存取與行動裝置審查較繁瑣。
- **Vercel 前端直接連回 QNAP**：會把家庭網路暴露、穿透、安全與可用性問題帶回線上請求路徑，未換得足夠簡化。
- **同時正式支援 Vercel 與 QNAP**：MVP 必須驗證兩套資料庫、檔案與登入路徑，超出單人產品的必要範圍。

## 後續決策

[ADR 0004](0004-use-supabase-postgres-and-storage.md) 將本 ADR 決策第 2、3、6、7 點中的抽象 PostgreSQL／Vercel Blob 組合，修訂為 Supabase PostgreSQL＋Supabase Storage；Vercel 正式部署、Cloudflare Access 與 QNAP 異地備份的邊界不變。

2026-08-21 的範圍調整將 QNAP 自動備份與還原驗收移出 MVP，列為 MVP 完成後的最高優先項目。此調整只延後實作，不改變 QNAP 作為異地備份目的地的方向。
