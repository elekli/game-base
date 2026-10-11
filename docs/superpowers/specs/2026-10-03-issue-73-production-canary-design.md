# Issue #73：正式環境寫入 canary 設計

狀態：已由使用者核准，實作與正式驗收進行中。此文件定義意圖、不變式與架構；未取得正式 workflow 證據前，不代表正式驗收完成。

## 目標與範圍

依 #73 驗收正式環境固定 canary 的筆記、清單、關聯、遊戲資源回收與還原；以 390 px viewport 驗未儲存筆記離頁保護及具名衝突；確認日誌不含秘密、產品還原入口與 canary 復原入口可用。證據齊全後才可關閉父票 #32。

延續 #54 與 #58 的固定、有界 canary 原則，並使用 #72 已合併的資源回收／還原行為。不得以使用者既有遊戲、筆記、清單、關聯或媒體作測試目標。保留目前 row／Storage canary；不把它改造成泛用測試平台。

不驗 BGG／IGDB 搜尋、媒體上傳、批次操作或永久刪除產品資料；不修改既有遊戲生命週期語意。正式 canary 不取代本機 CI、真 PostgreSQL 整合測試或 pgTAP。

## 可行方案

1. **固定合成遊戲聚合＋正式 owner 瀏覽器流程（採用）**：以專用 canary 身分建立兩筆不含來源及媒體的合成遊戲；受保護的 Playwright 使用正式 owner 工作階段，經正常介面與 owner API 執行驗收。只精確清除本次 canary 資料。它能同時驗證正式資料路徑與手機互動，代價是必須增加狹窄的 fixture 管理及復原邊界。
2. **只擴充內部 service-auth smoke route**：可檢查伺服器命令，但不會驗 owner 介面、手機離頁警告及實際操作流程；無法滿足 #73。
3. **借用使用者現有資料或只跑本機 E2E**：前者可能變更非 canary 資料，後者不能證明正式環境行為；兩者皆不採用。

## 架構與資料流

沿用既有受保護正式發布 workflow，在精確部署與現有固定 row／Storage smoke 通過後，於同一個持有發布 concurrency lock 的 workflow 內執行單一受保護的正式瀏覽器 canary。正式 Vercel Git 自動部署須維持停用，workflow 以唯讀 alias probe 與 owner API response SHA 核對當前部署。canary 使用專用 owner Access 工作階段；service principal 僅可準備、檢查及精確清理 fixture，不能呼叫 owner private API。owner 瀏覽器只使用正常產品介面及 private API。兩種身分與權限維持分離。

使用固定兩筆手動合成遊戲 ID，並以單一固定 canary 註冊列保存目前 generation、phase 與可清理資源 ID。fixture 不連結 BGG／IGDB、不建立媒體物件，也不使用既有遊戲。active fixture 不出現在一般收藏庫清單；Playwright 由固定路徑進入既有遊戲／筆記／資源回收介面。設定與清理 route 不接受 caller 指定 fixture ID 或 generation；owner mutation 只接受註冊列目前 generation，且目標必須是固定 fixture ID。

正式 owner Playwright 在 390 px 執行下列操作：建立筆記並驗儲存；在未儲存編輯時嘗試離頁，確認警告、取消後內容仍在；以過期版本驗 `command_version_conflict`，確認資料庫原內容未改且本機草稿仍保留；以相同 command ID／不同 payload 驗 `command_idempotency_conflict`，確認原結果未改；建立含 canary 遊戲的清單；建立雙向關聯並確認任一方向可見；資源回收一筆遊戲，再從產品還原入口還原，確認原遊戲 ID、筆記、清單成員及關聯均保留。命令 ID 與 generation 在同一 attempt 的重試中固定不變。

fixture 建立、generation 領取、狀態檢查與清理走專用內部 adapter／route；不擴張 owner verifier，也不接受呼叫端提供任意 owner、遊戲 ID、SQL、名稱或清理目標。owner 瀏覽器由受保護 runner 取得當代 generation，只能用於固定 fixture ID；一般 owner 請求不能任意選取 generation。

runner 一次只允許一筆 canary owner mutation 在途。送出前，先由專用 route 以資料庫時間獨立提交註冊列的 `request_pending` phase、command ID、開始時間及不可延長的 `deadline_at`；產品 API 只接受此固定 generation 與已登記 command ID。canary-targeted 的 owner mutation 必須在同一資料庫交易中鎖定註冊列（`FOR SHARE`），取得鎖後再核對 owner／固定 fixture ID／active generation／`request_pending`／command ID 及 `clock_timestamp() < deadline_at`，執行既有領域命令，並在同一交易提交。逾期才抵達的請求回 `canary_command_expired` 且零 mutation。若請求在期限內取得列鎖，鎖會持有至產品交易提交／回滾，cleanup 的 `FOR UPDATE` 必須等它結束。收到可判定的回應後，runner 才能在另一筆交易清除 pending 欄位並回到 `active`。禁止把 guard 與產品寫入拆成兩個交易。這使 response loss 留下持久的 pending 標記而不能開始新命令或 cleanup。

phase 轉成 `cleanup_pending` 的第一個 cleanup transaction 以 `FOR UPDATE` 鎖定同一列；只有沒有 `request_pending` 時才能進入一般清理。第二個清理交易才刪除 fixture／註冊列；後到的舊 generation 請求取得鎖後因 phase 不符而拒絕。workflow concurrency 是外層序列化，不能取代資料庫原子 fencing。

第二個清理交易按註冊列保存的精確 ID 清除本次筆記、清單、成員、關聯、命令收據及兩筆合成遊戲，確認相關列數為零後移除註冊列。若此交易回滾，已提交的 `cleanup_pending` 仍存在；程序以另一個短交易盡力標為 `recovery_required`。即使標記交易也失敗，留下的 `cleanup_pending` 仍會阻止新 attempt，並由 recovery workflow 辨識及續清。若任何 ID、owner、generation、內容摘要或 phase 不符，清理交易拒絕且不碰未知資料。成功條件包含所有產品檢查通過、精確清理成功及零殘留；單項失敗也必須完成同樣的精確清理，才可回報 `failed-cleanup-complete`。

```text
正式部署 SHA
  → 固定 row／Storage smoke
  → 領取 canary generation
  → 建立固定合成遊戲
  → owner Playwright：筆記／衝突／清單／關聯／trash／restore
  → 驗證資料保留與手機離頁保護
  → 精確交易式清理
  → 零殘留證據
```

## 不變式

| ID | 性質 | 必須永遠成立 | 驗證證據 |
|---|---|---|---|
| S1 | 安全 | 任何 mutation 只涉及固定 canary 身分及該 generation 記錄的產品列；其他 owner 資料不在清理候選集合。 | 固定 ID／FK／generation 精確比對；cleanup SQL 負向測試。 |
| S2 | 安全 | 同一時間最多一個 active generation；舊 generation 的遲到請求不能寫入或清理新 generation。`request_pending` 時只可完成或復原該 command ID，不可送下一個命令、清理或開始新 generation。 | 註冊列條件式轉移、workflow concurrency、雙 worker／晚到請求測試。 |
| S3 | 安全 | canary 不宣告通過，除非精確部署 SHA 已驗證，且每項產品、390 px、日誌及清理檢查均通過；任一 owner API 回應 SHA／alias 不符即停止後續產品操作並進入復原狀態。 | 每個 owner API response 的部署 SHA、前後 alias probe 與無秘密 artifact 逐項結果。 |
| S4 | 安全 | trash／restore 只改遊戲生命週期欄位、版本及收據；筆記原文與 ID、清單成員、關聯和來源／媒體身分不變。 | 操作前後固定資料摘要與真資料庫測試。 |
| S5 | 安全 | 相同 command ID 的重試沿用原 payload；相同 ID 不同 payload 必須回 `command_idempotency_conflict`，不可靜默重播或覆寫。 | response-loss replay、payload-conflict 命名結果與原資料不變斷言。 |
| S6 | 安全 | 過期 expected version 必須回 `command_version_conflict`；資料庫目前內容不變，本機草稿保留至使用者明確選擇。 | stale-writer 負向資料斷言與 390 px 草稿畫面檢查。 |
| S7 | 安全 | 離頁警告取消後保留編輯器內容；儲存逾時不得當成已儲存，也不得自動捨棄草稿。 | 390 px Playwright 對話框與畫面狀態。 |
| S8 | 安全 | 權杖、筆記內容、清單／關聯說明、request body、Cookie、HAR、trace 與包含私有資料的 screenshot 不進 log 或 artifact。 | artifact schema 封閉欄位、log redaction 測試、artifact 檢查。 |
| S9 | 安全 | 未授權、owner session 過期、部署 SHA 不符或 fixture 狀態不明時，在任何產品 mutation 前停止。 | route 零呼叫測試及 workflow 前置檢查。 |
| S10 | 安全 | cleanup 僅在固定 ID、owner、generation、phase 與預期關聯完整相符時執行；不符或結果不明時 fail closed。`cleanup_pending`／`recovery_required` 必須先持久提交，清理交易回滾不得使 canary 回到可寫入或可被新 attempt 接管的狀態。 | 刻意注入錯誤 ID／phase／殘留的真 DB 測試；清理交易回滾後 recovery 拒絕新 generation 並完成同代續清。 |
| L1 | 活性 | 無競爭且依賴正常時，canary 在固定步數內完成並回到零產品資料殘留。 | 有限步驟與 cleanup 計數。 |
| L2 | 活性 | 已知失敗能以同一 generation 精確清理；不確定狀態可由單一 recovery workflow 檢查／續清，不需重置正式資料庫。 | recovery drill 的成功收據。 |

## 失敗路徑與交錯

| 交錯 | 預期處理 | 不變式 |
|---|---|---|
| 兩個發布／復原 workflow 同時啟動 | workflow concurrency 只放行一個；資料庫 generation CAS 是第二層拒絕。 | S2 |
| owner 寫入已通過 generation guard，cleanup 同時開始 | 寫入交易持有註冊列 `FOR SHARE`；cleanup 的 `FOR UPDATE` 等待該交易提交／回滾後才清理。若 cleanup 先持鎖，寫入等候後因 phase／註冊列不符而拒絕。 | S2、S10 |
| owner token 無效或 SHA 已非目前正式部署 | 在領取／準備 fixture 前拒絕，產品列零變更。 | S3、S8 |
| 建立筆記／清單／關聯已提交但瀏覽器未收到回應 | `request_pending` 保留原 command ID；先等該版本 route／DB 期限結束，再用同一 payload 檢查 receipt 或重播原命令。不送不同命令，不盲目新建。 | S2、S5、S10 |
| 同 command ID 改變 payload | 回 `command_idempotency_conflict`，保留原結果及草稿；這是 canary 最後一個產品寫入，之後只做證據截圖與 runner 清理。 | S5、S7 |
| expected version 過期 | 回 `command_version_conflict`；資料庫內容不變，本機草稿保留，等待使用者明確選擇。 | S6、S7 |
| trash 已提交但回應遺失 | 同代重播後核對 trashed state，再繼續 restore；不得對恢復後的資料套用舊命令。 | S2、S4、S5 |
| restore 後檢查到筆記、成員或關聯消失 | canary 失敗；僅清理可證明屬本代的剩餘資料，保留失敗證據。 | S3、S4、S9 |
| cleanup 過程遇到未知 FK／ID 或 DB 結果不明 | 第二個清理交易回滾，已提交的 `cleanup_pending` 保留；另行標為 `recovery_required`，禁止新 attempt 或寬鬆刪除。若標記也失敗，recovery 仍依 `cleanup_pending` 接手。 | S2、S10、L2 |
| 瀏覽器請求 timeout，但 server 可能仍在執行 | 註冊列保留 `request_pending`、command ID、`deadline_at`；停止 owner 請求。只有已核實支援期限驗證的精確部署才可同代復原：逾期才抵達者在同一 guard 交易被拒；已通過 guard 者持有列鎖，cleanup 會等它提交／回滾。期限或部署能力無法查證時持久記錄 `recovery_required`，不清理、不開新 generation。 | S2、S10 |
| 使用者在 canary 執行期間操作保留資料 | 一般頁面不列出 fixture；API 對 fixture 寫入需附當代 generation，且 guard／mutation 同交易。其他資料不受 canary lock 影響。 | S1、S2 |
| 正式部署 SHA／alias 在產品操作開始後改變 | runner 核對每個 owner API response SHA，並在驗收前後唯讀檢查 alias；不符即不送下一個產品命令，保留 `request_pending` 並持久記錄 `recovery_required`。若不能證明所有可能接收此請求的部署均執行期限 guard，就不自動清理、不開新 generation；只由 recovery 回報 `manual-recovery-required`。已套用 migration 只走向前修復，不做 DB reset。 | S3、S8、S10 |

## 可觀測性與復原入口

成功及失敗 artifact 只記錄 workflow／request ID、精確執行 SHA、generation、具名 check、狀態碼、耗時、固定 canary 計數及 cleanup 結果；不記錄使用者資料或認證內容。截圖若只為 390 px 驗收，畫面只能有固定合成資料；不產生 HAR、trace、Cookie 或 network body artifact。

單一 recovery workflow 接受既有 run／generation，不接受任意資料列目標。它先 inspect 固定註冊列、pending command、部署相容性與精確產品殘留，再按同一 cleanup 規則清理或回報 `manual-recovery-required`。`request_pending`、`cleanup_pending` 及 `recovery_required` 都是已持久化的終止閘，不接受新 generation；清理回滾或回應遺失只會讓同一代次續行。相同且已核實支援期限 guard 的部署，可依資料庫 deadline、row lock 及固定資料列執行同代復原。SHA／alias 漂移或請求可能被不支援期限 guard 的版本接收時，絕不自動清理；保持固定 canary 隱藏與復原鎖，回報 `manual-recovery-required`，待維運者以唯讀平台證據確認相容性及請求狀態。未知狀態不自動修正；runbook 提供固定查詢與安全停止點。產品還原入口另由 Playwright 從資源回收介面實際操作驗證。

## 下游驗證界線

此設計層以不變式及交錯表檢查 soundness，尚未證明任何程式實作。實作階段需：

- 對 generation／phase、精確清理、response loss、舊請求晚到及錯誤殘留做 model-based／真 PostgreSQL 交錯測試。
- 以正常 owner API 和正式 390 px Playwright 驗產品流程；本機 E2E 仍保留為 CI 證據。
- 發布後核對正式工作流程 run、無秘密 artifact、Vercel 精確 alias、產品驗收結果及零殘留。
- 所有檢查完成前不得關閉 #73 或 #32。

## 待審查事項

1. cleanup 的 `manual-recovery-required` 是否應保留完整註冊列與 command receipt，直到人工核對完成；設計預設保留，避免復原證據被清除。
2. 現有 release workflow 是否能安全加入 owner Playwright 與新 canary adapter；若其 concurrency／deadline 無法覆蓋上述 fencing，應先補專用 generation guard，不可退化為只靠瀏覽器順序。
3. 390 px 截圖僅供人工 UX 檢視，artifact 必須使用固定合成內容，並在清理確認後才上傳。
