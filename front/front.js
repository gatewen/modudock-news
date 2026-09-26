// Native ES module; untrusted feed fields are only assigned as text.
import { css } from "./style.js";
import {
  categoryNames, themeNames, regionNames, regionTopics, issueNames, issueTopics, topicNames,
  financial, validAnalysis, topicOf, arrow, eventId, searchText,
} from "./labels.js";

const financeParts = [["positive", "偏多"], ["mixed", "多空互見"], ["idle", "與股市無關"], ["negative", "偏空"]];
let focusHeadingId = 0;
let descriptionId = 0;
let summaryId = 0;
let watchInputId = 0;
let shortcutId = 0;

export default function mount(ctx) {
  const document = ctx.container.ownerDocument;
  const view = document.defaultView;
  function loadState(name) {
    try { return JSON.parse(view.localStorage.getItem(`modudock.module.news.${name}`)); }
    catch { return null; }
  }
  function saveState(name, value) {
    try { view.localStorage.setItem(`modudock.module.news.${name}`, JSON.stringify(value)); }
    catch { /* Storage may be unavailable or full; reading news still works. */ }
  }
  function normalizeWatchWords(list) {
    const seen = new Set(), result = [];
    for (const value of Array.isArray(list) ? list : []) {
      if (typeof value !== "string") continue;
      const word = value.trim(), folded = word.toLowerCase();
      if (!word || Array.from(word).length > 20 || seen.has(folded)) continue;
      seen.add(folded);
      result.push(word);
      if (result.length === 10) break;
    }
    return result;
  }
  function watchWords() { return normalizeWatchWords(loadState("watch")); }
  function setWatchWords(list) {
    const normalized = normalizeWatchWords(list);
    saveState("watch", normalized);
    return normalized;
  }
  const storedView = loadState("view");
  const initialView = storedView && typeof storedView === "object" && !Array.isArray(storedView) ? {...storedView} : {};
  const storedLastSeen = loadState("lastSeen");
  const parsedLastSeen = typeof storedLastSeen === "string" ? Date.parse(storedLastSeen) : NaN;
  const lastSeen = Number.isFinite(parsedLastSeen) ? parsedLastSeen : null;
  let latestPublished = null;
  function persistLastSeen() {
    const stored = loadState("lastSeen");
    const current = typeof stored === "string" ? Date.parse(stored) : NaN;
    // A feed's future timestamp must not hide everything as "not new" later.
    const latest = Math.max(Number.isFinite(current) ? current : -Infinity,
      lastSeen ?? -Infinity, Math.min(latestPublished ?? -Infinity, Date.now()));
    if (Number.isFinite(latest)) saveState("lastSeen", new Date(latest).toISOString());
  }
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
  all.textContent = "全部來源 0";
  sources.append(all);
  const sourceDescription = make("span", "nw-sr");
  sourceDescription.id = `nw-source-description-${++descriptionId}`;
  sources.setAttribute("aria-describedby", sourceDescription.id);
  const categories = document.createElement("select");
  categories.setAttribute("aria-label", "新聞類別");
  for (const [id, name] of [["", "全部類別"], ...categoryNames]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${name} 0`;
    categories.append(option);
  }
  const searchToggle = make("button", "nw-search-toggle", "搜尋");
  searchToggle.type = "button";
  searchToggle.setAttribute("aria-expanded", "false");
  searchToggle.setAttribute("aria-pressed", "false");
  searchToggle.setAttribute("aria-keyshortcuts", "/");
  const searchBox = make("div", "nw-search-box");
  searchBox.id = `nw-search-${++descriptionId}`;
  searchBox.hidden = true;
  searchToggle.setAttribute("aria-controls", searchBox.id);
  const searchInput = make("input", "nw-search-input");
  searchInput.type = "text";
  searchInput.setAttribute("aria-label", "搜尋標題與摘要");
  searchInput.placeholder = "搜尋標題與摘要（Esc 清除）";
  const searchClear = make("button", "", "清除搜尋");
  searchClear.type = "button";
  searchBox.append(searchInput, searchClear);
  const searchHint = make("p", "nw-hint nw-search-hint");
  searchHint.setAttribute("role", "status");
  searchHint.setAttribute("aria-live", "polite");
  searchBox.append(searchHint);
  searchHint.hidden = true;
  const watchToggle = make("button", "", "追蹤關鍵字");
  watchToggle.type = "button";
  watchToggle.setAttribute("aria-expanded", "false");
  const watchSettings = make("div", "nw-watch-settings");
  watchSettings.hidden = true;
  const watchInput = make("input", "nw-watch-input");
  watchInput.type = "text";
  watchInput.id = `nw-watch-input-${++watchInputId}`;
  watchInput.placeholder = "以空白或逗號分隔，最多 10 個";
  const watchLabel = make("label", "", "追蹤關鍵字");
  watchLabel.htmlFor = watchInput.id;
  const watchSave = make("button", "", "儲存");
  watchSave.type = "button";
  const watchOnly = make("button", "nw-watch-only", "只看追蹤 0");
  watchOnly.type = "button";
  watchOnly.setAttribute("aria-pressed", "false");
  const watchDescription = make("span", "nw-sr", "只顯示標題或摘要含你的關鍵字的新聞（0 個事件）");
  watchOnly.title = watchDescription.textContent;
  watchDescription.id = `nw-watch-description-${++descriptionId}`;
  watchOnly.setAttribute("aria-describedby", watchDescription.id);
  let trackedWords = watchWords(), onlyWatched = false, onlyNew = false;
  watchInput.value = trackedWords.join(" ");
  watchOnly.disabled = trackedWords.length === 0;
  watchOnly.hidden = trackedWords.length === 0;
  const watchGuide = make("span", "nw-hint nw-watch-guide", "先輸入並儲存關鍵字，即可使用「只看追蹤」篩選標題或摘要。");
  watchGuide.hidden = trackedWords.length > 0;
  watchSettings.append(watchLabel, watchInput, watchSave, watchGuide);
  const status = make("span", "nw-status");
  status.setAttribute("role", "status");
  status.textContent = "等待模組就緒";
  const statusBefore = document.createTextNode("");
  const statusAfter = document.createTextNode("");
  const newOnly = make("button", "nw-new-only");
  newOnly.type = "button";
  newOnly.hidden = true;
  newOnly.disabled = true;
  newOnly.setAttribute("aria-pressed", "false");
  const newHint = make("div", "nw-hint nw-new-hint");
  newHint.hidden = true;
  const newHintText = make("span", "");
  const newClear = make("button", "", "關閉新進展篩選");
  newClear.type = "button";
  newHint.append(newHintText, newClear);
  const list = make("ul", "nw-list");
  list.tabIndex = -1;
  list.setAttribute("aria-keyshortcuts", "j k s e");
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
  clearTheme.textContent = "清除篩選";
  themeFilter.append(themeLabel, clearTheme);
  const topicSources = make("span", "nw-hint nw-topic-sources");
  topicSources.hidden = true;
  themeFilter.append(topicSources);
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
  const searchScope = make("p", "nw-hint nw-search-scope");
  searchScope.hidden = true;
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
  const marketParts = financeParts.map(([id, name]) => {
    const segment = make("span", `nw-segment nw-${id}`);
    segment.setAttribute("aria-hidden", "true");
    marketBar.append(segment);
    const entry = make("button", "nw-legend-item");
    entry.type = "button";
    const dot = make("span", `nw-dot nw-${id}`);
    dot.setAttribute("aria-hidden", "true");
    const value = make("span", "nw-value");
    const label = make("span", "", name);
    entry.append(dot, value, document.createTextNode(" "), label);
    legend.append(entry);
    return {segment, value, name, dot, label, entry};
  });
  const signalHeading = make("h3", "nw-heading", "股市訊號");
  const signalNote = make("small", "nw-hint", "依新聞內容判斷對股市的影響，非行情");
  const signalHeader = make("div", "nw-signal-heading");
  signalHeader.append(signalHeading, signalNote);
  market.append(signalHeader, marketBar, legend);
  const history = make("section", "nw-history");
  let historyOpen = loadState("history") === true;
  const historyToggle = make("button", "nw-heading nw-history-toggle", "近 24 小時變化");
  historyToggle.type = "button";
  const historyContent = make("div", "nw-history-content");
  historyContent.id = `nw-history-${focusHeadingId}`;
  historyToggle.setAttribute("aria-controls", historyContent.id);
  history.append(historyToggle, historyContent);
  const macro = make("p", "nw-macro");
  const rankingSection = make("div", "");
  const rankingHeading = make("div", "nw-ranking-heading");
  const rankingTitle = make("span", "", "題材");
  const rankingLegend = make("span", "nw-hint nw-ranking-legend");
  rankingHeading.append(rankingTitle, rankingLegend);
  const ranking = make("div", "nw-ranking");
  ranking.setAttribute("aria-label", "題材排行");
  rankingSection.append(rankingHeading, ranking);
  const note = make("small", "nw-note", "同一事件多家報導只算一次。");
  panel.append(searchScope, sample, market, history, macro, rankingSection, note);
  toolbar.append(refresh, sources, sourceDescription, categories, watchToggle, watchOnly, watchDescription, searchToggle, status, searchBox, watchSettings);
  const overview = make("div", "nw-hint nw-overview");
  overview.hidden = true;
  overview.append(make("span", "nw-overview-heading", "新聞風向（非行情）"));
  const overviewButtons = ["finance", "world"].map(category => {
    const button = make("button", "nw-overview-button");
    button.type = "button";
    button.dataset.overview = category;
    const segment = make("span", "nw-overview-segment");
    const separator = make("span", "nw-overview-separator", "｜");
    separator.setAttribute("aria-hidden", "true");
    segment.append(separator, button);
    overview.append(segment);
    return button;
  });
  toolbar.append(overview);
  const shortcutToggle = make("button", "nw-shortcut-toggle");
  shortcutToggle.type = "button";
  shortcutToggle.append(make("span", "nw-shortcut-name", "快捷鍵"));
  const shortcutIcon = make("span", "nw-shortcut-icon", "?");
  shortcutIcon.setAttribute("aria-hidden", "true");
  shortcutToggle.append(shortcutIcon);
  shortcutToggle.setAttribute("aria-expanded", "false");
  const shortcutHelp = make("section", "nw-shortcut-help");
  shortcutHelp.id = `nw-shortcuts-${++shortcutId}`;
  shortcutHelp.hidden = true;
  shortcutHelp.tabIndex = -1;
  shortcutHelp.setAttribute("role", "region");
  shortcutHelp.setAttribute("aria-label", "鍵盤快捷鍵");
  shortcutToggle.setAttribute("aria-controls", shortcutHelp.id);
  shortcutHelp.append(make("h3", "nw-heading", "鍵盤快捷鍵"),
    make("p", "nw-hint", "焦點在新聞模組內且不在輸入框時使用；不會鎖住焦點。"));
  const shortcutList = make("dl", "nw-shortcut-list");
  for (const [key, description] of [["j／k", "下一則／上一則新聞"], ["s", "開關目前新聞的摘要"],
    ["e", "展開／收合同事件其他報導"], ["/", "開啟並聚焦搜尋"],
    ["Esc", "依序：收起基調核對區、清除搜尋、收起本說明（每次一項）"], ["?（Shift+/）", "開關本說明"]]) {
    shortcutList.append(make("dt", "", key), make("dd", "", description));
  }
  shortcutHelp.append(shortcutList);
  const statusGroup = make("div", "nw-status-group");
  toolbar.insertBefore(statusGroup, status);
  statusGroup.append(status, shortcutToggle);
  const watchHint = make("p", "nw-hint nw-watch-hint");
  watchHint.hidden = true;
  root.append(toolbar, focus, panel, themeFilter, watchHint, newHint, shortcutHelp, list, empty);
  ctx.container.append(root);

  let up = false;
  let disposed = false;
  let shortcutOrigin = null;
  let refreshTimer = null;
  let latestAt = "", refreshAt = "", refreshNotice = "";
  let items = [];
  let searchIndex = new WeakMap();
  let searchRows = new Map();
  const dateOnlySources = new Set();
  let received = false;
  let modelState = "", modelReason = "";
  let selectedTheme = "";
  let selectedCount = null;
  let selectedTopic = "";
  let savedView = null;
  let topics = [];
  let toneAudit = null;
  let analysisEnabled = true;
  let eventsPending = 0;
  let historyAt = Date.now();
  let updatedText = "", failedText = "", classificationText = "";
  const expanded = new Set();
  const summaries = new Set();
  let sourceOrder = new Map();
  let sourceOutlets = new Map();
  const outletOf = item => sourceOutlets.get(text(item?.source)) || text(item?.source);
  const text = (value) => typeof value === "string" ? value : "";
  const localTime = (value) => {
    if (!text(value)) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const isMidnight = date => date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  const isDateOnly = (item, date) => dateOnlySources.has(text(item.source)) && isMidnight(date);
  function confirmedAt(source) {
    if (typeof source?.last_success !== "string") return null;
    const date = new Date(source.last_success);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function sourceDetail(source) {
    const date = confirmedAt(source);
    const pad = n => String(n).padStart(2, "0");
    const stamp = date ? `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${localTime(source.last_success)}:${pad(date.getSeconds())}（本地時間）` : "";
    const state = source?.ok === false ? (date ? "沿用舊資料；" : "失敗") : "";
    const error = source?.ok === false && typeof source.error === "string" ? `；${Array.from(source.error).slice(0,80).join("")}` : "";
    return `${text(source?.name) || "未命名來源"}：${state}${date ? `最後成功確認：${stamp}` : ""}${error}`;
  }
  function newsTime(item) {
    const value = localTime(item.published);
    const date = new Date(text(item.published));
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    const dateOnly = isDateOnly(item, date);
    const calendar = `${date.getMonth() + 1}/${date.getDate()}`;
    const label = value && (dateOnly ? (sameDay ? "今天" : calendar) : `${sameDay ? "" : `${calendar} `}${value}`);
    const node = make("span", "nw-time", `${item.time_guessed === true ? "約" : ""}${label}`);
    if (item.time_guessed === true) node.title = "來源沒有提供發布時間，以收錄時間代替";
    return node;
  }
  function onRefresh() {
    if (!up || disposed || refreshTimer !== null) return;
    refreshAt = latestAt;
    refresh.setAttribute("aria-disabled", "true");
    refresh.textContent = "↻ 更新中…";
    list.setAttribute("aria-busy", "true");
    refreshTimer = view.setTimeout(() => {
      finishRefresh();
      refreshNotice = "更新未完成，稍後自動重試";
      if (received) drawItems();
      else status.textContent = refreshNotice;
    }, 30000);
    ctx.channel.send({ op: "refresh" });
  }
  function finishRefresh() {
    if (refreshTimer !== null) view.clearTimeout(refreshTimer);
    refreshTimer = null;
    refresh.removeAttribute("aria-disabled");
    refresh.disabled = !up || disposed;
    refresh.textContent = "↻ 重新整理";
    list.removeAttribute("aria-busy");
  }
  function groupTime(reports) {
    const valid = reports.filter(item => Number.isFinite(Date.parse(text(item.published))));
    const first = valid[0], last = valid.at(-1);
    if (valid.length < 2 || Date.parse(first.published) === Date.parse(last.published)) return newsTime(reports[0]);
    const node = newsTime(first), end = newsTime(last);
    const startDate = new Date(first.published), endDate = new Date(last.published);
    const sameDay = startDate.getFullYear() === endDate.getFullYear()
      && startDate.getMonth() === endDate.getMonth() && startDate.getDate() === endDate.getDate();
    const dateOnly = isDateOnly(last, endDate);
    const endLabel = sameDay && !dateOnly
      ? `${last.time_guessed === true ? "約" : ""}${localTime(last.published)}` : end.textContent;
    node.textContent += `–${endLabel}`;
    if (end.title) node.title = end.title;
    return node;
  }
  function appendTone(meta, item) {
    const names = new Map([["positive", "正面"], ["negative", "負面"], ["mixed", "正反"], ["neutral", "中性"]]);
    if (selectedTopic && typeof item.tone === "string" && names.has(item.tone))
      meta.append(make("span", `nw-tone-tag nw-tone-tag-${item.tone}`, names.get(item.tone)));
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
  function isNew(item) {
    return lastSeen !== null && Date.parse(text(item.published)) > lastSeen;
  }
  function newsTitle(item, className, marked = isNew(item)) {
    let safeURL = null;
    try {
      const url = new URL(text(item.link));
      if (url.protocol === "http:" || url.protocol === "https:") safeURL = url.href;
    } catch { /* Invalid and relative links stay plain text. */ }
    const title = make(safeURL ? "a" : "span", className, text(item.title));
    if (marked) title.prepend(make("span", "nw-new", "新"));
    title.title = text(item.summary);
    if (safeURL) {
      title.href = safeURL;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
    }
    return title;
  }
  function summaryKey(group) {
    if (group.id) return `event:${group.id}`;
    const item = group.reports[0], link = text(item.link);
    return link ? `report:${JSON.stringify([link, text(item.source), text(item.title)])}` : "";
  }
  function onSummary(event) {
    const button = event.target?.closest?.("button.nw-summary-toggle");
    if (!button || (!list.contains(button) && !focusList.contains(button))) return;
    const key = button.dataset.summary;
    const open = button.getAttribute("aria-expanded") !== "true";
    if (key) {
      if (open) summaries.add(key);
      else summaries.delete(key);
    }
    button.setAttribute("aria-expanded", String(open));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !open;
  }
  function onExpand(event) {
    const button = event.target?.closest?.("button[data-event]");
    if (!button || !list.contains(button)) return;
    const id = button.dataset.event;
    if (button.getAttribute("aria-expanded") === "true") expanded.delete(id);
    else expanded.add(id);
    button.setAttribute("aria-expanded", String(expanded.has(id)));
    const reports = button.closest(".nw-row").querySelector(".nw-reports");
    if (!expanded.has(id) && reports.contains(document.activeElement)) button.focus({preventScroll: true});
    reports.hidden = !expanded.has(id);
  }
  const toneLabels = [["negative", "負面"], ["neutral", "中性"], ["mixed", "正反"], ["positive", "正面"]];
  const auditKey = item => `tone:${JSON.stringify([text(item.source), text(item.link), text(item.title)])}`;
  function summaryParts(item, key) {
    const paragraph = make("p", "nw-summary", item.summary);
    paragraph.id = `nw-summary-${++summaryId}`;
    paragraph.hidden = !summaries.has(key);
    paragraph.prepend(make("small", "nw-summary-label", "來源摘要"));
    const button = make("button", "nw-summary-toggle", "摘要");
    button.type = "button";
    button.dataset.summary = key;
    button.setAttribute("aria-expanded", String(summaries.has(key)));
    button.setAttribute("aria-controls", paragraph.id);
    return {button, paragraph};
  }
  function toneSummary(topic) {
    const tone = topic.tone;
    if (!tone || typeof tone !== "object" || Array.isArray(tone)
        || toneLabels.some(([id]) => !Number.isSafeInteger(tone[id]) || tone[id] < 0)) return null;
    const declared = toneLabels.reduce((sum, [id]) => sum + tone[id], 0);
    if (!Number.isSafeInteger(declared) || declared > topic.count) return null;
    // Count the reports we can actually show, never unverifiable aggregate numbers.
    const members = items.filter(item => item?.topic === topic.id);
    const counts = new Map(toneLabels.map(([id]) => [id, members.filter(item => item.tone === id).length]));
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const pending = members.length - total;
    if (total < 5 && !pending) return null;
    const summary = make("div", total < 5 ? "nw-tone-wait" : "nw-tone");
    if (total >= 5) {
      const bar = make("div", "nw-bar nw-tone-bar");
      bar.setAttribute("aria-hidden", "true");
      for (const id of ["positive", "mixed", "neutral", "negative"].filter(id => counts.get(id) > 0)) {
        const segment = make("span", `nw-segment nw-tone-${id}`);
        segment.style.width = `${counts.get(id) / total * 100}%`;
        bar.append(segment);
      }
      const labels = make("div", "nw-hint nw-tone-labels", "報導基調：");
      for (const [id, name] of toneLabels.filter(([id]) => counts.get(id) > 0).sort((a, b) => counts.get(b[0]) - counts.get(a[0]))) {
        const button = make("button", `nw-tone-button nw-tone-text-${id}`);
        button.append(document.createTextNode(`${name} `), make("strong", "", String(counts.get(id))), document.createTextNode(" 則報導"));
        button.type = "button";
        button.dataset.toneKey = `${topic.id}:${id}`;
        button.setAttribute("aria-expanded", String(toneAudit === button.dataset.toneKey));
        button.setAttribute("aria-pressed", String(toneAudit === button.dataset.toneKey));
        labels.append(button);
      }
      summary.append(bar, labels);
    }
    if (pending) summary.append(make("span", "nw-hint nw-tone-pending", `待判定 ${pending} 則`));
    return summary;
  }
  function drawToneAudit(row, topic) {
    const button = [...row.querySelectorAll(".nw-tone-button")].find(node => node.dataset.toneKey === toneAudit);
    if (!button) return;
    const tone = toneAudit.split(":")[1];
    const area = make("section", "nw-tone-audit");
    area.id = `nw-tone-audit-${++descriptionId}`;
    button.setAttribute("aria-controls", area.id);
    const heading = make("h4", "nw-heading", "依標題與摘要判斷的報導基調・按報導計");
    heading.id = `${area.id}-heading`;
    area.setAttribute("aria-labelledby", heading.id);
    area.append(heading, make("p", "nw-hint", button.textContent));
    const reports = make("ul", "nw-tone-reports");
    for (const item of items.filter(item => item?.topic === topic.id && item.tone === tone)) {
      const entry = make("li", "nw-tone-report");
      const title = newsTitle(item, "nw-audit-title", false);
      title.dataset.reportKey = auditKey(item);
      const meta = make("div", "nw-report-meta");
      meta.append(make("span", "nw-source", text(item.source)), newsTime(item));
      entry.append(title, meta);
      if (text(item.summary)) {
        const {button, paragraph} = summaryParts(item, auditKey(item));
        meta.append(button); entry.append(paragraph);
      }
      reports.append(entry);
    }
    area.append(reports); row.append(area);
  }
  function onTone(event) {
    const button = event.target?.closest?.(".nw-tone-button");
    if (disposed || !button || !focusList.contains(button)) return;
    const key = button.dataset.toneKey;
    toneAudit = toneAudit === key ? null : key;
    drawItems();
    [...focusList.querySelectorAll(".nw-tone-button")].find(node => node.dataset.toneKey === key)?.focus({preventScroll: true});
  }
  function closeToneAudit() {
    const key = toneAudit;
    toneAudit = null;
    drawItems();
    [...focusList.querySelectorAll(".nw-tone-button")].find(node => node.dataset.toneKey === key)?.focus({preventScroll: true});
  }
  function describe(button, value, parent) {
    const previousId = button.getAttribute("aria-describedby");
    const previous = previousId ? document.getElementById(previousId) : null;
    if (previous && root.contains(previous)) previous.remove();
    button.removeAttribute("aria-describedby");
    if (!value) return;
    const description = make("span", "nw-sr", value);
    description.id = `nw-description-${++descriptionId}`;
    parent.append(description);
    button.setAttribute("aria-describedby", description.id);
  }
  function drawFocus(groups) {
    focus.classList.remove("nw-focus-empty");
    focusHeader.hidden = false;
    if (onlyWatched) { focus.hidden = true; return; }
    if (topics.length) {
      focusList.replaceChildren();
      for (const topic of topics) {
        const members = items.filter(item => item && item.topic === topic.id);
        if (!selectedTopic && (sources.value || categories.value) && !members.some(item =>
          (!sources.value || text(item.source) === sources.value)
          && (!categories.value || text(item.category) === categories.value))) continue;
        const representative = members.find(item => item.title === topic.title);
        const row = make("div", "nw-focus-row");
        row.dataset.topicId = topic.id;
        const button = make("button", "nw-focus-count");
        button.type = "button";
        button.dataset.topicId = topic.id;
        button.setAttribute("aria-pressed", String(selectedTopic === topic.id));
        describe(button, `進入話題：${topic.title}，${topic.count} 則報導`, row);
        button.append(make("span", "nw-focus-long", `看話題・${topic.sources} 家`),
          make("span", "nw-focus-short", `${topic.sources} 家`));
        const copy = make("div", "nw-focus-copy");
        copy.append(newsTitle(representative || {title: topic.title}, "nw-title", members.some(isNew)));
        let latest = null, latestTime = -Infinity;
        for (const member of members) {
          const stamp = Date.parse(text(member.published));
          if (Number.isFinite(stamp) && stamp > latestTime) {
            latest = member;
            latestTime = stamp;
          }
        }
        // Another outlet's copy of the seed event is not a new development.
        const sameEvent = latest && representative && eventId(latest) && eventId(latest) === eventId(representative);
        if (latest && text(latest.title) && latest.title !== topic.title && !sameEvent) {
          const update = make("div", "nw-hint nw-topic-latest", `最新：${latest.title}`);
          update.title = latest.title;
          if (isNew(latest)) update.prepend(make("span", "nw-new", "新"));
          copy.append(update);
        }
        const tone = toneSummary(topic);
        if (tone) copy.append(tone);
        const newEvents = groupItems(members).filter(group => group.reports.some(isNew)).length;
        if (lastSeen !== null && newEvents) copy.append(make("div", "nw-topic-new", `上次之後新增 ${newEvents} 個事件`));
        row.append(copy, button);
        drawToneAudit(row, topic);
        focusList.append(row);
      }
      focus.hidden = focusList.childElementCount === 0;
      return;
    }
    if (modelState === "working") {
      focus.hidden = false;
      focusList.replaceChildren(make("p", "nw-hint", "正在整理多家媒體同報的話題"));
      return;
    }
    const ranked = groups.map(group => ({...group,
      count: new Set(group.reports.map(outletOf).filter(Boolean)).size,
      latest: Math.max(...group.reports.map(item => {
        const stamp = Date.parse(text(item.published));
        return Number.isFinite(stamp) ? stamp : -Infinity;
      })),
    })).filter(group => group.count >= 3)
      .sort((a, b) => b.count - a.count || b.latest - a.latest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 5);
    focus.hidden = false;
    focusList.replaceChildren();
    if (!ranked.length) {
      const hasEvent = groupItems(items.filter(item => item && typeof item === "object"))
        .some(group => new Set(group.reports.map(outletOf).filter(Boolean)).size >= 3);
      const filtered = onlyNew || sources.value || categories.value || selectedTheme || selectedCount || selectedTopic
        || searchText(searchInput.value).trim();
      focus.hidden = Boolean(hasEvent || filtered);
      if (!focus.hidden) {
        focus.classList.add("nw-focus-empty");
        focusHeader.hidden = true;
        const hint = make("p", "nw-hint", "目前沒有多家媒體同時報導的新聞");
        hint.title = "焦點事件門檻：至少 3 家不同媒體同時報導";
        focusList.append(hint);
      }
    }
    for (const group of ranked) {
      const row = make("div", "nw-focus-row");
      row.dataset.event = group.id;
      const button = make("button", "nw-focus-count");
      button.type = "button";
      button.dataset.event = group.id;
      describe(button, "展開同事件的其他報導", row);
      button.append(make("span", "nw-focus-long", `看同事件・${group.count} 家`),
        make("span", "nw-focus-short", `${group.count} 家`));
      row.append(newsTitle(group.reports[0], "nw-title", group.reports.some(isNew)), button);
      focusList.append(row);
    }
  }
  function onFocus(event) {
    const button = event.target?.closest?.("button[data-event], button[data-topic-id]");
    if (!button || !focusList.contains(button)) return;
    if (button.dataset.topicId) {
      if (selectedTopic === button.dataset.topicId) { returnToView(); return; }
      if (!selectedTopic && !selectedCount?.topic) {
        let scroller = root.parentElement;
        while (scroller) {
          const style = view.getComputedStyle(scroller);
          if (/(auto|scroll|overlay)/.test(style.overflowY || style.overflow) && scroller.scrollHeight > scroller.clientHeight) break;
          scroller = scroller.parentElement;
        }
        scroller ||= document.scrollingElement;
        savedView = {source:sources.value, category:categories.value, theme:selectedTheme, count:selectedCount, watched:onlyWatched, newOnly:onlyNew,
          scroller, scrollTop:scroller?.scrollTop || 0, focus:focusIdentity(document.activeElement)};
      }
      sources.value = "";
      categories.value = "";
      selectedTheme = "";
      selectedCount = null;
      onlyWatched = false;
      selectedTopic = button.dataset.topicId;
      drawItems();
      return;
    }
    const target = [...list.querySelectorAll(".nw-expand")].find(node => node.dataset.event === button.dataset.event);
    if (!target) return;
    if (!expanded.has(button.dataset.event)) target.click();
    target.closest(".nw-row").scrollIntoView({block: "nearest"});
    target.focus({preventScroll: true});
  }
  function onHistory() {
    historyOpen = !historyOpen;
    saveState("history", historyOpen);
    drawItems();
  }
  function drawHistory(groups, world, parts) {
    historyToggle.setAttribute("aria-expanded", String(historyOpen));
    historyContent.hidden = !historyOpen;
    historyContent.replaceChildren();
    if (!historyOpen) return;
    const step = 6 * 60 * 60 * 1000, start = historyAt - 4 * step;
    const buckets = Array.from({length: 4}, () => ({values: [0, 0, 0, 0], valid: 0}));
    for (const group of groups) {
      const stamp = Date.parse(text(group.reports[0].published));
      if (!Number.isFinite(stamp) || stamp < start || stamp > historyAt) continue;
      const bucket = buckets[Math.min(3, Math.floor((stamp - start) / step))];
      const analysis = group.reports.map(validAnalysis).find(Boolean);
      if (!analysis) continue;
      bucket.valid++;
      const signal = world ? analysis?.trend : analysis?.market;
      const index = world ? {escalation: 0, stalemate: 1, deescalation: 2}[signal]
        : {positive: 0, mixed: 1, negative: 3}[signal];
      bucket.values[index ?? (world ? 3 : 2)]++;
    }
    const collapsed = buckets.filter(bucket => bucket.valid < 5).length >= 3;
    historyContent.replaceChildren(make("span", "nw-hint", collapsed ? "樣本不足，無法比較 24 小時內的變化"
        : "每 6 小時一段，同一事件只算一次"));
    if (collapsed) return;
    buckets.forEach((bucket, i) => {
      const from = localTime(new Date(start + i * step).toISOString());
      const to = localTime(new Date(start + (i + 1) * step).toISOString());
      const label = `${from}–${i === 3 ? "現在" : to}`;
      const short = `${from.slice(0, 2)}–${i === 3 ? "現在" : to.slice(0, 2)}`;
      const values = bucket.values, total = values.reduce((sum, n) => sum + n, 0);
      const denominator = total - values[world ? 3 : 2];
      const insufficient = bucket.valid < 5;
      // A percentage over a tiny denominator overstates certainty; show the count instead.
      const name = world ? "升級" : "偏多";
      const result = insufficient ? "樣本不足" : !denominator ? "—"
        : denominator < 5 ? `${name} ${values[0]}/${denominator}`
        : `${name} ${Math.round(values[0] / denominator * 100)}%`;
      const row = make("div", "nw-history-row");
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", `${from}–${to}，${result}，樣本 ${bucket.valid} 個事件`);
      const time = make("span", "");
      time.setAttribute("aria-hidden", "true");
      time.append(make("span", "nw-history-long", label), make("span", "nw-history-short", short));
      const bar = make("div", "nw-bar nw-history-bar");
      bar.setAttribute("aria-hidden", "true");
      bar.dataset.empty = String(insufficient);
      if (!insufficient) parts.forEach(([id], j) => {
        const segment = make("span", `nw-segment nw-${id}`);
        segment.style.width = `${values[j] / total * 100}%`;
        bar.append(segment);
      });
      row.append(time, bar, make("span", "nw-history-value", result));
      historyContent.append(row);
    });
  }
  function contributes(group, id, category = categories.value) {
    const analysis = group.reports.map(validAnalysis).find(Boolean);
    if (!analysis) return false;
    if (id.startsWith("signal:")) {
      const signal = category === "world" ? analysis?.trend : analysis?.market;
      const index = category === "world"
        ? {escalation: 0, stalemate: 1, deescalation: 2}[signal]
        : {positive: 0, mixed: 1, negative: 3}[signal];
      return Number(id.slice(7)) === (index ?? (category === "world" ? 3 : 2));
    }
    return analysis?.theme === "macro" && (id === "macro:all"
      || arrow(analysis) === (id === "macro:bull" ? "▲" : "▼"));
  }
  function drawOverview() {
    overview.hidden = !received || Boolean(categories.value || selectedTopic || selectedCount?.topic
      || searchText(searchInput.value).trim() || onlyWatched) || !analysisEnabled;
    if (overview.hidden) return;
    for (const button of overviewButtons) {
      const category = button.dataset.overview, world = category === "world";
      let groups = groupItems(items.filter(item => item && text(item.category) === category
        && (!sources.value || text(item.source) === sources.value)));
      if (onlyNew) groups = groups.filter(group => group.reports.some(isNew));
      const analyzed = groups.filter(group => group.reports.some(item => validAnalysis(item))).length;
      const up = groups.filter(group => contributes(group, "signal:0", category)).length;
      const down = groups.filter(group => contributes(group, world ? "signal:2" : "signal:3", category)).length;
      const name = `${world ? "國際" : "財經"}${onlyNew ? "新進展" : ""}`;
      const coverage = analyzed < groups.length ? `（已分析 ${analyzed}／${groups.length}）` : "";
      button.textContent = `${name} ${world ? "升級" : "偏多"} ${up} 件・${world ? "緩和" : "偏空"} ${down} 件${coverage}${analyzed < 10 ? "（樣本少）" : ""}`;
      button.title = `已分析 ${analyzed}／${groups.length} 個事件；依標題與摘要判斷${world ? "局勢走向" : "對股市影響，非行情"}。點選查看${world ? "國際" : "財經"}面板`;
    }
  }
  function onOverview(event) {
    const button = event.target?.closest?.("button[data-overview]");
    if (disposed || overview.hidden || !button || !overview.contains(button)) return;
    categories.value = button.dataset.overview;
    onSourceOrCategory({currentTarget: categories});
    categories.focus({preventScroll: true});
  }
  function countLabel(id) {
    if (id.startsWith("signal:")) return (categories.value === "world"
      ? ["升級", "僵持", "緩和", "無關"] : financeParts.map(([, name]) => name))[Number(id.slice(7))];
    return {"macro:all": "大盤／總經", "macro:bull": "大盤／總經 利多", "macro:bear": "大盤／總經 利空"}[id];
  }
  function onCount(event) {
    const button = event.target?.closest?.("button[data-count]");
    if (!button || !panel.contains(button)) return;
    if (selectedCount?.id === button.dataset.count) { onClearTheme(); return; }
    selectedCount = {id: button.dataset.count, category: categories.value,
      topic: selectedTopic || selectedCount?.topic || ""};
    selectedTopic = "";
    selectedTheme = "";
    onlyWatched = false;
    drawItems();
  }
  function drawPanel(scoped) {
    const world = categories.value === "world";
    const politics = categories.value === "politics";
    panel.hidden = !world && !politics && !financial(categories.value);
    panel.setAttribute("aria-label", politics ? "政治議題分析" : world ? "國際局勢分析" : "財經分析");
    themeFilter.hidden = panel.hidden || (!selectedTheme && !selectedCount);
    const selectedLabel = selectedTheme === "region:other" ? "其他地區"
      : selectedTheme === "issue:other" ? "其他議題" : topicNames.get(selectedTheme);
    themeLabel.textContent = selectedTheme ? `已篩選：${selectedLabel}` : "";
    clearTheme.textContent = "清除篩選";
    describe(clearTheme, "", themeFilter);
    topicSources.hidden = !selectedTopic;
    topicSources.textContent = "";
    if (selectedTopic) {
      const counts = new Map(), outletOrder = new Map();
      for (const [source, index] of sourceOrder) {
        const outlet = sourceOutlets.get(source) || source;
        if (!outletOrder.has(outlet)) outletOrder.set(outlet, index);
      }
      for (const item of items) {
        const name = outletOf(item);
        if (item?.topic === selectedTopic && name) counts.set(name, (counts.get(name) || 0) + 1);
      }
      const ranked = [...counts].sort((a, b) => b[1] - a[1]
        || (outletOrder.get(a[0]) ?? Infinity) - (outletOrder.get(b[0]) ?? Infinity));
      topicSources.textContent = ranked.slice(0, 5).map(([name, count]) => `${name} ${count}`).join("・")
        + (ranked.length > 5 ? ` 等 ${ranked.length - 5} 家` : "");
      const title = Array.from(topics.find(topic => topic.id === selectedTopic).title);
      themeFilter.hidden = false;
      themeLabel.textContent = `話題：${title.slice(0, 24).join("")}${title.length > 24 ? "…" : ""}`;
      clearTheme.textContent = "返回原檢視";
      describe(clearTheme, "回到進入話題前的篩選與位置", themeFilter);
    }
    if (selectedCount) {
      themeLabel.textContent = `已篩選：${selectedCount.topic ? "話題內・" : ""}${countLabel(selectedCount.id)}`;
      clearTheme.textContent = "清除篩選";
      topicSources.hidden = true;
      if (selectedCount.topic) describe(clearTheme, "清除數字篩選並返回原檢視", themeFilter);
    }
    panel.hidden ||= onlyWatched;
    if (panel.hidden) return;
    signalHeading.textContent = world ? "局勢走向" : "股市訊號";
    signalNote.hidden = world || politics;
    rankingLegend.hidden = politics;
    rankingLegend.replaceChildren();
    if (!politics) {
      const entries = world ? [["escalation", "升級"], ["deescalation", "緩和"], ["idle", "無方向"]]
        : [["bull", "紅＝偏多"], ["bear", "綠＝偏空"], ["idle", "灰＝無方向"]];
      entries.forEach(([id, label], index) => {
        if (index) rankingLegend.append(document.createTextNode("・"));
        const entry = make("span", "nw-ranking-key");
        const dot = make("span", `nw-dot nw-${id}`);
        dot.setAttribute("aria-hidden", "true");
        entry.append(dot, document.createTextNode(label));
        rankingLegend.append(entry);
      });
    }
    rankingTitle.textContent = politics ? "議題" : world ? "地區" : "題材";
    ranking.setAttribute("aria-label", politics ? "議題排行" : world ? "地區排行" : "題材排行");
    macro.hidden = world || politics;
    market.hidden = politics;
    history.hidden = politics;
    const names = politics ? issueTopics : world ? regionTopics : themeNames;
    const parts = world ? [["escalation", "升級"], ["mixed", "僵持"], ["deescalation", "緩和"], ["idle", "無關"]]
      : financeParts;
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
    if (!politics) drawHistory(groups, world, parts);
    for (const group of groups) {
      const analysis = group.reports.map(validAnalysis).find(Boolean);
      if (!analysis) {
        pending++;
        continue;
      }
      if (!politics) counts[world ? analysis.trend : analysis.market]++;
      const theme = themes.get(topicOf(analysis));
      theme.count++;
      const direction = politics ? "" : arrow(analysis);
      if (world ? analysis.trend === "escalation" : direction === "▲") theme.bull++;
      if (world ? analysis.trend === "deescalation" : direction === "▼") theme.bear++;
    }
    const sourceCount = new Set(scoped.map(item => text(item.source)).filter(Boolean)).size;
    const analyzed = groups.length - pending;
    sampleCount.textContent = `${onlyNew ? "上次離開後的新進展：" : ""}${groups.length} 個事件（${scoped.length} 則報導），${sourceCount} 個來源・已分析 ${analyzed}／${groups.length}`;
    pendingCount.textContent = `待判定 ${pending}`;
    pendingCount.hidden = pending === 0 || !analysisEnabled || modelState === "paused";
    merging.hidden = eventsPending === 0;
    merging.textContent = eventsPending > 0 ? `・待合併 ${eventsPending}` : "";
    warning.hidden = groups.length >= 10;
    const values = marketParts.map((_, i) => groups.filter(group => contributes(group, `signal:${i}`)).length);
    marketBar.dataset.empty = String(analyzed === 0);
    marketBar.setAttribute("aria-label", marketParts.map((part, i) => `${part.name} ${values[i]}`).join("、"));
    market.title = `${world ? "無關" : "與股市無關"} ${world ? counts.not_conflict : counts.not_market}、未明 ${counts.other}`;
    marketParts.forEach((part, i) => {
      part.segment.style.width = `${analyzed ? values[i] / analyzed * 100 : 0}%`;
      part.value.textContent = String(values[i]);
      part.entry.dataset.count = `signal:${i}`;
      part.entry.setAttribute("aria-pressed", String(selectedCount?.id === `signal:${i}`));
    });
    const total = {count: groups.filter(group => contributes(group, "macro:all")).length,
      bull: groups.filter(group => contributes(group, "macro:bull")).length,
      bear: groups.filter(group => contributes(group, "macro:bear")).length};
    macro.replaceChildren(document.createTextNode("大盤方向："));
    for (const [id, label, value, className] of [["macro:all", "大盤／總經", total.count, ""],
      ["macro:bull", "利多", total.bull, "nw-up"], ["macro:bear", "利空", total.bear, "nw-down"]]) {
      const button = make("button", className, `${label} ${value}${id === "macro:all" ? " 個事件" : ""}`);
      button.type = "button";
      button.dataset.count = id;
      button.setAttribute("aria-pressed", String(selectedCount?.id === id));
      macro.append(button);
    }
    // Stable sorting preserves the fixed table order for equal counts.
    const ranked = [...themes].filter(([id, count]) => id !== "macro" && id !== "other" && count.count)
      // Region/issue "other" stays visible but always ranks last.
      .sort((a, b) => a[0].endsWith(":other") - b[0].endsWith(":other") || b[1].count - a[1].count).slice(0, 10);
    const existing = new Map([...ranking.querySelectorAll("button")].map(button => [button.dataset.topic, button]));
    const rankedIds = new Set(ranked.map(([id]) => id));
    for (const child of [...ranking.children]) {
      if (!rankedIds.has(child.dataset.topic)) child.remove();
    }
    if (!ranked.length) ranking.replaceChildren(make("span", "nw-hint", politics ? "議題：尚無" : world ? "地區：尚無" : "題材：尚無"));
    for (const [id, count] of ranked) {
      let button = existing.get(id);
      if (!button) {
        button = make("button", "nw-theme");
        button.type = "button";
        button.dataset.topic = id;
        const track = make("span", "nw-theme-track");
        track.setAttribute("aria-hidden", "true");
        const bar = make("span", "nw-bar nw-theme-bar");
        for (const direction of (politics ? ["issue-count"] : world ? ["escalation", "deescalation", "idle"] : ["bull", "bear", "idle"])) bar.append(make("span", `nw-segment nw-${direction}`));
        track.append(bar);
        button.append(make("span", "nw-theme-name", names.get(id)), track, make("span", "nw-theme-count"));
      }
      button.setAttribute("aria-pressed", String(selectedTheme === id));
      const description = politics ? "" : `${world ? "升級" : "利多"} ${count.bull}、${world ? "緩和" : "利空"} ${count.bear}`;
      describe(button, description, ranking);
      button.title = `${names.get(id)} ${count.count}${description ? `（${description}）` : ""}`;
      button.querySelector(".nw-theme-count").textContent = String(count.count);
      const bar = button.querySelector(".nw-theme-bar");
      bar.style.width = `${count.count / ranked[0][1].count * 100}%`;
      (politics ? [count.count] : [count.bull, count.bear, count.count - count.bull - count.bear]).forEach((value, i) => {
        bar.children[i].style.width = `${value / count.count * 100}%`;
      });
      ranking.append(button);
    }
  }

  function onTheme(event) {
    const button = event.target?.closest?.("button[data-topic]");
    if (!button || !ranking.contains(button) || !topicNames.has(button.dataset.topic)) return;
    if (selectedCount) {
      selectedTopic = selectedCount.topic || "";
      selectedCount = null;
      if (!selectedTopic) savedView = null;
    }
    selectedTheme = selectedTheme === button.dataset.topic ? "" : button.dataset.topic;
    drawItems();
  }
  function returnToView(automatic = false) {
    const focusWasInside = root.contains(document.activeElement);
    const currentFocus = focusIdentity(document.activeElement);
    // Mouse readers usually have focus on body; they still expect their scroll back.
    const restorePosition = !automatic || focusWasInside || document.activeElement === document.body;
    const saved = savedView;
    savedView = null;
    selectedTopic = "";
    selectedCount = null;
    if (saved) {
      sources.value = [...sources.options].some(option => option.value === saved.source) ? saved.source : "";
      const category = typeof initialView.category === "string" && items.some(item => categoryNames.has(text(item?.category)))
        ? initialView.category : saved.category;
      categories.value = [...categories.options].some(option => option.value === category) ? category : "";
      selectedTheme = saved.theme;
      selectedCount = saved.count || null;
      onlyWatched = saved.watched && trackedWords.length > 0;
      onlyNew = Boolean(saved.newOnly);
      saveState("view", {source: sources.value, category: categories.value});
    }
    drawItems(false);
    if (saved && restorePosition) {
      const restored = restoreFocus(saved.focus) || (automatic && restoreFocus(currentFocus));
      if (!restored && focusWasInside) list.focus({preventScroll: true});
      if (saved.scroller?.isConnected) saved.scroller.scrollTop = saved.scrollTop;
    }
  }
  function onClearTheme() {
    if (selectedTopic || selectedCount?.topic) { returnToView(); return; }
    selectedTheme = "";
    selectedCount = null;
    selectedTopic = "";
    drawItems();
  }
  function onSourceOrCategory(event) {
    const field = event.currentTarget === sources ? "source" : "category";
    delete initialView[field];
    const temporaryCategory = event.currentTarget === categories && (selectedTopic || selectedCount?.topic);
    if (!temporaryCategory) {
      const stored = loadState("view");
      const previous = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
      saveState("view", {source: text(previous.source), category: text(previous.category),
        [field]: event.currentTarget.value});
    }
    if (temporaryCategory) {
      selectedTopic = selectedTopic || selectedCount.topic;
      selectedCount = null;
      selectedTheme = "";
    } else {
      savedView = null;
      selectedTopic = "";
      if (event.currentTarget === categories || selectedCount?.topic) selectedCount = null;
    }
    drawItems();
  }
  function onWatchToggle() {
    watchSettings.hidden = !watchSettings.hidden;
    watchToggle.setAttribute("aria-expanded", String(!watchSettings.hidden));
  }
  function onWatchSave() {
    const words = [];
    let word = "";
    for (const char of watchInput.value) {
      if (!char.trim() || char === "," || char === "，") {
        if (word) words.push(word);
        word = "";
      } else word += char;
    }
    if (word) words.push(word);
    trackedWords = setWatchWords(words);
    watchInput.value = trackedWords.join(" ");
    if (!trackedWords.length) onlyWatched = false;
    drawItems();
  }
  function onWatchKey(event) {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      onWatchSave();
    }
  }
  function onWatchOnly() {
    if (!trackedWords.length) return;
    onlyWatched = !onlyWatched;
    drawItems();
  }
  function focusIdentity(node) {
    if (!node || !root.contains(node)) return null;
    if (node.matches(".nw-list a")) return {
      selector: node.classList.contains("nw-event-latest") ? ".nw-list a.nw-event-latest" : ".nw-list a:not(.nw-event-latest)", href: node.href, event: node.closest(".nw-row")?.dataset.event || "",
    };
    if (node.matches(".nw-tone-audit a")) return {selector: ".nw-tone-audit a", attribute: "reportKey", value: node.dataset.reportKey};
    if (node.matches(".nw-focus-row a")) {
      const row = node.closest(".nw-focus-row");
      return {selector: ".nw-focus-row a", href: node.href,
        event: row.dataset.event || "", topic: row.dataset.topicId || ""};
    }
    for (const [selector, attribute] of [[".nw-tone-button", "toneKey"], [".nw-tone-audit .nw-summary-toggle", "summary"], [".nw-list .nw-summary-toggle", "summary"], [".nw-list .nw-expand", "event"],
      [".nw-focus-count[data-event]", "event"], [".nw-focus-count[data-topic-id]", "topicId"],
      [".nw-theme[data-topic]", "topic"], [".nw-panel button[data-count]", "count"]]) {
      if (node.matches(selector)) return {selector, attribute, value: node.dataset[attribute],
        rowHref: node.matches(".nw-expand, .nw-summary-toggle")
          ? node.closest(".nw-row")?.querySelector("a.nw-title")?.href : undefined};
    }
    return null;
  }
  function unavailableFocus() {
    const active = document.activeElement;
    return !root.contains(active) || Boolean(active?.closest("[hidden]")) || active?.disabled === true;
  }
  function restoreFocus(identity, revealReports = true) {
    if (!identity) return false;
    let target = [...root.querySelectorAll(identity.selector)].find(node => {
      if (identity.href === undefined) return node.dataset[identity.attribute] === identity.value;
      const row = node.closest(".nw-row, .nw-focus-row");
      return node.href === identity.href && (row?.dataset.event || "") === identity.event
        && (identity.topic === undefined || (row?.dataset.topicId || "") === identity.topic);
    });
    if (!target && identity.href !== undefined) {
      const matches = [...list.querySelectorAll("a:not(.nw-event-latest)")].filter(node => node.href === identity.href);
      if (matches.length === 1) target = matches[0];
    }
    if (!target && identity.rowHref) {
      const matches = [...list.querySelectorAll("a:not(.nw-event-latest)")].filter(node => node.href === identity.rowHref);
      if (matches.length === 1)
        target = matches[0].closest(".nw-row").querySelector(identity.attribute === "event" ? ".nw-expand" : ".nw-summary-toggle");
    }
    const reports = target?.closest(".nw-reports");
    if (reports?.hidden) {
      const row = reports.closest(".nw-row");
      if (revealReports) {
        expanded.add(row.dataset.event);
        reports.hidden = false;
        row.querySelector(".nw-expand").setAttribute("aria-expanded", "true");
      } else target = row.querySelector(".nw-expand");
    }
    if (target) target.focus({preventScroll: true});
    return Boolean(target) && !unavailableFocus();
  }
  function drawItems(keepFocus = true, searchOnly = false) {
    if (!searchOnly) searchRows.clear();
    const searching = Boolean(searchText(searchInput.value).trim());
    searchScope.hidden = !searching;
    searchScope.textContent = searching ? `統計為全部${categoryNames.get(categories.value) || "類別"}，未套用搜尋` : "";
    sourceDescription.textContent = [...sources.options].find(option => option.value === sources.value)?.title || "";
    const focusWasInside = keepFocus && root.contains(document.activeElement);
    const focused = keepFocus ? focusIdentity(document.activeElement) : null;
    const availableItems = items.filter(item => item && typeof item === "object");
    for (const option of searchOnly ? [] : categories.options) {
      const count = groupItems(availableItems.filter(item => (!sources.value || text(item.source) === sources.value)
        && (!option.value || text(item.category) === option.value))).length;
      const next = `${categoryNames.get(option.value) || "全部類別"} ${count}`;
      if (option.textContent !== next) option.textContent = next;
    }
    for (const option of searchOnly ? [] : sources.options) {
      const count = groupItems(availableItems.filter(item => (!categories.value || text(item.category) === categories.value)
        && (!option.value || text(item.source) === option.value))).length;
      const next = `${option.value || "全部來源"} ${count}${option.dataset.statusSuffix || ""}`;
      if (option.textContent !== next) option.textContent = next;
    }
    const applicable = categories.value === "politics" ? issueTopics : categories.value === "world" ? regionTopics
      : financial(categories.value) ? themeNames : new Map();
    if (selectedTheme && !applicable.has(selectedTheme)) selectedTheme = "";
    if (selectedCount && selectedCount.category !== categories.value) selectedCount = null;
    drawOverview();
    const scopeTopic = selectedTopic || selectedCount?.topic;
    let scoped = items.filter(item => item && typeof item === "object"
      && (!sources.value || text(item.source) === sources.value)
      && (!categories.value || text(item.category) === categories.value)
      && (!scopeTopic || item.topic === scopeTopic));
    // A theme filter matches individual reports. Validate before the optional
    // new-progress restriction so toggling it cannot discard the user's theme.
    if (selectedTheme && !scoped.some(item => topicOf(validAnalysis(item)) === selectedTheme)) selectedTheme = "";
    // Keep complete eligible events, including their older representative.
    if (onlyNew) {
      const eligible = new Set(groupItems(scoped).filter(group => group.reports.some(isNew)).flatMap(group => group.reports));
      scoped = scoped.filter(item => eligible.has(item));
    }
    if (!searchOnly) drawPanel(scoped); // Theme filtering must not shrink the panel's scope.
    const rendered = document.createDocumentFragment();
    const filtered = scoped.filter(item => !selectedTheme || topicOf(validAnalysis(item)) === selectedTheme);
    const allGroups = groupItems(filtered).filter(group => !selectedCount || contributes(group, selectedCount.id));
    const groupIndices = new Map(allGroups.map((group, index) => [group, index]));
    const matches = new Map(allGroups.map(group => [group, trackedWords.find(word => group.reports.some(item =>
      text(item.title).toLowerCase().includes(word.toLowerCase()) || text(item.summary).toLowerCase().includes(word.toLowerCase())))]));
    const watchedCount = allGroups.filter(group => matches.get(group)).length;
    watchOnly.disabled = trackedWords.length === 0;
    watchOnly.hidden = trackedWords.length === 0;
    watchOnly.setAttribute("aria-pressed", String(onlyWatched));
    watchOnly.title = `只顯示標題或摘要含你的關鍵字的新聞（${watchedCount} 個事件）`;
    watchDescription.textContent = watchOnly.title;
    watchGuide.hidden = trackedWords.length > 0;
    watchOnly.textContent = `只看追蹤 ${watchedCount}`;  // Events, like the list and status.
    const query = searchText(searchInput.value).trim();
    const hits = item => !query || (searchIndex.get(item) || []).some(value => value.includes(query));
    const matchedGroups = allGroups.filter(group => (!onlyWatched || matches.get(group)) && group.reports.some(hits));
    const count = matchedGroups.filter(group => group.reports.some(isNew)).length;
    const groups = matchedGroups.filter(group => !onlyNew || group.reports.some(isNew));
    newOnly.hidden = lastSeen === null || count === 0;
    newOnly.disabled = count === 0;
    newOnly.textContent = newOnly.hidden ? "" : `新增 ${count} 個事件`;
    newOnly.setAttribute("aria-pressed", String(onlyNew));
    newHint.hidden = !onlyNew;
    newHintText.textContent = `只看上次離開後的新進展（${groups.length} 個事件）`;

    searchHint.hidden = !query;
    searchHint.textContent = query ? `搜尋「${searchInput.value.trim()}」：${groups.length} 個事件` : "";
    searchToggle.setAttribute("aria-pressed", String(Boolean(query)));
    const newGroups = groups.map(group => group.reports.some(isNew));
    // New groups normally form a prefix; the divider closes that prefix only
    // when old groups follow it. New groups outside the prefix keep a badge.
    const firstOld = newGroups.indexOf(false);
    const prefix = lastSeen === null ? 0 : firstOld < 0 ? groups.length : firstOld;
    const dividerIndex = prefix > 0 && prefix < groups.length ? prefix : -1;
    if (received) {
      const modelText = modelState === "working" ? "整理中" : modelState === "paused" ? (modelReason === "waiting" ? "整理暫停，等待下次更新" : "整理暫停，下次更新繼續") : "";
      const before = [updatedText, refreshNotice, modelText].filter(Boolean).join(" · ");
      const after = [failedText, classificationText].filter(Boolean).join(" · ");
      if (newOnly.parentNode !== status) status.replaceChildren(statusBefore, newOnly, statusAfter);
      statusBefore.textContent = before + (before && !newOnly.hidden ? " · " : "");
      statusAfter.textContent = after ? `${before || !newOnly.hidden ? " · " : ""}${after}` : "";
    }
    watchHint.hidden = !onlyWatched;
    watchHint.textContent = onlyWatched ? `只看追蹤：${trackedWords.join("、")}` : "";
    drawFocus(groups);
    if (toneAudit && ![...focusList.querySelectorAll(".nw-tone-button")].some(button =>
      button.dataset.toneKey === toneAudit && !button.closest("[hidden]"))) {
      toneAudit = null;
      focusList.querySelectorAll(".nw-tone-audit").forEach(node => node.remove());
      focusList.querySelectorAll(".nw-tone-button").forEach(button => {
        button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-pressed", "false"); button.removeAttribute("aria-controls");
      });
    }
    for (const [index, group] of groups.entries()) {
      if (index === dividerIndex) {
        const divider = make("li", "nw-divider", "以下為上次離開前的新聞");
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-label", "以下是上次離開前的新聞");
        rendered.append(divider);
      }
      const item = group.reports[0];
      const cacheKey = groupIndices.get(group);
      const cached = searchOnly && searchRows.get(cacheKey);
      if (cached) {
        for (const [report, marker, parent] of cached.markers) {
          const hit = Boolean(query && hits(report));
          if (hit && !marker.parentNode) parent.prepend(marker);
          else if (!hit) marker.remove();
        }
        if (cached.toggle) {
          const open = expanded.has(group.id) || Boolean(query && group.reports.slice(1).some(hits));
          cached.toggle.setAttribute("aria-expanded", String(open));
          cached.reports.hidden = !open;
        }
        if (cached.latestLink) cached.latestLink.hidden = Boolean(query && hits(cached.latest));
        const title = cached.row.querySelector(".nw-title");
        const badge = title.querySelector(".nw-new");
        const marked = newGroups[index] && index >= prefix;
        if (marked && !badge) title.prepend(make("span", "nw-new", "新"));
        else if (!marked) badge?.remove();
        rendered.append(cached.row);
        continue;
      }
      const markers = [];
      const mark = (parent, report) => {
        const hit = Boolean(query && hits(report));
        const marker = make("span", "nw-search-match", "搜尋命中");
        markers.push([report, marker, parent]);
        if (hit) parent.prepend(marker);
      };
      const category = text(item.category);
      const analysis = validAnalysis(item);
      const row = make("li", "nw-row");
      const tagDescriptions = document.createDocumentFragment();
      if (group.id) row.dataset.event = group.id;
      const meta = make("div", "nw-meta");
      const info = make("div", "nw-info");
      const actions = make("div", "nw-actions");
      meta.append(info);
      mark(info, item);
      if (matches.get(group)) info.append(make("span", "nw-watch", `追蹤：${matches.get(group)}`));
      if (analysis?.kind === "politics") {
        if (categories.value === "politics") info.append(make("span", "nw-tag", issueNames.get(analysis.issue)));
      } else if (analysis?.kind === "world") {
        const tag = make("span", "nw-tag", regionNames.get(analysis.region));
        if (analysis.trend === "escalation" || analysis.trend === "deescalation") {
          const escalating = analysis.trend === "escalation";
          tag.append(make("span", escalating ? "nw-danger-text" : "nw-calm-text", escalating ? " 升級" : " 緩和"));
        }
        info.append(tag);
      } else if (analysis && analysis.theme !== "other") {
        const direction = arrow(analysis);
        const name = analysis.theme === "macro" ? "大盤" : themeNames.get(analysis.theme);
        const tag = make("span", `nw-tag${direction === "▲" ? " nw-up" : direction === "▼" ? " nw-down" : ""}`,
          name + (direction ? ` ${direction}` : ""));
        const description = direction ? `這則新聞對${name}${direction === "▲" ? "偏多" : "偏空"}（依新聞內容判斷，非行情）`
          : `題材：${name}`;
        tag.title = description;
        describe(tag, description, tagDescriptions);
        info.append(tag);
      }
      if (!categories.value) info.append(make("span", "nw-category", categoryNames.get(category) || "未分類"));
      info.append(make("span", "nw-source", text(item.source)), groupTime(group.reports));
      appendTone(info, item);
      row.append(newsTitle(item, "nw-title", newGroups[index] && index >= prefix), meta);
      let latest = item, latestTime = Date.parse(text(item.published));
      for (const report of group.reports) {
        const time = Date.parse(text(report.published));
        if (Number.isFinite(latestTime) && time > latestTime) { latest = report; latestTime = time; }
      }
      let latestLink = null;
      if (latest !== item && text(latest.title) && text(latest.title) !== text(item.title)) {
        const link = newsTitle({...latest, title: `最新：${text(latest.title)}（${text(latest.source)}）`},
          "nw-hint nw-event-latest", isNew(latest));
        if (link.tagName === "A") {
          latestLink = link;
          link.title = text(latest.title);
          link.hidden = Boolean(query && hits(latest));
          meta.before(link);
        }
      }
      if (group.reports.length > 1) {
        const toggle = make("button", "nw-expand", `另 ${group.reports.length - 1} 則報導`);
        toggle.type = "button";
        toggle.dataset.event = group.id;
        const open = expanded.has(group.id) || Boolean(query && group.reports.slice(1).some(hits));
        toggle.setAttribute("aria-expanded", String(open));
        actions.append(toggle);
        const reports = make("ul", "nw-reports");
        reports.setAttribute("aria-label", "同事件其他報導");
        reports.hidden = !open;
        for (const report of group.reports.slice(1)) {
          const entry = make("li", "nw-report");
          const details = make("div", "nw-report-meta");
          details.append(make("span", "nw-source", text(report.source)), newsTime(report));
          mark(details, report);
          appendTone(details, report);
          entry.append(newsTitle(report, "nw-report-title", onlyNew && isNew(report)), details);
          reports.append(entry);
        }
        row.append(reports);
      }
      if (text(item.summary)) {
        const key = summaryKey(group);
        const {button, paragraph} = summaryParts(item, key);
        actions.prepend(button);
        meta.after(paragraph);  // Below meta, so the toggle does not move when expanded.
      }
      if (actions.childElementCount) meta.append(actions);
      row.append(tagDescriptions);
      searchRows.set(cacheKey, {row, markers, latest, latestLink, toggle: row.querySelector(".nw-expand"), reports: row.querySelector(".nw-reports")});
      rendered.append(row);
    }
    list.replaceChildren(rendered);
    empty.hidden = groups.length > 0;
    emptyText.textContent = received
      ? query ? "目前篩選範圍內沒有符合搜尋的新聞" : categories.value && modelState === "working" ? "分類中，稍後出現" : "這個條件下沒有新聞"
      : "正在取得新聞";
    clearAll.hidden = !received;
    if (!restoreFocus(focused) && focusWasInside && unavailableFocus())
      list.focus({preventScroll: true});
  }
  function onNewOnly() {
    if (disposed || newOnly.disabled) return;
    onlyNew = !onlyNew;
    drawItems();
  }
  function onNewClear() {
    if (disposed) return;
    onlyNew = false;
    drawItems();
    if (!newOnly.disabled) newOnly.focus();
  }
  function onSearch() { if (!disposed) drawItems(true, true); }
  function openSearch(open) {
    searchBox.hidden = !open;
    searchToggle.setAttribute("aria-expanded", String(open));
    if (open) searchInput.focus();
    else { clearSearch(); searchToggle.focus({preventScroll: true}); }
  }
  function onSearchToggle() { openSearch(searchBox.hidden); }
  function clearSearch() {
    const reports = document.activeElement?.closest?.(".nw-reports");
    const row = reports?.closest(".nw-row");
    // Move off a search-only child before redraw; restoring that hidden link
    // would otherwise turn a temporary expansion into a manual one.
    if (row && list.contains(row) && !expanded.has(row.dataset.event))
      row.querySelector(".nw-expand")?.focus({preventScroll: true});
    searchInput.value = "";
    drawItems();
  }
  function onSearchClear() { clearSearch(); searchInput.focus(); }
  function onSearchKey(event) {
    if (event.key === "Escape" && !event.isComposing && !event.ctrlKey && !event.metaKey
        && !event.altKey && !event.shiftKey && handleEscape()) event.preventDefault();
  }
  function toggleShortcuts() {
    if (disposed) return;
    if (!shortcutHelp.hidden) { closeShortcuts(); return; }
    const node = document.activeElement;
    shortcutOrigin = {node, identity: focusIdentity(node)};
    shortcutHelp.hidden = false;
    shortcutToggle.setAttribute("aria-expanded", "true");
    shortcutHelp.focus();
  }
  function closeShortcuts() {
    shortcutHelp.hidden = true;
    shortcutToggle.setAttribute("aria-expanded", "false");
    const origin = shortcutOrigin;
    shortcutOrigin = null;
    if (restoreFocus(origin?.identity, false)) return;
    const node = origin?.node;
    if (node && root.contains(node) && !node.closest("[hidden]") && !node.disabled) node.focus({preventScroll: true});
    else shortcutToggle.focus({preventScroll: true});
  }
  function handleEscape() {
    if (toneAudit) { closeToneAudit(); return true; }
    if (searchInput.value) { clearSearch(); return true; }
    if (!shortcutHelp.hidden) { closeShortcuts(); return true; }
    return false;
  }
  function onClearAll() {
    searchInput.value = "";
    delete initialView.category;
    delete initialView.source;
    savedView = null;
    sources.value = "";
    categories.value = "";
    selectedTheme = "";
    selectedCount = null;
    selectedTopic = "";
    onlyWatched = false;
    onlyNew = false;
    drawItems();
  }
  function renderList(body) {
    if (text(body.at) !== latestAt) refreshNotice = "";
    latestAt = text(body.at);
    if (refreshTimer !== null && latestAt !== refreshAt) finishRefresh();
    modelReason = typeof body.model?.reason === "string" ? body.model.reason : "";
    modelState = body.model && typeof body.model === "object" && ["working", "paused", "done", "off"].includes(body.model.state)
      ? body.model.state : "";
    received = true;
    const previousEvents = new Map();
    for (const item of items) {
      if (!text(item?.link) || !eventId(item)) continue;
      const ids = previousEvents.get(item.link) || new Set();
      ids.add(eventId(item));
      previousEvents.set(item.link, ids);
    }
    const wasExpanded = new Set(expanded), hadSummary = new Set(summaries);
    items = Array.isArray(body.items) ? body.items : [];
    // Transfer by shared reports before pruning old IDs. Snapshots avoid
    // cascading transfers when several old groups merge or split together.
    for (const item of items) {
      const id = item && typeof item === "object" ? eventId(item) : null;
      if (!id) continue;
      for (const old of previousEvents.get(text(item.link)) || []) {
        if (wasExpanded.has(old)) expanded.add(id);
        if (hadSummary.has(`event:${old}`)) summaries.add(`event:${id}`);
      }
    }
    // Use the full current list, before filters or event folding.
    dateOnlySources.clear();
    const sourceTimes = new Map();
    for (const item of items) {
      const source = text(item?.source);
      if (!source) continue;
      const counts = sourceTimes.get(source) || {total: 0, midnight: 0};
      counts.total++;
      if (isMidnight(new Date(text(item.published)))) counts.midnight++;
      sourceTimes.set(source, counts);
    }
    for (const [source, counts] of sourceTimes)
      if (counts.total >= 3 && counts.midnight / counts.total >= 0.8) dateOnlySources.add(source);
    searchIndex = new WeakMap();
    for (const item of items) if (item && typeof item === "object")
      searchIndex.set(item, [searchText(item.title), searchText(item.summary)]);
    const presentSummaries = new Set(items.filter(item => item && typeof item === "object")
      .map(item => summaryKey({id: eventId(item), reports: [item]})).filter(Boolean));
    for (const item of items) if (item && typeof item === "object") presentSummaries.add(auditKey(item));
    for (const key of summaries) if (!presentSummaries.has(key)) summaries.delete(key);
    const rawTopics = Array.isArray(body.topics?.list) ? body.topics.list : [];
    const topicIds = new Set();
    topics = rawTopics.filter(topic => {
      if (!topic || typeof topic.id !== "string" || topic.id.length !== 12 || !/^[0-9a-f]{12}$/i.test(topic.id)
          || typeof topic.title !== "string" || !Number.isInteger(topic.sources) || topic.sources < 3
          || !Number.isInteger(topic.count) || topic.count < 1 || topicIds.has(topic.id)) return false;
      topicIds.add(topic.id);
      return true;
    }).slice(0, 5);
    const scopeTopic = selectedTopic || selectedCount?.topic;
    const lostTopic = scopeTopic && !topics.some(topic => topic.id === scopeTopic);
    const published = items.map(item => Date.parse(text(item?.published))).filter(Number.isFinite);
    latestPublished = published.length ? Math.max(...published) : null;
    const presentEvents = new Set(items.filter(item => item && typeof item === "object").map(eventId).filter(Boolean));
    for (const id of expanded) if (!presentEvents.has(id)) expanded.delete(id);
    const events = body.events && typeof body.events === "object" ? body.events : {};
    eventsPending = Number.isInteger(events.pending) && events.pending > 0 ? events.pending : 0;
    const previous = sources.value;
    const records = Array.isArray(body.sources) ? body.sources : [];
    const options = new Map([...sources.options].map(option => [option.value, option]));
    const allText = `全部來源 ${groupItems(items.filter(item => item && typeof item === "object"
      && (!categories.value || text(item.category) === categories.value))).length}`;
    if (all.textContent !== allText) all.textContent = allText;
    const names = new Set();
    sourceOutlets = new Map();
    for (const source of records) {
      const name = text(source?.name);
      if (!name || names.has(name)) continue;
      names.add(name);
      const outlet = text(source.outlet).trim();
      sourceOutlets.set(name, outlet && outlet.length <= 64 ? outlet : name);
      const option = options.get(name) || document.createElement("option");
      option.value = name;
      const count = groupItems(items.filter(item => item && typeof item === "object" && text(item.source) === name
        && (!categories.value || text(item.category) === categories.value))).length;
      const date = confirmedAt(source);
      const today = new Date();
      const sameDay = date && date.getFullYear() === today.getFullYear()
        && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
      const calendar = date && !sameDay ? `${date.getMonth()+1}/${date.getDate()} ` : "";
      const suffix = source.ok === false ? (date ? `（${calendar}${localTime(source.last_success)} 資料）` : "（失敗）") : "";
      option.dataset.statusSuffix = suffix;
      const next = `${name} ${count}${suffix}`;
      option.title = date || source.ok === false ? sourceDetail(source) : "";
      if (option.textContent !== next) option.textContent = next;
      const position = sources.options[names.size];
      if (position !== option) sources.insertBefore(option, position || null);
    }
    for (const option of [...sources.options]) if (option !== all && !names.has(option.value)) option.remove();
    sourceOrder = new Map([...names].map((name, i) => [name, i]));
    sources.value = names.has(previous) ? previous : "";
    if (typeof initialView.source === "string" && [...sources.options].some(option => option.value === initialView.source))
      sources.value = initialView.source;
    delete initialView.source; // Source restoration belongs to the first list only.
    if (body.classify?.enabled === false) delete initialView.category;
    else if (items.some(item => categoryNames.has(text(item?.category)))) {
      if (typeof initialView.category === "string" && [...categories.options].some(option => option.value === initialView.category)) {
        if (selectedTopic || selectedCount?.topic || savedView) {
          if (savedView) savedView.category = initialView.category;
        } else categories.value = initialView.category;
      }
      delete initialView.category;
    }
    const failed = records.filter(source => source?.ok === false);
    const failureName = source => text(source.name) || "未命名來源";
    const classify = body.classify && typeof body.classify === "object" ? body.classify : {};
    analysisEnabled = classify.enabled !== false;
    const pending = Number.isInteger(classify.pending) && classify.pending >= 0 ? classify.pending : 0;
    const offNotice = classify.enabled === false && modelState === "off"
      ? {no_key: ["分類未啟用：未設定 API 金鑰", "設定 TYPESAFE_API_KEY 後重新載入模組"],
         auth: ["分類已停用：API 金鑰無效", "請確認金鑰後重新載入模組"]}[modelReason] : null;
    classificationText = classify.enabled === false ? (Array.isArray(offNotice) ? offNotice[0] : "分類：關閉")
      : modelState !== "working" && pending > 0 ? `未分類：${pending}` : "";
    const updated = localTime(body.at);
    const at = Date.parse(text(body.at));
    historyAt = Number.isFinite(at) ? at : Date.now();
    updatedText = updated ? `${updated} 更新` : "";
    const stale = failed.filter(source => confirmedAt(source));
    const unavailable = failed.filter(source => !confirmedAt(source));
    failedText = [stale.length ? `${stale.length} 個來源沿用舊資料` : "",
      unavailable.length === 1 ? `${failureName(unavailable[0])} 失敗`
        : unavailable.length > 1 ? `${failureName(unavailable[0])}等 ${unavailable.length} 個來源失敗` : ""]
      .filter(Boolean).join(" · ");
    status.title = failed.map(source => confirmedAt(source) ? sourceDetail(source)
      : `${failureName(source)}${typeof source.error === "string" ? `：${Array.from(source.error).slice(0,80).join("")}` : ""}`).join("\n");
    all.title = status.title;
    if (Array.isArray(offNotice)) status.title = [status.title, offNotice[1]].filter(Boolean).join("\n");
    if (lostTopic) returnToView(true);
    else drawItems();
  }
  function onBrowseKey(event) {
    const target = event.target;
    if (disposed || !root.contains(target) || event.ctrlKey || event.metaKey || event.altKey
        || event.isComposing || target.isContentEditable
        || target.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.key === "?") {
      if (!event.repeat) toggleShortcuts();
      event.preventDefault(); return;
    }
    if (event.shiftKey) return;
    if (event.key === "Escape" && handleEscape()) { event.preventDefault(); return; }
    if (event.key === "/") { openSearch(true); event.preventDefault(); return; }
    const row = target.closest?.(".nw-row");
    const current = row && list.contains(row) ? row : null;
    if (event.key === "j" || event.key === "k") {
      const rows = [...list.children].filter(node => node.classList.contains("nw-row"));
      const step = event.key === "j" ? 1 : -1;
      let index = current ? rows.indexOf(current) + step : 0;
      for (; index >= 0 && index < rows.length; index += step) {
        const title = rows[index].querySelector("a.nw-title");
        if (!title) continue;
        title.focus({preventScroll: true});
        title.scrollIntoView({block: "nearest"});
        event.preventDefault();
        return;
      }
    } else if (current && (event.key === "s" || event.key === "e")) {
      const button = current.querySelector(event.key === "s" ? ".nw-summary-toggle" : ".nw-expand");
      if (button) {
        button.click();
        event.preventDefault();
      }
    }
  }
  shortcutToggle.addEventListener("click", toggleShortcuts);
  overview.addEventListener("click", onOverview);
  newOnly.addEventListener("click", onNewOnly);
  newClear.addEventListener("click", onNewClear);
  searchToggle.addEventListener("click", onSearchToggle);
  searchInput.addEventListener("input", onSearch);
  searchInput.addEventListener("keydown", onSearchKey);
  searchClear.addEventListener("click", onSearchClear);
  root.addEventListener("keydown", onBrowseKey);
  list.addEventListener("click", onExpand);
  list.addEventListener("click", onSummary);
  focusList.addEventListener("click", onFocus);
  focusList.addEventListener("click", onTone);
  focusList.addEventListener("click", onSummary);
  clearAll.addEventListener("click", onClearAll);
  ranking.addEventListener("click", onTheme);
  panel.addEventListener("click", onCount);
  clearTheme.addEventListener("click", onClearTheme);
  historyToggle.addEventListener("click", onHistory);
  refresh.addEventListener("click", onRefresh);
  sources.addEventListener("change", onSourceOrCategory);
  categories.addEventListener("change", onSourceOrCategory);
  watchToggle.addEventListener("click", onWatchToggle);
  watchSave.addEventListener("click", onWatchSave);
  watchInput.addEventListener("keydown", onWatchKey);
  watchOnly.addEventListener("click", onWatchOnly);
  view.addEventListener("pagehide", persistLastSeen);
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
      if (disposed) return;
      persistLastSeen();
      view.removeEventListener("pagehide", persistLastSeen);
      disposed = true;
      up = false;
      finishRefresh();
      refresh.disabled = true;
      shortcutToggle.removeEventListener("click", toggleShortcuts);
      shortcutOrigin = null;
      overview.removeEventListener("click", onOverview);
      newOnly.removeEventListener("click", onNewOnly);
      newClear.removeEventListener("click", onNewClear);
      searchToggle.removeEventListener("click", onSearchToggle);
      searchInput.removeEventListener("input", onSearch);
      searchInput.removeEventListener("keydown", onSearchKey);
      searchClear.removeEventListener("click", onSearchClear);
      searchIndex = new WeakMap();
      searchRows.clear();
      root.removeEventListener("keydown", onBrowseKey);
      historyToggle.removeEventListener("click", onHistory);
      refresh.removeEventListener("click", onRefresh);
      sources.removeEventListener("change", onSourceOrCategory);
      categories.removeEventListener("change", onSourceOrCategory);
      watchToggle.removeEventListener("click", onWatchToggle);
      watchSave.removeEventListener("click", onWatchSave);
      watchInput.removeEventListener("keydown", onWatchKey);
      watchOnly.removeEventListener("click", onWatchOnly);
      list.removeEventListener("click", onExpand);
      list.removeEventListener("click", onSummary);
      summaries.clear();
      focusList.removeEventListener("click", onFocus);
      focusList.removeEventListener("click", onTone);
      focusList.removeEventListener("click", onSummary);
      toneAudit = null;
      expanded.clear();
      sourceOrder.clear();
      sourceOutlets.clear();
      clearAll.removeEventListener("click", onClearAll);
      ranking.removeEventListener("click", onTheme);
      panel.removeEventListener("click", onCount);
      selectedCount = null;
      clearTheme.removeEventListener("click", onClearTheme);
      selectedTheme = "";
      selectedTopic = "";
      savedView = null;
      topics = [];
      items = [];
      root.remove();
    },
  };
}
