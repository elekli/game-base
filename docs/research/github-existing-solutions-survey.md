# GitHub 現成方案初步調查

調查日期：2026-08-16

## 目的

在建立新產品前，先確認 GitHub 是否已有能同時管理桌遊與電子遊戲，並符合自動中繼資料、相片、附件、筆記、標籤、繁體中文及自架需求的方案。

本文件整理初次 `grill-with-docs` session 已完成的搜尋結果；它是當時的候選篩選紀錄，不是重新執行的市場調查。

## 候選與缺口

- [Floppy](https://github.com/dannyvfilms/Floppy) 最接近：涵蓋電子遊戲與桌遊，並整合 IGDB、BoardGameGeek、Steam 匯入、標籤及遊玩歷史；當時檢查未找到可同時滿足相片、一般附件、既定筆記流程與繁體中文介面的完整路徑。
- [Koillection](https://github.com/benjaminjonard/koillection) 是彈性的通用收藏管理器，支援圖片、標籤及自訂欄位，但不提供本產品需要的遊戲自動中繼資料流程。
- [BoardGameTracker](https://github.com/mregni/BoardGameTracker) 偏重桌遊場次統計，不涵蓋 Steam／主機遊戲；當時的 BoardGameGeek 整合仍不完整。
- [Gameyfin](https://github.com/gameyfin/gameyfin) 與 [RomM](https://github.com/rommapp/romm) 主要管理、下載或執行遊戲檔，不是本產品要建立的跨桌遊／電子遊戲私人收藏與筆記資料庫。

## 結論

沒有候選能直接符合後續已定稿的產品邊界：單一跨平台遊戲條目、BoardGameGeek／IGDB 雙來源、三分類貢獻者、相片與附件、多則 Markdown 筆記、一般清單與關聯遊戲、繁體中文手機流程，以及 Vercel＋Cloudflare Access＋Supabase 的學習目標。

因此 MVP 採自行建立較小的專用應用程式，不以改造既有專案為預設。除非後續出現能同時滿足上述核心條件的新證據，實作規劃不得重新開啟同一輪現成方案比較。

