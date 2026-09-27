// Pure aggregates over already scoped, chronologically ordered event groups.
import {themeNames, regionTopics, issueTopics, validAnalysis, topicOf, arrow} from './labels.js';

const text = value => typeof value === 'string' ? value : '';

export function contributes(group, id, category) {
  const analysis = group.reports.map(validAnalysis).find(Boolean);
  if (!analysis) return false;
  if (id.startsWith('signal:')) {
    const signal = category === 'world' ? analysis.trend : analysis.market;
    const index = category === 'world'
      ? {escalation: 0, stalemate: 1, deescalation: 2}[signal]
      : {positive: 0, mixed: 1, negative: 3}[signal];
    return Number(id.slice(7)) === (index ?? (category === 'world' ? 3 : 2));
  }
  return analysis.theme === 'macro' && (id === 'macro:all'
    || arrow(analysis) === (id === 'macro:bull' ? '▲' : '▼'));
}

export function aggregatePanel(groups, category) {
  const world = category === 'world', politics = category === 'politics';
  const names = politics ? issueTopics : world ? regionTopics : themeNames;
  const counts = {escalation: 0, stalemate: 0, deescalation: 0, not_conflict: 0,
    positive: 0, negative: 0, mixed: 0, not_market: 0, other: 0};
  const themes = new Map([...names.keys()].map(id => [id, {count: 0, bull: 0, bear: 0}]));
  let pending = 0;
  for (const group of groups) {
    const analysis = group.reports.map(validAnalysis).find(Boolean);
    if (!analysis) { pending++; continue; }
    if (!politics) counts[world ? analysis.trend : analysis.market]++;
    const theme = themes.get(topicOf(analysis));
    theme.count++;
    const direction = politics ? '' : arrow(analysis);
    if (world ? analysis.trend === 'escalation' : direction === '▲') theme.bull++;
    if (world ? analysis.trend === 'deescalation' : direction === '▼') theme.bear++;
  }
  const reports = groups.flatMap(group => group.reports);
  const sourceCount = new Set(reports.map(item => text(item.source)).filter(Boolean)).size;
  const analyzed = groups.length - pending;
  const values = Array.from({length: 4}, (_, i) => groups.filter(group => contributes(group, `signal:${i}`, category)).length);
  const macro = {count: groups.filter(group => contributes(group, 'macro:all', category)).length,
    bull: groups.filter(group => contributes(group, 'macro:bull', category)).length,
    bear: groups.filter(group => contributes(group, 'macro:bear', category)).length};
  macro.remainder = macro.count - macro.bull - macro.bear;
  // Stable sorting retains the fixed table order; region/issue other is last.
  const ranked = [...themes].filter(([id, count]) => id !== 'macro' && id !== 'other' && count.count)
    .sort((a,b) => a[0].endsWith(':other') - b[0].endsWith(':other') || b[1].count - a[1].count).slice(0,10);
  const largestCount = Math.max(0, ...ranked.map(([, count]) => count.count));
  for (const [, count] of ranked) {
    count.width = count.count / largestCount * 100;
    count.widths = (politics ? [count.count] : [count.bull, count.bear, count.count-count.bull-count.bear])
      .map(value => value / count.count * 100);
  }
  return {events: groups.length, reports: reports.length, sourceCount, analyzed, pending, counts, values,
    widths: values.map(value => analyzed ? value / analyzed * 100 : 0), macro, ranked};
}

export function aggregateHistory(groups, category, at) {
  const world = category === 'world';
  const step = 6 * 60 * 60 * 1000, start = at - 4 * step;
  const buckets = Array.from({length: 4}, () => ({values: [0,0,0,0], valid: 0}));
  for (const group of groups) {
    const stamp = Date.parse(text(group.reports[0].published));
    if (!Number.isFinite(stamp) || stamp < start || stamp > at) continue;
    const bucket = buckets[Math.min(3, Math.floor((stamp-start)/step))];
    const analysis = group.reports.map(validAnalysis).find(Boolean);
    if (!analysis) continue;
    bucket.valid++;
    const signal = world ? analysis.trend : analysis.market;
    const index = world ? {escalation: 0, stalemate: 1, deescalation: 2}[signal]
      : {positive: 0, mixed: 1, negative: 3}[signal];
    bucket.values[index ?? (world ? 3 : 2)]++;
  }
  for (const [i, bucket] of buckets.entries()) {
    bucket.from = start + i * step;
    bucket.to = start + (i+1) * step;
    bucket.total = bucket.values.reduce((sum, n) => sum+n, 0);
    bucket.denominator = bucket.total - bucket.values[world ? 3 : 2];
    bucket.insufficient = bucket.valid < 5;
    bucket.mode = bucket.insufficient ? 'insufficient' : !bucket.denominator ? 'empty'
      : bucket.denominator < 5 ? 'count' : 'percent';
    bucket.percent = bucket.denominator ? Math.round(bucket.values[0] / bucket.denominator * 100) : null;
    bucket.widths = bucket.values.map(value => bucket.total ? value / bucket.total * 100 : 0);
  }
  return {buckets, collapsed: buckets.filter(bucket => bucket.valid < 5).length >= 3};
}
