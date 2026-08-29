import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SecurityErrorPageProps = {
  searchParams: Promise<{ requestId?: string }>;
};

export default async function SecurityErrorPage({ searchParams }: SecurityErrorPageProps) {
  const { requestId: candidate } = await searchParams;
  const requestId = candidate !== undefined && UUID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
      <p className="text-sm font-medium tracking-[0.16em] text-amber-800">安全檢查</p>
      <h1 className="text-3xl font-semibold tracking-tight">目前無法開啟私人內容</h1>
      <p className="text-base leading-7 text-slate-700">
        請回到受保護的應用程式入口後再試一次。
      </p>
      <p className="rounded-xl border border-slate-300 bg-white px-4 py-3 font-mono text-xs text-slate-600">
        請求編號：{requestId}
      </p>
    </main>
  );
}
