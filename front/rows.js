// Builds one already-selected event group; owns no filters, cache or listeners.
import {categoryNames, themeNames, regionNames, issueNames, validAnalysis, arrow} from "./labels.js";

export function createRowBuilder({document, make, text, describe, groupTime, appendTone,
  newsTitle, newsTime, isNew, summaryKey, summaryParts}) {
  function build(group, {query, hits, watchMatch, categoryFilter, modelState,
    analysisEnabled, classificationPending, marked, expanded, onlyNew}) {
    const item = group.reports[0];
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
    if (watchMatch) info.append(make("span", "nw-watch", `追蹤：${watchMatch}`));
    if (analysis?.kind === "politics") {
      if (categoryFilter === "politics") info.append(make("span", "nw-tag", issueNames.get(analysis.issue)));
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
    if (!categoryFilter) info.append(make("span", "nw-category", categoryNames.get(category) || (modelState === "working" && analysisEnabled && classificationPending > 0 && (item.category == null || item.category === "") ? "分類中" : "未分類")));
    info.append(make("span", "nw-source", text(item.source)), groupTime(group.reports));
    appendTone(info, item, group.reports);
    row.append(newsTitle(item, "nw-title", marked), meta);
    let latest = item, latestTime = Date.parse(text(item.published));
    for (const report of group.reports) {
      const time = Date.parse(text(report.published));
      if (Number.isFinite(latestTime) && time > latestTime) { latest = report; latestTime = time; }
    }
    let latestLink = null;
    if (latest !== item && text(latest.title) && text(latest.title) !== text(item.title)) {
      const link = newsTitle({...latest, title: `最新：${text(latest.title)}（${text(latest.source)}）`},
        "nw-hint nw-event-latest", false);
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
      const open = expanded || Boolean(query && group.reports.slice(1).some(hits));
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
    return {row, markers, latest, latestLink, toggle: row.querySelector(".nw-expand"), reports: row.querySelector(".nw-reports")};
  }
  function update(cached, group, {query, hits, marked, expanded}) {
    for (const [report, marker, parent] of cached.markers) {
      const hit = Boolean(query && hits(report));
      if (hit && !marker.parentNode) parent.prepend(marker);
      else if (!hit) marker.remove();
    }
    if (cached.toggle) {
      const open = expanded || Boolean(query && group.reports.slice(1).some(hits));
      cached.toggle.setAttribute("aria-expanded", String(open));
      cached.reports.hidden = !open;
    }
    if (cached.latestLink) cached.latestLink.hidden = Boolean(query && hits(cached.latest));
    const title = cached.row.querySelector(".nw-title");
    const badge = title.querySelector(".nw-new");
    if (marked && !badge) title.prepend(make("span", "nw-new", "新"));
    else if (!marked) badge?.remove();
    return cached.row;
  }
  return {build, update};
}
