// Pure selection/counting. No DOM, storage, timers, or mutation of input reports.
import {categoryNames, themeNames, regionTopics, issueTopics, financial,
  validAnalysis, topicOf, eventId, searchText} from './labels.js';

import {contributes} from './panel.js';
export {contributes} from './panel.js';

const text = value => typeof value === 'string' ? value : '';
export const reportTime = item => {
  const value = Date.parse(text(item.published));
  return Number.isFinite(value) ? value : Infinity;
};
export const isNew = (item, lastSeen) => lastSeen !== null && Date.parse(text(item.published)) > lastSeen;

export function groupItems(items, sourceOrder = new Map()) {
  const groups = new Map();
  for (const item of items) {
    const id = eventId(item), key = id || Symbol();
    if (!groups.has(key)) groups.set(key, {id, reports: []});
    groups.get(key).reports.push(item);
  }
  for (const group of groups.values()) group.reports.sort((a, b) => reportTime(a) - reportTime(b)
    || ((sourceOrder.get(text(a.source)) ?? Infinity) - (sourceOrder.get(text(b.source)) ?? Infinity)) || 0);
  return [...groups.values()];
}

export function facetCounts(items, {source = '', category = ''} = {}) {
  const categories = new Map([['', new Set()]]), sources = new Map([['', new Set()]]);
  const add = (map, name, key) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(key);
  };
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = eventId(item) || Symbol();
    if (!source || text(item.source) === source) {
      add(categories, '', key);
      // Unknown/pending categories are not "other".
      if (categoryNames.has(item.category)) add(categories, item.category, key);
    }
    if (!category || text(item.category) === category) {
      add(sources, '', key);
      if (text(item.source)) add(sources, item.source, key);
    }
  }
  return {categories: new Map([...categories].map(([k,v]) => [k,v.size])),
    sources: new Map([...sources].map(([k,v]) => [k,v.size]))};
}

export function selectScope(items, state = {}, lastSeen = null, context = {}) {
  const {source = '', category = '', topic = '', onlyNew = false, onlyWatched = false,
    search = '', trackedWords = []} = state;
  const {sourceOrder = new Map(), sourceOutlets = new Map(), searchIndex} = context;
  const available = items.filter(item => item && typeof item === 'object');
  const group = reports => groupItems(reports, sourceOrder);
  const fresh = item => isNew(item, lastSeen);
  const outletOf = item => sourceOutlets.get(text(item.source)) || text(item.source);
  let theme = state.theme || '', count = state.count || null;
  const applicable = category === 'politics' ? issueTopics : category === 'world' ? regionTopics
    : financial(category) ? themeNames : new Map();
  if (theme && !applicable.has(theme)) theme = '';
  if (count && count.category !== category) count = null;
  const scopeTopic = topic || count?.topic || '';
  const outlet = scopeTopic ? state.outlet || '' : '';
  const chronological = Boolean(scopeTopic && state.chronological);
  let scoped = available.filter(item => (!source || text(item.source) === source)
    && (!category || text(item.category) === category) && (!scopeTopic || item.topic === scopeTopic));
  // Theme validity is checked before outlet/new restrictions, as in the UI.
  if (theme && !scoped.some(item => topicOf(validAnalysis(item)) === theme)) theme = '';
  if (outlet) scoped = scoped.filter(item => outletOf(item) === outlet);
  if (onlyNew) {
    const eligible = new Set(group(scoped).filter(g => g.reports.some(fresh)).flatMap(g => g.reports));
    scoped = scoped.filter(item => eligible.has(item));
  }
  const query = searchText(search).trim();
  const searchHits = new Set(available.filter(item => !query || (searchIndex?.get(item)
    || [searchText(item.title), searchText(item.summary)]).some(value => value.includes(query))));
  const watchMatch = g => trackedWords.find(word => g.reports.some(item =>
    text(item.title).toLowerCase().includes(word.toLowerCase()) || text(item.summary).toLowerCase().includes(word.toLowerCase())));
  const allGroups = group(scoped.filter(item => !theme || topicOf(validAnalysis(item)) === theme))
    .filter(g => !count || contributes(g, count.id, category));
  const groupIndices = new Map(allGroups.map((g,i) => [g,i]));
  const matches = new Map(allGroups.map(g => [g,watchMatch(g)]));
  const searched = allGroups.filter(g => g.reports.some(item => searchHits.has(item)));
  const watchedCount = searched.filter(g => matches.get(g) && (!onlyNew || g.reports.some(fresh))).length;
  const matched = searched.filter(g => !onlyWatched || matches.get(g));
  const newCount = matched.filter(g => g.reports.some(fresh)).length;
  const listGroups = matched.filter(g => !onlyNew || g.reports.some(fresh));
  if (chronological) listGroups.sort((a,b) => reportTime(a.reports[0]) - reportTime(b.reports[0]));

  const overview = new Map(['finance','world'].map(kind => {
    let groups = group(available.filter(item => text(item.category) === kind && (!source || text(item.source) === source)));
    if (onlyNew) groups = groups.filter(g => g.reports.some(fresh));
    return [kind, {total: groups.length, analyzed: groups.filter(g => g.reports.some(item => validAnalysis(item))).length,
      up: groups.filter(g => contributes(g,'signal:0',kind)).length,
      down: groups.filter(g => contributes(g,kind === 'world' ? 'signal:2' : 'signal:3',kind)).length}];
  }));
  let topicSummary = null;
  if (scopeTopic) {
    const members = available.filter(item => item.topic === scopeTopic);
    const order = new Map();
    for (const item of members) {
      const name = outletOf(item);
      if (name) order.set(name, Math.min(order.get(name) ?? Infinity, sourceOrder.get(text(item.source)) ?? Infinity));
    }
    // Counterfactual outlet buttons ignore source/outlet selection, but retain
    // category/theme/count/search/new/watch restrictions. Count only that outlet.
    const ranked = [...order.keys()].map(name => {
      const reports = group(members.filter(item => outletOf(item) === name
        && (!category || item.category === category) && (!theme || topicOf(validAnalysis(item)) === theme)))
        .filter(g => (!count || contributes(g,count.id,category)) && (!onlyNew || g.reports.some(fresh))
          && g.reports.some(item => searchHits.has(item)) && (!onlyWatched || watchMatch(g)))
        .flatMap(g => g.reports);
      return [name,reports];
    }).sort((a,b) => b[1].length-a[1].length || order.get(a[0])-order.get(b[0]));
    topicSummary = {members, events: group(members).length, reports: members.length, outlets: order.size,
      visibleEvents: listGroups.length, visibleReports: listGroups.reduce((n,g) => n+g.reports.length,0), ranked};
  }
  return {scoped, listGroups, allGroups, groupIndices, matches, searchHits, query, scopeTopic,
    normalized: {theme, count, outlet, chronological}, facets: facetCounts(available,{source,category}),
    newCount, watchedCount, searchCount: listGroups.length, overview, topicSummary};
}
