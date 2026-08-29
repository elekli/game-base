# Puizeru Gamebase

供個人使用的繁體中文遊戲收藏資料庫。產品與領域規格以 [`CONTEXT.md`](CONTEXT.md) 為準；本 repository 採 Next.js deep modular monolith、Supabase PostgreSQL／Storage 與 Cloudflare Access。

## 本機基線

需要 Node.js 24、pnpm 10.30.3、Docker／Colima。先複製 `.env.example` 為 `.env.local`，填入本機環境綁定後執行：

```sh
pnpm install --frozen-lockfile
pnpm supabase:start
pnpm supabase:reset
pnpm test:pgtap
pnpm dev
```

所有 private Route Handler 都必須先經 `requireOwner()`。本機也不提供 auth bypass；整合測試使用本地 RSA fixture，不使用真實憑證。

## 驗證

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm integrity:check
pnpm audit
pnpm build
```

Supabase migration 的唯一真本在 `supabase/migrations/`；Drizzle 只可從已套用的資料庫反向擷取型別，不可 `generate`、`migrate` 或 `push` schema。

部署與安全操作見 [`docs/deployment/environments.md`](docs/deployment/environments.md)、[`docs/security/CHECKLIST.md`](docs/security/CHECKLIST.md) 與 [`docs/security/SUPABASE.md`](docs/security/SUPABASE.md)。
