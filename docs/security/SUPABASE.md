# Supabase 安全基線

## 權威與角色

`supabase/migrations/` 是唯一 schema migration 真本。`app_migrator` 擁有 `app_private` schema；`app_runtime` 可登入但不是 owner、沒有 `BYPASSRLS`、`CREATEROLE` 或 `CREATEDB`。migration 不提交角色密碼：local、preview 與 production 各自在受保護的操作面設定不同密碼，再把 runtime URL 綁到對應環境。

```text
Supabase CLI／direct URL ──► app_migrator ──► schema ownership／migration
Vercel／Supavisor 6543  ──► app_runtime  ──► 有界 CRUD＋RLS
Server Storage adapter  ──► secret key   ──► private bucket（先驗 Access JWT）
Browser                 ──► signed URL／upload token only
```

Supabase secret key 會繞過 RLS，只能存在 server environment。它不取代 `app_runtime` PostgreSQL role，也不得下傳 client bundle。

## 本機重播

```sh
pnpm supabase:start
pnpm supabase:reset
pnpm test:pgtap
DIRECT_DATABASE_URL=postgres://... pnpm db:schema:pull
pnpm db:schema:check
```

`0001_runtime_security.sql` 建立角色、`app_private` default privileges 與 private `game-media` bucket（52,428,800 bytes）。pgTAP 在 transaction 內建立 probe table，驗證未來由 migrator 建表時 runtime 取得最小 grants，而 Data API roles 不取得權限；transaction 最後 rollback，不把 probe 留在 schema。

## 新增產品 table

1. 以 `app_migrator` 在新的 Supabase migration 建表，不能用 Drizzle schema push。
2. 每張 table 明確 `ENABLE ROW LEVEL SECURITY`；先寫拒絕測試，再加所需 policy。
3. pgTAP 驗 owner、grants、constraint、RLS 無 policy 的拒絕及合法 runtime path。
4. `pnpm supabase:reset && pnpm test:pgtap` 從空白環境重播。
5. Drizzle 只在 migration 套用後以 direct URL 反向擷取型別；`pnpm db:schema:check` 必須確認 tracked 變更與新檔皆不存在。
