export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-6 py-12">
      <p className="text-sm tracking-[0.2em] text-emerald-800">PUIZERU GAMEBASE</p>
      <h1 className="text-4xl font-semibold tracking-tight">私人遊戲收藏庫</h1>
      <p className="max-w-prose text-base leading-7 text-slate-700">
        專案基線已建立。私人資料入口會先驗證擁有者身分，再連接資料服務。
      </p>
    </main>
  );
}

