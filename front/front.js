// Native ES module; untrusted feed fields are only assigned as text.
const categoryNames = new Map([
  ["politics", "政治"], ["finance", "財經"], ["tech", "科技"],
  ["world", "國際"], ["society", "社會"], ["life", "生活"],
  ["sports", "體育"], ["entertainment", "娛樂"], ["other", "其他"],
]);

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
  toolbar.append(refresh, sources, categories, status);
  root.append(toolbar, list);
  ctx.container.append(root);

  let up = false;
  let disposed = false;
  let items = [];
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
  function drawItems() {
    list.replaceChildren();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (sources.value && text(item.source) !== sources.value) continue;
      const category = text(item.category);
      if (categories.value && category !== categories.value) continue;
      const row = document.createElement("li");
      row.textContent = `[${categoryNames.get(category) || "未分類"}] ${text(item.source)} · ${localTime(item.published)} · `;
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
    const pending = Number.isInteger(classify.pending) && classify.pending >= 0 ? classify.pending : 0;
    const classification = classify.enabled === false ? "分類：關閉" : `未分類：${pending}`;
    status.textContent = `更新：${text(body.at)} · 失敗來源：${failed} · ${classification}`;
    drawItems();
  }
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
      items = [];
      root.remove();
    },
  };
}
