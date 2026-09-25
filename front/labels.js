export const categoryNames = new Map([
  ["politics", "政治"], ["finance", "財經"], ["tech", "科技"],
  ["world", "國際"], ["society", "社會"], ["life", "生活"],
  ["sports", "體育"], ["entertainment", "娛樂"], ["other", "其他"],
]);

export const themeNames = new Map([
  ["foundry", "晶圓代工"], ["ic_design", "IC 設計"], ["memory", "記憶體"],
  ["packaging", "先進封裝"], ["semi_equip", "半導體設備材料"], ["ai_server", "AI 伺服器"],
  ["cooling", "散熱"], ["pcb", "PCB／被動元件"], ["optical", "光通訊"],
  ["display", "光電面板"], ["leo", "低軌衛星"], ["energy", "能源"],
  ["ev", "電動車"], ["financials", "金融"], ["property", "營建房產"],
  ["transport", "航運航空"], ["consumer_elec", "消費電子"], ["petrochem", "原物料傳產"],
  ["software", "軟體網路"], ["industrial", "工業電腦"], ["macro", "大盤／總經"], ["other", "其他"],
]);
export const regionNames = new Map([
  ["us_china", "美中"], ["asia_pacific", "亞太"], ["middle_east", "中東"],
  ["europe_russia", "歐洲／俄烏"], ["americas", "美洲"], ["other", "其他"],
]);
export const regionTopics = new Map([...regionNames].map(([id, name]) => [`region:${id}`, name]));
export const issueNames = new Map([
  ["cross_strait", "兩岸"], ["us_intl", "美國與國際"], ["defense", "國防"], ["election", "選舉"],
  ["budget", "預算與補貼"], ["legislature", "立法院"], ["justice", "司法"],
  ["energy_env", "能源環境"], ["local", "地方施政"], ["other", "其他"],
]);
export const issueTopics = new Map([...issueNames].map(([id, name]) => [`issue:${id}`, name]));
export const topicNames = new Map([...themeNames, ...regionTopics, ...issueTopics]);
export const trendIds = new Set(["escalation", "stalemate", "deescalation", "not_conflict", "other"]);
export const marketIds = new Set(["positive", "negative", "mixed", "not_market", "other"]);
export const directionIds = new Set(["bull", "bear", "mixed", "neutral"]);
export const financial = category => category === "finance" || category === "tech";
export function validAnalysis(item) {
  const value = item.analysis;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = Object.hasOwn(value, "kind") ? value.kind : "finance";
  if (kind === "politics") {
    return item.category === "politics" && typeof value.issue === "string" && issueNames.has(value.issue) ? value : null;
  }
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
export function topicOf(analysis) {
  return analysis?.kind === "politics" ? `issue:${analysis.issue}`
    : analysis?.kind === "world" ? `region:${analysis.region}` : analysis?.theme;
}
export function arrow(analysis) {
  if (!analysis || analysis.dir_p < 0.6) return "";
  return analysis.dir === "bull" ? "▲" : analysis.dir === "bear" ? "▼" : "";
}

export function eventId(item) {
  return typeof item.event === "string" && item.event.length === 12 && /^[0-9a-f]{12}$/i.test(item.event)
    && Number.isInteger(item.event_size) && item.event_size > 0 ? item.event.toLowerCase() : null;
}

