// Native ES module; untrusted feed fields are only assigned as text.
const categoryNames = new Map([
  ["politics", "政治"], ["finance", "財經"], ["tech", "科技"],
  ["world", "國際"], ["society", "社會"], ["life", "生活"],
  ["sports", "體育"], ["entertainment", "娛樂"], ["other", "其他"],
]);

const themeNames = new Map([
  ["foundry", "晶圓代工"], ["ic_design", "IC 設計"], ["memory", "記憶體"],
  ["packaging", "先進封裝"], ["semi_equip", "半導體設備材料"], ["ai_server", "AI 伺服器"],
  ["cooling", "散熱"], ["pcb", "PCB／被動元件"], ["optical", "光通訊"],
  ["display", "光電面板"], ["leo", "低軌衛星"], ["energy", "能源"],
  ["ev", "電動車"], ["financials", "金融"], ["property", "營建房產"],
  ["transport", "航運航空"], ["consumer_elec", "消費電子"], ["petrochem", "原物料傳產"],
  ["software", "軟體網路"], ["industrial", "工業電腦"], ["macro", "大盤／總經"], ["other", "其他"],
]);
const marketIds = new Set(["positive", "negative", "mixed", "not_market", "other"]);
const directionIds = new Set(["bull", "bear", "mixed", "neutral"]);
const financial = category => category === "finance" || category === "tech";
function validAnalysis(item) {
  const value = item.analysis;
  if (!financial(item.category) || !value || typeof value !== "object" || Array.isArray(value)
      || typeof value.market !== "string" || !marketIds.has(value.market)
      || typeof value.theme !== "string" || !themeNames.has(value.theme)
      || typeof value.dir !== "string" || !directionIds.has(value.dir)
      || typeof value.dir_p !== "number" || !Number.isFinite(value.dir_p)
      || value.dir_p < 0 || value.dir_p > 1) return null;
  return value;
}
function arrow(analysis) {
  if (!analysis || analysis.dir_p < 0.6) return "";
  return analysis.dir === "bull" ? "▲" : analysis.dir === "bear" ? "▼" : "";
}

const css = `
.nw {
  --nw-bg: var(--md-bg, #ffffff);
  --nw-fg: var(--md-fg, #242424);
  --nw-muted: var(--md-fg-muted, #616161);
  --nw-line: var(--md-border, #c7c7c7);
  --nw-surface: var(--md-surface, #f3f3f3);
  --nw-accent: var(--md-accent, #005fb8);
  --nw-focus: var(--md-focus, #005fb8);
  --nw-up: #c8102e;
  --nw-down: #0f7b3f;
  --nw-mixed: #b7791f;
  --nw-idle: color-mix(in srgb, var(--nw-muted) 45%, transparent);
  container-type: inline-size;
  margin: 8px;
  background: var(--nw-bg);
  color: var(--nw-fg);
  font: 14px/1.5 "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
:root[data-theme="dark"] .nw {
  --nw-up: #ff6b6b;
  --nw-down: #4fd18b;
  --nw-mixed: #f0b429;
}
.nw *, .nw *::before, .nw *::after { box-sizing: border-box; }
.nw [hidden] { display: none !important; }
.nw button, .nw select {
  font: inherit;
  color: var(--nw-fg);
  background: var(--nw-bg);
  border: 1px solid var(--nw-line);
  border-radius: 5px;
  padding: 5px 9px;
  max-width: 100%;
}
.nw button { cursor: pointer; }
.nw button:disabled { cursor: default; color: var(--nw-muted); }
.nw button:focus-visible, .nw a:focus-visible, .nw select:focus-visible {
  outline: 2px solid var(--nw-focus);
  outline-offset: 2px;
}
.nw .nw-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 0 12px; }
.nw .nw-status { margin-left: auto; font-size: 12px; color: var(--nw-muted); }
.nw .nw-panel { background: var(--nw-surface); border-radius: 8px; padding: 14px 16px; }
.nw .nw-sample { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0 0 18px; color: var(--nw-muted); font-size: 12px; }
.nw .nw-pending { margin-left: auto; }
.nw .nw-warning { flex-basis: 100%; }
.nw .nw-heading { font-size: 14px; font-weight: 500; margin: 0 0 8px; }
.nw .nw-bar { display: flex; height: 10px; overflow: hidden; border-radius: 3px; }
.nw .nw-bar[data-empty="true"] { background: var(--nw-idle); }
.nw .nw-segment { display: block; flex: 0 0 auto; height: 100%; transition: width 240ms ease; }
.nw .nw-positive, .nw .nw-bull { background: var(--nw-up); }
.nw .nw-negative, .nw .nw-bear { background: var(--nw-down); }
.nw .nw-mixed { background: var(--nw-mixed); }
.nw .nw-idle { background: var(--nw-idle); }
.nw .nw-legend { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 8px 0 18px; }
.nw .nw-legend-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; color: var(--nw-muted); font-size: 12px; }
.nw .nw-dot { width: 6px; height: 6px; border-radius: 50%; align-self: center; flex: 0 0 auto; }
.nw .nw-value { font-size: 20px; font-weight: 600; color: var(--nw-fg); }
.nw .nw-macro { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 18px; }
.nw .nw-up { color: var(--nw-up); }
.nw .nw-down { color: var(--nw-down); }
.nw .nw-ranking-heading { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.nw .nw-hint, .nw .nw-note { font-size: 12px; color: var(--nw-muted); }
.nw .nw-ranking { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px 20px; }
.nw .nw-theme {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(32px, 1fr) 3ch;
  align-items: center; gap: 10px; text-align: left;
  border: 0; border-left: 3px solid transparent; border-radius: 0;
  background: transparent; padding: 7px 8px;
  margin-left: -11px; margin-right: -8px; max-width: none;
}
.nw .nw-theme:hover { background: color-mix(in srgb, var(--nw-fg) 6%, transparent); }
.nw .nw-theme[aria-pressed="true"] { border-left-color: var(--nw-accent); }
.nw .nw-theme[aria-pressed="true"] .nw-theme-name { font-weight: 600; }
.nw .nw-theme-name { overflow-wrap: anywhere; }
.nw .nw-theme-track { min-width: 0; }
.nw .nw-theme-bar { height: 6px; transition: width 240ms ease; }
.nw .nw-theme-count { text-align: right; }
.nw .nw-note { display: block; margin-top: 16px; }
.nw .nw-filter { display: flex; align-items: center; gap: 8px; padding: 12px 0 0; color: var(--nw-muted); font-size: 12px; }
.nw .nw-list { list-style: none; margin: 0; padding: 0; }
.nw .nw-row { padding: 14px 0; }
.nw .nw-row + .nw-row { border-top: 1px solid var(--nw-line); }
.nw .nw-title { display: block; font-size: 15px; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; color: var(--nw-fg); text-decoration: none; }
.nw a.nw-title:hover { color: var(--nw-accent); text-decoration: underline; }
.nw .nw-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 5px; font-size: 12px; color: var(--nw-muted); }
.nw .nw-empty { padding: 32px 0; text-align: center; color: var(--nw-muted); }
.nw .nw-empty button { display: block; margin: 12px auto 0; }
.nw .nw-toolbar, .nw .nw-filter, .nw .nw-row { padding-inline: 16px; }
@container (min-width: 560px) {
  .nw .nw-ranking { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (max-width: 419.98px) {
  .nw .nw-status { flex-basis: 100%; margin-left: 0; }
  .nw .nw-theme { grid-template-columns: minmax(0, 1fr) 3ch; }
  .nw .nw-theme-track { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .nw .nw-segment, .nw .nw-theme-bar { transition: none; }
}
`;

export default function mount(ctx) {
  const document = ctx.container.ownerDocument;
  const make = (tag, className, text = "") => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  };
  const root = make("section", "nw");
  const style = document.createElement("style");
  style.textContent = css;
  root.append(style);
  const toolbar = make("div", "nw-toolbar");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "↻ 重新整理";
  refresh.disabled = true;
  const sources = document.createElement("select");
  sources.setAttribute("aria-label", "新聞來源");
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部來源";
  sources.append(all);
  const categories = document.createElement("select");
  categories.setAttribute("aria-label", "新聞類別");
  for (const [id, name] of [["", "全部類別"], ...categoryNames]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = name;
    categories.append(option);
  }
  const status = make("span", "nw-status");
  status.setAttribute("role", "status");
  status.textContent = "等待模組就緒";
  const list = make("ul", "nw-list");
  const empty = make("div", "nw-empty");
  const emptyText = make("span", "", "正在取得新聞");
  const clearAll = make("button", "", "清除篩選");
  clearAll.type = "button";
  clearAll.hidden = true;
  empty.append(emptyText, clearAll);
  list.setAttribute("aria-label", "新聞清單");
  const themeFilter = make("div", "nw-filter");
  themeFilter.hidden = true;
  const themeLabel = document.createElement("span");
  const clearTheme = document.createElement("button");
  clearTheme.type = "button";
  clearTheme.textContent = "清除";
  clearTheme.setAttribute("aria-label", "取消題材篩選");
  themeFilter.append(themeLabel, clearTheme);
  const panel = make("section", "nw-panel");
  panel.setAttribute("aria-label", "財經分析");
  panel.hidden = true;
  const sample = make("p", "nw-sample");
  const sampleCount = make("span", "nw-sample-count");
  const pendingCount = make("span", "nw-pending");
  const warning = make("span", "nw-warning", "樣本少，僅供參考");
  sample.append(sampleCount, pendingCount, warning);
  const market = make("div", "nw-market");
  const marketBar = make("div", "nw-bar nw-market-bar");
  marketBar.setAttribute("role", "img");
  const legend = make("div", "nw-legend");
  const marketParts = [ ["positive", "正面"], ["mixed", "正反"], ["idle", "無關"], ["negative", "負面"] ].map(([id, name]) => {
    const segment = make("span", `nw-segment nw-${id}`);
    segment.setAttribute("aria-hidden", "true");
    marketBar.append(segment);
    const entry = make("span", "nw-legend-item");
    const dot = make("span", `nw-dot nw-${id}`);
    dot.setAttribute("aria-hidden", "true");
    const value = make("span", "nw-value");
    entry.append(dot, value, make("span", "", name));
    legend.append(entry);
    return {segment, value, name};
  });
  market.append(make("h3", "nw-heading", "股市訊號"), marketBar, legend);
  const macro = make("p", "nw-macro");
  const rankingSection = make("div", "");
  const rankingHeading = make("div", "nw-ranking-heading");
  rankingHeading.append(make("span", "", "題材"), make("span", "nw-hint", "（點選篩選）"));
  const ranking = make("div", "nw-ranking");
  ranking.setAttribute("aria-label", "題材排行");
  rankingSection.append(rankingHeading, ranking);
  const note = make("small", "nw-note", "篇數是報導數，同一事件多家報導會重複計算。");
  panel.append(sample, market, macro, rankingSection, note);
  toolbar.append(refresh, sources, categories, status);
  root.append(toolbar, panel, themeFilter, list, empty);
  ctx.container.append(root);

  let up = false;
  let disposed = false;
  let items = [];
  let received = false;
  let selectedTheme = "";
  let analysisEnabled = true;
  const text = (value) => typeof value === "string" ? value : "";
  const localTime = (value) => {
    if (!text(value)) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  function onRefresh() {
    if (up && !disposed) ctx.channel.send({ op: "refresh" });
  }
  function drawPanel(scoped) {
    panel.hidden = !financial(categories.value);
    themeFilter.hidden = panel.hidden || !selectedTheme;
    themeLabel.textContent = selectedTheme ? `已篩選：${themeNames.get(selectedTheme)}` : "";
    if (panel.hidden) return;
    const counts = {positive: 0, negative: 0, mixed: 0, not_market: 0, other: 0};
    const themes = new Map([...themeNames.keys()].map(id => [id, {count: 0, bull: 0, bear: 0}]));
    let pending = 0;
    for (const item of scoped) {
      const analysis = validAnalysis(item);
      if (!analysis) {
        counts.other++;
        if (analysisEnabled) pending++;
        continue;
      }
      counts[analysis.market]++;
      const theme = themes.get(analysis.theme);
      theme.count++;
      const direction = arrow(analysis);
      if (direction === "▲") theme.bull++;
      if (direction === "▼") theme.bear++;
    }
    const sourceCount = new Set(scoped.map(item => text(item.source)).filter(Boolean)).size;
    sampleCount.textContent = `${scoped.length} 則，${sourceCount} 個來源`;
    pendingCount.textContent = `分析中 ${pending}`;
    warning.hidden = scoped.length >= 10;
    const values = [counts.positive, counts.mixed, counts.not_market + counts.other, counts.negative];
    marketBar.dataset.empty = String(scoped.length === 0);
    marketBar.setAttribute("aria-label", marketParts.map((part, i) => `${part.name} ${values[i]}`).join("、"));
    market.title = `無關 ${counts.not_market}、未明 ${counts.other}`;
    marketParts.forEach((part, i) => {
      part.segment.style.width = `${scoped.length ? values[i] / scoped.length * 100 : 0}%`;
      part.value.textContent = String(values[i]);
    });
    const total = themes.get("macro");
    macro.replaceChildren(make("span", "", `大盤／總經  ${total.count} 則`),
      make("span", "nw-up", `利多 ${total.bull}`), make("span", "nw-down", `利空 ${total.bear}`));
    // Stable sorting preserves the fixed table order for equal counts.
    const ranked = [...themes].filter(([id, count]) => id !== "macro" && id !== "other" && count.count)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    const existing = new Map([...ranking.querySelectorAll("button")].map(button => [button.dataset.theme, button]));
    const rankedIds = new Set(ranked.map(([id]) => id));
    for (const child of [...ranking.children]) {
      if (!rankedIds.has(child.dataset.theme)) child.remove();
    }
    if (!ranked.length) ranking.replaceChildren(make("span", "nw-hint", "題材：尚無"));
    for (const [id, count] of ranked) {
      let button = existing.get(id);
      if (!button) {
        button = make("button", "nw-theme");
        button.type = "button";
        button.dataset.theme = id;
        const track = make("span", "nw-theme-track");
        track.setAttribute("aria-hidden", "true");
        const bar = make("span", "nw-bar nw-theme-bar");
        for (const direction of ["bull", "bear", "idle"]) bar.append(make("span", `nw-segment nw-${direction}`));
        track.append(bar);
        button.append(make("span", "nw-theme-name", themeNames.get(id)), track, make("span", "nw-theme-count"));
      }
      button.setAttribute("aria-pressed", String(selectedTheme === id));
      const directions = [count.bull ? `▲${count.bull}` : "", count.bear ? `▼${count.bear}` : ""].filter(Boolean).join(" ");
      const description = `${themeNames.get(id)} ${count.count}` + (directions ? `（${directions}）` : "");
      button.setAttribute("aria-label", description);
      button.title = description;
      button.querySelector(".nw-theme-count").textContent = String(count.count);
      const bar = button.querySelector(".nw-theme-bar");
      bar.style.width = `${count.count / ranked[0][1].count * 100}%`;
      [count.bull, count.bear, count.count - count.bull - count.bear].forEach((value, i) => {
        bar.children[i].style.width = `${value / count.count * 100}%`;
      });
      ranking.append(button);
    }
  }

  function onTheme(event) {
    const button = event.target?.closest?.("button[data-theme]");
    if (!button || !ranking.contains(button) || !themeNames.has(button.dataset.theme)) return;
    selectedTheme = selectedTheme === button.dataset.theme ? "" : button.dataset.theme;
    drawItems();
  }
  function onClearTheme() {
    selectedTheme = "";
    drawItems();
  }
  function drawItems() {
    if (!financial(categories.value)) selectedTheme = "";
    const scoped = items.filter(item => item && typeof item === "object"
      && (!sources.value || text(item.source) === sources.value)
      && (!categories.value || text(item.category) === categories.value));
    drawPanel(scoped); // Theme filtering must not shrink the panel's scope.
    list.replaceChildren();
    for (const item of scoped) {
      const category = text(item.category);
      const analysis = validAnalysis(item);
      if (selectedTheme && analysis?.theme !== selectedTheme) continue;
      const row = make("li", "nw-row");
      const meta = make("div", "nw-meta");
      if (analysis && analysis.theme !== "other") {
        const direction = arrow(analysis);
        const name = analysis.theme === "macro" ? "大盤" : themeNames.get(analysis.theme);
        meta.append(make("span", `nw-tag${direction === "▲" ? " nw-up" : direction === "▼" ? " nw-down" : ""}`,
          name + (direction ? ` ${direction}` : "")));
      }
      meta.append(make("span", "nw-category", categoryNames.get(category) || "未分類"),
        make("span", "nw-source", text(item.source)), make("span", "nw-time", localTime(item.published)));
      let safeURL = null;
      try {
        const url = new URL(text(item.link));
        if (url.protocol === "http:" || url.protocol === "https:") safeURL = url.href;
      } catch { /* Invalid and relative links stay plain text. */ }
      const title = document.createElement(safeURL ? "a" : "span");
      title.className = "nw-title";
      title.textContent = text(item.title);
      title.title = text(item.summary);
      if (safeURL) {
        title.href = safeURL;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }
      row.append(title, meta);
      list.append(row);
    }
    empty.hidden = list.children.length > 0;
    emptyText.textContent = received ? "這個條件下沒有新聞" : "正在取得新聞";
    clearAll.hidden = !received;
  }
  function onClearAll() {
    sources.value = "";
    categories.value = "";
    selectedTheme = "";
    drawItems();
  }
  function renderList(body) {
    received = true;
    items = Array.isArray(body.items) ? body.items : [];
    const previous = sources.value;
    const records = Array.isArray(body.sources) ? body.sources : [];
    sources.replaceChildren(all);
    const names = new Set();
    for (const source of records) {
      const name = text(source?.name);
      if (!name || names.has(name)) continue;
      names.add(name);
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      sources.append(option);
    }
    sources.value = names.has(previous) ? previous : "";
    const failed = records.filter(source => source?.ok === false).length;
    const classify = body.classify && typeof body.classify === "object" ? body.classify : {};
    analysisEnabled = classify.enabled !== false;
    const pending = Number.isInteger(classify.pending) && classify.pending >= 0 ? classify.pending : 0;
    const classification = classify.enabled === false ? "分類：關閉" : pending > 0 ? `未分類：${pending}` : "";
    const updated = localTime(body.at);
    status.textContent = [updated ? `${updated} 更新` : "", failed > 0 ? `失敗來源：${failed}` : "", classification].filter(Boolean).join(" · ");
    drawItems();
  }
  clearAll.addEventListener("click", onClearAll);
  ranking.addEventListener("click", onTheme);
  clearTheme.addEventListener("click", onClearTheme);
  refresh.addEventListener("click", onRefresh);
  sources.addEventListener("change", drawItems);
  categories.addEventListener("change", drawItems);
  ctx.channel.onMessage((body) => {
    if (!disposed && body && body.op === "list") renderList(body);
  });
  ctx.onUp(() => {
    if (disposed) return;
    up = true;
    refresh.disabled = false;
    status.textContent = "等待新聞更新";
  });
  ctx.report("ready");
  return {
    unmount() {
      disposed = true;
      up = false;
      refresh.disabled = true;
      refresh.removeEventListener("click", onRefresh);
      sources.removeEventListener("change", drawItems);
      categories.removeEventListener("change", drawItems);
      clearAll.removeEventListener("click", onClearAll);
      ranking.removeEventListener("click", onTheme);
      clearTheme.removeEventListener("click", onClearTheme);
      selectedTheme = "";
      items = [];
      root.remove();
    },
  };
}
