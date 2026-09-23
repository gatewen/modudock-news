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

export default function mount(ctx) {
  const document = ctx.container.ownerDocument;
  const root = document.createElement("section");
  const toolbar = document.createElement("div");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "重新整理";
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
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.textContent = "等待模組就緒";
  const list = document.createElement("ul");
  list.setAttribute("aria-label", "新聞清單");
  const themeFilter = document.createElement("div");
  themeFilter.hidden = true;
  const themeLabel = document.createElement("span");
  const clearTheme = document.createElement("button");
  clearTheme.type = "button";
  clearTheme.textContent = "✕";
  clearTheme.setAttribute("aria-label", "取消題材篩選");
  themeFilter.append(themeLabel, clearTheme);
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "財經分析");
  panel.hidden = true;
  const sample = document.createElement("p");
  const market = document.createElement("p");
  const macro = document.createElement("p");
  const ranking = document.createElement("div");
  ranking.setAttribute("aria-label", "題材排行");
  const note = document.createElement("small");
  note.textContent = "篇數是報導數，同一事件多家報導會重複計算。";
  panel.append(sample, market, macro, ranking, note);
  toolbar.append(refresh, sources, categories, status);
  root.append(toolbar, themeFilter, panel, list);
  ctx.container.append(root);

  let up = false;
  let disposed = false;
  let items = [];
  let selectedTheme = "";
  let analysisEnabled = true;
  const text = (value) => typeof value === "string" ? value : "";
  const localTime = (value) => {
    if (!text(value)) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  function onRefresh() {
    if (up && !disposed) ctx.channel.send({ op: "refresh" });
  }
  function drawPanel(scoped) {
    panel.hidden = !financial(categories.value);
    themeFilter.hidden = panel.hidden || !selectedTheme;
    themeLabel.textContent = selectedTheme ? `題材：${themeNames.get(selectedTheme)} ` : "";
    ranking.replaceChildren();
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
    sample.textContent = `樣本：${scoped.length} 則・${sourceCount} 個來源・分析中 ${pending}`
      + (scoped.length < 10 ? "・樣本少，僅供參考" : "");
    market.textContent = `股市訊號：正面 ${counts.positive}・負面 ${counts.negative}・正反 ${counts.mixed}・無關 ${counts.not_market}・未明 ${counts.other}`;
    const total = themes.get("macro");
    macro.textContent = `大盤／總經：${total.count} 則（利多 ${total.bull}・利空 ${total.bear}）`;
    // Stable sorting preserves the fixed table order for equal counts.
    const ranked = [...themes].filter(([id, count]) => id !== "macro" && id !== "other" && count.count)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    if (!ranked.length) ranking.textContent = "題材：尚無";
    for (const [id, count] of ranked) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.theme = id;
      button.setAttribute("aria-pressed", String(selectedTheme === id));
      const directions = [count.bull ? `▲${count.bull}` : "", count.bear ? `▼${count.bear}` : ""].filter(Boolean).join(" ");
      button.textContent = `${themeNames.get(id)} ${count.count}` + (directions ? `（${directions}）` : "");
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
      const row = document.createElement("li");
      let label = categoryNames.get(category) || "未分類";
      if (analysis && analysis.theme !== "other") {
        const direction = arrow(analysis);
        label += `｜${themeNames.get(analysis.theme)}` + (direction ? ` ${direction}` : "");
      }
      row.textContent = `[${label}] ${text(item.source)} · ${localTime(item.published)} · `;
      let safeURL = null;
      try {
        const url = new URL(text(item.link));
        if (url.protocol === "http:" || url.protocol === "https:") safeURL = url.href;
      } catch { /* Invalid and relative links stay plain text. */ }
      const title = document.createElement(safeURL ? "a" : "span");
      title.textContent = text(item.title);
      title.title = text(item.summary);
      if (safeURL) {
        title.href = safeURL;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }
      row.append(title);
      list.append(row);
    }
  }
  function renderList(body) {
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
    const classification = classify.enabled === false ? "分類：關閉" : `未分類：${pending}`;
    status.textContent = `更新：${text(body.at)} · 失敗來源：${failed} · ${classification}`;
    drawItems();
  }
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
      ranking.removeEventListener("click", onTheme);
      clearTheme.removeEventListener("click", onClearTheme);
      selectedTheme = "";
      items = [];
      root.remove();
    },
  };
}
