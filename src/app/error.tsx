"use client";

export default function ErrorPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 px-6 py-12">
      <h1 className="text-3xl font-semibold">暫時無法完成操作</h1>
      <p className="leading-7 text-slate-700">請稍後再試。若問題持續，請保留畫面上的請求編號。</p>
    </main>
  );
}
