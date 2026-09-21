// Block 1: lifecycle and UI skeleton; list rendering comes in a later block.
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
  function onRefresh() {
    if (up && !disposed) ctx.channel.send({ op: "refresh" });
  }
  function renderList(_body) {
    // Deliberately empty until the list-rendering block.
  }
  refresh.addEventListener("click", onRefresh);
  ctx.channel.onMessage((body) => {
    if (!disposed && body && body.op === "list") renderList(body);
  });
  ctx.onUp(() => {
    if (disposed) return;
    up = true;
    refresh.disabled = false;
    status.textContent = "協定已就緒；抓取尚未實作";
  });
  ctx.report("ready");
  return {
    unmount() {
      disposed = true;
      up = false;
      refresh.disabled = true;
      refresh.removeEventListener("click", onRefresh);
      root.remove();
    },
  };
}
