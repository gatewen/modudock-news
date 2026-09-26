import { Window } from 'happy-dom';
import mount from '../front/front.js';
import { topicNames, eventId, validAnalysis, topicOf, searchText } from '../front/labels.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// 20,000 deterministic UI actions by default; larger campaigns use these same oracles.
const seeds = Number(process.env.NEWS_WALK_SEEDS || 200);
const steps = Number(process.env.NEWS_WALK_STEPS || 100);
const firstSeed = Number(process.env.NEWS_WALK_SEED || 1);
assert.ok(Number.isSafeInteger(seeds) && seeds > 0);
assert.ok(Number.isSafeInteger(steps) && steps > 0);
assert.ok(Number.isSafeInteger(firstSeed));
const prefix='modudock.module.news.', SRC=['甲','乙','丙','丁'];
const CATS=['','finance','tech','world','politics','sports'];
const allowed=new Set(['lastSeen','watch','history','view'].map(key=>prefix+key));
const hex=n=>n.toString(16).padStart(12,'0');
const visible=node=>node && !node.closest('[hidden]') && !node.disabled;
const groups=items=>{
  const map=new Map();
  for(const item of items) {
    const key=eventId(item)||item;
    if(!map.has(key)) map.set(key,[]);
    map.get(key).push(item);
  }
  return [...map.values()].map(group=>group.sort((a,b)=>Date.parse(a.published)-Date.parse(b.published)
    || SRC.indexOf(a.source)-SRC.indexOf(b.source)));
};
const groupCount=items=>new Set(items.map(item=>eventId(item)||item)).size;
const signal=(group,category,id)=>{
  const a=group.map(validAnalysis).find(Boolean);
  if(!a) return false;
  if(id.startsWith('signal:')) {
    const index=category==='world'?{escalation:0,stalemate:1,deescalation:2,not_conflict:3,other:3}[a.trend]
      : {positive:0,mixed:1,not_market:2,other:2,negative:3}[a.market];
    return Number(id.slice(7))===index;
  }
  return a.theme==='macro' && (id==='macro:all'||a.dir_p>=.6&&a.dir===(id==='macro:bull'?'bull':'bear'));
};
const stats={actions:{},facetProbes:0,overviewProbes:0,assertions:0};

for(let run=0;run<seeds;run++) test(`front walk seed=${firstSeed+run}`,async()=>{
  const originalSeed=firstSeed+run;
  let seed=originalSeed;
  const rnd=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
  const pick=a=>a[Math.floor(rnd()*a.length)];
  const window=new Window(), document=window.document, errors=[];
  window.addEventListener('error',event=>{errors.push(event.error||event.message);event.preventDefault();});
  window.addEventListener('unhandledrejection',event=>{errors.push(event.reason);event.preventDefault();});
  window.localStorage.setItem(prefix+'lastSeen',JSON.stringify('2026-09-21T05:00:00Z'));
  window.localStorage.setItem(prefix+'watch',JSON.stringify(['台積電']));
  let h, last, round=0, seen, expectedView=null, transientView=new Set(), topicScope='', topicTheme='', step=-1;
  const log=[];
  const note=value=>{log.push(value);if(log.length>30)log.shift();};
  const countAction=name=>{stats.actions[name]=(stats.actions[name]||0)+1;};
  function mountView() {
    const container=document.createElement('div');document.body.append(container);
    let message,up;
    const handle=mount({container,channel:{onMessage(fn){message=fn;},send(){}},onUp(fn){up=fn;},report(){}});
    up();
    const q=sel=>container.querySelector(sel), qa=sel=>[...container.querySelectorAll(sel)];
    seen=Date.parse(JSON.parse(window.localStorage.getItem(prefix+'lastSeen')));
    const refs={};
    for(const [key,sel] of Object.entries({source:'[aria-label=新聞來源]',category:'[aria-label=新聞類別]',list:'.nw-list',
      theme:'.nw-filter',themeLabel:'.nw-filter > span',watch:'.nw-watch-only',watchHint:'.nw-watch-hint',
      search:'.nw-search-input',searchBox:'.nw-search-box',searchHint:'.nw-search-hint',new:'.nw-new-only',newHint:'.nw-new-hint',
      panel:'.nw-panel',focus:'.nw-focus-section',empty:'.nw-empty',help:'.nw-shortcut-help',overview:'.nw-overview'})) refs[key]=q(sel);
    h={container,handle,message,q,qa,...refs};
    Object.defineProperty(h,'new',{get:()=>refs.new||(refs.new=q('.nw-new-only'))});
    topicScope='';topicTheme='';transientView=new Set();
    if(last)message(last);
    // All generated sources/categories are valid. Only disabled classification cancels
    // category restoration here; never excuse an arbitrary screen/storage mismatch.
    if(expectedView&&last?.classify.enabled===false)transientView.add('category');
  }
  function genList(sameAt=false) {
    const items=Array.from({length:10},(_,i)=>{
      const category=i<5?'finance':i<9?'world':pick(['tech','politics','sports']);
      const item={title:`新聞 ${i} ${i%3?'進展':'台積電'}`,summary:`摘要 ＡＩ\u200b ${i}`,source:SRC[i%4],
        link:`https://e.test/${i}`,category,published:new Date(seen+(pick([-3,-1,0,1,2,4])*3600000)+i*1000).toISOString(),
        event:hex(i===1?1:i+1+(round%3===0?20:0)),event_size:2,topic:hex(0x100+(i<5?0:1)),
        tone:i===4||i===9?pick([null,'mixed']):pick(['positive','negative','neutral','mixed'])};
      if(rnd()>.15) item.analysis=category==='world'?{kind:'world',trend:pick(['escalation','stalemate','deescalation','not_conflict']),region:pick(['asia_pacific','europe','other'])}
        :category==='politics'?{kind:'politics',issue:pick(['budget','cross_strait','other'])}
        :['finance','tech'].includes(category)?{kind:'finance',market:pick(['positive','negative','mixed','not_market']),theme:pick(['memory','macro','ai_server']),dir:pick(['bull','bear','neutral']),dir_p:pick([.59,.6,.9])}:null;
      return item;
    });
    const topics=[0,1].filter(()=>rnd()>.18).map(n=>{
      const members=items.filter(item=>item.topic===hex(0x100+n));
      const tone=Object.fromEntries(['positive','negative','neutral','mixed'].map(t=>[t,members.filter(item=>item.tone===t).length]));
      return {id:hex(0x100+n),title:`話題${n}`,sources:4,count:members.length,tone};
    });
    return {op:'list',at:sameAt&&last?last.at:new Date(Date.UTC(2026,8,21,12,round++)).toISOString(),items,
      sources:SRC.map(name=>({name,ok:true,count:items.filter(i=>i.source===name).length})),topics:{list:topics},
      model:{state:pick(['working','done','paused','off'])},classify:{enabled:rnd()>.05,pending:0},events:{pending:0}};
  }
  function state() {
    const label=h.theme.hidden?'':h.themeLabel.textContent;
    const topic=label.startsWith('話題：');
    if(topic) topicScope=last.topics.list.find(t=>label===`話題：${t.title}`)?.id||'';
    else if(!label.startsWith('已篩選：話題內・'))topicScope='';
    const count=label.startsWith('已篩選：')?(h.q('.nw-panel button[data-count][aria-pressed=true]')?.dataset.count||''):'';
    const namespace=h.category.value==='world'?'region:':h.category.value==='politics'?'issue:':'';
    if(topicTheme&&!last.items.some(i=>(!h.source.value||i.source===h.source.value)&&i.category===h.category.value&&i.topic===topicScope&&topicOf(validAnalysis(i))===topicTheme))topicTheme='';
    const theme=topic?topicTheme
      :!count&&label.startsWith('已篩選：')?[...topicNames].find(([id,name])=>
        label===`已篩選：${id==='region:other'?'其他地區':id==='issue:other'?'其他議題':name}`
        &&(namespace?id.startsWith(namespace):!id.includes(':')))?.[0]||'':'';
    return {label,topic:topicScope,count,theme,source:h.source.value,category:h.category.value,
      outlet:h.q('.nw-topic-outlet-label').textContent.replace(/^只看：/,''), chronological:h.q('.nw-topic-order').getAttribute('aria-pressed')==='true',
      watch:h.watch.getAttribute('aria-pressed')==='true',new:h.new.getAttribute('aria-pressed')==='true',query:searchText(h.search.value).trim()};
  }
  const isNew=group=>group.some(item=>Date.parse(item.published)>seen);
  function switchSelect(control,value) {
    const before=state(),field=control===h.source?'source':'category';
    const option=[...control.options].find(o=>o.value===value);
    const probe=!before.topic&&!before.theme&&!before.count&&!before.query&&!before.watch&&!before.new;
    const expected=probe?Number(option.textContent.match(/ (\d+)$/)[1]):null;
    if(field==='category'&&before.topic)topicTheme='';
    note(`${field}=${value}`);control.focus();control.value=value;control.dispatchEvent(new window.Event('change'));
    if(field==='category'&&before.topic)countAction('categoryInTopic');
    if(!(field==='category'&&before.topic)) {
      expectedView={source:expectedView?.source||'',category:expectedView?.category||'',[field]:value};
      transientView.delete(field);
    }
    if(expected!==null) {assert.equal(h.list.querySelectorAll(':scope > .nw-row').length,expected,'facet selection rows');stats.facetProbes++;}
  }
  function click(selector,name) {
    const nodes=h.qa(selector).filter(visible);if(!nodes.length)return false;
    const node=pick(nodes),before=state();
    note(`${name}:${node.dataset.count||node.dataset.toneKey||node.dataset.topic||node.dataset.topicId||node.textContent.slice(0,25)}`);
    const overview=node.dataset.overview;
    const forecast=overview?node.textContent.match(/(?:偏多|升級) (\d+) 件・(?:偏空|緩和) (\d+) 件/):null;
    const newCount=node===h.new&&node.getAttribute('aria-pressed')!=='true'?Number(node.textContent.match(/\d+/)[0]):null;
    if(name==='theme')topicTheme=before.theme===node.dataset.topic?'':node.dataset.topic;
    if(name==='topic'||name==='count'||name==='clearAll')topicTheme='';
    const outletCount=name==='outlet'&&node.getAttribute('aria-pressed')!=='true'?Number(node.textContent.match(/ (\d+)$/)[1]):null;
    node.focus();node.click();
    if(outletCount!==null)assert.equal(h.qa('.nw-list > .nw-row').length+h.qa('.nw-report').length,outletCount,'outlet button vs reports');
    if(overview) {expectedView={source:expectedView?.source||'',category:overview};transientView.delete('category');}
    const after=state();
    if(before.topic&&!after.topic&&['clear','topic','count'].includes(name)) {expectedView={source:h.source.value,category:h.category.value};transientView=new Set();}
    if(name==='clearAll'||!before.topic&&after.topic)transientView=new Set(['source','category']);
    if(newCount!==null) assert.equal(h.list.querySelectorAll(':scope > .nw-row').length,newCount,'new button vs resulting rows');
    if(forecast) {
      for(const [id,value] of [['signal:0',forecast[1]],[overview==='world'?'signal:2':'signal:3',forecast[2]]])
        assert.equal(h.q(`button[data-count="${id}"] .nw-value`).textContent,value,'overview vs destination panel');
      stats.overviewProbes++;
    }
    countAction(name);return true;
  }
  function act() {
    const choice=Math.floor(rnd()*34);
    if(choice===26) click('.nw-topic-order','topicOrder');
    else if(choice===27) click('.nw-outlet','outlet');
    else if(choice===28) click('.nw-topic-outlet-clear','outletClear');
    else if(choice>=29) {
      // Browsing between edits is common; still assert all invariants after every key.
      const target=h.container.contains(document.activeElement)?document.activeElement:h.list;
      const key=pick(['j','k']);target.focus();note(`browse=${key}`);
      target.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));countAction(key);
    } else if(choice<2) {
      const before=state();last=genList(choice===0);note(`resend:${choice===0?'same':'new'} topics=${last.topics.list.map(t=>t.id).join(',')}`);h.message(last);
      if(before.topic&&!last.topics.list.some(t=>t.id===before.topic)) {countAction('topicDisappeared');expectedView={source:h.source.value,category:h.category.value};transientView=new Set();}
      countAction(choice===0?'sameAt':'newAt');
    } else if(choice===2) click('.nw-shortcut-toggle','help');
    else if(choice===3) click('.nw-tone-button','tone');
    else if(choice===24) click('.nw-refresh','refresh');
    else if(choice===25) {
      if(h.q('.nw-watch-settings').hidden) {const toggle=h.q('.nw-watch-toggle');toggle.focus();toggle.click();}
      const input=h.q('.nw-watch-input');input.focus();input.value=pick(['台積電','','進展']);
      note(`watchWords=${input.value}`);h.q('.nw-watch-settings button').click();countAction('watchWords');
    } else if(choice===4) {switchSelect(h.source,pick(['',...SRC]));countAction('source');}
    else if(choice===5) {switchSelect(h.category,pick(CATS));countAction('category');}
    else if(choice===6) click('.nw-theme','theme');
    else if(choice===7) click('.nw-focus-count[data-topic-id]','topic');
    else if(choice===8) click('.nw-filter > button','clear');
    else if(choice===9) click('.nw-panel button[data-count]','count');
    else if(choice===10) click('.nw-search-toggle','searchToggle');
    else if(choice===11) {
      if(h.searchBox.hidden)click('.nw-search-toggle','searchToggle');
      h.search.focus();h.search.value=pick(['','台積','ＡＩ','進展','no-match','?']);note(`search=${h.search.value}`);
      h.search.dispatchEvent(new window.Event('input',{bubbles:true}));countAction('searchInput');
    } else if(choice===12) click('.nw-new-only','new');
    else if(choice===13) click('.nw-new-hint button','newClear');
    else if(choice===14) click('.nw-tone-button','tone');
    else if(choice===15) click('.nw-overview-button','overview');
    else if(choice===16||choice===17) {
      const key=choice===16?'Escape':pick(['?','/','j','k','s','e']);
      const target=h.container.contains(document.activeElement)?document.activeElement:h.list;
      target.focus();note(`key=${key}`);target.dispatchEvent(new window.KeyboardEvent('keydown',{key,shiftKey:key==='?',bubbles:true,cancelable:true}));countAction(key);
    } else if(choice===18) click('.nw-watch-only','watch');
    else if(choice===19) click('.nw-expand,.nw-summary-toggle','row');
    else if(choice===20) {
      const nodes=h.qa('a,.nw-list button,.nw-tone-button').filter(visible);if(nodes.length){const node=pick(nodes);note(`focus=${node.className}`);node.focus();}countAction('focus');
    } else if(choice===21) click('.nw-empty button','clearAll');
    else if(choice===22) click('.nw-history-toggle,.nw-shortcut-toggle','disclosure');
    else if(rnd()<.1) {note('remount');h.handle.unmount();h.container.remove();mountView();countAction('remount');}
    else click('.nw-shortcut-toggle','help');
  }
  function check() {
    assert.deepEqual(errors,[],'uncaught DOM callback error');
    const s=state(),rows=[...h.list.children].filter(n=>n.classList.contains('nw-row'));
    const scope=last.items.filter(i=>(!s.source||i.source===s.source)&&(!s.category||i.category===s.category)&&(!s.topic||i.topic===s.topic)&&(!s.outlet||i.source===s.outlet));
    const panelGroups=groups(scope).filter(g=>!s.new||isNew(g));
    const base=groups(scope.filter(i=>!s.theme||topicOf(validAnalysis(i))===s.theme)).filter(g=>!s.count||signal(g,s.category,s.count));
    const words=JSON.parse(window.localStorage.getItem(prefix+'watch')||'[]');
    const matching=base.filter(g=>(!s.watch||g.some(i=>words.some(w=>(i.title+i.summary).toLowerCase().includes(w.toLowerCase()))))
      &&(!s.query||g.some(i=>[i.title,i.summary].some(value=>searchText(value).includes(s.query)))));
    const expected=matching.filter(g=>!s.new||isNew(g));
    const watched=base.filter(g=>g.some(i=>words.some(w=>[i.title,i.summary].some(value=>value.toLowerCase().includes(w.toLowerCase()))))
      &&(!s.query||g.some(i=>[i.title,i.summary].some(value=>searchText(value).includes(s.query))))
      &&(!s.new||isNew(g))).length;
    assert.equal(h.watch.textContent,`只看追蹤 ${watched}`,'watch count includes all intersections');
    if(s.watch) assert.equal(watched,rows.length,'pressed watch count vs rows');
    assert.equal(rows.length,expected.length,`rows source=${s.source} category=${s.category} theme=${s.theme} topic=${s.topic} count=${s.count}`);
    if(s.chronological&&s.topic) {
      const stamps=rows.map(row=>Date.parse(last.items.find(item=>item.link===row.querySelector('a.nw-title')?.href)?.published));
      assert.ok(stamps.every((stamp,index)=>index===0||stamp>=stamps[index-1]),'chronological row order');
    }
    for(const button of h.qa('.nw-outlet'))assert.equal(button.getAttribute('aria-pressed')==='true',button.dataset.outlet===s.outlet);
    const newCount=matching.filter(isNew).length;
    assert.equal(h.new.hidden,newCount===0,'new visibility');
    if(newCount)assert.equal(h.new.textContent,`新增 ${newCount} 個事件`);
    assert.equal(h.newHint.hidden,!s.new);if(s.new)assert.ok(h.newHint.textContent.includes(`（${expected.length} 個事件）`));
    assert.equal(h.empty.hidden,rows.length>0);
    assert.equal(h.searchHint.hidden,!s.query);
    if(s.query)assert.ok(h.searchHint.textContent.endsWith(`：${rows.length} 個事件`),'search count');
    if(!h.panel.hidden)for(const button of [...h.panel.querySelectorAll('button[data-count]')].filter(visible)) {
      const count=panelGroups.filter(g=>signal(g,s.category,button.dataset.count)).length;
      assert.equal(Number(button.textContent.match(/\d+/)[0]),count,'panel count oracle');
      if(button.getAttribute('aria-pressed')==='true'&&!s.query&&!s.watch)assert.equal(count,rows.length,'pressed count vs rows');
    }
    if(!h.overview.hidden)for(const button of h.overview.querySelectorAll('button')) {
      const cat=button.dataset.overview,gs=groups(last.items.filter(i=>i.category===cat&&(!s.source||i.source===s.source))).filter(g=>!s.new||isNew(g));
      const numbers=button.textContent.match(/(?:偏多|升級) (\d+) 件・(?:偏空|緩和) (\d+) 件/);
      assert.equal(Number(numbers[1]),gs.filter(g=>signal(g,cat,'signal:0')).length);
      assert.equal(Number(numbers[2]),gs.filter(g=>signal(g,cat,cat==='world'?'signal:2':'signal:3')).length);
    }
    for(const [select,other] of [[h.category,'source'],[h.source,'category']])for(const option of select.options) {
      const field=other==='source'?'category':'source';
      const expected=groupCount(last.items.filter(i=>(!s[other]||i[other]===s[other])&&(!option.value||i[field]===option.value)));
      assert.equal(Number(option.textContent.match(/ (\d+)$/)[1]),expected,`facet ${field}:${option.value}`);
    }
    const active=document.activeElement;
    if(h.container.contains(active))assert.ok(visible(active),`hidden/disabled focus: ${active.className}`);
    assert.equal(h.watchHint.hidden,!s.watch);
    if(s.watch) {assert.equal(h.panel.hidden,true);assert.equal(h.focus.hidden,true);}
    const audits=h.qa('.nw-tone-audit');
    assert.ok(audits.length<=1,'multiple audits');
    assert.equal(audits.length,h.qa('.nw-tone-button[aria-expanded=true]').length,'audit visibility');
    for(const button of h.container.getElementsByTagName('button')) {
      if(!button.hasAttribute('aria-expanded'))continue;
      const id=button.getAttribute('aria-controls');
      const target=id?document.getElementById(id):button.matches('.nw-expand')?button.closest('.nw-row').querySelector('.nw-reports')
        :button.textContent==='追蹤關鍵字'?h.q('.nw-watch-settings'):null;
      if(target)assert.equal(button.getAttribute('aria-expanded')==='true',!target.hidden,`aria expanded ${button.className}`);
      if(button.matches('.nw-tone-button')) {
        assert.equal(button.getAttribute('aria-pressed'),button.getAttribute('aria-expanded'));
        if(button.getAttribute('aria-expanded')==='true')assert.equal(h.qa('.nw-tone-report').length,Number(button.textContent.match(/\d+/)[0]));
      }
    }
    assert.equal(h.q('.nw-search-toggle').getAttribute('aria-pressed')==='true',Boolean(s.query));
    assert.equal(h.qa('.nw-theme[aria-pressed=true]').length<=1,true);
    assert.equal(h.qa('button[data-count][aria-pressed=true]').length<=1,true);
    for(let k=0;k<window.localStorage.length;k++)assert.ok(allowed.has(window.localStorage.key(k)),'unexpected storage key');
    assert.deepEqual(JSON.parse(window.localStorage.getItem(prefix+'view')||'null'),expectedView,'persisted view oracle');
    // Per-field temporary exceptions: clear-all, topic entry/source exit, and deferred/disabled
    // category restoration. A manual edit clears only that field; return persists both (§19).
    if(expectedView&&!s.topic)for(const field of ['source','category'])if(!transientView.has(field))
      assert.equal(s[field],expectedView[field],`view vs screen ${field}`);
    assert.ok(h.qa('.nw-divider').length<=1);stats.assertions++;
  }
  try {
    mountView();last=genList();h.message(last);
    for(step=0;step<steps;step++) {act();check();}
  } catch(error) {
    throw new Error(`seed=${originalSeed} step=${step} actions=${log.join('; ')}: ${error.message}`,{cause:error});
  } finally {
    h.handle.unmount();h.container.remove();await window.happyDOM.abort();
  }
});
test('walk campaign covers required operations',t=>{
  t.diagnostic(JSON.stringify(stats));
  if(seeds<200||steps<100)return; // Small single-seed reproductions remain useful.
  for(const name of ['sameAt','newAt','source','category','count','topic','searchToggle','searchInput','Escape','new','tone','overview','?','categoryInTopic','topicDisappeared','refresh','watchWords','topicOrder','outlet','outletClear'])
    assert.ok(stats.actions[name]>0,`missing action: ${name}`);
  assert.ok(stats.facetProbes>0);assert.ok(stats.overviewProbes>0);
  assert.equal(stats.assertions,seeds*steps);
});
