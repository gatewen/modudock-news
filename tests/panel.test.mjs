import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {aggregatePanel, aggregateHistory, contributes} from '../front/panel.js';
import {groupItems, contributes as scopeContributes} from '../front/scope.js';
import {themeNames} from '../front/labels.js';

const at = Date.parse('2026-09-27T12:00:00Z'), hour = 3600000;
const finance = (market='positive', theme='memory', dir='bull', dir_p=.9) => ({kind:'finance',market,theme,dir,dir_p});
const world = (trend='escalation', region='us_china') => ({kind:'world',trend,region});
const report = (n, changes={}) => ({event:n.toString(16).padStart(12,'0'),event_size:1,source:'A',
  category:'finance',published:new Date(at-hour).toISOString(),analysis:finance(),...changes});
const group = (...reports) => ({reports});
const hist = (counts, analysis=finance()) => counts.flatMap((count,b) => Array.from({length:count},(_,n)=>
  group(report(b*100+n,{published:new Date(at-24*hour+b*6*hour).toISOString(),analysis}))));

// Synthetic data only. These fixtures never invoke the backend or API.
test('panel functions are pure and scope shares the same contribution rule',()=>{
  const source=readFileSync(new URL('../front/panel.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:document|window|localStorage|setTimeout|innerHTML)\b|Date\.now/);
  const row=report(1);Object.freeze(row.analysis);Object.freeze(row);
  const groups=Object.freeze([Object.freeze({reports:Object.freeze([row])})]);
  const before=JSON.stringify(groups);
  assert.deepEqual(aggregatePanel(groups,'finance'),aggregatePanel(groups,'finance'));
  assert.deepEqual(aggregateHistory(groups,'finance',at),aggregateHistory(groups,'finance',at));
  assert.equal(JSON.stringify(groups),before);
  assert.equal(scopeContributes,contributes);
});

test('panel counts only analyzed events and keeps not_market separate from pending',()=>{
  const reports=['positive','mixed','negative','not_market','other'].map((m,i)=>report(i,{analysis:finance(m)}));
  reports.push(report(5,{analysis:null}),report(6,{analysis:{...finance(),dir_p:2}}));
  const p=aggregatePanel(groupItems(reports),'finance');
  assert.deepEqual(p.values,[1,1,2,1]);assert.equal(p.pending,2);assert.equal(p.analyzed,5);
  assert.equal(p.events,7);assert.equal(p.reports,7);assert.equal(p.sourceCount,1);
  assert.deepEqual(p.widths,[20,20,40,20]);
  assert.equal(p.counts.other,1);assert.equal(p.counts.not_market,1);
  const empty=aggregatePanel([group(report(1,{analysis:null}))],'finance');
  assert.deepEqual(empty.widths,[0,0,0,0]);assert.deepEqual(empty.ranked,[]);
});

test('same event chooses earliest valid analysis, not representative absence or last report',()=>{
  const reports=[report(1,{source:'A',published:new Date(at-3*hour).toISOString(),analysis:null}),
    report(1,{source:'B',published:new Date(at-2*hour).toISOString(),analysis:finance('negative','memory','bear')}),
    report(1,{source:'B',analysis:finance('positive','foundry')})];
  const groups=groupItems(reports),p=aggregatePanel(groups,'finance');
  assert.equal(p.events,1);assert.equal(p.reports,3);assert.equal(p.sourceCount,2);
  assert.deepEqual(p.values,[0,0,0,1]);assert.equal(p.ranked[0][0],'memory');
  assert.equal(contributes(groups[0],'signal:3','finance'),true);
  assert.equal(contributes(groups[0],'signal:0','finance'),false);
});

test('macro threshold includes .6 and keeps directionless remainder',()=>{
  const analyses=[finance('positive','macro','bull',.6),finance('negative','macro','bear',.6),
    finance('positive','macro','bull',.599),finance('mixed','macro','mixed'),finance('other','macro','neutral')];
  const groups=analyses.map((analysis,i)=>group(report(i,{analysis})));
  const p=aggregatePanel(groups,'finance');
  assert.deepEqual(p.macro,{count:5,bull:1,bear:1,remainder:3});assert.deepEqual(p.ranked,[]);
  for(const [id,n] of [['macro:all',5],['macro:bull',1],['macro:bear',1]])
    assert.equal(groups.filter(g=>contributes(g,id,'finance')).length,n);
});

test('finance ranking excludes macro and other, uses fixed tie order and top ten',()=>{
  const themes=[...themeNames.keys()];
  const groups=[...themes].reverse().map((theme,i)=>group(report(i,{analysis:finance('positive',theme)})));
  const p=aggregatePanel(groups,'tech');
  assert.deepEqual(p.ranked.map(([id])=>id),themes.slice(0,10));
  assert.deepEqual(p.ranked[0][1],{count:1,bull:1,bear:0,width:100,widths:[100,0,0]});
});

test('world signals and ranking directions use trend without financial probability',()=>{
  const groups=['escalation','stalemate','deescalation','not_conflict','other'].map((trend,i)=>
    group(report(i,{category:'world',analysis:world(trend)})));
  const p=aggregatePanel(groups,'world');
  assert.deepEqual(p.values,[1,1,1,2]);assert.equal(p.counts.not_conflict,1);assert.equal(p.counts.other,1);
  assert.deepEqual(p.ranked[0][1],{count:5,bull:1,bear:1,width:100,widths:[20,20,60]});
  assert.equal(p.macro.count,0);
  p.values.forEach((count,i)=>assert.equal(count,groups.filter(g=>contributes(g,`signal:${i}`,'world')).length));
});

test('largest other region remains last but scales all bars by the actual maximum',()=>{
  const groups=['us_china','europe_russia','europe_russia',...Array(5).fill('other')].map((region,i)=>
    group(report(i,{category:'world',analysis:world('stalemate',region)})));
  const p=aggregatePanel(groups,'world');
  assert.deepEqual(p.ranked.map(([id,count])=>[id,count.width]),
    [['region:europe_russia',40],['region:us_china',20],['region:other',100]]);
});

test('politics counts issues once per event and other stays last, without directions',()=>{
  const groups=['other','other','other','us_intl','cross_strait'].map((issue,i)=>
    group(report(i,{category:'politics',analysis:{kind:'politics',issue}})));
  const p=aggregatePanel(groups,'politics');
  assert.deepEqual(p.ranked.map(([id])=>id),['issue:cross_strait','issue:us_intl','issue:other']);
  assert.equal(p.analyzed,5);
  for(const [,count] of p.ranked){assert.equal(count.bull,0);assert.equal(count.bear,0);assert.deepEqual(count.widths,[100]);}
});

test('history includes endpoints, uses left-inclusive six-hour boundaries and skips invalid dates',()=>{
  const stamps=[at-24*hour-1,at-24*hour,at-18*hour,at-12*hour,at-6*hour,at,at+1];
  const groups=stamps.map((stamp,i)=>group(report(i,{published:new Date(stamp).toISOString()})));
  groups.push(group(report(99,{published:'bad'})),group(report(98,{analysis:null})));
  const h=aggregateHistory(groups,'finance',at);
  assert.deepEqual(h.buckets.map(b=>b.valid),[1,1,1,2]);assert.equal(h.collapsed,true);
  assert.deepEqual(h.buckets.map(b=>[b.from,b.to]),Array.from({length:4},(_,i)=>[at-24*hour+i*6*hour,at-18*hour+i*6*hour]));
});

test('history uses earliest publication but earliest valid analysis in its group',()=>{
  const groups=[group(report(1,{published:new Date(at-25*hour).toISOString(),analysis:null}),report(1)),
    group(report(2,{published:new Date(at-23*hour).toISOString(),analysis:null}),
      report(2,{analysis:finance('negative')}),report(2,{analysis:finance('positive')}))];
  const h=aggregateHistory(groups,'finance',at);
  assert.deepEqual(h.buckets.map(b=>b.values),[[0,0,0,1],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
});

test('history collapses at three insufficient segments, not two',()=>{
  assert.equal(aggregateHistory(hist([5,4,4,4]),'finance',at).collapsed,true);
  const h=aggregateHistory(hist([5,5,4,4]),'finance',at);
  assert.equal(h.collapsed,false);assert.deepEqual(h.buckets.map(b=>b.insufficient),[false,false,true,true]);
});

test('history denominator excludes unrelated and selects counts versus rounded percent',()=>{
  const groups=hist([0,0,0,5],finance('not_market'));
  let b=aggregateHistory(groups,'finance',at).buckets[3];
  assert.equal(b.mode,'empty');assert.equal(b.denominator,0);assert.equal(b.percent,null);
  groups[0].reports[0].analysis=finance();
  b=aggregateHistory(groups,'finance',at).buckets[3];
  assert.equal(b.mode,'count');assert.equal(b.denominator,1);assert.deepEqual(b.widths,[20,0,80,0]);
  const six=hist([0,0,0,6],finance('negative'));
  six[0].reports[0].analysis=finance();six[1].reports[0].analysis=finance();
  b=aggregateHistory(six,'finance',at).buckets[3];
  assert.equal(b.mode,'percent');assert.equal(b.percent,33);assert.equal(b.denominator,6);
  const five=hist([0,0,0,5]);
  assert.equal(aggregateHistory(five,'finance',at).buckets[3].mode,'percent');
  const four=hist([0,0,0,4]);
  assert.equal(aggregateHistory(four,'finance',at).buckets[3].mode,'insufficient');
});

test('world history treats other and not_conflict as unrelated, with escalation numerator',()=>{
  const groups=['escalation','deescalation','stalemate','not_conflict','other'].map((trend,i)=>
    group(report(i,{category:'world',analysis:world(trend)})));
  const b=aggregateHistory(groups,'world',at).buckets[3];
  assert.deepEqual(b.values,[1,1,1,2]);assert.equal(b.denominator,3);assert.equal(b.mode,'count');
  assert.deepEqual(b.widths,[20,20,20,40]);
});
