# 遊戲中繼資料 API 調查

查證日期：2026-08-18

## 結論

- 桌遊主來源：BoardGameGeek XML API2。
- 電子遊戲主來源：IGDB，但永久保存圖片前仍應確認 IGDB 文件與 Twitch 上位協議的適用關係。
- 桌遊備援：只填名稱建立；Wikidata 可選擇性補繁中別名，但不作主來源。
- 電子遊戲備援：MVP 先採只填名稱建立，不增加第二個商業資料源。
- 不採用：Board Game Atlas 已關閉；Giant Bomb 遊戲 API 目前不可用；SteamGridDB 的長期圖片重用條款不清楚；BoardGameFYI 缺乏可核對的 API 授權。

## 候選對照

| 來源 | 申請資格與認證 | 費用與額度 | 繁中能力 | NAS 保存與展示 | 裁決 |
|---|---|---|---|---|---|
| BoardGameGeek XML API2 | 個人可申請非商業應用；須有 BGG 帳號、登錄應用程式並等待人工核准，官方提醒可能超過一週；核准後建立 Bearer token | 非商業通常免費；精確配額未公布，官方要求降低請求並使用伺服器端快取 | 可能有中文別名與中文版資料，但別名沒有語言標記，繁中覆蓋不穩定 | 非商業可重製與展示 API 資料，必須標示 BGG；不得修改來源資料。原圖永久快取及縮圖是否屬於「修改」仍應在申請時確認 | 桌遊主來源 |
| Wikidata／Wikimedia Commons | 唯讀不需 token；須提供可辨識 User-Agent | 免費；2026 年公布的試行限制為合規 User-Agent 每分鐘 200 次 | 原生支援繁中標籤與別名，但桌遊覆蓋不完整 | Wikidata 主命名空間資料為 CC0；Commons 圖片須逐張遵守作者、署名與授權條件 | 選配的繁中別名補強 |
| TCGAPIs Board Games | 一般帳號可註冊，未見公司或人工審核要求 | Hobby £99／月、10,000 次；Business £199／月；Unlimited £499／月 | 未確認繁中資料 | 允許內部應用使用與快取，但其 BGG 衍生資料授權不透明 | 不划算，不採用 |
| BoardGameFYI | 無 token | 未公布 | 有簡中網站，未確認繁中 API 資料 | 缺乏可核對的 API 使用與快取授權 | 不採用 |
| Board Game Atlas | 已停止服務 | 不適用 | 不適用 | 不適用 | 排除 |
| IGDB | 個人可用免費 Twitch 帳號申請；需驗證信箱、啟用 2FA、建立 Confidential 應用程式並產生 Client ID／Secret | 非商業免費；4 次／秒、最多 8 個並行請求；access token 約 60 天，須由後端自動更新 | 有區域化名稱、封面、別名與語言資料，但官方未承諾繁中名稱或描述覆蓋率 | IGDB FAQ 明確允許本機保存、提供及在合作終止後保留資料；Twitch 上位協議則預設只允許快取 24 小時，除非另有授權。IGDB FAQ 很可能構成該授權，但圖片範圍仍應書面確認 | 電子遊戲主來源，有一項條款灰區 |
| RAWG | 個人註冊後取得 API key | 個人非商業免費，20,000 次／月；Business USD 149／月、50,000 次 | 官方未確認繁中在地化 | 每個使用 RAWG 資料或圖片的頁面都須回鏈；條款未清楚授權永久快取，且禁止再散布 | 不作 MVP 備援 |
| MobyGames | Hobbyist 可直接付費申請私人 API key | USD 9.99／月；720 次／小時，最高 1 次／秒 | 有別名資料，但繁中覆蓋未知；Hobbyist 是否包含別名與方案表存在文件衝突 | 官方建議保存在自有伺服器，必須標示「Data by MobyGames.com」；取消訂閱後能否永久展示既有資料未明定 | 付費備援，MVP 不採用 |
| SteamGridDB | 建立帳號後可在偏好設定產生 API key | 官方公開文件未找到價格及精確速率 | 取決於社群投稿 | 未找到足以支持 NAS 永久保存及再展示投稿圖片的明確授權 | 不自動存圖 |
| Steam Web API | 一般 Steam 帳號可申請 key，須填關聯網域 | 免費；100,000 次／日 | 部分介面有語言參數 | 適合未來匯入個人 Steam 收藏，不是跨平台中繼資料庫 | 不作主來源 |
| Giant Bomb | 官方表示 Games 等端點目前不可用 | 不適用 | 未知 | 不適用 | 排除 |

## 申請流程

### BoardGameGeek

1. 建立或登入 BGG 帳號。
2. 前往 Applications 頁建立 Non-commercial application。
3. 申請說明應明列：單人、非商業、只在區域網路／私人 VPN 使用、自架 QNAP、伺服器端呼叫、只保存已加入資料庫的遊戲資料及代表圖片、顯示 BGG 來源連結。
4. 等待人工核准；官方稱可能超過一週。
5. 在應用程式的 Tokens 頁建立 token，後端以 `Authorization: Bearer ...` 呼叫。

### IGDB

1. 建立免費 Twitch 帳號、驗證電子郵件並啟用 2FA。
2. 在 Twitch Developer Console 註冊應用程式；redirect 可填 `localhost`，Client Type 選 `Confidential`。
3. 產生 Client Secret，保存 Client ID 與 Secret。
4. 後端以 client credentials 換取 access token；不得由瀏覽器直接呼叫。
5. 後端須在 token 到期前自動更新，且不得把 Secret 寫入前端或版本庫。

## 產品與資料模型影響

- 來源資料與使用者資料必須分開保存。BGG 明確禁止修改 API 資料，因此繁中顯示名稱、筆記、標籤與自訂封面只能疊加，不能覆寫來源快照。
- 所有來源保存 `source`、`source_id`、來源名稱、原始網址與最後同步時間；手動條目可沒有來源。
- BGG 採「搜尋 → 選取 → 詳細資料」兩段呼叫並快取結果，避免頻繁請求。
- IGDB 的 Client Secret 與 BGG token 只存在 QNAP 後端設定；記錄與錯誤訊息必須遮罩憑證。
- 繁中介面不代表來源具有繁中資料；產品仍須保留自訂顯示名稱、原文名稱與別名搜尋。
- 在 IGDB 圖片永久鏡像獲得書面確認前，可保存來源圖片網址，或採不超過 24 小時的可失效快取；使用者自行上傳的封面與相簿不受此限制。

## 待人工確認

1. 向 IGDB 詢問：官方 FAQ 的本機保存授權是否明確涵蓋封面與截圖原檔，且優先於 Twitch Developer Services Agreement 的 24 小時預設快取限制。
2. 在 BGG 應用程式申請中詢問：下載代表圖片、產生縮圖與重新壓縮是否符合其非商業授權及「不得修改資料」條款。

## 官方來源

- [BGG：Using the XML API](https://boardgamegeek.com/using_the_xml_api)
- [BGG：XML API Terms of Use](https://boardgamegeek.com/wiki/page/XML_API_Terms_of_Use)
- [BGG：XML API2](https://boardgamegeek.com/wiki/page/BGG_XML_API2)
- [IGDB API 文件與 FAQ](https://api-docs.igdb.com/)
- [Twitch Developer Services Agreement](https://legal.twitch.com/en/legal/developer-agreement/)
- [RAWG API 方案](https://rawg.io/apidocs)
- [RAWG API 條款](https://rawg.io/tos_api)
- [MobyGames API](https://www.mobygames.com/info/api/)
- [MobyGames API 方案](https://www.mobygames.com/api/subscribe/)
- [Wikidata REST API 與 CC0](https://www.wikidata.org/wiki/Wikidata:REST_API)
- [Wikimedia API rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
- [Wikimedia Commons 外部重用規則](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/en)
- [Steam Web API 認證](https://partner.steamgames.com/doc/webapi_overview/auth)
- [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms)
- [SteamGridDB 官方 API wrapper](https://github.com/SteamGridDB/node-steamgriddb)
- [Giant Bomb API 現況](https://www.giantbomb.com/api/)
