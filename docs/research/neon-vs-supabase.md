# Neon 與 Supabase 選型調查

查證日期：2026-08-20

## 結論

**建議採用方案 C：Supabase PostgreSQL＋Supabase Storage。**

若只看這個單人、低流量 MVP 的技術與免費方案可靠度，Neon PostgreSQL＋Vercel Blob 較省事：Neon 免費方案會閒置縮至零而非因七日未使用而暫停，並提供六小時還原窗口；其 Vercel 整合也能為預覽部署建立資料庫分支。

但 elek 已把「累積可用於求職的 Supabase 經驗」列入效益。只把 Supabase 當代管 PostgreSQL，主要接觸的只是連線字串、Supavisor 與控制台，不能有說服力地概括為完整的 Supabase 經驗。這個產品原本就需要私有封面、相簿與 PDF，因此同時使用 Supabase Storage、私有 bucket、限時上傳／下載網址、RLS、CLI、本機環境及 migration，並非為作品集硬加功能，而是把真實需求交給 Supabase 的原生能力。這足以改變原先偏向 Neon 的建議。

此建議**不包含 Supabase Auth**。Cloudflare Access 仍是唯一登入入口；Vercel 應用程式在伺服器端驗證 Cloudflare Access JWT 後，才以伺服器端憑證存取 Supabase。Supabase Auth 與 Cloudflare Access 的雙重帳號／工作階段沒有產品需求，不應為了履歷而加入。

## 既定前提

- 單一擁有者、非商業、低流量。
- 正式應用程式部署於 Vercel。
- 自訂網域由 Cloudflare Access 保護；應用程式伺服器仍驗證 JWT 的簽章、issuer 與 audience。
- 圖片與 PDF 為私有資料。
- QNAP 是可還原備份目的地，不參與線上請求。
- MVP 不需要公開註冊、多人權限或應用程式內帳號管理。

## 候選方案

- **A：Neon PostgreSQL＋Vercel Blob**
- **B：Supabase PostgreSQL＋Vercel Blob**
- **C：Supabase PostgreSQL＋Supabase Storage**

## 決策矩陣

以下評語只針對上述既定前提，不代表通用排名。

| 判準 | A：Neon＋Vercel Blob | B：Supabase DB＋Vercel Blob | C：Supabase DB＋Storage |
|---|---|---|---|
| Vercel 部署便利 | **最佳**。原生整合、pooler、預覽部署可配資料庫分支 | 良好。Marketplace 可同步環境變數；serverless 使用 Supavisor transaction mode | 良好。與 B 相同，另以 Supabase SDK／簽署網址處理檔案 |
| 免費方案待命可靠度 | **最佳**。閒置縮至零；100 CU-hours／專案／月、0.5 GB、六小時還原 | 較弱。500 MB；低活動七日可能暫停；無自動備份 | 較弱。同 B；另有 1 GB Storage、單檔最高 50 MB |
| 預覽環境隔離 | **最佳**。Vercel 預覽可自動建立 Neon branch | 較弱。Supabase Free 不含 branching；須以本機環境或第二個免費專案替代 | 較弱。同 B；Storage bucket 也不可讓預覽環境誤寫正式資料 |
| 本機開發／migration | 一般。可用一般本機 PostgreSQL 或 Neon Local；Neon 本身不提供 schema migration，通常交由 ORM | **完整**。Supabase CLI 可在 Docker 啟動 PostgreSQL、Auth、Storage 等本機堆疊，migration 納入版本控制 | **完整且最貼近正式環境**。可同時測 migration、Storage 設定及 RLS |
| 備份與還原 | 免費方案有六小時平台還原；仍須自行 `pg_dump` 與備份 Blob | Free 無自動備份或可下載備份；必須自行匯出 DB，Blob 另備份 | Free 無自動備份；DB backup 不含 Storage 物件，必須分開匯出 DB 與同步物件 |
| 資安邊界 | Cloudflare／應用程式驗證＋DB／Blob 伺服器憑證，邊界清楚 | 同左；若不用 Supabase Data API，RLS 與 Supabase 平台能力價值有限 | Cloudflare／應用程式驗證仍是入口；私有 bucket、限時網址與伺服器端 secret 形成第二層控制 |
| 可攜性 | DB 很高；Vercel Blob API 需 adapter | DB 很高；Blob 同左；卻同時依賴兩個資料供應商 | DB 很高；Storage API 與 `storage` schema 有鎖定，但支援部分 S3 協定，物件可另行同步 |
| 未來維運 | 兩個資料供應商；Neon 閒置喚醒但不會因七日未使用而把專案標為暫停 | 三個線上供應商，沒有換來顯著產品能力 | 兩個線上供應商；Supabase Free 暫停、檔案額度及雙份備份是主要負擔 |
| 求職訊號 | PostgreSQL／serverless DB 經驗；Neon 特有能力集中在 branching、autoscaling | **弱**。只能誠實聲稱「Supabase-hosted Postgres／Supavisor」 | **最佳**。可展示 DB、migration、RLS、Storage、簽署網址、本機環境與備份；但不能聲稱 Auth／Realtime／Edge Functions 經驗 |
| 對本案整體裁決 | 純技術與零費用可靠度首選 | 不採用：取兩邊缺點，求職學習又不足 | **建議採用**：求職目標足以抵銷免費方案劣勢 |

## 費用與方案限制

### Neon

截至查證日，Free 為 USD 0，官方列出：

- 每個專案每月 100 CU-hours；閒置時自動 scale-to-zero。
- 每個專案 0.5 GB 儲存空間。
- 最長六小時、或最多 1 GB 資料變更的 time travel／restore。
- Free 也有 autoscaling、branching、read replicas 與 connection pooling。
- Launch 為用量計價；官方以間歇性、1 GB 工作負載估算「典型」約 USD 15／月，不是固定最低月費。

Neon 的優點不是完全沒有冷啟動，而是閒置停止計算 compute，下一次查詢再喚醒；官方方案頁沒有寫成「七日未活動即暫停專案」。

### Supabase

截至查證日，Free 為 USD 0，官方列出：

- 最多兩個 active Free projects。
- 每個專案 500 MB database size；新專案本身約使用 40–60 MB。超過 500 MB 會進入唯讀模式。
- 低活動達七日的 Free 專案可能暫停，可在控制台恢復。
- Free 不含 automatic backups、可下載的 dashboard backup 或 PITR；官方建議定期執行 `supabase db dump` 並保存異地備份。
- 1 GB Storage、5 GB uncached egress＋5 GB cached egress；Free 單檔上限 50 MB。
- Free 不含 database branching。
- Pro 由 USD 25／月起，包含一個預設 compute 的 credit、8 GB disk、100 GB Storage、七日每日 DB backup，且不因閒置暫停。
- PITR 是額外付費項目；七日保存官方列價約 USD 100／月。

對本案而言，500 MB 資料庫大致足夠，但 1 GB 檔案與 50 MB 單檔上限必須在實作前用真實照片與規則書樣本驗證。若一份掃描規則書超過 50 MB，Supabase Free Storage 會直接不符合需求。

### Vercel Blob（方案 A／B）

Vercel Blob 的 Hobby 額度也是 1 GB／月，另含 10 GB data transfer、10,000 次 simple operations 與 2,000 次 advanced operations；超額後 Hobby 不收取追加費用，而是暫停 Blob 存取直到額度窗口恢復。其單一物件上限遠高於 Supabase Free 的 50 MB。

因此，方案 C 並沒有靠免費 Storage 取得更大容量；它取得的是 Supabase 原生 Storage／RLS／簽署網址經驗與少一個資料供應商，代價則是 50 MB 單檔上限及七日低活動暫停風險。

## 開發與部署

### Neon 路徑

- Vercel Marketplace 的 Neon 原生整合可注入連線設定，並可為每個 Vercel Preview 建立資料庫 branch。
- pooled connection 使用 PgBouncer，Free 也支援；適合 Vercel serverless 的大量短連線。
- Neon Local 是連往雲端 Neon branch 的本機 proxy，不是完全離線的本機 PostgreSQL。若要完全離線，可自行執行 PostgreSQL；migration 由 Drizzle、Prisma 等工具管理。

### Supabase 路徑

- Vercel Marketplace 可建立／連結 Supabase 專案並同步 DB、Supabase URL 與 key 等環境變數。
- Vercel serverless runtime 應使用 Supavisor transaction mode（port 6543）；此模式不支援 prepared statements，ORM 必須使用相容設定。migration、`pg_dump` 等維運工作使用 direct connection，不走 transaction pooler。
- Supabase CLI＋Docker 可在本機啟動 PostgreSQL、Storage、Studio 等服務；schema migration、Storage bucket 設定與 seed 可保存於版本庫。
- Supabase Free 不含 branching。MVP 應以本機 Supabase 作為主要 schema／Storage 驗證環境；Vercel Preview 預設不得連正式資料。必要時使用第二個 Free project 作固定測試環境，不宣稱每個預覽都有獨立資料庫。
- 官方文件警告 Supabase Vercel branching integration 的環境變數同步與 Vercel build 之間可能有競速；整合會自動重新部署最近的 PR deployment。即使日後升級 branching，仍須在驗收流程覆蓋此路徑。

## 建議架構

```text
瀏覽器
  │
  ▼
Cloudflare Access
  │  Cf-Access-Jwt-Assertion
  ▼
Vercel／Next.js 應用程式
  ├─ 驗證 Cloudflare JWT：簽章＋issuer＋audience＋期限
  ├─ PostgreSQL：經 Supavisor transaction pooler，使用受限 runtime role
  └─ Supabase Storage：伺服器端 secret
       ├─ 產生限時 signed upload URL → 瀏覽器直接上傳
       └─ 產生短效 signed download URL → 瀏覽器查看／下載

QNAP 排程備份
  ├─ PostgreSQL logical dump
  ├─ S3 相容介面同步全部 Storage 物件
  └─ manifest：物件路徑、原始檔名、大小、雜湊、資料列關聯
```

### 資安界線

1. Cloudflare Access 是登入與人員准入層；應用程式必須自行驗證 `Cf-Access-Jwt-Assertion`，以阻擋直接造訪 `.vercel.app` 的請求。
2. Supabase Auth 不加入 MVP。Cloudflare Access token 不是官方文件列出的 Supabase first-class third-party provider；雖然它以 RS256、`kid` 與 JWKS 簽署，Supabase 官方頁面未確認可直接把 Cloudflare Access 設為 third-party auth。此整合視為**未確認**。
3. `SUPABASE_SECRET_KEY` 只存在 Vercel server environment，不下傳瀏覽器。官方明確指出 secret／service key 會 bypass RLS，故每個使用它的 server route 都必須先完成 Cloudflare JWT 驗證與輸入驗證。
4. 圖片與附件使用 private bucket。瀏覽器只取得短效 signed URL 或 signed upload token，不取得 secret key。
5. 正式資料表仍啟用 RLS 並撤銷 `anon`／`authenticated` 不必要 grants，避免意外經 Data API 暴露。runtime 連線角色不得是 table owner 或具有 `BYPASSRLS`。
6. 單人系統的 RLS 可以是「只有受限 runtime role 可操作全部列」，不應假裝成已完成多租戶隔離。若未來增加多人，須另作資料擁有權模型與 RLS 重設計。

## 備份、刪除與復原

- Supabase Free 沒有可依賴的自動 DB backup。QNAP 排程至少要執行 `supabase db dump`／`pg_dump`，並保留多個時間點。
- Supabase 的 DB backup **不包含 Storage 物件本體**，只包含物件 metadata；QNAP 必須另外經 S3 相容介面同步物件。
- Supabase Storage 不支援 S3 object versioning；被刪除的物件無法由 Storage 原生版本還原。應用程式永久刪除必須先確認該物件已存在於最近一份完整 QNAP 備份。
- 還原測試必須建立全新 Supabase project，先還原 DB/schema，再回傳 Storage 物件，最後核對 manifest 的數量與 hash。只驗證 `pg_restore` 不算完成。
- Free 專案暫停後可從控制台恢復，但「可恢復」不等於備份；供應商專案被誤刪時，所有平台備份也會永久刪除。

## 可攜性與供應商鎖定

### PostgreSQL

兩家都提供真正的 PostgreSQL connection string，可用 `pg_dump`／`pg_restore` 搬遷。可攜性的主要風險不在供應商本身，而在是否大量依賴平台專屬 schema、extension、Data API 與 auth claims。

建議：領域資料放在自有 schema／tables；migration 保存在版本庫；資料存取介面不要把 Supabase SDK 型別滲入 domain layer。

### Storage

Supabase Storage 支援部分 S3 協定，常見物件上傳、下載與列表可使用 S3 工具，降低搬出難度；但不是完整 S3 實作，而且不支援 object versioning。bucket policy、`storage` schema、RLS helper 與 signed URL 行為仍是 Supabase 專屬。

建議建立小型 `AssetStore` 介面，至少隔離：建立上傳授權、建立下載授權、刪除、列舉、讀取 metadata。不要把 Supabase object path 當作永久外部網址；資料庫只保存 provider-independent object key 與檔案 metadata。

## 求職價值：事實與推論

### 可查證事實

- Supabase 官方產品涵蓋 PostgreSQL、Data API、Auth、Storage、Realtime、Edge Functions、RLS 與本機 CLI；只連 PostgreSQL 不等於使用了其餘能力。
- 近期公開職缺樣本確實把「Supabase」拆成多項能力。例如 InstaSupply 的職缺明列 Database、Edge Functions、Auth、Storage、RLS；Bardo 明列 Auth、Database、Storage、RLS；Finite State 明列 Postgres functions、views、triggers、RLS、Edge Functions、Auth／OIDC。這些是存在性證據，不是市場占有率或完整職缺統計。
- 部分職缺只要求「PostgreSQL via Supabase」或把 Supabase 列為加分條件，顯示代管 DB 經驗仍有價值，但訊號較接近 PostgreSQL／平台整合，而非完整 Supabase 後端能力。

### 推論

- **只採方案 B，不足以有說服力地在履歷寫「具 Supabase 經驗」。**較精確的寫法只能是「在 Vercel serverless 使用 Supabase-hosted PostgreSQL 與 Supavisor」。
- **方案 C 能形成一段可信但有邊界的 Supabase 經驗。**因為檔案管理是本產品的核心需求，候選人可以解釋為何採 private bucket、signed URL、RLS、CLI migration、off-site backup，而不是列出一串沒用到的服務。
- 求職面試的訊號主要來自能否說清楚安全邊界、失敗路徑與搬遷策略，而不是用了多少 Supabase 產品。因此不應為了「全家桶」加入 Supabase Auth、Realtime 或 Edge Functions。

### 最低可信作品集範圍

完成下列各項後，可以誠實聲稱：**「以 Supabase PostgreSQL、Supavisor、Storage、RLS 與 CLI migration 建置並部署一個 Vercel 私有應用程式。」**

1. 以 Supabase CLI 啟動本機 stack；migration、seed、bucket 設定可從空環境重建。
2. Vercel runtime 經 Supavisor transaction pooler 連線；migration／backup 使用 direct connection；測試 prepared statement 相容性。
3. 領域資料表啟用 RLS、移除不必要 grants，並有整合測試證明匿名／錯誤角色被拒絕、runtime role 可執行預期操作。
4. 使用 private Storage bucket；手機批次圖片上傳使用 signed upload URL 或 TUS resumable upload；查看與下載使用短效 signed URL。
5. 不在瀏覽器暴露 Supabase secret；所有建立簽署網址的 server route 先驗 Cloudflare JWT。
6. 實際跑過 QNAP DB dump＋Storage object sync，並還原到全新專案，核對物件 hash 與資料關聯。
7. 文件明說未使用 Supabase Auth、Realtime、Edge Functions，不把未使用能力包裝成經驗。

若只完成第 1–2 項，履歷應寫「Supabase-hosted PostgreSQL」，不要寫成籠統的「Supabase backend」。

## 主要風險與緩解

| 風險 | 影響 | 緩解方式 |
|---|---|---|
| Free 專案七日低活動後暫停 | 私人資料庫偶爾打開時可能先遇到不可用 | 接受手動恢復；若要求隨時可用，升級 Pro 或改 Neon |
| Free 無自動 DB backup | 操作錯誤或專案刪除可能遺失資料 | QNAP 定期 logical dump、多版本保留、還原演練 |
| DB backup 不含 Storage 物件 | 只備份 DB 無法恢復圖片／PDF | 分開同步物件，manifest＋hash 驗證完整性 |
| Storage 無 object versioning | 誤刪物件後平台端不可還原 | 應用層 soft delete；永久刪除前確認異地備份 |
| Free 單檔 50 MB、總量 1 GB | 掃描 PDF 或照片庫可能超限 | 實作前測真實樣本；必要時升 Pro，或推翻方案 C |
| Supavisor transaction mode 不支援 prepared statements | ORM 設定錯誤會在正式環境失敗 | 明確關閉／調整 prepared statements；以 Vercel 預覽做整合測試 |
| secret key bypass RLS | 任一未驗 JWT 的 server route 都可能成為全權入口 | 集中式 auth middleware；最小權限 runtime DB role；secret 不進瀏覽器 |
| Vercel Preview 誤連正式 Supabase | 測試可能污染或刪除正式資料 | 預覽預設不注入 production secret；本機 stack 或固定測試 project |
| 學習範圍膨脹 | 為作品集拖慢核心 MVP | 只用 DB、CLI、RLS、Storage；Auth／Realtime／Functions 明確排除 |

## 會推翻建議的新證據

出現任一項，就應改回方案 A（Neon PostgreSQL＋Vercel Blob），或重新選 Storage：

1. 使用者要求免費方案也必須七日以上不使用後仍可立即開啟，且不接受手動恢復或 USD 25／月 Pro。
2. 真實規則書樣本存在超過 50 MB 的必要檔案，且不接受壓縮、拆檔或升級 Supabase Pro。
3. 預估相片／PDF 很快超過 1 GB，且沒有付費預算；此時 Vercel Blob Hobby 同樣只有 1 GB，應重新比較付費物件儲存，不只回到既有兩案。
4. Vercel 每個預覽部署都必須在免費方案自動取得隔離資料庫；Neon 原生 branch 明顯較符合。
5. 作品集／求職學習目標不再重要，或 elek 已從其他專案取得可證明的 Supabase Storage、RLS 與 migration 經驗。
6. QNAP 無法可靠執行 DB dump＋Storage object sync 與還原演練；Supabase Free 沒有足以替代的自動備份。
7. 實測 Supavisor、ORM 或 Vercel runtime 出現無法在合理範圍內解決的相容性問題。

## 未確認事項

- Supabase 官方 third-party auth 文件列出的 first-class providers 不含 Cloudflare Access。Cloudflare token 具 RS256、`kid` 與 JWKS，但是否可直接配置成 Supabase generic third-party provider、如何映射必要的 `role` claim，未找到兩方官方整合文件；MVP 不依賴此路徑。
- 目前尚未取得實際相片與 PDF 樣本，無法確認 50 MB 單檔及 1 GB 總額度是否足夠。
- Supabase Free 專案被判定為「低活動」的精確活動計算方式未在本次查證的官方頁面完整定義；只採用官方明載的「一週低活動可能暫停」。
- 公開職缺樣本不能推算 Supabase 的精確需求量、市占率或薪資溢價；本報告只用它們判斷雇主期待的能力範圍。

## 官方來源

### Neon

- [Neon Pricing](https://neon.com/pricing)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
- [Neon database branching workflow](https://neon.com/docs/get-started-with-neon/workflow-primer)
- [Neon Local](https://neon.com/docs/local/neon-local)
- [Vercel Marketplace：Neon](https://vercel.com/marketplace/neon)
- [Neon：Vercel preview branch integration](https://neon.com/blog/neon-vercel-native-integration)

### Supabase

- [Supabase Pricing](https://supabase.com/pricing)
- [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase database size](https://supabase.com/docs/guides/platform/database-size)
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase PostgreSQL connections and Supavisor](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase local development](https://supabase.com/docs/guides/local-development)
- [Supabase migration workflow](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Supabase Vercel integration](https://vercel.com/marketplace/supabase)
- [Supabase branching integrations](https://supabase.com/docs/guides/deployment/branching/integrations)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Data API security](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Supabase signed upload／resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
- [Supabase private file delivery](https://supabase.com/docs/guides/storage/serving/downloads)
- [Supabase Storage limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
- [Supabase Storage pricing](https://supabase.com/docs/guides/storage/pricing)
- [Supabase S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility)
- [Supabase third-party auth](https://supabase.com/docs/guides/auth/third-party/overview)
- [Supabase custom JWT and signing keys](https://supabase.com/docs/guides/auth/signing-keys)

### 既定存取與替代 Storage

- [Cloudflare Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Vercel Blob usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)

## 非官方職缺樣本（只作能力範圍證據）

- [InstaSupply：React Native＋Supabase](https://wellfound.com/jobs/4015075-senior-full-stack-developer-react-native-supabase)
- [Bardo：SvelteKit＋Supabase](https://wellfound.com/jobs/3711428-senior-full-stack-developer-sveltekit-supabase)
- [Finite State：Next.js／PostgreSQL／Supabase](https://wellfound.com/jobs/3681271-lead-ai-software-engineer)
- [Second Sponsor：PostgreSQL via Supabase](https://wellfound.com/jobs/3827101-senior-full-stack-developer)
