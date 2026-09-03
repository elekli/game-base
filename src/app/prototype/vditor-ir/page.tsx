import type { Metadata } from "next";
import Link from "next/link";
import { VditorIrPrototype } from "./vditor-ir-prototype";
import styles from "./vditor-ir-prototype.module.css";

export const metadata: Metadata = {
  title: "Vditor ir 行動版原型｜Puizeru Gamebase",
  description: "隔離的 Vditor ir 行動版編輯體驗驗證原型。",
};

export default function VditorIrPrototypePage() {
  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brand}>
            <p className={styles.brandEyebrow}>Puizeru Gamebase ／ Prototype 12</p>
            <p className={styles.brandTitle}>Vditor ir 行動版編輯體驗</p>
          </div>
          <Link className={styles.back} href="/">回到收藏庫</Link>
        </div>
      </header>
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="prototype-title">
          <div>
            <p className={styles.kicker}>Mobile field test · 390px</p>
            <h1 id="prototype-title">讓 Markdown 在手機上保持可見。</h1>
            <p className={styles.heroLede}>
              這是與 MVP 隔離的實作原型。它用 Vditor 的即時渲染模式，檢查筆記語法、固定工具列、Markdown 往返與自動儲存狀態是否能共存。
            </p>
          </div>
          <aside className={styles.decision} aria-label="原型邊界">
            <p className={styles.decisionLabel}>現在的判定</p>
            <strong>保留原始碼保底方案</strong>
            <span>繁中輸入法仍需要真人手機測試；這個頁面不會寫入正式筆記資料。</span>
          </aside>
        </section>
        <VditorIrPrototype />
      </main>
    </div>
  );
}
