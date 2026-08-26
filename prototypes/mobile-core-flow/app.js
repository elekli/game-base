const variantOrder = ["a", "b", "c"];

const variants = {
  a: {
    id: "A",
    name: "封面書架",
    explores: "This explores: browse → cover grid → facet sheet → full-screen detail，讓收藏形狀與封面辨識先於搜尋。",
  },
  b: {
    id: "B",
    name: "索引櫃",
    explores: "This explores: find → search-first dense index → bottom-sheet preview，減少已知目標的滑動與頁面切換。",
  },
  c: {
    id: "C",
    name: "任務棧",
    explores: "This explores: act → focused game → thumb-reach tasks → full-screen journeys，把拍照與筆記置於瀏覽之前。",
  },
};

const games = [
  {
    id: "barrage",
    title: "Barrage",
    original: "Barrage",
    type: "桌遊",
    typeKey: "board",
    detail: "重度 4.11 · 1–4 人",
    year: "2019",
    source: "BoardGameGeek",
    people: "Tommaso Battista、Simone Luciani",
    cover: "linear-gradient(145deg, #132f49 0 46%, #be5e2e 47% 63%, #e0ba60 64%)",
  },
  {
    id: "citizen-sleeper",
    title: "Citizen Sleeper",
    original: "Citizen Sleeper",
    type: "電子遊戲",
    typeKey: "video",
    detail: "Steam · Nintendo Switch",
    year: "2022",
    source: "IGDB",
    people: "Jump Over the Age",
    cover: "linear-gradient(24deg, #e8b62f 0 27%, #202d50 28% 59%, #cd4a38 60%)",
  },
  {
    id: "azul",
    title: "花磚物語",
    original: "Azul",
    type: "桌遊",
    typeKey: "board",
    detail: "重度 1.76 · 2–4 人",
    year: "2017",
    source: "BoardGameGeek",
    people: "Michael Kiesling",
    cover: "linear-gradient(135deg, #f1e4b8 0 20%, #256ba0 21% 38%, #e2a729 39% 58%, #6d9d72 59% 75%, #b63f34 76%)",
  },
  {
    id: "hades",
    title: "Hades",
    original: "Hades",
    type: "電子遊戲",
    typeKey: "video",
    detail: "Steam · Nintendo Switch",
    year: "2020",
    source: "IGDB",
    people: "Supergiant Games",
    cover: "linear-gradient(150deg, #161b20 0 42%, #9a2922 43% 62%, #d9a43a 63%)",
  },
  {
    id: "cascadia",
    title: "璀璨大地",
    original: "Cascadia",
    type: "桌遊",
    typeKey: "board",
    detail: "重度 1.86 · 1–4 人",
    year: "2021",
    source: "BoardGameGeek",
    people: "Randy Flynn",
    cover: "linear-gradient(25deg, #2c5e4d 0 31%, #89a866 32% 56%, #dfc07c 57% 72%, #547ca5 73%)",
  },
  {
    id: "outer-wilds",
    title: "Outer Wilds",
    original: "Outer Wilds",
    type: "電子遊戲",
    typeKey: "video",
    detail: "Steam · PS5",
    year: "2019",
    source: "IGDB",
    people: "Mobius Digital",
    cover: "radial-gradient(circle at 62% 29%, #f7c84f 0 8%, #bb5429 9% 20%, #17263d 21% 67%, #090d17 68%)",
  },
  {
    id: "spirit-island",
    title: "Spirit Island",
    original: "Spirit Island",
    type: "桌遊",
    typeKey: "board",
    detail: "重度 4.07 · 1–4 人",
    year: "2017",
    source: "BoardGameGeek",
    people: "R. Eric Reuss",
    cover: "linear-gradient(160deg, #193934 0 34%, #367d71 35% 53%, #d4aa4d 54% 68%, #672e32 69%)",
  },
  {
    id: "slay-the-spire",
    title: "Slay the Spire",
    original: "Slay the Spire",
    type: "電子遊戲",
    typeKey: "video",
    detail: "Steam",
    year: "2019",
    source: "IGDB",
    people: "Mega Crit",
    cover: "linear-gradient(130deg, #4c1833 0 35%, #b3343c 36% 57%, #e1b446 58% 66%, #202033 67%)",
  },
];

const candidates = [
  {
    id: "dune-imperium",
    title: "Dune: Imperium",
    original: "Dune: Imperium",
    type: "桌遊",
    typeKey: "board",
    detail: "重度 3.05 · 1–4 人",
    year: "2020",
    source: "BoardGameGeek",
    people: "Paul Dennen · Dire Wolf",
    cover: "linear-gradient(155deg, #36271e 0 37%, #b46a32 38% 62%, #e3b65d 63% 76%, #623a26 77%)",
  },
  {
    id: "dorfromantik",
    title: "Dorfromantik",
    original: "Dorfromantik",
    type: "電子遊戲",
    typeKey: "video",
    detail: "Steam · Nintendo Switch",
    year: "2022",
    source: "IGDB",
    people: "Toukana Interactive",
    cover: "linear-gradient(30deg, #668e5c 0 28%, #e5b968 29% 54%, #74aabd 55% 73%, #dd7c53 74%)",
  },
];

const initialUploads = () => [
  { id: "u1", name: "桌面全景.heic", size: "3.4 MB", status: "waiting", reason: "", description: "" },
  { id: "u2", name: "水壩特寫.jpg", size: "5.8 MB", status: "waiting", reason: "", description: "" },
  { id: "u3", name: "規則書掃描.png", size: "58.2 MB", status: "waiting", reason: "", description: "" },
  { id: "u4", name: "玩家版圖.jpg", size: "4.1 MB", status: "waiting", reason: "", description: "" },
];

const params = new URLSearchParams(window.location.search);
const requestedVariant = params.get("variant");

let state = {
  variant: variantOrder.includes(requestedVariant) ? requestedVariant : "a",
  screen: params.get("screen") || "home",
  gameId: params.get("game") || "barrage",
  overlay: params.get("overlay") || "",
  query: params.get("query") || "",
  typeFilter: params.get("type") || "all",
  addType: params.get("addType") || "board",
};

let noteText = "## 第一局\n\n水壩的位置比想像中更難調整。\n\n- 下次先保留水滴\n- 留意第四回合的收入";
let noteStatus = params.get("noteState") || "saved";
let simulateSaveFailure = false;
let noteSaveTimer = null;
let uploadItems = initialUploads();
let uploadTimers = [];
let toastTimer = null;

const app = document.querySelector("#prototype");
const toast = document.querySelector("#toast");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getGame(id = state.gameId) {
  return [...games, ...candidates].find((game) => game.id === id) || games[0];
}

function cover(game, size = "") {
  return `<div class="cover ${size}" style="--cover:${game.cover}"><span class="cover-title">${escapeHtml(game.title)}</span></div>`;
}

function setUrl(replace = false) {
  const next = new URLSearchParams();
  next.set("variant", state.variant);
  next.set("screen", state.screen);
  if (state.gameId && state.gameId !== "barrage") next.set("game", state.gameId);
  if (state.overlay) next.set("overlay", state.overlay);
  if (state.query) next.set("query", state.query);
  if (state.typeFilter !== "all") next.set("type", state.typeFilter);
  if (state.addType !== "board") next.set("addType", state.addType);
  if (state.screen === "note" && noteStatus !== "saved") next.set("noteState", noteStatus);
  const url = `${window.location.pathname}?${next.toString()}`;
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function navigate(screen, patch = {}, replace = false) {
  state = { ...state, ...patch, screen };
  setUrl(replace);
  render();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2400);
}

function updateSwitcher() {
  const variant = variants[state.variant];
  document.querySelector("#variant-id").textContent = variant.id;
  document.querySelector("#variant-name").textContent = variant.name;
  document.querySelector("#variant-explores").textContent = variant.explores;
}

function screenHeader(title, back = "home", action = "") {
  return `
    <header class="screen-header">
      <button type="button" class="header-button" data-action="back" data-target="${back}">← 返回</button>
      <h2 class="screen-title">${title}</h2>
      ${action || '<span aria-hidden="true" style="width:64px"></span>'}
    </header>`;
}

function bottomNav(active = "library") {
  return `
    <nav class="bottom-nav" aria-label="主要導覽">
      <button type="button" class="nav-button ${active === "library" ? "active" : ""}" data-nav="home">▦<br>收藏庫</button>
      <button type="button" class="nav-button ${active === "find" ? "active" : ""}" data-nav="find">⌕<br>搜尋</button>
      <button type="button" class="nav-button ${active === "add" ? "active" : ""}" data-nav="add-type">＋<br>新增</button>
    </nav>`;
}

function filteredGames() {
  const query = state.query.trim().toLocaleLowerCase();
  return games.filter((game) => {
    const matchesQuery = !query || `${game.title} ${game.original}`.toLocaleLowerCase().includes(query);
    const matchesType = state.typeFilter === "all" || game.typeKey === state.typeFilter;
    return matchesQuery && matchesType;
  });
}

function gameCard(game) {
  return `
    <button type="button" class="game-card" data-action="select-game" data-game="${game.id}">
      ${cover(game)}
      <h3>${escapeHtml(game.title)}</h3>
      <p>${escapeHtml(game.type)} · ${escapeHtml(game.detail)}</p>
    </button>`;
}

function filterSheet() {
  return `
    <div class="sheet-scrim" data-action="close-overlay">
      <section class="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="filter-title" data-sheet>
        <div class="sheet-handle"></div>
        <div class="sheet-heading">
          <div><p class="section-label">不同維度取交集</p><h2 id="filter-title">篩選收藏庫</h2></div>
          <button type="button" class="sheet-close" data-action="close-overlay">完成</button>
        </div>
        <div class="filter-groups">
          <div class="filter-group">
            <h3>遊戲類型</h3>
            <div class="chip-row">
              ${filterChip("all", "全部")}${filterChip("board", "桌遊")}${filterChip("video", "電子遊戲")}
            </div>
          </div>
          <div class="filter-group">
            <h3>自由標籤（同維度取聯集）</h3>
            <div class="chip-row"><button class="chip selected">兩人</button><button class="chip">單人</button><button class="chip">聚會</button></div>
          </div>
          <div class="filter-group">
            <h3>排序</h3>
            <div class="chip-row"><button class="chip selected">顯示名稱</button><button class="chip">最近新增</button><button class="chip">重度</button></div>
          </div>
        </div>
      </section>
    </div>`;
}

function filterChip(value, label) {
  return `<button type="button" class="chip ${state.typeFilter === value ? "selected" : ""}" data-filter="${value}">${label}</button>`;
}

function renderAHome(showFilters = false) {
  const results = filteredGames();
  return `
    <section class="screen variant-a">
      <div class="brand-block"><p class="section-label">示意資料 · ${games.length} 款</p><h2>遊戲收藏庫</h2><p>依顯示名稱排序</p></div>
      <div class="home-controls">
        <label class="search-box">⌕<input data-input="query" value="${escapeHtml(state.query)}" placeholder="搜尋收藏庫" aria-label="搜尋收藏庫"></label>
        <button type="button" class="icon-button" data-action="open-filters" aria-label="開啟篩選">篩</button>
      </div>
      <div class="chip-row" style="padding:2px 12px 4px"><span class="chip selected">${results.length} 個結果</span>${state.typeFilter !== "all" ? `<button class="chip" data-filter="all">清除：${state.typeFilter === "board" ? "桌遊" : "電子遊戲"}</button>` : ""}</div>
      <div class="scroll-region"><div class="cover-grid">${results.map(gameCard).join("") || '<div class="empty-state">找不到符合項目</div>'}</div></div>
      ${bottomNav("library")}
      ${showFilters ? filterSheet() : ""}
    </section>`;
}

function renderIndexRow(game, index) {
  return `
    <button type="button" class="row-button index-row" data-action="select-game" data-game="${game.id}">
      <span class="index-letter">${index === 0 ? game.title.slice(0, 1).toUpperCase() : "·"}</span>
      ${cover(game, "cover-small")}
      <span class="row-main"><strong>${escapeHtml(game.title)}</strong><span>${escapeHtml(game.original)} · ${escapeHtml(game.detail)}</span></span>
      <span aria-hidden="true">›</span>
    </button>`;
}

function previewSheet(game) {
  return `
    <div class="sheet-scrim" data-action="close-overlay">
      <section class="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="preview-title" data-sheet>
        <div class="sheet-handle"></div>
        <div class="confirm-cover-row">
          ${cover(game, "cover-hero")}
          <div><span class="type-badge">${game.type}</span><h2 id="preview-title">${escapeHtml(game.title)}</h2><p class="meta">${escapeHtml(game.detail)}<br>${escapeHtml(game.people)}</p></div>
        </div>
        <div class="preview-actions">
          <button type="button" data-action="open-detail" data-game="${game.id}">打開詳情</button>
          <button type="button" data-action="open-upload" data-game="${game.id}">上傳照片</button>
          <button type="button" data-action="open-note" data-game="${game.id}">新增筆記</button>
        </div>
      </section>
    </div>`;
}

function renderBHome() {
  const results = filteredGames();
  const selected = getGame();
  return `
    <section class="screen variant-b">
      <div class="index-header">
        <p class="section-label">本地收藏庫 · 不呼叫外部來源</p>
        <h2>找到一款遊戲</h2>
        <label class="search-box">⌕<input data-input="query" value="${escapeHtml(state.query)}" placeholder="名稱、原文或別名" aria-label="搜尋收藏庫"></label>
      </div>
      <div class="index-summary"><span>${results.length} 個結果 · 顯示名稱排序</span><button type="button" class="quiet-button" data-action="open-filters">篩選</button></div>
      <div class="scroll-region">${results.map(renderIndexRow).join("") || '<div class="empty-state">沒有結果。外部搜尋請走「新增」。</div>'}</div>
      ${bottomNav("find")}
      ${state.overlay === "filters" ? filterSheet() : ""}
      ${state.overlay === "preview" ? previewSheet(selected) : ""}
    </section>`;
}

function renderCHome() {
  const game = games[0];
  return `
    <section class="screen variant-c">
      <div class="scroll-region task-home">
        <div class="task-greeting"><p class="section-label">示意資料 · 週二晚間</p><h2>現在想替收藏做什麼？</h2><p>先完成手邊工作，再回到完整收藏庫。</p></div>
        <article class="focus-game">
          <p class="section-label">最近開啟</p><h3>${game.title}</h3><p>${game.detail}</p>
          <div class="focus-actions"><button type="button" data-action="open-upload" data-game="${game.id}">相機／照片</button><button type="button" data-action="open-note" data-game="${game.id}">寫一則筆記</button></div>
        </article>
        <div class="task-stack">
          <button type="button" data-nav="find"><span><strong>找收藏中的遊戲</strong><small>名稱、類型、平台與標籤</small></span><span>⌕</span></button>
          <button type="button" data-nav="add-type"><span><strong>新增一款遊戲</strong><small>先選桌遊或電子遊戲</small></span><span>＋</span></button>
          <button type="button" data-action="open-detail" data-game="citizen-sleeper"><span><strong>繼續整理 Citizen Sleeper</strong><small>平台與清單放在次要操作</small></span><span>›</span></button>
        </div>
      </div>
      ${bottomNav("library")}
    </section>`;
}

function renderCFind() {
  const results = filteredGames();
  return `
    <section class="screen variant-c">
      ${screenHeader("搜尋收藏庫")}
      <div class="form-stack" style="background:#f8f0dd;color:var(--ink)">
        <label class="search-box">⌕<input data-input="query" value="${escapeHtml(state.query)}" placeholder="即時部分字串比對" aria-label="搜尋收藏庫"></label>
        <div class="chip-row">${filterChip("all", "全部")}${filterChip("board", "桌遊")}${filterChip("video", "電子遊戲")}</div>
      </div>
      <div class="scroll-region" style="background:#fffaf0;color:var(--ink)">${results.map(renderIndexRow).join("") || '<div class="empty-state">找不到符合項目</div>'}</div>
      ${bottomNav("find")}
    </section>`;
}

function renderDetail() {
  const game = getGame();
  return `
    <section class="screen variant-${state.variant}">
      ${screenHeader("遊戲詳細頁")}
      <div class="scroll-region">
        <div class="detail-hero">${cover(game, "cover-hero")}<div><span class="type-badge">${game.type}</span><h1 class="hero-title">${escapeHtml(game.title)}</h1><p class="meta">${escapeHtml(game.original)} · ${game.year}<br>${escapeHtml(game.detail)}</p></div></div>
        <section class="detail-section"><p class="section-label">主要資料</p><h3>${game.typeKey === "board" ? "重度與人數" : "實際平台"}</h3><p>${escapeHtml(game.detail)}</p></section>
        <section class="detail-section"><p class="section-label">最近筆記</p><h3>第一局</h3><p>水壩的位置比想像中更難調整。下次先保留水滴。</p></section>
        <section class="detail-section"><p class="section-label">次要操作</p><h3>平台、標籤、清單與資料編輯</h3><p>這些操作不和「上傳照片／新增筆記」競爭拇指區。</p><button type="button" class="secondary-button">管理資料</button></section>
      </div>
      <div class="action-dock"><button type="button" class="action-tile" data-action="open-upload" data-game="${game.id}">▣ 上傳照片</button><button type="button" class="action-tile" data-action="open-note" data-game="${game.id}">✎ 新增筆記</button></div>
    </section>`;
}

function renderAddType() {
  return `
    <section class="screen variant-${state.variant}">
      ${screenHeader("新增遊戲")}
      <div class="scroll-region">
        <div class="task-intro"><p class="section-label">STEP 1 OF 2</p><h1 class="task-title">先選遊戲類型</h1><p>桌遊只搜尋 BoardGameGeek；電子遊戲只搜尋 IGDB，不混合候選。</p></div>
        <div class="form-stack">
          <div class="segmented" aria-label="遊戲類型"><button type="button" class="${state.addType === "board" ? "selected" : ""}" data-add-type="board">桌遊</button><button type="button" class="${state.addType === "video" ? "selected" : ""}" data-add-type="video">電子遊戲</button></div>
          <label class="search-box">⌕<input data-input="add-query" placeholder="搜尋 ${state.addType === "board" ? "BoardGameGeek" : "IGDB"}" value="${state.addType === "board" ? "Dune" : "Dorfromantik"}"></label>
          <p class="meta subtle">外部來源找不到時，可只填名稱建立最小條目。</p>
        </div>
        <div>${candidates.filter((game) => game.typeKey === state.addType).map((game) => `
          <button type="button" class="row-button result-row" data-action="choose-candidate" data-game="${game.id}">${cover(game, "cover-small")}<span class="row-main"><strong>${game.title}</strong><span>${game.year} · ${game.source} · ${game.detail}</span></span><span>›</span></button>`).join("")}</div>
      </div>
      ${bottomNav("add")}
    </section>`;
}

function renderAddConfirm() {
  const candidate = getGame(state.gameId && candidates.some((game) => game.id === state.gameId) ? state.gameId : "dune-imperium");
  return `
    <section class="screen variant-${state.variant}">
      ${screenHeader("確認新增", "add-type")}
      <div class="scroll-region">
        <div class="confirm-card">
          <p class="section-label">尚未建立 · ${candidate.source}</p>
          <div class="confirm-cover-row">${cover(candidate, "cover-hero")}<div><span class="type-badge">${candidate.type}</span><h2>${candidate.title}</h2><p class="meta">${candidate.original}</p></div></div>
          <dl><dt>年份</dt><dd>${candidate.year}</dd><dt>${candidate.typeKey === "board" ? "人數／重度" : "來源平台"}</dt><dd>${candidate.detail}</dd><dt>${candidate.typeKey === "board" ? "設計師" : "開發公司"}</dt><dd>${candidate.people}</dd><dt>來源</dt><dd>${candidate.source}</dd></dl>
          <button type="button" class="primary-button button-wide" data-action="create-game" data-game="${candidate.id}">加入收藏庫</button>
          <p class="meta subtle">按下前不建立資料；送出時再次檢查來源身分是否重複。</p>
        </div>
      </div>
    </section>`;
}

function renderUpload() {
  const game = getGame();
  const successCount = uploadItems.filter((item) => item.status === "success").length;
  const failedCount = uploadItems.filter((item) => item.status === "failed").length;
  const started = uploadItems.some((item) => item.status !== "waiting");
  return `
    <section class="screen variant-${state.variant}">
      ${screenHeader("批次照片", "detail")}
      <div class="task-intro"><p class="section-label">${escapeHtml(game.title)} · 示意檔案</p><h1 class="task-title">先上傳，再整理</h1><p>說明與指定封面都是上傳後的選填工作；單檔失敗不影響其他檔案。</p></div>
      <div class="scroll-region">
        <div class="upload-list">${uploadItems.map(renderUploadRow).join("")}</div>
      </div>
      <div class="sticky-footer">
        <p class="meta" style="margin:0">${started ? `${successCount} 成功 · ${failedCount} 失敗 · 其餘處理中` : "已選取 4 張；尚未上傳"}</p>
        ${started ? `<button type="button" class="primary-button button-wide" data-action="retry-all-failed">只重試可重試的失敗項目</button>` : '<button type="button" class="primary-button button-wide" data-action="start-upload">開始批次上傳</button>'}
      </div>
    </section>`;
}

function renderUploadRow(item) {
  const labels = { waiting: "等待中", uploading: "上傳中", success: "成功", failed: "失敗" };
  const retryable = item.status === "failed" && item.reason.includes("網路");
  return `
    <article class="upload-row">
      <div class="upload-thumb" aria-hidden="true">▧</div>
      <div class="row-main"><strong>${escapeHtml(item.name)}</strong><span>${item.size}</span><span class="upload-status ${item.status}">${labels[item.status]}${item.reason ? ` · ${escapeHtml(item.reason)}` : ""}</span>${item.status === "success" ? `<label class="description-field"><span class="meta">照片說明（選填）</span><input data-description="${item.id}" value="${escapeHtml(item.description)}" placeholder="上傳後再補"></label>` : ""}</div>
      ${retryable ? `<button type="button" class="upload-retry" data-action="retry-upload" data-file="${item.id}">重試</button>` : item.status === "failed" ? `<button type="button" class="upload-retry" data-action="remove-upload" data-file="${item.id}">移除</button>` : ""}
    </article>`;
}

function renderNote() {
  const game = getGame();
  const statusText = { saved: "已儲存", dirty: "尚未儲存", saving: "儲存中…", failed: "儲存失敗 · 文字仍保留" }[noteStatus] || "已儲存";
  return `
    <section class="screen variant-${state.variant}">
      ${screenHeader("Markdown 筆記", "detail", `<button type="button" class="quiet-button" data-action="toggle-save-failure">${simulateSaveFailure ? "恢復連線" : "模擬斷線"}</button>`)}
      <div class="note-status ${noteStatus}" data-note-status><span>${escapeHtml(game.title)} · 新筆記</span><strong>${statusText}</strong></div>
      <textarea class="note-editor" data-note-editor aria-label="Markdown 原始碼筆記" spellcheck="true">${escapeHtml(noteText)}</textarea>
      <div class="editor-toolbar" aria-label="Markdown 工具列">
        <button type="button" class="toolbar-button" data-markdown="bold" aria-label="粗體">**B**</button>
        <button type="button" class="toolbar-button" data-markdown="heading" aria-label="標題"># H</button>
        <button type="button" class="toolbar-button" data-markdown="list" aria-label="項目清單">- ≡</button>
        <button type="button" class="toolbar-button" data-markdown="link" aria-label="連結">[↗]</button>
        <button type="button" class="toolbar-button" data-markdown="quote" aria-label="引用">&gt; ”</button>
      </div>
      ${state.overlay === "leave" ? renderLeaveDialog() : ""}
    </section>`;
}

function renderLeaveDialog() {
  return `
    <div class="sheet-scrim">
      <section class="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="leave-title">
        <div class="leave-dialog"><p class="section-label">未完成狀態</p><h2 id="leave-title">這則筆記還沒安全儲存</h2><p class="meta">文字仍保留在目前編輯器內。MVP 不建立離線佇列；直接離開會回到伺服器舊值。</p><div class="dialog-actions"><button type="button" class="secondary-button" data-action="stay-note">繼續編輯</button><button type="button" class="primary-button" data-action="discard-note">放棄並離開</button></div></div>
      </section>
    </div>`;
}

function render() {
  updateSwitcher();
  let html;
  switch (state.screen) {
    case "detail": html = renderDetail(); break;
    case "add-type": html = renderAddType(); break;
    case "add-confirm": html = renderAddConfirm(); break;
    case "upload": html = renderUpload(); break;
    case "note": html = renderNote(); break;
    case "find":
      html = state.variant === "a" ? renderAHome(true) : state.variant === "b" ? renderBHome() : renderCFind();
      break;
    case "home":
    default:
      html = state.variant === "a" ? renderAHome(false) : state.variant === "b" ? renderBHome() : renderCHome();
      break;
  }
  app.innerHTML = html;
  app.className = `phone-screen variant-${state.variant}`;
}

function switchVariant(direction) {
  const current = variantOrder.indexOf(state.variant);
  state.variant = variantOrder[(current + direction + variantOrder.length) % variantOrder.length];
  state.screen = "home";
  state.overlay = "";
  state.query = "";
  setUrl();
  render();
}

function handleGameSelection(gameId) {
  state.gameId = gameId;
  if (state.variant === "b") {
    state.overlay = "preview";
    setUrl();
    render();
    return;
  }
  navigate("detail", { overlay: "" });
}

function startUploads() {
  uploadTimers.forEach(window.clearTimeout);
  uploadItems = initialUploads();
  uploadItems[0].status = "uploading";
  render();
  const steps = [
    [500, 0, "success", ""],
    [650, 1, "uploading", ""],
    [950, 2, "failed", "超過 50 MB"],
    [1200, 1, "success", ""],
    [1350, 3, "uploading", ""],
    [2050, 3, "failed", "網路中斷，可重試"],
  ];
  steps.forEach(([delay, index, status, reason]) => {
    const timer = window.setTimeout(() => {
      uploadItems[index].status = status;
      uploadItems[index].reason = reason;
      render();
    }, delay);
    uploadTimers.push(timer);
  });
}

function retryUpload(id) {
  const item = uploadItems.find((candidate) => candidate.id === id);
  if (!item) return;
  item.status = "uploading";
  item.reason = "";
  render();
  window.setTimeout(() => {
    item.status = "success";
    render();
    showToast(`${item.name} 已成功；其他成功項目沒有重複建立。`);
  }, 850);
}

function setNoteStatus(next) {
  noteStatus = next;
  const node = document.querySelector("[data-note-status]");
  if (!node) return;
  const statusText = { saved: "已儲存", dirty: "尚未儲存", saving: "儲存中…", failed: "儲存失敗 · 文字仍保留" }[noteStatus];
  node.className = `note-status ${noteStatus}`;
  const strong = node.querySelector("strong");
  if (strong) strong.textContent = statusText;
  setUrl(true);
}

function queueNoteSave() {
  window.clearTimeout(noteSaveTimer);
  setNoteStatus("dirty");
  noteSaveTimer = window.setTimeout(() => {
    setNoteStatus("saving");
    noteSaveTimer = window.setTimeout(() => {
      setNoteStatus(simulateSaveFailure ? "failed" : "saved");
    }, 850);
  }, 850);
}

function applyMarkdown(kind) {
  const editor = document.querySelector("[data-note-editor]");
  if (!editor) return;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selection = editor.value.slice(start, end);
  const formats = {
    bold: [`**`, `**`, selection || "粗體文字"],
    heading: [`## `, ``, selection || "小標題"],
    list: [`- `, ``, selection || "清單項目"],
    link: [`[`, `](https://)`, selection || "連結文字"],
    quote: [`> `, ``, selection || "引用"],
  };
  const [before, after, fallback] = formats[kind];
  const value = `${before}${selection || fallback}${after}`;
  editor.setRangeText(value, start, end, "end");
  noteText = editor.value;
  editor.focus();
  queueNoteSave();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-action], [data-nav], [data-jump]");
  if (!target) return;
  if (target.closest("[data-sheet]") && target === target.closest("[data-sheet]")) return;

  if (target.dataset.action === "previous-variant") return switchVariant(-1);
  if (target.dataset.action === "next-variant") return switchVariant(1);

  if (target.dataset.jump) {
    const screen = target.dataset.jump;
    const patch = { overlay: "", gameId: screen === "add-confirm" ? "dune-imperium" : "barrage" };
    if (screen === "note") {
      noteStatus = "dirty";
      noteText += "\n\n這行尚未送到伺服器。";
    }
    navigate(screen, patch);
    return;
  }

  if (target.dataset.nav) {
    navigate(target.dataset.nav, { overlay: "", query: "" });
    return;
  }

  if (target.dataset.filter) {
    state.typeFilter = target.dataset.filter;
    setUrl(true);
    render();
    return;
  }

  if (target.dataset.addType) {
    state.addType = target.dataset.addType;
    state.gameId = target.dataset.addType === "board" ? "dune-imperium" : "dorfromantik";
    setUrl(true);
    render();
    return;
  }

  const action = target.dataset.action;
  if (!action) return;

  switch (action) {
    case "back": {
      const targetScreen = target.dataset.target || "home";
      if (state.screen === "note" && ["dirty", "saving", "failed"].includes(noteStatus)) {
        state.overlay = "leave";
        setUrl(true);
        render();
      } else {
        navigate(targetScreen, { overlay: "" });
      }
      break;
    }
    case "open-filters":
      state.overlay = "filters";
      if (state.variant === "a") state.screen = "find";
      setUrl();
      render();
      break;
    case "close-overlay":
      if (event.target.closest("[data-sheet]") && !target.matches(".sheet-close")) return;
      state.overlay = "";
      if (state.variant === "a" && state.screen === "find") state.screen = "home";
      setUrl();
      render();
      break;
    case "select-game":
      handleGameSelection(target.dataset.game);
      break;
    case "open-detail":
      navigate("detail", { gameId: target.dataset.game || state.gameId, overlay: "" });
      break;
    case "open-upload":
      navigate("upload", { gameId: target.dataset.game || state.gameId, overlay: "" });
      break;
    case "open-note":
      noteStatus = "saved";
      navigate("note", { gameId: target.dataset.game || state.gameId, overlay: "" });
      break;
    case "choose-candidate":
      navigate("add-confirm", { gameId: target.dataset.game, overlay: "" });
      break;
    case "create-game":
      navigate("detail", { gameId: target.dataset.game, overlay: "" });
      showToast("已加入收藏庫；現在位於新遊戲詳細頁。");
      break;
    case "start-upload":
      startUploads();
      break;
    case "retry-upload":
      retryUpload(target.dataset.file);
      break;
    case "retry-all-failed":
      uploadItems.filter((item) => item.status === "failed" && item.reason.includes("網路")).forEach((item) => retryUpload(item.id));
      break;
    case "remove-upload":
      uploadItems = uploadItems.filter((item) => item.id !== target.dataset.file);
      render();
      break;
    case "toggle-save-failure":
      simulateSaveFailure = !simulateSaveFailure;
      if (!simulateSaveFailure && noteStatus === "failed") queueNoteSave();
      render();
      showToast(simulateSaveFailure ? "下一次自動儲存會失敗。" : "連線恢復，將重試目前文字。");
      break;
    case "stay-note":
      state.overlay = "";
      setUrl(true);
      render();
      window.setTimeout(() => document.querySelector("[data-note-editor]")?.focus(), 0);
      break;
    case "discard-note":
      noteStatus = "saved";
      state.overlay = "";
      navigate("detail");
      showToast("已放棄本機未儲存內容；伺服器舊值保持不變。");
      break;
    default:
      break;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-input='query']")) {
    state.query = event.target.value;
    setUrl(true);
    render();
    const input = document.querySelector("[data-input='query']");
    input?.focus();
    input?.setSelectionRange(state.query.length, state.query.length);
  }
  if (event.target.matches("[data-note-editor]")) {
    noteText = event.target.value;
    queueNoteSave();
  }
  if (event.target.matches("[data-description]")) {
    const item = uploadItems.find((candidate) => candidate.id === event.target.dataset.description);
    if (item) item.description = event.target.value;
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-markdown]");
  if (button) applyMarkdown(button.dataset.markdown);
});

document.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  if (event.target.matches("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
  switchVariant(event.key === "ArrowRight" ? 1 : -1);
});

window.addEventListener("popstate", () => {
  const next = new URLSearchParams(window.location.search);
  state.variant = variantOrder.includes(next.get("variant")) ? next.get("variant") : "a";
  state.screen = next.get("screen") || "home";
  state.gameId = next.get("game") || "barrage";
  state.overlay = next.get("overlay") || "";
  state.query = next.get("query") || "";
  state.typeFilter = next.get("type") || "all";
  state.addType = next.get("addType") || "board";
  render();
});

render();
