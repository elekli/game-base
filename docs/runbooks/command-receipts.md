# 命令收據與版本衝突

收藏庫的寫入操作必須攜帶呼叫端產生的 `commandId` 與畫面讀到的 `expectedVersion`。第一個縱切是遊戲編輯；後續寫入沿用同一份命令契約。

```text
使用者送出編輯
      │ commandId + expectedVersion + payload
      ▼
私有擁有者邊界 ──拒絕──> 未授權／無效輸入
      │ ownerId
      ▼
鎖定命令收據
      ├─ 相同綁定且已完成 ──> 重播 resourceId／version／state
      ├─ 同 ID、不同綁定 ──> command_idempotency_conflict
      └─ 首次命令
             │
             ▼
       鎖定目標遊戲
             ├─ 版本不同 ──> command_version_conflict
             ├─ 不存在 ───> command_target_not_found
             └─ 同一交易寫入內容、version + 1、完成收據
```

## 保留與清理

- 完成的收據固定保留 90 天。這段期間涵蓋用戶重試與事故診斷；收據只保存擁有者、命令種類、目標、預期版本、內容的 SHA-256 摘要，以及可安全重播的資源版本／狀態，不保存原始內容。
- `PostgresGameStore.cleanupExpiredCommandReceipts(limit)` 每次最多刪除 500 筆已完成且到期的收據，使用 `FOR UPDATE SKIP LOCKED`，可由單一排程重複執行。
- 清理範圍只有 `app_private.command_receipts`。它不級聯，也不刪除遊戲、媒體或其他擁有者內容。
- 未完成的收據不由一般清理刪除。正常命令將收據與內容寫入放在同一資料庫交易，因此程序失敗會一起回滾；若發現未完成且已提交的收據，視為資料不變式異常，先調查再處理。

## 操作判讀

- `command_version_conflict`：重新載入最新遊戲後，由使用者再次送出；新內容使用新的 `commandId` 與最新 `expectedVersion`。
- `command_idempotency_conflict`：同一 `commandId` 被不同擁有者、目標、版本或內容使用。不要自動重試，應重新產生識別碼並保留事件供調查。
- `command_target_not_found`：目標已不存在。重新載入收藏庫，不要把它改寫成一般伺服器錯誤。
