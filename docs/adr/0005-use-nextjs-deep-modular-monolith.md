# ADR 0005：採用 Next.js deep modular monolith

- 狀態：已接受
- 日期：2026-08-22
- 延伸：ADR 0003 的 Vercel 部署與 ADR 0004 的 Supabase 邊界

## 背景

MVP 需要在 Vercel 上提供手機優先的繁體中文介面，並連接 Supabase PostgreSQL、私有 Storage、BGG 與 IGDB。既有決策已固定 Cloudflare Access 是唯一登入層，Vercel 執行環境透過 Supavisor 使用受限 PostgreSQL role，資料庫結構由 Supabase CLI migration 管理；Supabase Auth、Realtime 與 Edge Functions 不在 MVP。

技術棧仍須避免兩種相反風險：一是為作品集拆出不必要的獨立後端、monorepo 或重複 migration 工具；二是把所有行為堆進 Next.js route、Server Action 或通用 CRUD repository，導致產品規則分散且難以測試。專案需要的是單一部署單位中的 deep modules：少量 interface 隱藏較多行為，呼叫端不需要理解資料庫、外部來源與錯誤復原細節。

## 決策

### Web 框架與執行模式

1. 採用 Next.js App Router、React 與 TypeScript，建立單一全端 Web 專案，不另拆獨立後端服務。
2. 預設使用 React Server Components 讀取資料；互動元件才使用 Client Components。
3. 資料異動預設由 Server Actions 接收。MVP 不為內部介面另建 REST API；若日後出現外部呼叫者，再由相同 module interface 增加 Route Handler adapter。
4. 所有伺服器程式預設使用 Node.js runtime。MVP 不使用 Edge Runtime；只有日後量測證明某條無 Node.js 相依的 route 有明確延遲問題時才另行評估。
5. Server Actions 與 Route Handlers 都視為公開網路入口，必須在入口重新驗證 Cloudflare JWT、授權與輸入，不能依賴介面是否從本頁呼叫。

### Deep modules 與專案骨架

6. 採單一 `pnpm` package 的 modular monolith，不建立 monorepo。具體 module 名稱等待資料模型 ticket 定稿，不由本 ADR 預先發明。
7. 每個 module 只暴露一個小型 public interface；interface 以完整使用者意圖與結果為單位，例如從來源建立遊戲、手動建立、重新整理中繼資料或移入資源回收區，而不是暴露通用 `find`／`insert`／`update` CRUD。
8. 驗證、交易、資料寫入、來源唯一性、錯誤命名與復原行為放在 module implementation。Next.js route、page、Server Action、Supabase、Drizzle 與第三方 SDK 型別不得滲入 module interface。
9. 只有實際存在兩個合理 adapter 時才建立 seam。BGG、IGDB 等真正外部依賴使用 production adapter 與測試 adapter；本機 Supabase 可替代正式 Supabase，因此 PostgreSQL／Storage 細節可留在 module 的 internal seam，不建立沒有替換需求的全域 repository interface。
10. 初始骨架如下；module 內部檔案依行為需要建立，不強制複製固定技術分層：

```text
src/
  app/                 Next.js route、page 與組裝 adapter
  modules/
    <module>/
      index.ts         唯一 public interface
      internal/        規則、資料操作與狀態轉換
  adapters/            真正外部系統的 adapter
  shared/              少量真正跨 module 的基礎型別與工具
supabase/
  migrations/          唯一 schema migration 真本
  tests/               pgTAP database tests
  seed.sql             可重建的本機假資料
tests/
  e2e/                 Playwright 關鍵流程
```

### 資料庫、Storage 與 migration

11. 結構化資料沿用 ADR 0004：Vercel 經 Supavisor transaction pooler 連接 Supabase PostgreSQL 的受限 runtime role；不以 `supabase-js` Data API 作為主要資料庫路徑。
12. Drizzle 作為 module implementation 內的型別安全 SQL 查詢工具，runtime driver 使用 `postgres.js`，並以 `prepare: false` 相容 Supavisor transaction mode。
13. `supabase/migrations/` 是唯一 schema 真本。只使用 `drizzle-kit pull` 從套用 migration 後的本機 PostgreSQL 反向產生 Drizzle TypeScript schema；禁止使用 `drizzle-kit generate`、`migrate` 或 `push`。
14. CI 在重播 migration 後重新產生 Drizzle schema，若 repository 中的產物有差異即失敗，避免型別描述落後於資料庫。
15. `supabase-js` 只用於 Supabase Storage，例如上傳私有物件與核發短效簽署網址。PostgreSQL 與 Storage 不共享 transaction；跨兩者的部分成功、重試與補償由媒體狀態機 ticket 定義。

### 表單、驗證與介面樣式

16. 表單預設使用原生 `<form>`、Server Actions 與 `useActionState`。Zod 在每個伺服器入口執行 runtime validation；TypeScript 型別不能取代這項檢查。
17. React Hook Form 不作為全域預設。只有動態欄位或複雜即時互動已有實作證據時，才在該表單局部引入。
18. 樣式採 Tailwind CSS；可重用的介面元件以 shadcn/ui 為起點，元件原始碼由本 repository 持有。不得因使用元件範本而略過無障礙、觸控尺寸與手機 viewport 驗證。

### 測試與本機開發

19. 測試以 module interface 為主要表面；測試可觀測結果，不穿透 internal implementation。深化 module 後，不保留與 interface 測試重複的淺層測試。
20. 測試分層如下：
    - pgTAP：schema、constraint、database function 與 RLS。
    - Vitest：純領域邏輯、module interface，以及透過本機 Supabase 的資料整合。
    - Testing Library：只有具實質互動狀態的 Client Components。
    - Playwright：建立遊戲、搜尋／篩選、編輯筆記與媒體上傳等關鍵瀏覽器流程；非同步 Server Components 優先由此層覆蓋。
    - Snapshot tests 不作為預設。
21. 本機開發使用 Supabase CLI 與容器化本機 stack。`supabase db reset` 必須能從空資料庫依序重播全部 migration，再載入 `seed.sql`；Next.js 應用程式連到該本機環境。
22. Vercel 預覽部署沿用固定的 Supabase 測試專案，正式與測試 secrets 分離。本機與 CI 不使用正式資料。
23. 套件只由 `pnpm` 管理並提交 lockfile。建立骨架時在 `packageManager` 與 Node 版本檔固定實際版本，不以未固定的全域工具作為可重建前提。

## 執行流程

```text
瀏覽器
  │
  ├─ React Server Components ───────────────┐
  └─ Client Component／form                 │
                 │                          │
                 ▼                          │
        Server Action／Route adapter        │
        驗 Cloudflare JWT＋Zod              │
                 │                          │
                 └──────────┬───────────────┘
                            ▼
                    Deep module interface
                            │
                    Internal implementation
                       ┌────┴────┐
                       ▼         ▼
                 Drizzle SQL   supabase-js
                       │         │
                  Supavisor   Storage API
                       │         │
                 PostgreSQL   Private Storage
                    ＋RLS
```

## 理由

- Next.js 與 Vercel 對齊既有部署決策；單一全端專案少一個部署、網路與版本協調面。
- Server-first 渲染讓資料與 secrets 留在伺服器；deep module interface 又避免產品邏輯綁死於 Server Actions。
- Supavisor 保留既有的受限資料庫 role 與 RLS 安全路徑；Drizzle 提供直接 PostgreSQL 路徑所需的型別安全，但不成為第二套 migration 權威。
- 使用者意圖導向的 module interface 能隱藏跨資料表、Storage 與外部來源的複雜度，並讓同一 interface 同時服務呼叫者與測試。
- 本機 Supabase、pgTAP、integration tests 與 Playwright 分別驗證資料庫不變式、module 行為及真實瀏覽器流程，避免只靠 mock 或重複測試。

## 後果

優點：

- 單一 repository、單一 package、單一部署與單一 migration 真本，初始操作成本較低。
- 產品規則集中於 deep modules；UI、資料庫與外部 API 可在 interface 不變時替換 implementation。
- PostgreSQL、RLS、Storage、migration 與 Supavisor 都以真實產品需求被使用，保留既定的 Supabase 學習目標。

代價：

- Server Actions 與 App Router 仍是框架 adapter，版本升級須由 integration／E2E tests 保護。
- Drizzle schema 是從 PostgreSQL 產生的衍生產物；若 CI 未執行漂移檢查，型別可能與 migration 不一致。
- shadcn/ui 元件由專案持有，升級、無障礙與手機操作品質不能外包給套件供應者。
- Node.js runtime 不取得 Edge Runtime 的低延遲特性；目前沒有證據顯示本產品需要承擔 Edge 限制換取該效益。
- PostgreSQL 與 Storage 沒有共同 transaction，媒體流程必須明確處理部分成功。

## 會推翻本決策的條件

- 實測證明 Drizzle／`postgres.js` 無法在 Vercel 與 Supavisor transaction mode 下穩定運作，且沒有可接受的設定或等價型別安全 SQL 工具。
- 出現 Next.js 以外的實際呼叫者，需要穩定的外部 HTTP interface；屆時新增 adapter，而不是把 module interface 改成 HTTP 型別。
- module 數量、獨立發布需求或團隊 ownership 已大到單一 package 明確造成部署與協作瓶頸；在此之前不建立 monorepo。
- 經量測確認某條 route 的全球延遲是實際問題，且該 route 能在不破壞 module interface 的情況下移至 Edge Runtime。
