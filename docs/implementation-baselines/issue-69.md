# Issue #69 實作基線：筆記草稿、自動儲存與可復原移除

本票只交付筆記縱切。清單、關聯遊戲與 game trash／restore 仍由 #70–#72 承接，不在本票預先建立半套介面或資料表。

## 使用者流程

```text
空白新草稿 ──輸入非空白──> 待儲存 ──debounce──> 儲存中 ──成功──> 已儲存
    │                              │                    │
    └─離開：零寫入                └─失敗：保留文字      └─再編輯

已儲存 ──清空──> 待確認移除 ──確認──> removed_at ──立即復原──> 已儲存
   │                    └─保留：回填伺服器舊文
   └─stale save──> 可見衝突 ──載入伺服器版本／以最新版本明確重送本地內容
```

## 資料與命令契約

- `notes` 保存 `game_id`、Markdown `content`、單調遞增 `version`、`removed_at`、`created_at` 與 `updated_at`。內容永遠是非空白原文；軟移除不清空內容。
- `createNote`、`updateNote`、`removeNote`、`restoreNote` 都帶擁有者與 `commandId`；後三者另帶 `expectedVersion`。建立命令以 game 為 target，完成 receipt 另保存產生的 note ID。
- 筆記命令使用獨立的 `note_command_receipts`。既有 `command_receipts` 以資料庫約束限定 `game.edit`，本票不以破壞性 migration 放寬既有契約。
- 同一 command 重送在 90 天內回放相同 note ID／版本／狀態；同 ID 不同綁定或 payload 回 `command_idempotency_conflict`。
- note mutation 先鎖自己的 receipt，再鎖 note 與所屬 game；過期清理沿用 #68 的 `SKIP LOCKED` 與 `clock_timestamp()` 精確到期規則，且排除正在執行的 receipt。
- stale writer 回傳目前 note 的版本、狀態與內容；伺服器零寫入，用戶端文字保持不變。明確重送使用新 command ID 與最新版本，不做自動合併。
- 遊戲不存在或已在資源回收區時，不可建立或更新筆記。已軟移除筆記只接受 restore；active 筆記才接受 update／remove。

## 介面狀態與失敗路徑

- 空白新草稿只存在瀏覽器；首次非空儲存失敗後仍無 note ID，重試沿用同一 command ID。
- 每次內容改變都取消舊 debounce；過時回應不得覆寫較新的文字或狀態。
- `pending`／`saving`／`failed`／`conflict`／`removal_pending` 都屬未收斂狀態。關閉分頁使用原生 `beforeunload`；應用程式內離開必須先讓使用者處理未儲存內容或待確認移除。
- 一般失敗顯示具名繁中操作，不洩漏 PostgreSQL、receipt digest、token 或筆記內容到 log。

## 驗證

- pgTAP：內容非空、版本正數、RLS、restrict 外鍵、receipt 新命令種類／target／結果 ID。
- 真 PostgreSQL：response-loss replay、同 ID 不同 payload、兩個 stale writer 恰一成功、rollback、remove／restore 保留原文與 ID、精確到期後重新判定。
- module／private action：空白拒絕、trashed game 拒絕、命名錯誤、安全映射、auth 在 store 前完成。
- 390 px Playwright：空白草稿零寫入、debounced 狀態、失敗保留、pending 離開提示、衝突兩個處理動作、清空確認、立即復原。

## 非目標

- Vditor `ir`、離線佇列、自動合併、筆記永久刪除、獨立筆記資源回收頁。
- 清單、關聯遊戲、庫外引用轉正、game trash／restore。
