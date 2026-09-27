import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectScope, groupItems, contributes, facetCounts, isNew} from '../front/scope.js';

const id = n => n.toString(16).padStart(12,'0');
const baseTime = Date.parse('2026-09-27T01:00:00Z');
const finance = (theme='memory', market='positive', dir='bull') => ({kind:'finance',theme,market,dir,dir_p:.9});
const row = (n, changes={}) => ({title:`News ${n}`,summary:'',source:'A',category:'finance',topic:'topic',
  link:`https://example.test/${n}`,published:new Date(baseTime+n*1000).toISOString(),
  event:id(n),event_size:1,analysis:finance(),...changes});
const ids = selection => selection.listGroups.map(g=>g.reports.map(r=>r.link));
const order = new Map([['A',0],['B',1],['C',2]]);
const context = {sourceOrder:order,sourceOutlets:new Map([['A','One'],['B','One'],['C','Two']])};

test('scope is DOM-free and does not mutate items, state or ordering maps',()=>{
  const source=readFileSync(new URL('../front/scope.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:document|window|localStorage|setTimeout|innerHTML)\b/);
  const items=[row(2),row(1)];for(const item of items){Object.freeze(item.analysis);Object.freeze(item);}Object.freeze(items);
  const state=Object.freeze({topic:'topic',chronological:true});
  const before=JSON.stringify(items), orders=[...order];
  assert.equal(selectScope(items,state,null,context).listGroups[0].reports[0],items[1]);
  assert.equal(JSON.stringify(items),before);assert.deepEqual([...order],orders);
});

test('scope intersects source and category, before grouping',()=>{
  const a=row(1),b=row(2,{source:'B'}),c=row(3,{category:'tech'});
  const result=selectScope([a,b,c],{source:'A',category:'finance'});
  assert.deepEqual(result.scoped,[a]);assert.deepEqual(ids(result),[[a.link]]);
});

test('scope grouping validates event metadata and picks earliest then feed order',()=>{
  const a=row(1,{source:'B'}),b=row(2,{event:id(1),published:a.published}),c=row(3,{event:'bad'}),d=row(4,{event:'bad'});
  const g=groupItems([a,b,c,d],order);
  assert.equal(g.length,3);assert.deepEqual(g[0].reports,[b,a]);
  assert.equal(groupItems([row(5,{event_size:0}),row(6,{event:id(5),event_size:0})]).length,2);
  assert.equal(groupItems([a,row(7,{event:id(1),published:'bad'})],order)[0].reports[0],a);
});

test('scope theme matches reports without shrinking panel scope',()=>{
  const a=row(1),b=row(2,{event:id(1),analysis:finance('macro')}),c=row(3,{analysis:finance('macro')});
  const r=selectScope([a,b,c],{category:'finance',theme:'memory'});
  assert.deepEqual(r.scoped,[a,b,c]);assert.deepEqual(ids(r),[[a.link]]);
  assert.equal(r.normalized.theme,'memory');
  assert.equal(selectScope([a],{category:'world',theme:'memory'}).normalized.theme,'');
});

test('scope count uses earliest analyzed report, and missing is not unrelated',()=>{
  const missing=row(1,{analysis:null}),negative=row(2,{event:id(1),analysis:finance('macro','negative','bear')}),positive=row(3);
  const r=selectScope([missing,negative,positive],{category:'finance',count:{category:'finance',id:'signal:3'}});
  assert.deepEqual(ids(r),[[missing.link,negative.link]]);
  assert.equal(contributes({reports:[missing]},'signal:2','finance'),false);
  assert.equal(contributes({reports:[negative]},'macro:bear','finance'),true);
  assert.equal(contributes({reports:[negative]},'macro:bull','finance'),false);
  assert.equal(contributes({reports:[positive]},'macro:all','finance'),false);
});

test('scope captured numeric topic survives while invalid count category clears',()=>{
  const a=row(1),b=row(2,{topic:'other'});
  const r=selectScope([a,b],{category:'finance',count:{category:'finance',id:'signal:0',topic:'topic'}});
  assert.equal(r.scopeTopic,'topic');assert.deepEqual(ids(r),[[a.link]]);
  const reset=selectScope([a,b],{category:'finance',count:{category:'world',id:'signal:0',topic:'topic'}});
  assert.equal(reset.normalized.count,null);assert.equal(reset.listGroups.length,2);
});

test('scope outlet merges feeds and remains topic-local',()=>{
  const a=row(1),b=row(2,{source:'B'}),c=row(3,{source:'C'});
  const r=selectScope([a,b,c],{topic:'topic',outlet:'One'},null,context);
  assert.deepEqual(r.scoped,[a,b]);assert.equal(r.topicSummary.outlets,2);
  assert.deepEqual(r.topicSummary.ranked.map(([name,reports])=>[name,reports.length]),[['One',2],['Two',1]]);
  const clear=selectScope([a,b,c],{outlet:'One',chronological:true},null,context);
  assert.equal(clear.listGroups.length,3);assert.equal(clear.normalized.outlet,'');assert.equal(clear.normalized.chronological,false);
});

test('scope search normalizes fullwidth/zero-width and keeps a matching child event',()=>{
  const a=row(1),b=row(2,{event:id(1),summary:'ＡＩ 台\u200b積電'}),c=row(3);
  const r=selectScope([a,b,c],{search:'ai 台積電'});
  assert.deepEqual(ids(r),[[a.link,b.link]]);assert.deepEqual(r.scoped,[a,b,c]);
  assert.equal(r.searchCount,1);assert.equal(r.searchHits.has(a),false);assert.equal(r.searchHits.has(b),true);
});

test('scope watch count includes search/new intersections and list retains siblings',()=>{
  const a=row(1,{title:'KEEP old'}),b=row(2,{event:id(1),title:'query',published:new Date(baseTime+10000).toISOString()}),
    c=row(3,{title:'KEEP wrong'}),d=row(4,{title:'query untracked'});
  const r=selectScope([a,b,c,d],{search:'query',trackedWords:['keep'],onlyWatched:true,onlyNew:true},baseTime+5000);
  assert.deepEqual(ids(r),[[a.link,b.link]]);assert.equal(r.watchedCount,1);assert.equal(r.newCount,1);
  assert.equal(r.matches.get(r.listGroups[0]),'keep');
});

test('scope new progress keeps old representatives but theme must itself contribute new reports',()=>{
  const a=row(1),b=row(9,{event:id(1),analysis:finance('macro')});
  const r=selectScope([a,b],{category:'finance',theme:'memory',onlyNew:true},baseTime+5000);
  assert.deepEqual(r.scoped,[a,b]);assert.equal(r.normalized.theme,'memory');assert.equal(r.listGroups.length,0);
  assert.equal(r.newCount,0);
  const whole=selectScope([a,b],{onlyNew:true},baseTime+5000);
  assert.deepEqual(ids(whole),[[a.link,b.link]]);
  assert.equal(isNew(b,null),false);assert.equal(isNew(b,Date.parse(b.published)),false);
});

test('scope watch/new are an intersection and toggle counts equal matching events',()=>{
  const a=row(1,{title:'keep'}),b=row(9,{title:'keep'}),c=row(10);
  const all=selectScope([a,b,c],{trackedWords:['keep']},baseTime+5000);
  assert.equal(all.watchedCount,2);assert.equal(all.newCount,2);
  const watch=selectScope([a,b,c],{trackedWords:['keep'],onlyWatched:true},baseTime+5000);
  assert.equal(watch.newCount,1);assert.equal(watch.listGroups.length,2);
  const both=selectScope([a,b,c],{trackedWords:['keep'],onlyWatched:true,onlyNew:true},baseTime+5000);
  assert.deepEqual(ids(both),[[b.link]]);assert.equal(both.watchedCount,1);
});

test('scope chronological order uses oldest report of each event only within a topic',()=>{
  const a=row(9),b=row(1),c=row(10,{event:id(1)});
  const r=selectScope([a,b,c],{topic:'topic',chronological:true});
  assert.deepEqual(ids(r),[[b.link,c.link],[a.link]]);
  assert.deepEqual(ids(selectScope([a,b,c],{chronological:true})),[[a.link],[b.link,c.link]]);
});

test('scope facets are cross-filtered event counts; pending is not other',()=>{
  const a=row(1),b=row(2,{event:id(1),source:'B'}),c=row(3,{source:'B',category:'tech'}),
    d=row(4,{category:''}),e=row(5,{category:'other'});
  const r=facetCounts([a,b,c,d,e],{source:'A',category:'finance'});
  assert.equal(r.categories.get(''),3);assert.equal(r.categories.get('finance'),1);
  assert.equal(r.categories.get('other'),1);assert.equal(r.categories.get('tech')||0,0);
  assert.equal(r.sources.get(''),1);assert.equal(r.sources.get('A'),1);assert.equal(r.sources.get('B'),1);
});

test('scope overview shares panel representative/source/new rules and ignores search',()=>{
  const a=row(1,{analysis:finance('memory','negative','bear')}),b=row(2,{event:id(1),analysis:null}),
    c=row(3,{source:'B'}),d=row(9,{category:'world',analysis:{kind:'world',region:'asia_pacific',trend:'deescalation'}});
  const r=selectScope([a,b,c,d],{source:'A',search:'no match'},baseTime+5000);
  assert.equal(r.listGroups.length,0);assert.deepEqual(r.overview.get('finance'),{total:1,analyzed:1,up:0,down:1});
  assert.equal(r.overview.get('world').down,1);
  assert.equal(selectScope([a,b,c,d],{source:'A',onlyNew:true},baseTime+5000).overview.get('finance').total,0);
});

test('scope topic total is stable and outlet counterfactual retains full filter intersection',()=>{
  const a=row(1,{title:'keep query'}),b=row(2,{event:id(1),source:'B'}),c=row(3,{source:'C',title:'keep query'}),
    d=row(4,{source:'C',title:'keep unrelated'});
  const r=selectScope([a,b,c,d],{topic:'topic',category:'finance',outlet:'One',search:'query',onlyWatched:true,trackedWords:['keep']},null,context);
  assert.deepEqual([r.topicSummary.events,r.topicSummary.reports,r.topicSummary.outlets],[3,4,2]);
  assert.deepEqual([r.topicSummary.visibleEvents,r.topicSummary.visibleReports],[1,2]);
  assert.deepEqual(r.topicSummary.ranked.map(([name,reports])=>[name,reports.length]),[['One',2],['Two',1]]);
});

test('scope outlet counts apply numeric category and theme at report level',()=>{
  const a=row(1),b=row(2,{source:'B',analysis:finance('macro')}),c=row(3,{source:'C',analysis:finance('memory','negative','bear')});
  const r=selectScope([a,b,c],{topic:'topic',category:'finance',theme:'memory',count:{category:'finance',id:'signal:0'}},null,context);
  assert.deepEqual(r.topicSummary.ranked.map(([name,reports])=>[name,reports.length]),[['One',1],['Two',0]]);
});

test('scope recomputes after partial classification without carrying caches across snapshots',()=>{
  const a=row(1,{category:'',analysis:null}),b=row(2,{category:'other',analysis:null});
  assert.equal(selectScope([a,b]).facets.categories.get('other'),1);
  assert.equal(selectScope([a,b]).overview.get('finance').analyzed,0);
  const next={...a,category:'finance',analysis:finance()};
  assert.equal(selectScope([next,b]).facets.categories.get('finance'),1);
  assert.equal(selectScope([next,b]).facets.categories.get('other'),1);
  assert.equal(selectScope([next,b]).overview.get('finance').analyzed,1);
});

test('scope query itself folds fullwidth and zero-width separators',()=>{
  const a=row(1,{summary:'AI 台積電'}),b=row(2,{summary:'AI unrelated'});
  assert.deepEqual(ids(selectScope([a,b],{search:'ＡＩ　台\u200b積電'})),[[a.link]]);
});

test('scope new panel removes old-only events while search still leaves panel intact',()=>{
  const old=row(1),fresh=row(9);
  const r=selectScope([old,fresh],{onlyNew:true,search:'not found'},baseTime+5000);
  assert.deepEqual(r.scoped,[fresh]);assert.equal(r.listGroups.length,0);
});

test('scope watch toggle count excludes fresh tracked events outside search',()=>{
  const hit=row(9,{title:'keep needle'}),miss=row(10,{title:'keep elsewhere'});
  const r=selectScope([hit,miss],{onlyNew:true,trackedWords:['keep'],search:'needle'},baseTime+5000);
  assert.equal(r.watchedCount,1);assert.deepEqual(ids(r),[[hit.link]]);
});
