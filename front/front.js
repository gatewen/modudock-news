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
const regionNames = new Map([
  ["us_china", "美中"], ["asia_pacific", "亞太"], ["middle_east", "中東"],
  ["europe_russia", "歐洲／俄烏"], ["americas", "美洲"], ["other", "其他"],
]);
const regionTopics = new Map([...regionNames].map(([id, name]) => [`region:${id}`, name]));
const topicNames = new Map([...themeNames, ...regionTopics]);
const trendIds = new Set(["escalation", "stalemate", "deescalation", "not_conflict", "other"]);
const marketIds = new Set(["positive", "negative", "mixed", "not_market", "other"]);
const directionIds = new Set(["bull", "bear", "mixed", "neutral"]);
const financial = category => category === "finance" || category === "tech";
function validAnalysis(item) {
  const value = item.analysis;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = Object.hasOwn(value, "kind") ? value.kind : "finance";
  if (kind === "world") {
    return item.category === "world" && typeof value.trend === "string" && trendIds.has(value.trend)
      && typeof value.region === "string" && regionNames.has(value.region) ? value : null;
  }
  if (kind !== "finance" || !financial(item.category)
      || typeof value.market !== "string" || !marketIds.has(value.market)
      || typeof value.theme !== "string" || !themeNames.has(value.theme)
      || typeof value.dir !== "string" || !directionIds.has(value.dir)
      || typeof value.dir_p !== "number" || !Number.isFinite(value.dir_p)
      || value.dir_p < 0 || value.dir_p > 1) return null;
  return value;
}
function topicOf(analysis) {
  return analysis?.kind === "world" ? `region:${analysis.region}` : analysis?.theme;
}
function arrow(analysis) {
  if (!analysis || analysis.dir_p < 0.6) return "";
  return analysis.dir === "bull" ? "▲" : analysis.dir === "bear" ? "▼" : "";
}

function eventId(item) {
  return typeof item.event === "string" && item.event.length === 12 && /^[0-9a-f]{12}$/i.test(item.event)
    && Number.isInteger(item.event_size) && item.event_size > 0 ? item.event.toLowerCase() : null;
}

let focusHeadingId = 0;
const css = `
.nw {
  --nw-bg: var(--md-bg, #ffffff);
  --nw-fg: var(--md-fg, #242424);
  --nw-muted: var(--md-fg-muted, #616161);
  --nw-line: var(--md-border, #c7c7c7);
  --nw-surface: var(--md-surface, #f3f3f3);
  --nw-accent: var(--md-accent, #005fb8);
  --nw-focus: var(--md-focus, #005fb8);
  --nw-danger: var(--md-danger, light-dark(#b42318, #ff8b82));
  --nw-up: light-dark(#c8102e, #ff6b6b);
  --nw-down: light-dark(#0f7b3f, #4fd18b);
  --nw-mixed: light-dark(#b7791f, #f0b429);
  --nw-idle: color-mix(in srgb, var(--nw-muted) 45%, transparent);
  container-type: inline-size;
  margin: 8px;
  background: var(--nw-bg);
  color: var(--nw-fg);
  font: 14px/1.5 "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
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
.nw .nw-focus-section { background: var(--nw-surface); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.nw .nw-focus-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.nw .nw-focus-list { display: grid; gap: 10px; }
.nw .nw-focus-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.nw .nw-focus-count { font-size: 12px; white-space: nowrap; }
.nw .nw-focus-short { display: none; }
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
.nw .nw-escalation { background: var(--nw-danger); }
.nw .nw-deescalation { background: var(--nw-accent); }
.nw .nw-danger-text { color: var(--nw-danger); }
.nw .nw-calm-text { color: var(--nw-accent); }
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
.nw .nw-expand { color: var(--nw-muted); background: transparent; padding: 0 5px; font-size: 12px; }
.nw .nw-reports { list-style: none; margin: 10px 0 0; padding: 0 0 0 16px; border-left: 1px solid var(--nw-line); }
.nw .nw-report { padding: 6px 0; font-size: 12px; color: var(--nw-muted); }
.nw .nw-report-title { color: var(--nw-muted); font-size: 12px; text-decoration: none; overflow-wrap: anywhere; }
.nw a.nw-report-title:hover { color: var(--nw-accent); text-decoration: underline; }
.nw .nw-report-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.nw .nw-empty { padding: 32px 0; text-align: center; color: var(--nw-muted); }
.nw .nw-empty button { display: block; margin: 12px auto 0; }
.nw .nw-toolbar, .nw .nw-filter, .nw .nw-row { padding-inline: 16px; }
@container (min-width: 560px) {
  .nw .nw-ranking { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (max-width: 419.98px) {
  .nw .nw-focus-long { display: none; }
  .nw .nw-focus-short { display: inline; }
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
  const focus = make("section", "nw-focus-section");
  focus.hidden = true;
  const focusHeading = make("h3", "nw-heading", "焦點");
  focusHeading.id = `nw-focus-heading-${++focusHeadingId}`;
  focus.setAttribute("aria-labelledby", focusHeading.id);
  const focusHeader = make("div", "nw-focus-heading");
  focusHeader.append(focusHeading, make("span", "nw-hint", "多家媒體同時報導"));
  const focusList = make("div", "nw-focus-list");
  focus.append(focusHeader, focusList);
  panel.setAttribute("aria-label", "財經分析");
  panel.hidden = true;
  const sample = make("p", "nw-sample");
  const sampleCount = make("span", "nw-sample-count");
  const pendingCount = make("span", "nw-pending");
  const warning = make("span", "nw-warning", "樣本少，僅供參考");
  const merging = make("span", "nw-merging");
  merging.hidden = true;
  sample.append(sampleCount, pendingCount, merging, warning);
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
    const label = make("span", "", name);
    entry.append(dot, value, label);
    legend.append(entry);
    return {segment, value, name, dot, label};
  });
  const signalHeading = make("h3", "nw-heading", "股市訊號");
  market.append(signalHeading, marketBar, legend);
  const macro = make("p", "nw-macro");
  const rankingSection = make("div", "");
  const rankingHeading = make("div", "nw-ranking-heading");
  const rankingTitle = make("span", "", "題材");
  rankingHeading.append(rankingTitle, make("span", "nw-hint", "（點選篩選）"));
  const ranking = make("div", "nw-ranking");
  ranking.setAttribute("aria-label", "題材排行");
  rankingSection.append(rankingHeading, ranking);
  const note = make("small", "nw-note", "同一事件多家報導只算一次。");
  panel.append(sample, market, macro, rankingSection, note);
  toolbar.append(refresh, sources, categories, status);
  root.append(toolbar, focus, panel, themeFilter, list, empty);
  ctx.container.append(root);

  let up = false;
  let disposed = false;
  let items = [];
  let received = false;
  let selectedTheme = "";
  let analysisEnabled = true;
  let eventsPending = 0;
  const expanded = new Set();
  let sourceOrder = new Map();
  const text = (value) => typeof value === "string" ? value : "";
  const localTime = (value) => {
    if (!text(value)) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  function newsTime(item) {
    const value = localTime(item.published);
    const date = new Date(text(item.published));
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    const dateOnly = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
    const calendar = `${date.getMonth() + 1}/${date.getDate()}`;
    const label = value && (dateOnly ? (sameDay ? "今天" : calendar) : `${sameDay ? "" : `${calendar} `}${value}`);
    const node = make("span", "nw-time", `${item.time_guessed === true ? "約" : ""}${label}`);
    if (item.time_guessed === true) node.title = "來源沒有提供發布時間，以收錄時間代替";
    return node;
  }
  function onRefresh() {
    if (up && !disposed) ctx.channel.send({ op: "refresh" });
  }
  function groupItems(scoped) {
    const groups = new Map();
    for (const item of scoped) {
      const id = eventId(item);
      const key = id || Symbol(); // Invalid metadata must never merge two reports.
      if (!groups.has(key)) groups.set(key, {id, reports: []});
      groups.get(key).reports.push(item);
    }
    const timestamp = item => {
      const value = Date.parse(text(item.published));
      return Number.isFinite(value) ? value : Infinity;
    };
    for (const group of groups.values()) {
      group.reports.sort((a, b) => (timestamp(a) - timestamp(b))
        || ((sourceOrder.get(text(a.source)) ?? Infinity) - (sourceOrder.get(text(b.source)) ?? Infinity)) || 0);
    }
    return [...groups.values()];
  }
  function newsTitle(item, className) {
    let safeURL = null;
    try {
      const url = new URL(text(item.link));
      if (url.protocol === "http:" || url.protocol === "https:") safeURL = url.href;
    } catch { /* Invalid and relative links stay plain text. */ }
    const title = make(safeURL ? "a" : "span", className, text(item.title));
    title.title = text(item.summary);
    if (safeURL) {
      title.href = safeURL;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
    }
    return title;
  }
  function onExpand(event) {
    const button = event.target?.closest?.("button[data-event]");
    if (!button || !list.contains(button)) return;
    const id = button.dataset.event;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    button.setAttribute("aria-expanded", String(expanded.has(id)));
    button.closest(".nw-row").querySelector(".nw-reports").hidden = !expanded.has(id);
  }
  function drawFocus(groups) {
    const ranked = groups.map(group => ({...group,
      count: new Set(group.reports.map(item => text(item.source)).filter(Boolean)).size,
      latest: Math.max(...group.reports.map(item => {
        const stamp = Date.parse(text(item.published));
        return Number.isFinite(stamp) ? stamp : -Infinity;
      })),
    })).filter(group => group.count >= 3)
      .sort((a, b) => b.count - a.count || b.latest - a.latest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 5);
    focus.hidden = ranked.length === 0;
    focusList.replaceChildren();
    for (const group of ranked) {
      const row = make("div", "nw-focus-row");
      const button = make("button", "nw-focus-count");
      button.type = "button";
      button.dataset.event = group.id;
      button.setAttribute("aria-label", `展開 ${group.count} 家媒體的報導`);
      button.append(make("span", "nw-focus-long", `${group.count} 家媒體`),
        make("span", "nw-focus-short", `${group.count} 家`));
      row.append(newsTitle(group.reports[0], "nw-title"), button);
      focusList.append(row);
    }
  }
  function onFocus(event) {
    const button = event.target?.closest?.("button[data-event]");
    if (!button || !focusList.contains(button)) return;
    const target = [...list.querySelectorAll(".nw-expand")].find(node => node.dataset.event === button.dataset.event);
    if (!target) return;
    if (!expanded.has(button.dataset.event)) target.click();
    target.closest(".nw-row").scrollIntoView({block: "nearest"});
    target.focus({preventScroll: true});
  }
  function drawPanel(scoped) {
    const world = categories.value === "world";
    panel.hidden = !world && !financial(categories.value);
    panel.setAttribute("aria-label", world ? "國際局勢分析" : "財經分析");
    clearTheme.setAttribute("aria-label", world ? "取消地區篩選" : "取消題材篩選");
    themeFilter.hidden = panel.hidden || !selectedTheme;
    themeLabel.textContent = selectedTheme ? `已篩選：${topicNames.get(selectedTheme)}` : "";
    if (panel.hidden) return;
    signalHeading.textContent = world ? "局勢走向" : "股市訊號";
    rankingTitle.textContent = world ? "地區" : "題材";
    ranking.setAttribute("aria-label", world ? "地區排行" : "題材排行");
    macro.hidden = world;
    const names = world ? regionTopics : themeNames;
    const parts = world ? [["escalation", "升級"], ["mixed", "僵持"], ["deescalation", "緩和"], ["idle", "無關"]]
      : [["positive", "正面"], ["mixed", "正反"], ["idle", "無關"], ["negative", "負面"]];
    marketParts.forEach((part, i) => {
      part.name = parts[i][1];
      part.label.textContent = part.name;
      part.segment.className = `nw-segment nw-${parts[i][0]}`;
      part.dot.className = `nw-dot nw-${parts[i][0]}`;
    });
    const counts = {escalation: 0, stalemate: 0, deescalation: 0, not_conflict: 0, positive: 0, negative: 0, mixed: 0, not_market: 0, other: 0};
    const themes = new Map([...names.keys()].map(id => [id, {count: 0, bull: 0, bear: 0}]));
    let pending = 0;
    const groups = groupItems(scoped);
    for (const group of groups) {
      const analysis = group.reports.map(validAnalysis).find(Boolean);
      if (!analysis) {
        counts.other++;
        if (analysisEnabled) pending++;
        continue;
      }
      counts[world ? analysis.trend : analysis.market]++;
      const theme = themes.get(topicOf(analysis));
      theme.count++;
      const direction = arrow(analysis);
      if (world ? analysis.trend === "escalation" : direction === "▲") theme.bull++;
      if (world ? analysis.trend === "deescalation" : direction === "▼") theme.bear++;
    }
    const sourceCount = new Set(scoped.map(item => text(item.source)).filter(Boolean)).size;
    sampleCount.textContent = `${groups.length} 個事件（${scoped.length} 則報導），${sourceCount} 個來源`;
    pendingCount.textContent = `待分析 ${pending}`;
    merging.hidden = eventsPending === 0;
    merging.textContent = eventsPending > 0 ? `・待合併 ${eventsPending}` : "";
    warning.hidden = groups.length >= 10;
    const values = world ? [counts.escalation, counts.stalemate, counts.deescalation, counts.not_conflict + counts.other]
      : [counts.positive, counts.mixed, counts.not_market + counts.other, counts.negative];
    marketBar.dataset.empty = String(groups.length === 0);
    marketBar.setAttribute("aria-label", marketParts.map((part, i) => `${part.name} ${values[i]}`).join("、"));
    market.title = `無關 ${world ? counts.not_conflict : counts.not_market}、未明 ${counts.other}`;
    marketParts.forEach((part, i) => {
      part.segment.style.width = `${groups.length ? values[i] / groups.length * 100 : 0}%`;
      part.value.textContent = String(values[i]);
    });
    const total = themes.get("macro") || {count: 0, bull: 0, bear: 0};
    macro.replaceChildren(make("span", "", `大盤／總經  ${total.count} 個事件`),
      make("span", "nw-up", `利多 ${total.bull}`), make("span", "nw-down", `利空 ${total.bear}`));
    // Stable sorting preserves the fixed table order for equal counts.
    const ranked = [...themes].filter(([id, count]) => id !== "macro" && id !== "other" && count.count)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    const existing = new Map([...ranking.querySelectorAll("button")].map(button => [button.dataset.topic, button]));
    const rankedIds = new Set(ranked.map(([id]) => id));
    for (const child of [...ranking.children]) {
      if (!rankedIds.has(child.dataset.topic)) child.remove();
    }
    if (!ranked.length) ranking.replaceChildren(make("span", "nw-hint", world ? "地區：尚無" : "題材：尚無"));
    for (const [id, count] of ranked) {
      let button = existing.get(id);
      if (!button) {
        button = make("button", "nw-theme");
        button.type = "button";
        button.dataset.topic = id;
        const track = make("span", "nw-theme-track");
        track.setAttribute("aria-hidden", "true");
        const bar = make("span", "nw-bar nw-theme-bar");
        for (const direction of (world ? ["escalation", "deescalation", "idle"] : ["bull", "bear", "idle"])) bar.append(make("span", `nw-segment nw-${direction}`));
        track.append(bar);
        button.append(make("span", "nw-theme-name", names.get(id)), track, make("span", "nw-theme-count"));
      }
      button.setAttribute("aria-pressed", String(selectedTheme === id));
      const directions = [count.bull ? `${world ? "升級 " : "▲"}${count.bull}` : "", count.bear ? `${world ? "緩和 " : "▼"}${count.bear}` : ""].filter(Boolean).join(" ");
      const description = `${names.get(id)} ${count.count}` + (directions ? `（${directions}）` : "");
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
    const button = event.target?.closest?.("button[data-topic]");
    if (!button || !ranking.contains(button) || !topicNames.has(button.dataset.topic)) return;
    selectedTheme = selectedTheme === button.dataset.topic ? "" : button.dataset.topic;
    drawItems();
  }
  function onClearTheme() {
    selectedTheme = "";
    drawItems();
  }
  function drawItems() {
    if ((!financial(categories.value) && categories.value !== "world")
        || (selectedTheme && selectedTheme.startsWith("region:") !== (categories.value === "world"))) selectedTheme = "";
    const scoped = items.filter(item => item && typeof item === "object"
      && (!sources.value || text(item.source) === sources.value)
      && (!categories.value || text(item.category) === categories.value));
    drawPanel(scoped); // Theme filtering must not shrink the panel's scope.
    list.replaceChildren();
    const filtered = scoped.filter(item => !selectedTheme || topicOf(validAnalysis(item)) === selectedTheme);
    const groups = groupItems(filtered);
    drawFocus(groups);
    for (const group of groups) {
      const item = group.reports[0];
      const category = text(item.category);
      const analysis = validAnalysis(item);
      const row = make("li", "nw-row");
      const meta = make("div", "nw-meta");
      if (analysis?.kind === "world") {
        const tag = make("span", "nw-tag", regionNames.get(analysis.region));
        if (analysis.trend === "escalation" || analysis.trend === "deescalation") {
          const escalating = analysis.trend === "escalation";
          tag.append(make("span", escalating ? "nw-danger-text" : "nw-calm-text", escalating ? " 升級" : " 緩和"));
        }
        meta.append(tag);
      } else if (analysis && analysis.theme !== "other") {
        const direction = arrow(analysis);
        const name = analysis.theme === "macro" ? "大盤" : themeNames.get(analysis.theme);
        meta.append(make("span", `nw-tag${direction === "▲" ? " nw-up" : direction === "▼" ? " nw-down" : ""}`,
          name + (direction ? ` ${direction}` : "")));
      }
      meta.append(make("span", "nw-category", categoryNames.get(category) || "未分類"),
        make("span", "nw-source", text(item.source)), newsTime(item));
      row.append(newsTitle(item, "nw-title"), meta);
      if (group.reports.length > 1) {
        const toggle = make("button", "nw-expand", `另 ${group.reports.length - 1} 則報導`);
        toggle.type = "button";
        toggle.dataset.event = group.id;
        toggle.setAttribute("aria-expanded", String(expanded.has(group.id)));
        meta.append(toggle);
        const reports = make("ul", "nw-reports");
        reports.setAttribute("aria-label", "同事件其他報導");
        reports.hidden = !expanded.has(group.id);
        for (const report of group.reports.slice(1)) {
          const entry = make("li", "nw-report");
          const details = make("div", "nw-report-meta");
          details.append(make("span", "nw-source", text(report.source)), newsTime(report));
          entry.append(newsTitle(report, "nw-report-title"), details);
          reports.append(entry);
        }
        row.append(reports);
      }
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
    const presentEvents = new Set(items.filter(item => item && typeof item === "object").map(eventId).filter(Boolean));
    for (const id of expanded) if (!presentEvents.has(id)) expanded.delete(id);
    const events = body.events && typeof body.events === "object" ? body.events : {};
    eventsPending = Number.isInteger(events.pending) && events.pending > 0 ? events.pending : 0;
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
    sourceOrder = new Map([...names].map((name, i) => [name, i]));
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
  list.addEventListener("click", onExpand);
  focusList.addEventListener("click", onFocus);
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
      list.removeEventListener("click", onExpand);
      focusList.removeEventListener("click", onFocus);
      expanded.clear();
      sourceOrder.clear();
      clearAll.removeEventListener("click", onClearAll);
      ranking.removeEventListener("click", onTheme);
      clearTheme.removeEventListener("click", onClearTheme);
      selectedTheme = "";
      items = [];
      root.remove();
    },
  };
}
