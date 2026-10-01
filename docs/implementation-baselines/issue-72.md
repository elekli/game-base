# Issue #72 實作基線：遊戲資源回收與原樣還原

## 範圍

本票完成遊戲聚合的 `active → trashed → active` 閉環。移入資源回收區與還原只改 `games.trashed_at`、遞增 `games.version`，並在同一交易寫入既有 `app_private.command_receipts`。外部身分、來源快照、擁有者欄位、平台、標籤、貢獻者、筆記、媒體、清單成員、遊戲關聯及 Storage 路徑皆不得更新、刪除或重建。

## 使用者入口

- 一般遊戲頁提供「移入資源回收區」。送出前顯示確認內容，列出目前會從一般介面隱藏、但仍完整保留的筆記、照片、附件、清單與關聯數量；不要求輸入遊戲名稱。
- 成功移入後導向 `/trash`，聚焦剛移入的項目並提供立即還原。
- `/trash` 是精簡的資源回收區，列出全部已移入遊戲並提供還原。它不提供搜尋、篩選、排序設定、永久刪除或批次操作。
- 清單與關聯中的資源回收遊戲維持原位置，以灰階及「已移入資源回收區」標記顯示，並提供還原入口。
- 建立遊戲或首次連結來源若命中資源回收項目，回傳既有遊戲 ID 與 `trashed` 狀態；介面連到該遊戲的還原畫面，不建立第二筆。
- 直接開啟已移入遊戲的 `/games/[gameId]` 時，只顯示資源回收狀態、還原按鈕與返回資源回收區入口，不呈現一般編輯、筆記或媒體操作。

## 模組與命令

- `games` 模組新增讀取 `getTrashConfirmation(gameId)`、`listTrashedGames()`，以及命令 `moveGameToTrash`、`restoreGame`。不為兩個狀態轉移建立新的泛用 CRUD 或資料副本。
- 兩個命令都帶 `ownerId`、`commandId`、`gameId`、`expectedVersion`。命令 payload 為固定空物件；receipt hash 仍包含命令種類與 target，禁止同一 command ID 改作其他操作。
- `moveGameToTrash` 鎖定 game，驗證目前為 active 且版本相符，設定 `trashed_at = clock_timestamp()`、版本加一並完成 receipt。
- `restoreGame` 鎖定同一 game，驗證目前為 trashed 且版本相符，清除 `trashed_at`、版本加一並完成 receipt。
- 相同 command ID、相同 target／版本／命令種類的回應遺失重送只回放原結果，不再次增加版本；不同 payload 或用途重用同一 ID 時具名拒絕。
- active 對 trash、trashed 對 restore 以外的狀態要求，回傳含最新版本與狀態的生命週期衝突；不存在的 target 不洩漏其他擁有者資料。

## 資料庫與安全邊界

- 下一個 migration 只擴充既有 `command_receipts.command_kind` 約束以接受 `game.trash`、`game.restore`；不新增第二張遊戲生命週期 receipt 表。
- 聚合內容數量是確認畫面的唯讀快照，不參與 trash 交易，也不形成「只移除畫面列出的子資料」語意。確認後新增的內容同樣因遊戲狀態而隱藏，沒有部分刪除。
- 一般收藏庫、搜尋、篩選、來源重新整理、筆記與媒體一般讀取持續排除 trashed game。`listTrashedGames` 是唯一列出全部資源回收遊戲的查詢。
- private action 在建立 store 或執行資料庫查詢前完成 Cloudflare 擁有者驗證；錯誤映射沿用命名錯誤與結構化記錄，不輸出私人內容。
- 移入與還原沒有 Storage 工作、非同步工作或補償刪除。

## 介面流程

```text
一般遊戲頁
  └─ 開啟確認 → 顯示五類內容數量
       └─ moveGameToTrash(expectedVersion, commandId)
            ├─ 成功／重播 → /trash 聚焦項目＋立即還原
            └─ 版本／狀態衝突 → 保留畫面，載入最新狀態

/trash／清單／關聯／來源碰撞
  └─ restoreGame(expectedVersion, commandId)
       ├─ 成功／重播 → 原遊戲頁，全部既有資料重新可見
       └─ 版本／狀態衝突 → 顯示最新狀態，不改其他資料
```

390 px 介面使用既有按鈕、卡片與錯誤樣式。確認畫面清楚說明資料仍會保留；「永久刪除」不出現在任何文案或操作中。

## 驗證

- 模組／private action：擁有者驗證先於 store、狀態與版本衝突、target 不存在、response-loss replay、command ID 不同用途衝突、安全錯誤映射。
- 真 PostgreSQL：trash／restore 前後逐項比對外部身分、來源資料、筆記、媒體與 object path、標籤、平台、貢獻者、清單成員、關聯主鍵及說明；只有 `trashed_at`、版本與 receipt 改變。
- 真 PostgreSQL 交錯：兩個 stale writer 恰一成功；trash 與新增筆記／媒體 begin 的鎖定順序不允許在 trashed game 留下新的 active 子資料；交易中任一錯誤完整回滾。
- pgTAP：命令種類約束、receipt owner／RLS、來源唯一性不因 trash 釋放、子資料列及關係保留。
- 查詢測試：一般收藏庫與所有 active query 排除 trashed game；資源回收區只列 trashed game；清單與關聯保留並標示狀態。
- Playwright 390 px：確認數量、移入、立即還原、資源回收區還原、清單／關聯就地還原，以及來源碰撞導向既有資源回收項目。

## 非目標

- 永久刪除、自動清空、保留期限、批次移入／還原、Storage 刪除、資料搬移或備份還原。
- 獨立生命週期框架、泛用狀態機引擎、跨聚合 receipt 重構、搜尋／篩選資源回收區。
- 修正或合併疑似重複遊戲；來源唯一性仍由既有資料庫約束仲裁。
