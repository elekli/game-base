# 已有裁決與 Wayfinder 追溯表

目的：確保後續 session 只處理新的工程裁決，不要求 elek 重答 `grill-with-docs` 已定案的產品問題，也不重做已有研究。

## 使用規則

- `CONTEXT.md` 是產品語意唯一真本；票面若與其衝突，以 `CONTEXT.md` 為準並先指出矛盾。
- `docs/research/` 與現行 ADR 是既有研究及架構決策；除非日期過期、官方能力改變或實測推翻，不重新調查同一問題。
- 後續 issue 的問題是「如何在選定技術棧落實既有行為」，不是「使用者想要什麼行為」。只有新成本門檻、新風險或兩個同樣合理且影響長期介面的方案，才再次詢問。

## 需求覆蓋

| 已定範圍 | 權威位置 | 後續 issue 的責任 |
|---|---|---|
| 單一遊戲條目、來源唯一性、名稱、平台、標籤、來源分類、貢獻者、人數 | `CONTEXT.md`「詞彙」 | [將既有領域模型轉成資料模型與不變式](https://github.com/elekli/game-base/issues/4) 只轉譯成 schema 與 constraints |
| 本地搜尋／篩選、雙來源新增搜尋、結果內漸進確認、建立後落點 | `CONTEXT.md`「遊戲條目」「遊戲名稱」「篩選」「使用介面」 | [驗證行動版核心流程](https://github.com/elekli/game-base/issues/9) 以原型裁決資訊架構與操作，結論採 A／A1／A1a |
| BGG／IGDB 選擇、申請資格、費用、速率與條款 | `docs/research/game-metadata-api-survey.md` | [定稿 BGG 與 IGDB adapter 介面及錯誤語意](https://github.com/elekli/game-base/issues/6) 不重做供應商研究 |
| 中繼資料欄位白名單、來源／自訂資料分離、手動最小條目、重新整理 | `CONTEXT.md`「中繼資料來源」「自動中繼資料範圍」 | [定稿 BGG 與 IGDB adapter 介面及錯誤語意](https://github.com/elekli/game-base/issues/6) 只決定 adapter、交易與失敗語意 |
| BGG 重度、策略排名、每日第一次登入、快取與錯誤顯示 | `CONTEXT.md`「BoardGameGeek 動態指標」 | [將既定 BGG 每日更新規則落成並行安全流程](https://github.com/elekli/game-base/issues/10) 只處理鎖、限流與重試 |
| 封面、批次相簿、附件、50 MB、原檔、WebP 縮圖與短效 URL | `CONTEXT.md`「封面」至「圖片原檔與縮圖」 | [將既有媒體規則落成縮圖與上傳狀態機](https://github.com/elekli/game-base/issues/7) 只處理冪等、狀態與孤兒清理 |
| 多則 Markdown 筆記、自動儲存、空白、清空確認與軟刪除 | `CONTEXT.md`「筆記」 | [將既有筆記、清單與刪除規則落成狀態機](https://github.com/elekli/game-base/issues/8) 只處理事件、transaction 與 concurrency |
| 一般清單、關聯遊戲、庫外引用、封存／還原與資源回收 | `CONTEXT.md`「遊戲清單」「資源回收項目」 | [將既有筆記、清單與刪除規則落成狀態機](https://github.com/elekli/game-base/issues/8) 只處理資料狀態與不變式 |
| Vditor、MDXEditor 等編輯器比較 | 原 session 已完成；驗收條件在 `TODOS.md` | [並行驗證 Vditor ir 行動版編輯體驗](https://github.com/elekli/game-base/issues/12) 只做手機原型，不重做選型 |
| Vercel、Cloudflare Access、Supabase、QNAP 邊界與費用 | ADR 0003／0004、`docs/research/neon-vs-supabase.md` | [裁決 Web 技術棧與專案骨架](https://github.com/elekli/game-base/issues/2) 與 [落實身分驗證與伺服器資料存取邊界](https://github.com/elekli/game-base/issues/5) 只處理框架及落實方式 |
| GitHub 現成方案 | `docs/research/github-existing-solutions-survey.md` | 已決定自行建立；沒有新的研究 issue |
| 可見失敗與復原操作 | 工程規範＋`CONTEXT.md` 各流程錯誤狀態 | [定稿 MVP 最低限度可觀測性與復原操作](https://github.com/elekli/game-base/issues/13) 補足技術事件、告警與 runbook |
| MVP 後功能 | `TODOS.md` | 不得混回本地圖；QNAP 備份／還原日後另開 Wayfinder 地圖 |

## 尚需 elek 參與的新增資訊

- [裁決 Web 技術棧與專案骨架](https://github.com/elekli/game-base/issues/2)：只有選項涉及明顯開發體驗或求職取捨時才請 elek 裁決；Supabase 學習目標已固定，不再詢問。
- [驗證真實檔案是否符合 Supabase Free 限制](https://github.com/elekli/game-base/issues/3)：需要真實但不公開的代表性檔案樣本。
- [驗證行動版核心流程](https://github.com/elekli/game-base/issues/9)：需要對可操作原型提出回饋，不是再回答需求問卷。
- [並行驗證 Vditor ir 行動版編輯體驗](https://github.com/elekli/game-base/issues/12)：只需要實機體驗判定通過／不通過，而且不阻擋 MVP。

其餘子議題應由 agent 依既有規格提出技術決策與證據；除非發現新矛盾或高代價取捨，不應要求使用者介入。
