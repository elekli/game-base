# 行動版核心流程互動原型

> Throwaway prototype：只用來回答 GitHub issue「驗證行動版核心流程」的互動問題，不得直接搬進 production。

## 要回答的問題

在約 390 px 寬的手機上，哪種資訊架構能讓擁有者從收藏庫找到或新增遊戲，再順暢完成批次照片與 Markdown 筆記工作，同時不失去返回位置或未儲存狀態？

## 執行

```bash
python3 -m http.server 4173 --directory prototypes/mobile-core-flow
```

開啟：

- `http://127.0.0.1:4173/?variant=a&screen=home`
- `http://127.0.0.1:4173/?variant=b&screen=home`
- `http://127.0.0.1:4173/?variant=c&screen=home`

原型內的變體切換器與「驗收情境」按鈕都會同步更新 URL，方便重新載入及分享指定狀態。

## 資料與限制

- 所有遊戲、照片與上傳結果均為標示過的示意資料。
- 狀態只存在記憶體；重新載入會重設上傳與筆記草稿。
- 不呼叫 BoardGameGeek、IGDB、Supabase 或任何正式服務。
- Vditor `ir` 不在本原型內；筆記只驗證 MVP 保底的 Markdown 原始碼編輯器。
