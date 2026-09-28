import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {createRowBuilder} from '../front/rows.js';

const story=(extra={})=>({title:'甲標題',summary:'甲摘要',source:'甲',link:'https://example.test/a',published:'2026-09-27T00:00:00Z',category:'finance',...extra});
function fixture(t) {
  const window=new Window(),document=window.document;
  t.after(()=>window.happyDOM.close());
  const make=(tag,cls,text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
  const text=v=>typeof v==='string'?v:'';
  const calls={titles:[],tones:[],summaries:[]};
  const builder=createRowBuilder({document,make,text,
    describe(tag,description,fragment){const n=make('span','nw-sr',description);n.id='desc';tag.setAttribute('aria-describedby',n.id);fragment.append(n);},
    groupTime(reports){return make('span','nw-time',`range:${reports.length}`);},
    appendTone(parent,item,reports=[item]){calls.tones.push(reports);parent.append(make('span','nw-tone-tag',text(item.tone)));},
    newsTitle(item,cls,marked){calls.titles.push({item,cls,marked});const n=make(item.link?.startsWith('https:')?'a':'span',cls,text(item.title));if(n.tagName==='A')n.href=item.link;if(marked)n.prepend(make('span','nw-new','新'));return n;},
    newsTime(item){return make('span','nw-time',item.published);},
    isNew(item){return item.fresh===true;},
    summaryKey(group){return `key:${group.id}`;},
    summaryParts(item,key){calls.summaries.push({item,key});const button=make('button','nw-summary-toggle','摘要'),paragraph=make('p','nw-summary',item.summary);return {button,paragraph};}});
  const group={id:'abcdef123456',reports:[story(),story({title:'乙標題',source:'乙',link:'https://example.test/b',published:'2026-09-27T01:00:00Z',fresh:true})]};
  const opts={query:'',hits:()=>false,watchMatch:'追蹤詞',categoryFilter:'',modelState:'working',analysisEnabled:true,classificationPending:1,marked:true,expanded:false,onlyNew:true};
  return {builder,group,opts,calls};
}

test('row builder preserves title/latest/meta/summary/report order and delegates report semantics',t=>{
  const {builder,group,opts,calls}=fixture(t),built=builder.build(group,opts);
  assert.equal(built.row.dataset.event,group.id);
  assert.deepEqual([...built.row.children].map(n=>n.className),['nw-title','nw-hint nw-event-latest','nw-meta','nw-summary','nw-reports']);
  assert.equal(built.row.querySelector('.nw-watch').textContent,'追蹤：追蹤詞');
  assert.equal(built.row.querySelector('.nw-info .nw-time').textContent,'range:2');
  assert.equal(built.latestLink.textContent,'最新：乙標題（乙）');assert.equal(built.latestLink.title,'乙標題');
  assert.deepEqual([...built.row.querySelector('.nw-actions').children].map(n=>n.className),['nw-summary-toggle','nw-expand']);
  assert.equal(built.toggle.textContent,'另 1 則報導');assert.equal(built.toggle.type,'button');
  assert.equal(built.toggle.getAttribute('aria-expanded'),'false');assert.equal(built.reports.hidden,true);
  assert.equal(built.reports.getAttribute('aria-label'),'同事件其他報導');
  assert.equal(built.row.querySelectorAll('.nw-new').length,2);
  assert.deepEqual(calls.tones,[group.reports,[group.reports[1]]]);
  assert.deepEqual(calls.summaries,[{item:group.reports[0],key:`key:${group.id}`}]);
  assert.equal(calls.titles.find(x=>x.cls==='nw-hint nw-event-latest').marked,false);
});

test('latest requires later time, a different nonempty title and a safe anchor',t=>{
  const {builder,group,opts}=fixture(t);
  for(const change of [{title:'甲標題'},{title:''},{published:group.reports[0].published},{published:'bad'},{link:'javascript:alert(1)'}]) {
    const g={...group,reports:[group.reports[0],{...group.reports[1],...change}]};
    assert.ok(builder.build(g,opts).latestLink === null);
  }
  const lone=builder.build({...group,reports:[story({summary:''})]},opts);
  assert.ok(lone.toggle === null);assert.ok(lone.latestLink === null);assert.ok(lone.row.querySelector('.nw-actions') === null);
});

test('classification-in-progress only for empty category with all pending guards',t=>{
  const {builder,group,opts}=fixture(t);
  const g={...group,reports:[story({category:''})]};
  const label=(item,options)=>builder.build({...g,reports:[item]},options).row.querySelector('.nw-category')?.textContent;
  assert.equal(label(g.reports[0],opts),'分類中');
  for(const change of [{modelState:'paused'},{classificationPending:0},{analysisEnabled:false}])assert.equal(label(g.reports[0],{...opts,...change}),'未分類');
  for(const category of ['bad',{}])assert.equal(label(story({category}),opts),'未分類');
  assert.equal(label(story(),{...opts,categoryFilter:'finance'}),undefined);
});

test('row tags preserve finance descriptions and world/politics visibility',t=>{
  const {builder,group,opts}=fixture(t);
  const row=(item,options=opts)=>builder.build({...group,reports:[item]},options).row;
  const finance=dir=>story({analysis:{kind:'finance',market:'positive',theme:'macro',dir,dir_p:.8}});
  for(const [dir,arrow,cls,word] of [['bull','▲','nw-up','偏多'],['bear','▼','nw-down','偏空']]) {
    const r=row(finance(dir)),tag=r.querySelector('.nw-tag');
    assert.equal(tag.textContent,`大盤 ${arrow}`);assert.ok(tag.classList.contains(cls));
    assert.equal(tag.title,`這則新聞對大盤${word}（依新聞內容判斷，非行情）`);
    assert.equal(tag.getAttribute('aria-describedby'),'desc');assert.equal(r.querySelector('.nw-sr').textContent,tag.title);
  }
  assert.equal(row(story({analysis:{...finance('bull').analysis,dir_p:.59}})).querySelector('.nw-tag').title,'題材：大盤');
  for(const [trend,cls] of [['escalation','nw-danger-text'],['deescalation','nw-calm-text']])
    assert.ok(row(story({category:'world',analysis:{kind:'world',trend,region:'other'}})).querySelector('.'+cls));
  const politics=story({category:'politics',analysis:{kind:'politics',issue:'other'}});
  assert.ok(row(politics).querySelector('.nw-tag') === null);
  assert.ok(row(politics,{...opts,categoryFilter:'politics'}).querySelector('.nw-tag'));
  assert.ok(row(story({analysis:{bad:true}})).querySelector('.nw-tag') === null);
});

test('cached search updates markers, auto expansion, latest visibility and new badge without rebuilding',t=>{
  const {builder,group,opts}=fixture(t),built=builder.build(group,opts),row=built.row;
  const hit={...opts,query:'乙',hits:item=>item.source==='乙',marked:false};
  assert.equal(builder.update(built,group,hit),row);
  assert.equal(built.toggle.getAttribute('aria-expanded'),'true');assert.equal(built.reports.hidden,false);
  assert.equal(row.querySelectorAll('.nw-search-match').length,1);assert.ok(row.querySelector('.nw-report-meta .nw-search-match'));
  assert.equal(built.latestLink.hidden,true);assert.ok(row.querySelector('.nw-title .nw-new') === null);
  builder.update(built,group,opts);builder.update(built,group,opts);
  assert.equal(row.querySelectorAll('.nw-search-match').length,0);assert.equal(built.reports.hidden,true);
  assert.equal(built.latestLink.hidden,false);assert.equal(row.querySelectorAll('.nw-title .nw-new').length,1);
  builder.update(built,group,{...opts,expanded:true});assert.equal(built.reports.hidden,false);
});

test('fresh search rendering equals cached update and displays hostile strings only as text',t=>{
  const {builder,group,opts}=fixture(t);
  group.reports[0]={...group.reports[0],title:'<img src=x onerror=alert(1)>',source:'<svg>',summary:'<script>x</script>'};
  const built=builder.build(group,opts),next={...opts,query:'x',hits:()=>true,marked:false};
  builder.update(built,group,next);
  const fresh=builder.build(group,next);
  assert.equal(built.row.outerHTML,fresh.row.outerHTML);
  assert.ok(built.row.querySelector('img,svg,script') === null);
  assert.equal(built.row.querySelector('.nw-title').textContent,group.reports[0].title);
  assert.equal(built.row.querySelectorAll('.nw-search-match').length,2);
});


test('biotech and retail row tags render names and existing direction colors',t=>{
  const {builder,group,opts}=fixture(t);
  for(const [theme,name,dir,arrow,cls] of [['biotech','生技醫療','bull','▲','nw-up'],['retail','零售通路','bear','▼','nw-down']]) {
    const row=builder.build({...group,reports:[story({analysis:{kind:'finance',market:'positive',theme,dir,dir_p:.8}})]},opts).row;
    const tag=row.querySelector('.nw-tag');
    assert.equal(tag.textContent,`${name} ${arrow}`);
    assert.ok(tag.classList.contains(cls));
  }
});
