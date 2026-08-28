/*
 * THROWAWAY PROTOTYPE — Issue 9 only.
 * Question: In a 390 px mobile viewport, which information architecture lets
 * one person browse/find, add, then act on a game without losing their place?
 */

const variants = [
  {
    id: "a",
    name: "A．圖鑑導覽",
    question: "此變體探索：以封面優先的收藏庫作為起點，讓搜尋和篩選留在同一個瀏覽面。",
    model: "browse → 封面網格 → 篩選底板 → 全頁詳情",
  },
  {
    id: "b",
    name: "B．搜尋中樞",
    question: "此變體探索：把「我知道要找什麼」當成手機的主要入口，瀏覽退居次要。",
    model: "find → 全頁搜尋 → 密集結果 → 全頁詳情",
  },
  {
    id: "c",
    name: "C．工作佇列",
    question: "此變體探索：把回到收藏庫後最常做的下一步，放進行動優先的工作佇列。",
    model: "act → 排名工作佇列 → 明確任務 → 全頁詳情",
  },
  {
    id: "a1",
    name: "A1．來源分組",
    question: "此變體探索：同一個查詢同時顯示兩個來源，但用來源分組保留結果的身分與類型。",
    model: "search → 來源群組 → 直接選結果 → 確認",
  },
  {
    id: "a2",
    name: "A2．名稱先收斂",
    question: "此變體探索：先讓使用者確認要的是哪個名稱，再在同一張卡上選桌遊或電子遊戲。",
    model: "search → 名稱候選 → 選呈現形式 → 確認",
  },
  {
    id: "a1a",
    name: "A1a．列內確認",
    question: "此變體探索：展開結果卡片後，在原列表內讀完辨識資料並直接加入。",
    model: "來源群組 → 列內展開 → 加入收藏庫",
  },
  {
    id: "a1b",
    name: "A1b．底部預覽",
    question: "此變體探索：保留列表位置，以底部預覽呈現辨識資料和加入操作。",
    model: "來源群組 → 底部預覽 → 加入收藏庫",
  },
];

const rounds = {
  root: { parent: null, question: "手機上如何從收藏庫移動到一款遊戲並完成下一個核心操作？", variants: ["a", "b", "c"] },
  a: { parent: "root:a", question: "當兩個來源都以同一個查詢命中時，如何讓使用者晚一點才選類型，卻仍不混淆來源身分？", variants: ["a1", "a2"] },
  a1: { parent: "a:a1", question: "如何讓擁有者不離開搜尋結果脈絡，仍能確認辨識資料後才明確加入收藏庫？", variants: ["a1a", "a1b"] },
};

const games = [
  { id: "spirit", name: "Spirit Island", type: "桌遊", meta: "重度 4.07", art: "cover-forest" },
  { id: "hades", name: "Hades", type: "電子遊戲", meta: "Steam · PS5", art: "cover-space" },
  { id: "root", name: "Root", type: "桌遊", meta: "重度 3.81", art: "cover-orchard" },
  { id: "dredge", name: "DREDGE", type: "電子遊戲", meta: "Nintendo Switch", art: "cover-wave" },
];

const state = {
  round: readRound(),
  variant: readVariant(readRound()),
  screen: "home",
  overlay: null,
  detailGame: games[0],
  query: "",
  filters: new Set(),
  addStep: "type",
  pendingType: null,
  pendingName: null,
  pendingArt: null,
  progressiveChoice: null,
  files: [],
  note: "",
  save: "已儲存",
  dirty: false,
};

const app = document.querySelector("#app");
const variantName = document.querySelector("#variant-name");
const variantQuestion = document.querySelector("#variant-question");
const parentVariant = document.querySelector("#parent-variant");

function readRound() {
  const value = new URLSearchParams(location.search).get("branch");
  return Object.hasOwn(rounds, value) ? value : "root";
}

function readVariant(round = "root") {
  const value = new URLSearchParams(location.search).get("variant");
  return rounds[round].variants.includes(value) ? value : rounds[round].variants[0];
}

function currentVariant() { return variants.find((variant) => variant.id === state.variant); }
function currentRound() { return rounds[state.round]; }

function setVariant(next, round = state.round) {
  state.round = round;
  state.variant = next;
  state.screen = "home";
  state.overlay = null;
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  if (round === "root") url.searchParams.delete("branch");
  else url.searchParams.set("branch", round);
  history.pushState({}, "", url);
  render();
}

function gameCard(game) {
  return `<button class="cover-card" data-action="open-detail" data-game="${game.id}">
    <span class="cover-art ${game.art}">${game.type === "桌遊" ? "BGG" : "IGDB"}</span>
    <strong>${game.name}</strong><small>${game.meta}</small>
  </button>`;
}

function listCard(game, index = null) {
  return `<button class="list-card" data-action="open-detail" data-game="${game.id}">
    ${index === null ? `<span class="tiny-cover ${game.art}"></span>` : `<span class="rank">${index}</span>`}
    <span><strong>${game.name}</strong><small>${game.type} · ${game.meta}</small></span><span>›</span>
  </button>`;
}

function visibleGames() {
  const query = state.query.trim().toLowerCase();
  return games.filter((game) => {
    const matchesQuery = !query || game.name.toLowerCase().includes(query);
    const matchesFilter = state.filters.size === 0 || state.filters.has(game.type);
    return matchesQuery && matchesFilter;
  });
}

function topHeader(title, subtitle = "") {
  return `<header class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div><button class="icon-button" data-action="start-add" aria-label="新增遊戲">＋</button></header>`;
}

function libraryControls({ compact = false } = {}) {
  const selected = [...state.filters].map((item) => `<button class="chip selected" data-action="toggle-filter" data-filter="${item}">${item} ×</button>`).join("");
  return `<div class="utility-row"><label class="search-control">⌕ <input data-input="query" value="${escapeHtml(state.query)}" placeholder="搜尋名稱、別名…" aria-label="搜尋收藏庫" /></label><button class="filter-button ${state.filters.size ? "is-active" : ""}" data-action="open-filters" aria-label="篩選">篩</button></div>
    ${compact ? "" : `<div class="filter-chips"><button class="chip" data-action="open-filters">遊戲類型與標籤</button>${selected}</div>`}`;
}

function renderBrowseHome() {
  const visible = visibleGames();
  return `<section class="screen">${topHeader("收藏庫", "12 款 · 依名稱排序")}${libraryControls()}
    <div class="section-label"><strong>${visible.length} 個結果</strong><span>封面優先</span></div>
    <div class="cover-grid">${visible.map(gameCard).join("") || emptyResults()}</div>
    ${taskDock("瀏覽收藏", "新增遊戲")}</section>`;
}

function renderSearchHome() {
  const visible = visibleGames();
  if (!state.query && state.filters.size === 0) {
    return `<section class="screen search-first"><button class="text-button" data-action="show-browse">← 收藏庫概覽</button><h1>先找你要的。</h1><p>本地搜尋只查你已建立的遊戲；外部搜尋在新增流程才開始。</p>${libraryControls({ compact: true })}
      <div class="recent-queries"><button class="recent-query" data-action="set-query" data-query="Spirit">最近：Spirit Island <span>↗</span></button><button class="recent-query" data-action="set-query" data-query="Hades">最近：Hades <span>↗</span></button></div>
      <div class="prompt-card"><p><strong>還不在收藏庫？</strong><br />先選桌遊或電子遊戲，再搜尋單一來源。</p></div>
      ${taskDock("收藏庫概覽", "新增遊戲")}</section>`;
  }
  return `<section class="screen">${topHeader("搜尋結果", "${visible.length} 個符合條件")}${libraryControls({ compact: true })}<div class="dense-list">${visible.map((game) => listCard(game)).join("") || emptyResults()}</div>${taskDock("清除搜尋", "新增遊戲")}</section>`;
}

function renderQueueHome() {
  return `<section class="screen"><div class="workbench"><div class="workbench-intro"><p class="eyebrow">回到收藏庫的下一件事</p><h1>今天要處理什麼？</h1><p>這不是待辦清單；它只把尚未完成的核心操作排在前面。</p></div>
    <div class="work-queue">
      <button class="work-card photo" data-action="open-detail" data-game="spirit"><span></span><span><small>照片</small><strong>Spirit Island</strong><p>上週的 3 張相片還沒上傳。</p></span></button>
      <button class="work-card" data-action="open-detail" data-game="hades"><span></span><span><small>筆記</small><strong>Hades</strong><p>有一則尚未儲存的筆記草稿。</p></span></button>
      <button class="work-card" data-action="open-detail" data-game="root"><span></span><span><small>瀏覽</small><strong>Root</strong><p>最近新增；還沒有個人補充。</p></span></button>
    </div>
    <div class="detail-section"><h2>完整收藏庫</h2><p>需要搜尋、篩選或比較時，再進入完整瀏覽面。</p><button class="wide-button secondary" data-action="show-browse">開啟收藏庫</button></div></div>${taskDock("完整收藏庫", "新增遊戲")}</section>`;
}

function taskDock(left, right) {
  return `<nav class="task-dock" aria-label="主要操作"><button data-action="${left.includes("清除") ? "clear-query" : "show-browse"}">${left}</button><button class="primary" data-action="start-add">＋ ${right}</button></nav>`;
}

function emptyResults() { return `<div class="notice">沒有符合條件的收藏。外部結果不會混在這裡；可改用「新增遊戲」。</div>`; }

function renderDetail() {
  const game = state.detailGame;
  return `<section class="full-screen"><div class="back-row"><button data-action="back-home">← 回到${currentVariant().id === "c" ? "工作佇列" : "收藏庫"}</button></div>
    <div class="detail-hero"><div class="cover-art detail-cover ${game.art}">${game.type === "桌遊" ? "BGG" : "IGDB"}</div><h1>${game.name}</h1><div class="detail-meta"><span>${game.type}</span><span>${game.meta}</span><span>來源已儲存</span></div></div>
    <div class="primary-actions"><button class="action-button accent" data-action="open-upload"><strong>＋ 上傳照片</strong><small>多選後逐檔上傳</small></button><button class="action-button" data-action="open-note"><strong>✎ 新增筆記</strong><small>Markdown · 自動儲存</small></button></div>
    <section class="detail-section"><h2>相簿</h2><p>依上傳時間排列。說明在上傳後才選填。</p></section>
    <section class="detail-section"><h2>筆記</h2><p>2 則 · 最近修改於 2026-08-25</p></section>
    <section class="detail-section"><h2>次要資料</h2><div class="secondary-list"><button><span>平台與自由標籤</span><span>›</span></button><button><span>清單與關聯遊戲</span><span>›</span></button><button><span>重新整理中繼資料</span><span>›</span></button></div></section></section>`;
}

function renderAdd() {
  if (state.addStep === "unified-search") return renderUnifiedSearch();
  if (state.addStep === "progressive-search") return renderProgressiveSearch();
  if (state.addStep === "type") {
    return `<section class="full-screen"><div class="back-row"><button data-action="back-home">← 取消新增</button></div><div class="page-header"><div><span class="step-pill">步驟 1／3</span><h1>先選遊戲類型</h1><p>來源結果不混在同一份清單。</p></div></div><div class="type-choices"><button class="type-choice" data-action="choose-type" data-type="桌遊"><strong>桌遊</strong><small>只搜尋 BoardGameGeek</small></button><button class="type-choice" data-action="choose-type" data-type="電子遊戲"><strong>電子遊戲</strong><small>只搜尋 IGDB</small></button></div><p class="notice">找不到遊戲或來源暫時失敗時，仍可只填名稱建立最小條目。</p></section>`;
  }
  if (state.addStep === "search") {
    const source = state.pendingType === "桌遊" ? "BoardGameGeek" : "IGDB";
    const game = state.pendingType === "桌遊" ? games[2] : games[3];
    return `<section class="full-screen"><div class="back-row"><button data-action="reset-add">← 更改類型</button></div><div class="page-header"><div><span class="step-pill">步驟 2／3</span><h1>搜尋 ${source}</h1><p>只顯示 ${state.pendingType} 結果。</p></div></div>${libraryControls({ compact: true })}<div class="result-list"><button class="source-result" data-action="choose-result"><span class="tiny-cover ${game.art}"></span><span><strong>${game.name}</strong><small>${game.type} · ${game.meta}</small><small>來源：${source}</small></span></button></div><button class="wide-button secondary" data-action="manual-entry">改建手動最小條目</button></section>`;
  }
  const confirmedName = state.pendingName || (state.pendingType === "桌遊" ? "Root" : "DREDGE");
  const confirmedYear = state.pendingName ? (state.pendingType === "桌遊" ? "2020" : "2023") : "2022";
  return `<section class="full-screen"><div class="back-row"><button data-action="back-to-search">← 回到來源結果</button></div><div class="page-header"><div><span class="step-pill">步驟 3／3</span><h1>確認後才建立</h1><p>送出時會重新確認來源身分。</p></div></div><div class="confirm-card"><h2>${confirmedName}</h2><dl><dt>年份</dt><dd>${confirmedYear}</dd><dt>來源</dt><dd>${state.pendingType === "桌遊" ? "BoardGameGeek" : "IGDB"}</dd><dt>辨識資料</dt><dd>${state.pendingType === "桌遊" ? "設計師、出版社、人數" : "支援平台、開發／發行公司"}</dd></dl><button class="wide-button" data-action="confirm-add">加入收藏庫</button></div><p class="notice">來源辨識欄位改變時，系統會更新此畫面並要求再次確認。</p></section>`;
}

function renderUnifiedSearch() {
  const isGrouped = currentVariant().id === "a1";
  const input = `<label class="search-control"><span>⌕</span><input data-input="unified-query" value="Dune" aria-label="搜尋所有來源" /></label>`;
  const grouped = `<div class="source-group"><h2>BoardGameGeek · 桌遊</h2><button class="source-result" data-action="choose-unified-result" data-type="桌遊" data-name="Dune: Imperium" data-art="cover-orchard"><span class="tiny-cover cover-orchard"></span><span><strong>Dune: Imperium</strong><small>2020 · 設計師與出版社已載入</small><small>來源：BoardGameGeek</small></span></button></div><div class="source-group"><h2>IGDB · 電子遊戲</h2><button class="source-result" data-action="choose-unified-result" data-type="電子遊戲" data-name="Dune: Spice Wars" data-art="cover-wave"><span class="tiny-cover cover-wave"></span><span><strong>Dune: Spice Wars</strong><small>2023 · 開發與發行公司已載入</small><small>來源：IGDB</small></span></button></div>`;
  const nameFirst = `<div class="match-card"><h2>Dune</h2><p>兩個來源皆有相近結果。先選你要建立的遊戲形式；每個選項仍清楚標示唯一來源。</p><button class="match-choice" data-action="choose-unified-result" data-type="桌遊" data-name="Dune: Imperium" data-art="cover-orchard"><span><strong>桌遊：Dune: Imperium</strong><small>BoardGameGeek · 2020</small></span><span>›</span></button><button class="match-choice" data-action="choose-unified-result" data-type="電子遊戲" data-name="Dune: Spice Wars" data-art="cover-wave"><span><strong>電子遊戲：Dune: Spice Wars</strong><small>IGDB · 2023</small></span><span>›</span></button></div>`;
  return `<section class="full-screen"><div class="back-row"><button data-action="back-home">← 取消新增</button></div><div class="page-header"><div><span class="step-pill">雙來源探索 · 暫存分支</span><h1>先搜尋遊戲</h1><p>同時查詢 BoardGameGeek 與 IGDB；選定結果才決定遊戲類型。</p></div></div><div class="utility-row">${input}</div>${isGrouped ? grouped : nameFirst}<p class="notice">這是在測試使用者是否能晚一點選類型；建立時仍只會使用選定結果的一個來源，並在確認後才寫入。</p></section>`;
}

const duneMatches = [
  { type: "桌遊", name: "Dune: Imperium", year: "2020", source: "BoardGameGeek", art: "cover-orchard", facts: "設計師、出版社、人數已載入" },
  { type: "電子遊戲", name: "Dune: Spice Wars", year: "2023", source: "IGDB", art: "cover-wave", facts: "支援平台、開發與發行公司已載入" },
];

function choiceData(match) {
  return `data-type="${match.type}" data-name="${match.name}" data-art="${match.art}" data-year="${match.year}" data-source="${match.source}" data-facts="${match.facts}"`;
}

function renderProgressiveSearch() {
  const inline = currentVariant().id === "a1a";
  const results = duneMatches.map((match) => {
    const expanded = inline && state.progressiveChoice?.name === match.name;
    const action = inline ? "expand-inline" : "open-source-preview";
    return `<article class="progressive-result"><button class="source-result" data-action="${action}" ${choiceData(match)}><span class="tiny-cover ${match.art}"></span><span><strong>${match.name}</strong><small>${match.year} · ${match.source}</small><small>${match.type}</small></span></button>${expanded ? `<div class="inline-preview"><p><strong>${match.source} · ${match.type}</strong><br />${match.facts}</p><p>這些辨識欄位會在送出時再次從來源取得並比對；有變更時留在此處更新，不會直接建立。</p><button class="wide-button" data-action="join-from-search">加入收藏庫</button></div>` : ""}</article>`;
  }).join("");
  return `<section class="full-screen"><div class="back-row"><button data-action="back-home">← 取消新增</button></div><div class="page-header"><div><span class="step-pill">搜尋內確認 · 暫存分支</span><h1>搜尋「Dune」</h1><p>結果先顯示最小識別資訊；點選後才揭露加入前需要確認的欄位。</p></div></div><div class="source-group"><h2>BoardGameGeek · 桌遊</h2>${results.includes("Dune: Imperium") ? results.split("</article>")[0] + "</article>" : ""}</div><div class="source-group"><h2>IGDB · 電子遊戲</h2>${results.includes("Dune: Spice Wars") ? results.split("</article>")[1] + "</article>" : ""}</div><p class="notice">這個分支沒有獨立確認頁；「加入收藏庫」仍是唯一建立動作，伺服器必須再取來源資料、比對辨識欄位與來源身分。</p></section>`;
}

function renderSourcePreview() {
  const match = state.progressiveChoice;
  if (!match) return "";
  return `<div class="overlay" role="dialog" aria-modal="true" aria-label="來源結果預覽"><section class="sheet"><div class="sheet-handle"></div><div class="sheet-header"><h2>${match.name}</h2><button class="sheet-close" data-action="close-overlay" aria-label="關閉預覽">×</button></div><p class="step-pill">${match.source} · ${match.type}</p><div class="detail-meta"><span>${match.year}</span><span>${match.facts}</span></div><p class="notice">送出時再次從來源取得並比對辨識欄位；若資料已改變，會留在這張預覽中更新，不會直接建立。</p><button class="wide-button" data-action="join-from-search">加入收藏庫</button></section></div>`;
}

function renderUpload() {
  const rows = state.files.length ? state.files.map((file, index) => `<div class="file-row"><span class="file-thumb"></span><span>${escapeHtml(file.name)}<br /><span class="status ${file.failed ? "failed" : ""}">${file.failed ? "失敗：模擬網路中斷" : index === 0 ? "已成功" : "上傳中…"}</span></span>${file.failed ? `<button data-action="retry-file" data-index="${index}">重試</button>` : ""}</div>`).join("") : "";
  return `<section class="full-screen"><div class="back-row"><button data-action="back-detail">← 返回遊戲</button></div><div class="page-header"><div><h1>上傳照片</h1><p>可一次選取多張；每檔獨立處理。</p></div></div><label class="upload-drop"><input type="file" accept="image/*" multiple hidden data-input="files" /><strong>選取相片或拍照</strong><small>單檔上限 50 MB · 說明在上傳後再填</small></label>${rows || `<div class="notice">尚未選取檔案。為了可評估失敗狀態，可按下方模擬批次。</div>`}<button class="wide-button secondary" data-action="simulate-files">模擬 3 張照片（含 1 張失敗）</button><div class="detail-section"><h2>上傳後</h2><p>成功項目會保留；只重試失敗檔案，不會重複建立已成功圖片。每張圖片的說明都是選填。</p></div></section>`;
}

function renderNote() {
  const warning = state.dirty ? `<p class="leave-warning">尚有未儲存內容；離開前系統會嘗試儲存，失敗時會提示你。</p>` : "";
  return `<section class="full-screen"><div class="back-row"><button data-action="attempt-leave-note">← 返回遊戲</button></div><div class="page-header"><div><h1>新增筆記</h1><p>Markdown 原始碼是權威格式。</p></div></div>${warning}<div class="editor"><div class="editor-toolbar" aria-label="Markdown 工具列"><button data-insert="**粗體**" aria-label="粗體">B</button><button data-insert="*斜體*" aria-label="斜體">I</button><button data-insert="\n- 清單項目" aria-label="清單">•</button><button data-insert="\n## 標題" aria-label="標題">H2</button><button data-insert="[文字](https://)" aria-label="連結">↗</button></div><textarea data-input="note" aria-label="筆記內容" placeholder="輸入心得、規則提醒或下次想試的策略…">${escapeHtml(state.note)}</textarea></div><p class="save-state ${state.save === "儲存中" ? "saving" : ""}">${state.save}</p><p class="notice">空白新筆記不會建立。清空既有筆記時，會先保留舊內容並在離開時詢問是否移除。</p></section>`;
}

function renderOverlay() {
  if (state.overlay === "source-preview") return renderSourcePreview();
  if (state.overlay !== "filters") return "";
  const filters = ["桌遊", "電子遊戲"];
  return `<div class="overlay" role="dialog" aria-modal="true" aria-label="篩選收藏庫"><section class="sheet"><div class="sheet-handle"></div><div class="sheet-header"><h2>篩選</h2><button class="sheet-close" data-action="close-overlay" aria-label="關閉篩選">×</button></div><h3>遊戲類型</h3>${filters.map((filter) => `<button class="filter-option ${state.filters.has(filter) ? "selected" : ""}" data-action="toggle-filter" data-filter="${filter}"><span>${filter}</span><span class="check">${state.filters.has(filter) ? "✓" : ""}</span></button>`).join("")}<h3>來源分類與自由標籤</h3><p class="notice">來源分類只在選定單一遊戲類型時顯示；此處只示範層級，不把固定規格重新交給你決定。</p><button class="wide-button" data-action="close-overlay">套用篩選</button></section></div>`;
}

function render() {
  const variant = currentVariant();
  variantName.textContent = `${variant.name}｜${variant.model}`;
  variantQuestion.textContent = `問題：${currentRound().question} ${variant.question}`;
  const parent = currentRound().parent;
  if (parent) {
    const parentId = parent.split(":")[1];
    parentVariant.hidden = false;
    parentVariant.textContent = `← 回到 ${variants.find((item) => item.id === parentId).name}`;
  } else parentVariant.hidden = true;
  let content;
  if (state.screen === "detail") content = renderDetail();
  else if (state.screen === "add") content = renderAdd();
  else if (state.screen === "upload") content = renderUpload();
  else if (state.screen === "note") content = renderNote();
  else if (["a", "a1", "a2", "a1a", "a1b"].includes(variant.id)) content = renderBrowseHome();
  else if (variant.id === "b") content = renderSearchHome();
  else content = renderQueueHome();
  app.innerHTML = content + renderOverlay();
}

function getGame(id) { return games.find((game) => game.id === id) || games[0]; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[character])); }
function matchFromDataset(dataset) { return { type: dataset.type, name: dataset.name, art: dataset.art, year: dataset.year, source: dataset.source, facts: dataset.facts }; }
function gameFromChoice(choice) { return { ...games[0], name: choice.name, type: choice.type, meta: choice.type === "桌遊" ? "重度未知" : "支援平台待選", art: choice.art }; }

function handleAction(target) {
  const action = target.dataset.action;
  if (!action) return;
  if (action === "open-detail") { state.detailGame = getGame(target.dataset.game); state.screen = "detail"; }
  if (action === "back-home" || action === "show-browse") { state.screen = "home"; state.overlay = null; }
  if (action === "back-detail") state.screen = "detail";
  if (action === "start-add") { state.screen = "add"; state.addStep = "type"; state.pendingName = null; state.pendingArt = null; }
  if (action === "start-add" && ["a1", "a2"].includes(state.variant)) state.addStep = "unified-search";
  if (action === "start-add" && ["a1a", "a1b"].includes(state.variant)) state.addStep = "progressive-search";
  if (action === "choose-type") { state.pendingType = target.dataset.type; state.addStep = "search"; }
  if (action === "choose-result") state.addStep = "confirm";
  if (action === "choose-unified-result") { state.pendingType = target.dataset.type; state.pendingName = target.dataset.name; state.pendingArt = target.dataset.art; state.addStep = "confirm"; }
  if (action === "expand-inline") state.progressiveChoice = matchFromDataset(target.dataset);
  if (action === "open-source-preview") { state.progressiveChoice = matchFromDataset(target.dataset); state.overlay = "source-preview"; }
  if (action === "join-from-search") { state.detailGame = gameFromChoice(state.progressiveChoice); state.screen = "detail"; state.overlay = null; }
  if (action === "reset-add") { state.addStep = "type"; state.pendingType = null; }
  if (action === "back-to-search") state.addStep = "search";
  if (action === "manual-entry") { state.screen = "detail"; state.detailGame = { ...games[0], name: "未命名手動條目", meta: "尚未連結來源" }; }
  if (action === "confirm-add") { state.detailGame = state.pendingName ? { ...games[0], name: state.pendingName, type: state.pendingType, meta: state.pendingType === "桌遊" ? "重度未知" : "支援平台待選", art: state.pendingArt } : state.pendingType === "桌遊" ? games[2] : games[3]; state.screen = "detail"; }
  if (action === "open-filters") state.overlay = "filters";
  if (action === "close-overlay") state.overlay = null;
  if (action === "toggle-filter") { const filter = target.dataset.filter; state.filters.has(filter) ? state.filters.delete(filter) : state.filters.add(filter); }
  if (action === "set-query") { state.query = target.dataset.query; }
  if (action === "clear-query") { state.query = ""; state.filters.clear(); }
  if (action === "open-upload") state.screen = "upload";
  if (action === "simulate-files") state.files = [{ name: "spirit-island-01.jpg" }, { name: "spirit-island-02.jpg", failed: true }, { name: "spirit-island-03.jpg" }];
  if (action === "retry-file") state.files[Number(target.dataset.index)].failed = false;
  if (action === "open-note") { state.screen = "note"; state.note = ""; state.dirty = false; state.save = "已儲存"; }
  if (action === "attempt-leave-note") { state.screen = "detail"; state.dirty = false; }
  if (action === "back-home") { state.screen = "home"; state.overlay = null; }
  if (action === "parent-round") { const [round, variant] = currentRound().parent.split(":"); setVariant(variant, round); }
  render();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target) handleAction(target);
  const insert = event.target.closest("[data-insert]");
  if (insert) {
    state.note += insert.dataset.insert;
    state.dirty = true;
    state.save = "儲存中";
    render();
    window.setTimeout(() => { state.save = "已儲存"; state.dirty = false; render(); }, 700);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.dataset.input === "query") {
    const position = event.target.selectionStart;
    state.query = event.target.value;
    render();
    const replacement = document.querySelector('[data-input="query"]');
    if (replacement) {
      replacement.focus();
      replacement.setSelectionRange(position, position);
    }
  }
  if (event.target.dataset.input === "note") {
    state.note = event.target.value;
    state.dirty = true;
    state.save = "儲存中";
    const status = document.querySelector(".save-state");
    const warning = document.querySelector(".leave-warning");
    if (status) {
      status.textContent = state.save;
      status.classList.add("saving");
    }
    if (!warning) {
      document.querySelector(".editor")?.insertAdjacentHTML("beforebegin", '<p class="leave-warning">尚有未儲存內容；離開前系統會嘗試儲存，失敗時會提示你。</p>');
    }
    window.clearTimeout(window.noteTimer);
    window.noteTimer = window.setTimeout(() => {
      state.save = "已儲存";
      state.dirty = false;
      const currentStatus = document.querySelector(".save-state");
      if (currentStatus) {
        currentStatus.textContent = state.save;
        currentStatus.classList.remove("saving");
      }
      document.querySelector(".leave-warning")?.remove();
    }, 700);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.dataset.input === "files") {
    state.files = [...event.target.files].map((file) => ({ name: file.name }));
    render();
  }
});

document.querySelectorAll("[data-variant-step]").forEach((button) => button.addEventListener("click", () => {
  const siblings = currentRound().variants;
  const index = siblings.findIndex((variant) => variant === state.variant);
  setVariant(siblings[(index + Number(button.dataset.variantStep) + siblings.length) % siblings.length]);
}));

document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const siblings = currentRound().variants;
    const index = siblings.findIndex((variant) => variant === state.variant);
    const offset = event.key === "ArrowLeft" ? -1 : 1;
    setVariant(siblings[(index + offset + siblings.length) % siblings.length]);
  }
});

window.addEventListener("popstate", () => { state.round = readRound(); state.variant = readVariant(state.round); state.screen = "home"; render(); });
render();
