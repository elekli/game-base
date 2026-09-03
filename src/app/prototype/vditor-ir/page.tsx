import type { Metadata } from "next";
import Link from "next/link";
import { VditorIrPrototype } from "./vditor-ir-prototype";

export const metadata: Metadata = {
  title: "Vditor ir 行動版原型｜Puizeru Gamebase",
  description: "隔離的 Vditor ir 行動版編輯體驗驗證原型。",
};

export default function VditorIrPrototypePage() {
  return (
    <div className="vditor-ir-prototype">
      <header className="prototype-topbar">
        <div className="prototype-topbar__inner">
          <div className="prototype-brand">
            <p className="prototype-brand__eyebrow">Puizeru Gamebase ／ Prototype 12</p>
            <p className="prototype-brand__title">Vditor ir 行動版編輯體驗</p>
          </div>
          <Link className="prototype-back" href="/">回到收藏庫</Link>
        </div>
      </header>
      <main className="prototype-main">
        <section className="prototype-hero" aria-labelledby="prototype-title">
          <div>
            <p className="prototype-kicker">Mobile field test · 390px</p>
            <h1 id="prototype-title">讓 Markdown 在手機上保持可見。</h1>
            <p className="prototype-hero__lede">
              這是與 MVP 隔離的實作原型。它用 Vditor 的即時渲染模式，檢查筆記語法、固定工具列、Markdown 往返與自動儲存狀態是否能共存。
            </p>
          </div>
          <aside className="prototype-decision" aria-label="原型邊界">
            <p className="prototype-decision__label">現在的判定</p>
            <strong>保留原始碼保底方案</strong>
            <span>繁中輸入法仍需要真人手機測試；這個頁面不會寫入正式筆記資料。</span>
          </aside>
        </section>
        <VditorIrPrototype />
      </main>
    </div>
  );
}
