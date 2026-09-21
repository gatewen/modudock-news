// Native ES module; untrusted feed fields are only assigned as text.
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
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.textContent = "等待模組就緒";
  const list = document.createElement("ul");
  list.setAttribute("aria-label", "新聞清單");
  toolbar.append(refresh, sources, status);
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
      const row = document.createElement("li");
      row.textContent = `${text(item.source)} · ${localTime(item.published)} · `;
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
    status.textContent = `更新：${text(body.at)} · 失敗來源：${failed}`;
    drawItems();
  }
  refresh.addEventListener("click", onRefresh);
  sources.addEventListener("change", drawItems);
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
      items = [];
      root.remove();
    },
  };
}
