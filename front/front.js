// Native ES module; untrusted feed fields are only assigned as text.
import { css } from "./style.js";
import {
  categoryNames, themeNames, regionNames, regionTopics, issueNames, issueTopics, topicNames,
  financial, validAnalysis, topicOf, arrow, eventId,
} from "./labels.js";

let focusHeadingId = 0;
let descriptionId = 0;
let summaryId = 0;
let watchInputId = 0;

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
  const categories = document.createElement("select");
  categories.setAttribute("aria-label", "新聞類別");
  for (const [id, name] of [["", "全部類別"], ...categoryNames]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${name} 0`;
    categories.append(option);
  }
  const watchToggle = make("button", "", "追蹤設定");
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
  let trackedWords = watchWords(), onlyWatched = false;
  watchInput.value = trackedWords.join(" ");
  watchOnly.disabled = trackedWords.length === 0;
  watchOnly.hidden = trackedWords.length === 0;
  watchSettings.append(watchLabel, watchInput, watchSave);
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
  const history = make("section", "nw-history");
  const macro = make("p", "nw-macro");
  const rankingSection = make("div", "");
  const rankingHeading = make("div", "nw-ranking-heading");
  const rankingTitle = make("span", "", "題材");
  rankingHeading.append(rankingTitle, make("span", "nw-hint", "（點選篩選）"));
  const ranking = make("div", "nw-ranking");
  ranking.setAttribute("aria-label", "題材排行");
  rankingSection.append(rankingHeading, ranking);
  const note = make("small", "nw-note", "同一事件多家報導只算一次。");
  panel.append(sample, market, history, macro, rankingSection, note);
  toolbar.append(refresh, sources, categories, watchToggle, watchOnly, status, watchSettings);
  root.append(toolbar, focus, panel, themeFilter, list, empty);
  ctx.container.append(root);

  let up = false;
  let disposed = false;
  let refreshTimer = null;
  let latestAt = "", refreshAt = "", refreshNotice = "";
  let items = [];
  let received = false;
  let modelState = "";
  let selectedTheme = "";
  let selectedTopic = "";
  let savedView = null;
  let topics = [];
  let analysisEnabled = true;
  let eventsPending = 0;
  let historyAt = Date.now();
  let updatedText = "", failedText = "", classificationText = "";
  const expanded = new Set();
  const summaries = new Set();
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
    if (!up || disposed || refreshTimer !== null) return;
    refreshAt = latestAt;
    refresh.disabled = true;
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
    const dateOnly = endDate.getHours() === 0 && endDate.getMinutes() === 0 && endDate.getSeconds() === 0;
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
    if (!button || !list.contains(button)) return;
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
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    button.setAttribute("aria-expanded", String(expanded.has(id)));
    button.closest(".nw-row").querySelector(".nw-reports").hidden = !expanded.has(id);
  }
  function toneSummary(topic) {
    const tone = topic.tone;
    const labels = [["negative", "負面"], ["neutral", "中性"], ["mixed", "正反"], ["positive", "正面"]];
    if (!tone || typeof tone !== "object" || Array.isArray(tone)
        || labels.some(([id]) => !Number.isSafeInteger(tone[id]) || tone[id] < 0)) return null;
    const total = labels.reduce((sum, [id]) => sum + tone[id], 0);
    if (!Number.isSafeInteger(total) || total < 5 || total > topic.count) return null;
    const ranked = labels.filter(([id]) => tone[id] > 0).sort((a, b) => tone[b[0]] - tone[a[0]]);
    const summary = make("div", "nw-tone");
    const bar = make("div", "nw-bar nw-tone-bar");
    bar.setAttribute("aria-hidden", "true");
    // Fixed segment order (like the market bar) keeps colors comparable across topics.
    for (const id of ["positive", "mixed", "neutral", "negative"].filter(id => tone[id] > 0)) {
      const segment = make("span", `nw-segment nw-tone-${id}`);
      segment.style.width = `${tone[id] / total * 100}%`;
      bar.append(segment);
    }
    summary.append(bar, make("span", "nw-hint", `報導基調：${ranked.map(([id, name]) => `${name} ${tone[id]}`).join("・")}`));
    return summary;
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
        describe(button, `篩選話題：${topic.title}`, row);
        button.append(make("span", "nw-focus-long", `${topic.sources} 家媒體・${topic.count} 則`),
          make("span", "nw-focus-short", `${topic.sources} 家`));
        const copy = make("div", "nw-focus-copy");
        copy.append(newsTitle(representative || {title: topic.title}, "nw-title", members.some(isNew)));
        const tone = toneSummary(topic);
        if (tone) copy.append(tone);
        const newEvents = groupItems(members).filter(group => group.reports.some(isNew)).length;
        if (lastSeen !== null && newEvents) copy.append(make("div", "nw-topic-new", `上次之後新增 ${newEvents} 個事件`));
        row.append(copy, button);
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
      row.dataset.event = group.id;
      const button = make("button", "nw-focus-count");
      button.type = "button";
      button.dataset.event = group.id;
      describe(button, "展開同事件的其他報導", row);
      button.append(make("span", "nw-focus-long", `${group.count} 家媒體`),
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
      if (!selectedTopic) {
        let scroller = root.parentElement;
        while (scroller) {
          const style = view.getComputedStyle(scroller);
          if (/(auto|scroll|overlay)/.test(style.overflowY || style.overflow) && scroller.scrollHeight > scroller.clientHeight) break;
          scroller = scroller.parentElement;
        }
        scroller ||= document.scrollingElement;
        savedView = {source:sources.value, category:categories.value, theme:selectedTheme, watched:onlyWatched,
          scroller, scrollTop:scroller?.scrollTop || 0, focus:focusIdentity(document.activeElement)};
      }
      sources.value = "";
      categories.value = "";
      selectedTheme = "";
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
  function drawHistory(groups, world, parts) {
    const step = 6 * 60 * 60 * 1000, start = historyAt - 4 * step;
    const buckets = Array.from({length: 4}, () => ({values: [0, 0, 0, 0], valid: 0}));
    for (const group of groups) {
      const stamp = Date.parse(text(group.reports[0].published));
      if (!Number.isFinite(stamp) || stamp < start || stamp > historyAt) continue;
      const bucket = buckets[Math.min(3, Math.floor((stamp - start) / step))];
      const analysis = group.reports.map(validAnalysis).find(Boolean);
      if (analysis) bucket.valid++;
      const signal = world ? analysis?.trend : analysis?.market;
      const index = world ? {escalation: 0, stalemate: 1, deescalation: 2}[signal]
        : {positive: 0, mixed: 1, negative: 3}[signal];
      bucket.values[index ?? (world ? 3 : 2)]++;
    }
    history.replaceChildren(make("h3", "nw-heading", "近 24 小時"),
      make("span", "nw-hint", "每 6 小時一段，同一事件只算一次"));
    buckets.forEach((bucket, i) => {
      const from = localTime(new Date(start + i * step).toISOString());
      const to = localTime(new Date(start + (i + 1) * step).toISOString());
      const label = `${from}–${i === 3 ? "現在" : to}`;
      const short = `${from.slice(0, 2)}–${i === 3 ? "現在" : to.slice(0, 2)}`;
      const values = bucket.values, total = values.reduce((sum, n) => sum + n, 0);
      const denominator = total - values[world ? 3 : 2];
      const insufficient = bucket.valid < 5;
      // A percentage over a tiny denominator overstates certainty; show the count instead.
      const name = world ? "升級" : "正面";
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
      history.append(row);
    });
  }
  function drawPanel(scoped) {
    const world = categories.value === "world";
    const politics = categories.value === "politics";
    panel.hidden = !world && !politics && !financial(categories.value);
    panel.setAttribute("aria-label", politics ? "政治議題分析" : world ? "國際局勢分析" : "財經分析");
    themeFilter.hidden = panel.hidden || !selectedTheme;
    themeLabel.textContent = selectedTheme ? `已篩選：${topicNames.get(selectedTheme)}` : "";
    clearTheme.textContent = "清除篩選";
    describe(clearTheme, "", themeFilter);
    topicSources.hidden = !selectedTopic;
    topicSources.textContent = "";
    if (selectedTopic) {
      const counts = new Map();
      for (const item of items) {
        const name = text(item?.source);
        if (item?.topic === selectedTopic && name) counts.set(name, (counts.get(name) || 0) + 1);
      }
      const ranked = [...counts].sort((a, b) => b[1] - a[1]
        || (sourceOrder.get(a[0]) ?? Infinity) - (sourceOrder.get(b[0]) ?? Infinity));
      topicSources.textContent = ranked.slice(0, 5).map(([name, count]) => `${name} ${count}`).join("・")
        + (ranked.length > 5 ? ` 等 ${ranked.length - 5} 家` : "");
      const title = Array.from(topics.find(topic => topic.id === selectedTopic).title);
      themeFilter.hidden = false;
      themeLabel.textContent = `話題：${title.slice(0, 24).join("")}${title.length > 24 ? "…" : ""}`;
      clearTheme.textContent = "返回";
      describe(clearTheme, "回到進入話題前的篩選與位置", themeFilter);
    }
    if (panel.hidden) return;
    signalHeading.textContent = world ? "局勢走向" : "股市訊號";
    rankingTitle.textContent = politics ? "議題" : world ? "地區" : "題材";
    ranking.setAttribute("aria-label", politics ? "議題排行" : world ? "地區排行" : "題材排行");
    macro.hidden = world || politics;
    market.hidden = politics;
    history.hidden = politics;
    const names = politics ? issueTopics : world ? regionTopics : themeNames;
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
    if (!politics) drawHistory(groups, world, parts);
    for (const group of groups) {
      const analysis = group.reports.map(validAnalysis).find(Boolean);
      if (!analysis) {
        counts.other++;
        if (analysisEnabled) pending++;
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
    selectedTheme = selectedTheme === button.dataset.topic ? "" : button.dataset.topic;
    drawItems();
  }
  function returnToView(automatic = false) {
    const currentFocus = focusIdentity(document.activeElement);
    const restorePosition = !automatic || root.contains(document.activeElement)
      || document.activeElement === document.body;
    const saved = savedView;
    savedView = null;
    selectedTopic = "";
    if (saved) {
      sources.value = [...sources.options].some(option => option.value === saved.source) ? saved.source : "";
      categories.value = [...categories.options].some(option => option.value === saved.category) ? saved.category : "";
      selectedTheme = saved.theme;
      onlyWatched = saved.watched && trackedWords.length > 0;
    }
    drawItems(false);
    if (selectedTheme && ![...ranking.querySelectorAll("button[data-topic]")].some(button => button.dataset.topic === selectedTheme)) {
      selectedTheme = "";
      drawItems(false);
    }
    if (saved && restorePosition) {
      if (!restoreFocus(saved.focus) && automatic) restoreFocus(currentFocus);
      if (saved.scroller?.isConnected) saved.scroller.scrollTop = saved.scrollTop;
    }
  }
  function onClearTheme() {
    if (selectedTopic) { returnToView(); return; }
    selectedTheme = "";
    selectedTopic = "";
    drawItems();
  }
  function onSourceOrCategory() {
    savedView = null;
    selectedTopic = "";
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
      selector: ".nw-list a", href: node.href, event: node.closest(".nw-row")?.dataset.event || "",
    };
    if (node.matches(".nw-focus-row a")) {
      const row = node.closest(".nw-focus-row");
      return {selector: ".nw-focus-row a", href: node.href,
        event: row.dataset.event || "", topic: row.dataset.topicId || ""};
    }
    for (const [selector, attribute] of [[".nw-list .nw-summary-toggle", "summary"], [".nw-list .nw-expand", "event"],
      [".nw-focus-count[data-event]", "event"], [".nw-focus-count[data-topic-id]", "topicId"],
      [".nw-theme[data-topic]", "topic"]]) {
      if (node.matches(selector)) return {selector, attribute, value: node.dataset[attribute]};
    }
    return null;
  }
  function restoreFocus(identity) {
    if (!identity) return false;
    let target = [...root.querySelectorAll(identity.selector)].find(node => {
      if (identity.href === undefined) return node.dataset[identity.attribute] === identity.value;
      const row = node.closest(".nw-row, .nw-focus-row");
      return node.href === identity.href && (row?.dataset.event || "") === identity.event
        && (identity.topic === undefined || (row?.dataset.topicId || "") === identity.topic);
    });
    if (!target && identity.href !== undefined) {
      const matches = [...list.querySelectorAll("a")].filter(node => node.href === identity.href);
      if (matches.length === 1) target = matches[0];
    }
    const reports = target?.closest(".nw-reports");
    if (reports?.hidden) {
      const row = reports.closest(".nw-row");
      expanded.add(row.dataset.event);
      reports.hidden = false;
      row.querySelector(".nw-expand").setAttribute("aria-expanded", "true");
    }
    if (target) target.focus({preventScroll: true});
    return Boolean(target);
  }
  function drawItems(keepFocus = true) {
    const focused = keepFocus ? focusIdentity(document.activeElement) : null;
    const sourceItems = items.filter(item => item && typeof item === "object"
      && (!sources.value || text(item.source) === sources.value));
    for (const option of categories.options) {
      const count = groupItems(sourceItems.filter(item => !option.value || text(item.category) === option.value)).length;
      option.textContent = `${categoryNames.get(option.value) || "全部類別"} ${count}`;
    }
    const applicable = categories.value === "politics" ? issueTopics : categories.value === "world" ? regionTopics
      : financial(categories.value) ? themeNames : new Map();
    if (selectedTheme && !applicable.has(selectedTheme)) selectedTheme = "";
    const scoped = items.filter(item => item && typeof item === "object"
      && (!sources.value || text(item.source) === sources.value)
      && (!categories.value || text(item.category) === categories.value)
      && (!selectedTopic || item.topic === selectedTopic));
    drawPanel(scoped); // Theme filtering must not shrink the panel's scope.
    list.replaceChildren();
    const filtered = scoped.filter(item => !selectedTheme || topicOf(validAnalysis(item)) === selectedTheme);
    const allGroups = groupItems(filtered);
    const matches = new Map(allGroups.map(group => [group, trackedWords.find(word => group.reports.some(item =>
      text(item.title).toLowerCase().includes(word.toLowerCase()) || text(item.summary).toLowerCase().includes(word.toLowerCase())))]));
    const watchedCount = allGroups.filter(group => matches.get(group)).length;
    watchOnly.disabled = trackedWords.length === 0;
    watchOnly.hidden = trackedWords.length === 0;
    watchOnly.setAttribute("aria-pressed", String(onlyWatched));
    watchOnly.textContent = `只看追蹤 ${watchedCount}`;  // Events, like the list and status.
    const groups = onlyWatched ? allGroups.filter(group => matches.get(group)) : allGroups;
    const newGroups = groups.map(group => group.reports.some(isNew));
    // New groups normally form a prefix; the divider closes that prefix only
    // when old groups follow it. New groups outside the prefix keep a badge.
    const firstOld = newGroups.indexOf(false);
    const prefix = lastSeen === null ? 0 : firstOld < 0 ? groups.length : firstOld;
    const dividerIndex = prefix > 0 && prefix < groups.length ? prefix : -1;
    if (received) {
      const count = groups.filter(group => group.reports.some(isNew)).length;
      const modelText = modelState === "working" ? "整理中" : modelState === "paused" ? "整理暫停，下次更新繼續" : "";
      status.textContent = [updatedText, refreshNotice, modelText, count ? `${count} 則新` : "", failedText, classificationText]
        .filter(Boolean).join(" · ");
    }
    drawFocus(groups);
    for (const [index, group] of groups.entries()) {
      if (index === dividerIndex) {
        const divider = make("li", "nw-divider", "上次看到這裡");
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-label", "以上是上次之後的新報導");
        list.append(divider);
      }
      const item = group.reports[0];
      const category = text(item.category);
      const analysis = validAnalysis(item);
      const row = make("li", "nw-row");
      if (group.id) row.dataset.event = group.id;
      const meta = make("div", "nw-meta");
      const info = make("div", "nw-info");
      const actions = make("div", "nw-actions");
      meta.append(info);
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
        info.append(make("span", `nw-tag${direction === "▲" ? " nw-up" : direction === "▼" ? " nw-down" : ""}`,
          name + (direction ? ` ${direction}` : "")));
      }
      if (!categories.value) info.append(make("span", "nw-category", categoryNames.get(category) || "未分類"));
      info.append(make("span", "nw-source", text(item.source)), groupTime(group.reports));
      appendTone(info, item);
      row.append(newsTitle(item, "nw-title", newGroups[index] && index >= prefix), meta);
      if (group.reports.length > 1) {
        const toggle = make("button", "nw-expand", `另 ${group.reports.length - 1} 則報導`);
        toggle.type = "button";
        toggle.dataset.event = group.id;
        toggle.setAttribute("aria-expanded", String(expanded.has(group.id)));
        actions.append(toggle);
        const reports = make("ul", "nw-reports");
        reports.setAttribute("aria-label", "同事件其他報導");
        reports.hidden = !expanded.has(group.id);
        for (const report of group.reports.slice(1)) {
          const entry = make("li", "nw-report");
          const details = make("div", "nw-report-meta");
          details.append(make("span", "nw-source", text(report.source)), newsTime(report));
          appendTone(details, report);
          entry.append(newsTitle(report, "nw-report-title", false), details);
          reports.append(entry);
        }
        row.append(reports);
      }
      if (text(item.summary)) {
        const key = summaryKey(group);
        const paragraph = make("p", "nw-summary", item.summary);
        paragraph.id = `nw-summary-${++summaryId}`;
        paragraph.hidden = !summaries.has(key);
        paragraph.prepend(make("small", "nw-summary-label", "來源摘要"));
        const button = make("button", "nw-summary-toggle", "摘要");
        button.type = "button";
        button.dataset.summary = key;
        button.setAttribute("aria-expanded", String(summaries.has(key)));
        button.setAttribute("aria-controls", paragraph.id);
        actions.append(button);
        meta.after(paragraph);  // Below meta, so the toggle does not move when expanded.
      }
      if (actions.childElementCount) meta.append(actions);
      list.append(row);
    }
    empty.hidden = groups.length > 0;
    emptyText.textContent = received ? "這個條件下沒有新聞" : "正在取得新聞";
    clearAll.hidden = !received;
    restoreFocus(focused);
  }
  function onClearAll() {
    savedView = null;
    sources.value = "";
    categories.value = "";
    selectedTheme = "";
    selectedTopic = "";
    onlyWatched = false;
    drawItems();
  }
  function renderList(body) {
    latestAt = text(body.at);
    refreshNotice = "";
    if (refreshTimer !== null && latestAt !== refreshAt) finishRefresh();
    modelState = body.model && typeof body.model === "object" && ["working", "paused", "done", "off"].includes(body.model.state)
      ? body.model.state : "";
    received = true;
    items = Array.isArray(body.items) ? body.items : [];
    const presentSummaries = new Set(items.filter(item => item && typeof item === "object")
      .map(item => summaryKey({id: eventId(item), reports: [item]})).filter(Boolean));
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
    const lostTopic = selectedTopic && !topics.some(topic => topic.id === selectedTopic);
    const published = items.map(item => Date.parse(text(item?.published))).filter(Number.isFinite);
    latestPublished = published.length ? Math.max(...published) : null;
    const presentEvents = new Set(items.filter(item => item && typeof item === "object").map(eventId).filter(Boolean));
    for (const id of expanded) if (!presentEvents.has(id)) expanded.delete(id);
    const events = body.events && typeof body.events === "object" ? body.events : {};
    eventsPending = Number.isInteger(events.pending) && events.pending > 0 ? events.pending : 0;
    const previous = sources.value;
    const records = Array.isArray(body.sources) ? body.sources : [];
    const options = new Map([...sources.options].map(option => [option.value, option]));
    all.textContent = `全部來源 ${items.filter(item => item && typeof item === "object").length}`;
    const names = new Set();
    for (const source of records) {
      const name = text(source?.name);
      if (!name || names.has(name)) continue;
      names.add(name);
      const option = options.get(name) || document.createElement("option");
      option.value = name;
      const count = Number.isSafeInteger(source.count) && source.count >= 0 ? source.count : 0;
      option.textContent = `${name} ${count}${source.ok === false ? "（失敗）" : ""}`;
      const position = sources.options[names.size];
      if (position !== option) sources.insertBefore(option, position || null);
    }
    for (const option of [...sources.options]) if (option !== all && !names.has(option.value)) option.remove();
    sourceOrder = new Map([...names].map((name, i) => [name, i]));
    sources.value = names.has(previous) ? previous : "";
    const failed = records.filter(source => source?.ok === false);
    const failureName = source => text(source.name) || "未命名來源";
    const classify = body.classify && typeof body.classify === "object" ? body.classify : {};
    analysisEnabled = classify.enabled !== false;
    const pending = Number.isInteger(classify.pending) && classify.pending >= 0 ? classify.pending : 0;
    classificationText = classify.enabled === false ? "分類：關閉"
      : modelState !== "working" && pending > 0 ? `未分類：${pending}` : "";
    const updated = localTime(body.at);
    const at = Date.parse(text(body.at));
    historyAt = Number.isFinite(at) ? at : Date.now();
    updatedText = updated ? `${updated} 更新` : "";
    failedText = failed.length === 1 ? `${failureName(failed[0])} 失敗`
      : failed.length > 1 ? `${failureName(failed[0])}等 ${failed.length} 個來源失敗` : "";
    status.title = failed.map(source => `${failureName(source)}${typeof source.error === "string"
      ? `：${Array.from(source.error).slice(0, 80).join("")}` : ""}`).join("\n");
    if (lostTopic) returnToView(true);
    else drawItems();
  }
  list.addEventListener("click", onExpand);
  list.addEventListener("click", onSummary);
  focusList.addEventListener("click", onFocus);
  clearAll.addEventListener("click", onClearAll);
  ranking.addEventListener("click", onTheme);
  clearTheme.addEventListener("click", onClearTheme);
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
    refresh.disabled = refreshTimer !== null;
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
      expanded.clear();
      sourceOrder.clear();
      clearAll.removeEventListener("click", onClearAll);
      ranking.removeEventListener("click", onTheme);
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
