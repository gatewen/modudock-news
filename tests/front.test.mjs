import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import mount from '../front/front.js';

function setup(t, prepare = () => {}) {
  const window = new Window();
  prepare(window);
  t.after(() => window.happyDOM.abort());
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const sent = [], reported = [];
  let message, up;
  const handle = mount({
    container,
    channel: { onMessage(fn) { message = fn; }, send(body) { sent.push(body); } },
    onUp(fn) { up = fn; },
    report(value) {
      assert.equal(typeof message, 'function');
      assert.equal(typeof up, 'function');
      assert.ok(container.querySelector('button'));
      reported.push(value);
    },
  });
  return {window, container, handle, sent, reported, message, up,
    button: container.querySelector('button'), select: container.querySelector('[aria-label=新聞來源]'),
    categories: container.querySelector('[aria-label=新聞類別]')};
}

const article = (overrides = {}) => ({title: '新聞', source: '甲', summary: '摘要',
  link: 'https://example.com/story', published: '2026-09-21T02:03:00Z', ...overrides});
const listing = (items, sources = [{name: '甲', ok: true}, {name: '乙', ok: false}]) =>
  ({op: 'list', at: '2026-09-21T02:04:00Z', items, sources});

test('mount is synchronous, ready after registration; refresh only after up', t => {
  const h = setup(t);
  assert.deepEqual(h.reported, ['ready']);
  assert.equal(typeof h.handle.unmount, 'function');
  assert.equal(h.handle.then, undefined);
  assert.equal(h.button.disabled, true);
  h.button.click();
  h.button.dispatchEvent(new h.window.Event('click')); // Guard also handles synthetic events.
  assert.deepEqual(h.sent, []);
  h.up();
  assert.equal(h.button.disabled, false);
  h.button.click();
  assert.deepEqual(h.sent, [{op: 'refresh'}]);
});

test('list rows, local time, link attributes, summary and status', t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 8, 25, 12)});
  const h = setup(t);
  h.up();
  h.message(listing([article(), article({title: '第二則', source: '乙'})]));
  assert.equal(h.container.querySelectorAll('li').length, 2);
  const anchor = h.container.querySelector('a');
  assert.equal(anchor.textContent, '新聞');
  assert.equal(anchor.href, 'https://example.com/story');
  assert.equal(anchor.target, '_blank');
  assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(anchor.title, '摘要');
  const date = new Date('2026-09-21T02:03:00Z');
  const pad = n => String(n).padStart(2, '0');
  const local = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const row = h.container.querySelector('li');
  assert.equal(row.firstElementChild, anchor);
  assert.equal(row.lastElementChild.className, 'nw-meta');
  assert.equal(row.querySelector('.nw-category').textContent, '未分類');
  assert.equal(row.querySelector('.nw-source').textContent, '甲');
  assert.equal(row.querySelector('.nw-time').textContent, `${date.getMonth() + 1}/${date.getDate()} ${local}`);
  const updated = new Date('2026-09-21T02:04:00Z');
  assert.equal(h.container.querySelector('[role=status]').textContent,
    `${pad(updated.getHours())}:${pad(updated.getMinutes())} 更新 · 乙 失敗`);
});

test('untrusted text stays text; non-http links never become anchors', t => {
  const h = setup(t);
  const evil = '<img src=x onerror=alert(1)>';
  h.message(listing([
    article({title: evil, summary: evil}),
    ...['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '/relative', 'bad'].map(link => article({link})),
  ]));
  assert.equal(h.container.querySelectorAll('li').length, 6);
  assert.equal(h.container.querySelectorAll('img').length, 0);
  assert.equal(h.container.querySelectorAll('a').length, 1);
  assert.equal(h.container.querySelector('a').textContent, evil);
  assert.equal(h.container.querySelector('a').title, evil);
});

test('malformed packets and fields are safe and never stringify objects', t => {
  const h = setup(t);
  h.message(null);
  h.message({op: 'unknown'});
  h.message(listing([null, 4, {title: {}, source: [], summary: 3, link: {}, published: {}},
    article({published: 'not-a-date'})], [null, {}, {name: {}, ok: false}]));
  assert.equal(h.container.querySelectorAll('li').length, 2);
  assert.equal(h.container.querySelector('li').textContent, '未分類');
  assert.equal(h.container.querySelector('.nw-list span[title]').title, '');
  assert.equal(h.select.options.length, 1);
  h.message({op: 'list', items: {}, sources: {}, at: {}});
  assert.equal(h.container.querySelectorAll('li').length, 0);
  assert.equal(h.container.querySelector('[role=status]').textContent, '');
});

test('source filter is rebuilt, selection preserved or reset when removed', t => {
  const h = setup(t);
  const items = [article(), article({source: '乙'})];
  h.message(listing(items));
  h.select.value = '乙';
  h.select.dispatchEvent(new h.window.Event('change'));
  assert.equal(h.container.querySelectorAll('li').length, 1);
  assert.equal(h.container.querySelector('li .nw-source').textContent, '乙');
  h.message(listing(items, [{name: '乙', ok: true}, {name: '甲', ok: true}, {name: '乙', ok: true}]));
  assert.equal(h.select.value, '乙');
  assert.equal(h.select.options.length, 3);
  assert.equal(h.container.querySelectorAll('li').length, 1);
  h.message(listing([article()], [{name: '甲', ok: true}]));
  assert.equal(h.select.value, '');
  assert.equal(h.container.querySelectorAll('li').length, 1);
});

test('unmount removes nodes and listeners; retained callbacks cannot revive UI', t => {
  const h = setup(t);
  h.up();
  h.message(listing([article()]));
  const detachedList = h.container.querySelector('ul');
  h.handle.unmount();
  assert.equal(h.container.childNodes.length, 0);
  h.button.disabled = false;
  h.button.click();
  h.select.dispatchEvent(new h.window.Event('change'));
  h.categories.dispatchEvent(new h.window.Event('change'));
  assert.equal(detachedList.children.length, 1); // category listener also removed
  h.message(listing([article(), article()]));
  h.up();
  assert.deepEqual(h.sent, []);
  assert.equal(detachedList.children.length, 1); // change listener really removed
  assert.equal(h.container.childNodes.length, 0);
  h.handle.unmount();
});

test('static defense: no HTML sinks or dynamic code execution', () => {
  const source = readFileSync(new URL('../front/front.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:innerHTML|insertAdjacentHTML|eval|Function)\b/);
});

test('category options are fixed, ordered and independent of received data', t => {
  const h = setup(t);
  const expected = [['', '全部類別'], ['politics', '政治'], ['finance', '財經'],
    ['tech', '科技'], ['world', '國際'], ['society', '社會'], ['life', '生活'],
    ['sports', '體育'], ['entertainment', '娛樂'], ['other', '其他']];
  const options = () => [...h.categories.options].map(option => [option.value, option.textContent]);
  assert.equal(h.categories.options.length, 10);
  assert.deepEqual(options(), expected);
  h.message(listing([article({category: 'zzz'})]));
  assert.deepEqual(options(), expected);
  h.message(listing([]));
  assert.deepEqual(options(), expected);
});

test('category labels recognize only string ids and safely handle malformed values', t => {
  const h = setup(t);
  const known = [['politics', '政治'], ['finance', '財經'], ['tech', '科技'],
    ['world', '國際'], ['society', '社會'], ['life', '生活'], ['sports', '體育'],
    ['entertainment', '娛樂'], ['other', '其他']];
  const unknown = ['', 'zzz', 'constructor', '__proto__', '<img src=x onerror=alert(1)>',
    null, undefined, 1, true, {}, ['tech'], {toString() { throw new Error('do not coerce'); }}];
  assert.doesNotThrow(() => h.message(listing([
    ...known.map(([category]) => article({category})),
    ...unknown.map(category => article({category})),
  ])));
  const rows = [...h.container.querySelectorAll('li')];
  assert.equal(rows.length, known.length + unknown.length);
  known.forEach(([, name], i) => assert.equal(rows[i].querySelector('.nw-category').textContent, name));
  rows.slice(known.length).forEach(row => assert.equal(row.querySelector('.nw-category').textContent, '未分類'));
  assert.equal(h.container.querySelectorAll('img').length, 0);
});

test('source AND category filtering and both selections survive same-at replacement', t => {
  const h = setup(t);
  const items = [article({title: '甲科技', category: 'tech'}),
    article({title: '甲生活', category: 'life'}),
    article({title: '乙科技', source: '乙', category: 'tech'}),
    article({title: '乙未分類', source: '乙', category: ''})];
  const titles = () => [...h.container.querySelectorAll('li a')].map(a => a.textContent);
  h.message(listing(items));
  h.select.value = '乙';
  h.select.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(titles(), ['乙科技', '乙未分類']);
  h.categories.value = 'tech';
  h.categories.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(titles(), ['乙科技']);
  const resend = listing(items.map(item => item.title === '乙未分類' ? {...item, category: 'tech'} : item));
  assert.equal(resend.at, listing(items).at);
  h.message(resend);
  assert.equal(h.select.value, '乙');
  assert.equal(h.categories.value, 'tech');
  assert.deepEqual(titles(), ['乙科技', '乙未分類']);
  h.select.value = '';
  h.select.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(titles(), ['甲科技', '乙科技', '乙未分類']);
  h.categories.value = '';
  h.categories.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(titles(), items.map(item => item.title));
});

test('category selection survives empty lists and source removal', t => {
  const h = setup(t);
  h.message(listing([article({category: 'tech'})]));
  h.select.value = '甲';
  h.categories.value = 'tech';
  h.message(listing([], []));
  assert.equal(h.select.value, '');
  assert.equal(h.categories.value, 'tech');
  assert.equal(h.container.querySelectorAll('li').length, 0);
});

test('classification status requires literal false or a nonnegative integer pending', t => {
  const h = setup(t);
  const status = () => h.container.querySelector('[role=status]').textContent;
  h.message({...listing([]), classify: {enabled: false, pending: 9}});
  assert.ok(status().endsWith(' · 分類：關閉'));
  assert.ok(!status().includes('未分類：'));
  for (const pending of [0, 1, 42]) {
    h.message({...listing([]), classify: {enabled: true, pending}});
    assert.equal(status().includes('未分類：'), pending > 0);
    if (pending > 0) assert.ok(status().endsWith(` · 未分類：${pending}`));
  }
  for (const pending of [-1, 0.5, '3', true, null, undefined, {}, [], NaN, Infinity]) {
    h.message({...listing([]), classify: {enabled: true, pending}});
    assert.ok(!status().includes('未分類：'));
  }
  for (const classify of [undefined, null, false, 'bad', [], {}]) {
    assert.doesNotThrow(() => h.message({...listing([]), classify}));
    assert.ok(!status().includes('未分類：'));
  }
  for (const enabled of [0, 'false', null]) {
    h.message({...listing([]), classify: {enabled, pending: 2}});
    assert.ok(status().endsWith(' · 未分類：2'));
  }
});

const analysis = (overrides = {}) => ({market: 'positive', theme: 'memory', dir: 'bull', dir_p: 0.8, ...overrides});
const financeArticle = (overrides = {}) => article({category: 'finance', analysis: analysis(), ...overrides});
const panel = h => h.container.querySelector('[aria-label=財經分析]');
const themeButtons = h => [...h.container.querySelectorAll('[aria-label=題材排行] button')];
const themeButton = (h, id) => themeButtons(h).find(button => button.dataset.topic === id);
const choose = (h, control, value) => {
  control.value = value;
  control.dispatchEvent(new h.window.Event('change'));
};
const rowTitles = h => [...h.container.querySelectorAll('li a')].map(a => a.textContent);

test('analysis panel appears only for finance or tech between toolbar and list', t => {
  const h = setup(t);
  assert.equal(panel(h).hidden, true);
  h.message(listing([financeArticle(), financeArticle({category: 'tech'})]));
  for (const category of ['', 'politics', 'life', 'other', 'finance', 'tech']) {
    choose(h, h.categories, category);
    assert.equal(panel(h).hidden, !['finance', 'tech'].includes(category));
  }
  assert.equal(panel(h).nextElementSibling.className, 'nw-filter');
  assert.equal(panel(h).nextElementSibling.nextElementSibling, h.container.querySelector('ul'));
  assert.equal(panel(h).previousElementSibling.className, 'nw-focus-section');
  assert.equal(panel(h).previousElementSibling.previousElementSibling.contains(h.categories), true);
  assert.equal(panel(h).children.length, 6);
  assert.equal(panel(h).querySelector('small').textContent, '同一事件多家報導只算一次。');
});

test('panel counts scope, unknowns, pending and macro direction using validated analysis', t => {
  const h = setup(t);
  const items = [
    financeArticle({analysis: analysis({dir_p: 0.6})}),
    financeArticle({analysis: analysis({market: 'negative', dir: 'bear', dir_p: 0.59})}),
    financeArticle({analysis: analysis({market: 'mixed', theme: 'macro', dir: 'bear', dir_p: 0.6})}),
    financeArticle({analysis: analysis({market: 'not_market', theme: 'macro', dir_p: 0.59})}),
    financeArticle({analysis: analysis({market: 'other', theme: 'energy', dir: 'neutral'})}),
    financeArticle({analysis: null}), financeArticle({analysis: analysis({theme: 'zzz'})}),
    financeArticle({source: '乙', analysis: analysis({theme: 'optical'})}),
    financeArticle({category: 'tech'}), article({category: 'society'}),
  ];
  h.message({...listing(items), classify: {enabled: true}, analysis: {pending: 999}});
  choose(h, h.categories, 'finance');
  const lines = () => [panel(h).querySelector('.nw-sample-count').textContent,
    panel(h).querySelector('.nw-pending').textContent,
    panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'),
    panel(h).querySelector('.nw-market').title,
    panel(h).querySelector('.nw-macro').textContent];
  assert.deepEqual(lines(), [
    '8 個事件（8 則報導），2 個來源', '待分析 2',
    '正面 2、正反 1、無關 4、負面 1', '無關 1、未明 3',
    '大盤／總經  2 個事件利多 0利空 1',
  ]);
  assert.deepEqual(themeButtons(h).map(b => b.getAttribute('aria-label')), ['記憶體 2（▲1）', '光通訊 1（▲1）', '能源 1']);
  choose(h, h.select, '甲');
  assert.equal(lines()[0], '7 個事件（7 則報導），1 個來源');
  assert.equal(lines()[1], '待分析 2');
  assert.equal(lines()[2], '正面 1、正反 1、無關 4、負面 1');
  assert.equal(lines()[3], '無關 1、未明 3');
  assert.equal(themeButton(h, 'optical'), undefined);
  h.message({...listing(items), classify: {enabled: false}});
  assert.equal(lines()[1], '待分析 0');
});

test('ranking uses count then fixed table order, excludes macro/other and caps at ten', t => {
  const h = setup(t);
  const themes = [['foundry', '晶圓代工'], ['ic_design', 'IC 設計'], ['memory', '記憶體'],
    ['packaging', '先進封裝'], ['semi_equip', '半導體設備材料'], ['ai_server', 'AI 伺服器'],
    ['cooling', '散熱'], ['pcb', 'PCB／被動元件'], ['optical', '光通訊'], ['display', '光電面板'],
    ['leo', '低軌衛星'], ['energy', '能源'], ['ev', '電動車'], ['financials', '金融'],
    ['property', '營建房產'], ['transport', '航運航空'], ['consumer_elec', '消費電子'],
    ['petrochem', '原物料傳產'], ['software', '軟體網路'], ['industrial', '工業電腦']];
  h.message(listing([...themes].reverse().map(([theme]) => financeArticle({analysis: analysis({theme, dir: 'neutral'})}))
    .concat([financeArticle({analysis: analysis({dir: 'neutral'})}),
      ...Array.from({length: 11}, () => financeArticle({analysis: analysis({theme: 'macro'})})),
      ...Array.from({length: 11}, () => financeArticle({analysis: analysis({theme: 'other'})}))])));
  choose(h, h.categories, 'finance');
  assert.equal(themeButtons(h).length, 10);
  assert.deepEqual(themeButtons(h).map(b => b.dataset.topic),
    ['memory', 'foundry', 'ic_design', 'packaging', 'semi_equip', 'ai_server', 'cooling', 'pcb', 'optical', 'display']);
  assert.equal(themeButton(h, 'memory').getAttribute('aria-label'), '記憶體 2');
  for (const group of [themes.slice(0, 10), themes.slice(10)]) {
    h.message(listing(group.map(([theme]) => financeArticle({analysis: analysis({theme, dir: 'neutral'})}))));
    assert.deepEqual(themeButtons(h).map(b => b.getAttribute('aria-label')), group.map(([, name]) => `${name} 1`));
  }
});

test('direction threshold 0.59/0.6 controls both ranking arrows and row prefixes', t => {
  const h = setup(t);
  h.message(listing([
    financeArticle({analysis: analysis({dir_p: 0.59})}),
    financeArticle({analysis: analysis({dir_p: 0.6})}),
    financeArticle({analysis: analysis({dir: 'bear', dir_p: 0.59})}),
    financeArticle({analysis: analysis({dir: 'bear', dir_p: 0.6})}),
    financeArticle({analysis: analysis({dir: 'mixed', dir_p: 1})}),
    financeArticle({analysis: analysis({dir: 'neutral', dir_p: 1})}),
    financeArticle({analysis: analysis({theme: 'macro'})}),
    financeArticle({analysis: analysis({theme: 'other'})}),
    financeArticle({analysis: null}),
    financeArticle({category: 'tech'}), financeArticle({category: 'society'}),
  ]));
  const labels = () => [...h.container.querySelectorAll('li')].map(li =>
    [li.querySelector('.nw-category').textContent, li.querySelector('.nw-tag')?.textContent || '']);
  assert.deepEqual(labels(), [['財經', '記憶體'], ['財經', '記憶體 ▲'], ['財經', '記憶體'], ['財經', '記憶體 ▼'],
    ['財經', '記憶體'], ['財經', '記憶體'], ['財經', '大盤 ▲'], ['財經', ''], ['財經', ''], ['科技', '記憶體 ▲'], ['社會', '']]);
  choose(h, h.categories, 'finance');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-label'), '記憶體 6（▲1 ▼1）');
});

test('theme filter toggles, cancels, preserves panel scope and survives same-at updates', t => {
  const h = setup(t);
  const items = [financeArticle({title: '甲記憶體'}),
    financeArticle({title: '甲代工', analysis: analysis({theme: 'foundry'})}),
    financeArticle({title: '乙記憶體', source: '乙'}),
    financeArticle({title: '科技記憶體', category: 'tech'}), article({title: '社會', category: 'society'})];
  h.message(listing(items));
  choose(h, h.categories, 'finance');
  choose(h, h.select, '甲');
  const stats = panel(h).textContent;
  themeButton(h, 'memory').click();
  assert.deepEqual(rowTitles(h), ['甲記憶體']);
  assert.equal(panel(h).textContent, stats);
  assert.equal(themeButton(h, 'memory').getAttribute('aria-pressed'), 'true');
  const clear = h.container.querySelector('[aria-label=取消題材篩選]');
  assert.equal(clear.parentElement.hidden, false);
  assert.equal(clear.parentElement.textContent, '已篩選：記憶體清除');
  themeButton(h, 'memory').click();
  assert.deepEqual(rowTitles(h), ['甲記憶體', '甲代工']);
  themeButton(h, 'memory').click();
  clear.click();
  assert.deepEqual(rowTitles(h), ['甲記憶體', '甲代工']);
  themeButton(h, 'memory').click();
  h.message(listing([...items, financeArticle({title: '新增記憶體'})]));
  assert.equal(h.select.value, '甲');
  assert.equal(h.categories.value, 'finance');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(rowTitles(h), ['甲記憶體', '新增記憶體']);
  choose(h, h.categories, 'tech');
  assert.equal(clear.parentElement.hidden, false);
  assert.deepEqual(rowTitles(h), ['科技記憶體']);
  choose(h, h.categories, 'society');
  assert.equal(clear.parentElement.hidden, true);
  choose(h, h.categories, 'finance');
  assert.deepEqual(rowTitles(h), ['甲記憶體', '甲代工', '新增記憶體']);
});

test('selected theme remains cancellable after it disappears from new data', t => {
  const h = setup(t);
  h.message(listing([financeArticle()]));
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  h.message(listing([financeArticle({analysis: analysis({theme: 'foundry'})})]));
  assert.deepEqual(rowTitles(h), []);
  assert.equal(themeButton(h, 'foundry').getAttribute('aria-label'), '晶圓代工 1（▲1）');
  h.container.querySelector('[aria-label=取消題材篩選]').click();
  assert.equal(rowTitles(h).length, 1);
});

test('small-sample boundary is below ten and empty ranking has placeholder', t => {
  const h = setup(t);
  choose(h, h.categories, 'finance');
  for (const size of [0, 9, 10]) {
    h.message(listing(Array.from({length: size}, () => financeArticle({analysis: null}))));
    assert.equal(!panel(h).querySelector('.nw-warning').hidden, size < 10);
    assert.equal(h.container.querySelector('[aria-label=題材排行]').textContent, '題材：尚無');
  }
});

test('invalid analysis is entirely treated as missing and never coerces field types', t => {
  const h = setup(t);
  const throwing = {toString() { throw new Error('do not coerce'); }};
  const bad = [null, undefined, [], true, 1, 'bad', {},
    ...['market', 'theme', 'dir'].flatMap(field => [undefined, null, [], throwing, 'zzz', '__proto__', 'constructor']
      .map(value => analysis({[field]: value}))),
    ...[undefined, null, '0.8', true, {}, [], NaN, Infinity, -0.01, 1.01].map(dir_p => analysis({dir_p}))];
  choose(h, h.categories, 'finance');
  assert.doesNotThrow(() => h.message(listing(bad.map(value => financeArticle({analysis: value})))));
  assert.equal(h.container.querySelectorAll('li').length, bad.length);
  assert.ok([...h.container.querySelectorAll('li')].every(li => li.querySelector('.nw-category').textContent === '財經' && !li.querySelector('.nw-tag')));
  assert.equal(panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'),
    `正面 0、正反 0、無關 ${bad.length}、負面 0`);
  assert.equal(panel(h).querySelector('.nw-market').title, `無關 0、未明 ${bad.length}`);
  assert.equal(themeButtons(h).length, 0);
  for (const dir_p of [0, 1]) {
    h.message(listing([financeArticle({analysis: analysis({dir_p})})]));
    assert.equal(themeButtons(h).length, 1);
  }
});

test('analysis panel and prefixes remain text-only with hostile fields', t => {
  const h = setup(t);
  const evil = '<img src=x onerror=alert(1)>';
  h.message(listing([financeArticle({title: evil, summary: evil}),
    financeArticle({title: evil, analysis: analysis({theme: evil})})]));
  choose(h, h.categories, 'finance');
  assert.equal(h.container.querySelectorAll('img,script').length, 0);
  assert.equal(h.container.querySelector('a').textContent, evil);
  assert.equal(h.container.querySelector('a').title, evil);
  assert.equal(themeButton(h, 'memory').getAttribute('aria-label'), '記憶體 1（▲1）');
  assert.equal(themeButtons(h).length, 1);
  assert.equal(h.container.querySelectorAll('li')[1].querySelector('.nw-category').textContent, '財經');
  assert.equal(h.container.querySelectorAll('li')[1].querySelector('.nw-tag'), null);
});

test('unmount removes theme delegation and clear-filter listeners', t => {
  const h = setup(t);
  h.message(listing([financeArticle(), financeArticle({analysis: analysis({theme: 'foundry'})})]));
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  const button = themeButton(h, 'foundry');
  const clear = h.container.querySelector('[aria-label=取消題材篩選]');
  const detachedList = h.container.querySelector('ul');
  const detachedPanel = panel(h);
  const text = detachedPanel.textContent;
  h.handle.unmount();
  button.click();
  assert.equal(detachedList.children.length, 1);
  clear.click();
  assert.equal(detachedList.children.length, 1);
  assert.equal(detachedPanel.textContent, text);
  assert.equal(h.container.childNodes.length, 0);
});

test('style stays inside module root, scopes parsed CSS rules and leaves host untouched', t => {
  const h = setup(t);
  const root = h.container.querySelector('section.nw');
  const style = root.querySelector('style');
  assert.equal(style.parentElement, root);
  assert.equal(h.window.document.head.querySelector('style'), null);
  assert.equal(h.container.getAttribute('style'), null);
  assert.equal(h.container.getAttribute('class'), null);
  assert.equal(h.container.hidden, false);
  const selectors = [], groups = [];
  function inspect(rules) {
    for (const rule of rules) {
      if (rule.selectorText) {
        for (const selector of rule.selectorText.split(',')) {
          const value = selector.trim();
          assert.ok(/^\.nw(?:\b|\s)/.test(value), value);
          selectors.push(value);
        }
      } else {
        assert.ok(rule.cssRules, rule.cssText);
        groups.push(rule.cssText);
        inspect(rule.cssRules);
      }
    }
  }
  assert.doesNotMatch(style.textContent, /data-theme/);
  inspect(style.sheet.cssRules);
  assert.ok(selectors.length > 50);
  assert.ok(groups.some(text => text.startsWith('@container (min-width: 560px)')));
  assert.ok(groups.some(text => text.startsWith('@container (max-width: 419.98px)')));
  assert.ok(groups.some(text => text.includes('prefers-reduced-motion: reduce') && text.includes('transition: none')));
  assert.match(style.textContent, /container-type: inline-size/);
  assert.match(style.textContent, /transition: width 240ms ease/);
  assert.match(style.textContent, /outline: 2px solid var\(--nw-focus\)/);
  h.handle.unmount();
  assert.equal(h.window.document.querySelector('style'), null);
  assert.equal(h.container.childNodes.length, 0);
});

test('palette inherits shell tokens and uses light-dark for semantic colors', t => {
  const h = setup(t);
  const rules = [...h.container.querySelector('style').sheet.cssRules];
  const base = rules.find(rule => rule.selectorText === '.nw').style;
  for (const [token, shell, fallback] of [['bg', 'bg', '#ffffff'], ['fg', 'fg', '#242424'],
    ['muted', 'fg-muted', '#616161'], ['line', 'border', '#c7c7c7'], ['surface', 'surface', '#f3f3f3'],
    ['accent', 'accent', '#005fb8'], ['focus', 'focus', '#005fb8']]) {
    assert.equal(base.getPropertyValue(`--nw-${token}`), `var(--md-${shell}, ${fallback})`);
  }
  for (const [token, light, night] of [['up', '#c8102e', '#ff6b6b'], ['down', '#0f7b3f', '#4fd18b'], ['mixed', '#b7791f', '#f0b429']]) {
    assert.equal(base.getPropertyValue(`--nw-${token}`), `light-dark(${light}, ${night})`);
  }
  assert.equal(base.getPropertyValue('--nw-idle'), 'color-mix(in srgb, var(--nw-muted) 45%, transparent)');
});

test('market bar has four ordered proportional segments, complete accessible counts and zero state', t => {
  const h = setup(t);
  choose(h, h.categories, 'finance');
  const bar = panel(h).querySelector('.nw-market-bar');
  assert.equal(bar.getAttribute('role'), 'img');
  assert.equal(bar.dataset.empty, 'true');
  assert.equal(bar.getAttribute('aria-label'), '正面 0、正反 0、無關 0、負面 0');
  const parts = [...bar.children];
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(part => part.style.width), ['0%', '0%', '0%', '0%']);
  assert.deepEqual(parts.map(part => part.className),
    ['nw-segment nw-positive', 'nw-segment nw-mixed', 'nw-segment nw-idle', 'nw-segment nw-negative']);
  h.message(listing(['positive', 'positive', 'mixed', 'not_market', 'other', null, 'negative', 'negative']
    .map(market => financeArticle({analysis: market ? analysis({market}) : null}))));
  assert.equal(bar.dataset.empty, 'false');
  assert.equal(bar.getAttribute('aria-label'), '正面 2、正反 1、無關 3、負面 2');
  assert.deepEqual(parts.map(part => part.style.width), ['25%', '12.5%', '37.5%', '25%']);
  assert.deepEqual([...panel(h).querySelectorAll('.nw-value')].map(value => value.textContent), ['2', '1', '3', '2']);
  h.message(listing([financeArticle()]));
  assert.equal(bar.firstElementChild, parts[0]); // Keep nodes so width transitions can run on resends.
  assert.equal(parts[0].style.width, '100%');
  h.message(listing([]));
  assert.equal(bar.dataset.empty, 'true');
  assert.deepEqual(parts.map(part => part.style.width), ['0%', '0%', '0%', '0%']);
});

test('theme mini-bars scale to leader and split qualified bull, bear and remaining reports', t => {
  const h = setup(t);
  const items = [
    ...[analysis(), analysis({dir_p: 0.6}), analysis({dir: 'bear'}),
      analysis({dir_p: 0.59}), analysis({dir: 'mixed'}), analysis({dir: 'neutral'})]
      .map(value => financeArticle({analysis: value})),
    ...Array.from({length: 3}, () => financeArticle({analysis: analysis({theme: 'foundry'})})),
  ];
  h.message(listing(items));
  choose(h, h.categories, 'finance');
  const leader = themeButton(h, 'memory');
  assert.equal(leader.getAttribute('data-topic'), 'memory');
  assert.equal(h.container.querySelector('button[data-theme]'), null);
  assert.equal(h.container.querySelectorAll('button[data-topic]').length, 2);
  const leaderBar = leader.querySelector('.nw-theme-bar');
  assert.equal(leaderBar.style.width, '100%');
  assert.equal(themeButton(h, 'foundry').querySelector('.nw-theme-bar').style.width, '50%');
  assert.deepEqual([...leaderBar.children].map(part => part.className),
    ['nw-segment nw-bull', 'nw-segment nw-bear', 'nw-segment nw-idle']);
  [2 / 6 * 100, 1 / 6 * 100, 50].forEach((width, i) =>
    assert.ok(Math.abs(parseFloat(leaderBar.children[i].style.width) - width) < 0.00001));
  assert.equal(leader.querySelector('.nw-theme-name').textContent, '記憶體');
  assert.equal(leader.querySelector('.nw-theme-count').textContent, '6');
  leader.querySelector('.nw-theme-name').click(); // Delegation also works on the new child spans.
  assert.equal(leader.getAttribute('aria-pressed'), 'true');
  assert.equal(rowTitles(h).length, 6);
  h.message(listing([...items, financeArticle({analysis: analysis({theme: 'foundry'})})]));
  assert.equal(themeButton(h, 'memory'), leader);
  assert.equal(leader.querySelector('.nw-theme-bar'), leaderBar);
  assert.ok(Math.abs(parseFloat(themeButton(h, 'foundry').querySelector('.nw-theme-bar').style.width) - 4 / 6 * 100) < 0.00001);
});

test('status shows local HH:mm and suppresses zero failures and zero unclassified counts', t => {
  const h = setup(t);
  const date = new Date('2026-09-21T02:04:00Z');
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const status = () => h.container.querySelector('[role=status]').textContent;
  h.message({...listing([], [{name: '甲', ok: true}]), classify: {enabled: true, pending: 0}});
  assert.equal(status(), `${hhmm} 更新`);
  h.message({...listing([]), classify: {enabled: true, pending: 3}});
  assert.equal(status(), `${hhmm} 更新 · 乙 失敗 · 未分類：3`);
  h.message({...listing([], [{ok: false}, {ok: false}, {ok: 'false'}]), classify: {enabled: false}});
  assert.equal(status(), `${hhmm} 更新 · 未命名來源等 2 個來源失敗 · 分類：關閉`);
  for (const at of [null, {}, 10, 'bad']) {
    h.message({...listing([], []), at});
    assert.equal(status(), '');
  }
});

test('empty state starts loading and clear filters resets source, category and theme', t => {
  const h = setup(t);
  const empty = h.container.querySelector('.nw-empty');
  const clear = empty.querySelector('button');
  assert.equal(empty.hidden, false);
  assert.equal(empty.querySelector('span').textContent, '正在取得新聞');
  assert.equal(clear.hidden, true);
  h.message(listing([financeArticle()]));
  assert.equal(empty.hidden, true);
  choose(h, h.select, '甲');
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  h.message(listing([financeArticle({source: '乙', analysis: analysis({theme: 'foundry'})}), article({title: '未分類'})]));
  assert.equal(empty.hidden, false);
  assert.equal(empty.querySelector('span').textContent, '這個條件下沒有新聞');
  assert.equal(clear.hidden, false);
  clear.click();
  assert.equal(h.select.value, '');
  assert.equal(h.categories.value, '');
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  assert.equal(empty.hidden, true);
  assert.equal(rowTitles(h).length, 2);
  choose(h, h.categories, 'finance');
  assert.equal(rowTitles(h).length, 1); // The old memory filter really is gone.
  const detachedList = h.container.querySelector('ul');
  h.handle.unmount();
  clear.click();
  assert.equal(h.categories.value, 'finance');
  assert.equal(detachedList.children.length, 1);
});

test('clear buttons are separate and only visible in their intended states', t => {
  const h = setup(t);
  const themeClear = h.container.querySelector('[aria-label=取消題材篩選]');
  const emptyClear = h.container.querySelector('.nw-empty button');
  assert.notEqual(themeClear, emptyClear);
  // Check computed display along the ancestor chain: hidden attributes alone
  // miss a later display:flex rule overriding the hiding rule.
  const visible = element => {
    for (let node = element; node && node !== h.container; node = node.parentElement) {
      if (h.window.getComputedStyle(node).display === 'none') return false;
    }
    return true;
  };
  const visibleClearButtons = () => [...h.container.querySelectorAll('button')]
    .filter(button => button.textContent.startsWith('清除') && visible(button))
    .map(button => button.textContent);
  assert.deepEqual(visibleClearButtons(), []);
  h.message(listing([financeArticle()]));
  for (const category of ['', 'finance', 'tech']) {
    if (category === 'tech') h.message(listing([financeArticle({category: 'tech'})]));
    choose(h, h.categories, category);
    assert.deepEqual(visibleClearButtons(), []);
  }
  themeButton(h, 'memory').click();
  assert.deepEqual(visibleClearButtons(), ['清除']);
  themeClear.click();
  assert.deepEqual(visibleClearButtons(), []);
  h.message(listing([]));
  assert.deepEqual(visibleClearButtons(), ['清除篩選']);
  h.message(listing([financeArticle({category: 'tech'})]));
  assert.deepEqual(visibleClearButtons(), []);
});

test('content shares panel inline insets and theme button insets cancel without shifting selection', t => {
  const h = setup(t);
  h.message(listing([financeArticle()]));
  choose(h, h.categories, 'finance');
  const computed = element => h.window.getComputedStyle(element);
  const root = computed(h.container.querySelector('.nw'));
  assert.ok(parseFloat(root.marginLeft) > 0);
  assert.ok(parseFloat(root.marginRight) > 0);
  const panelStyle = computed(panel(h));
  for (const selector of ['.nw-toolbar', '.nw-filter', '.nw-row']) {
    const style = computed(h.container.querySelector(selector));
    assert.equal(style.getPropertyValue('padding-inline'), panelStyle.paddingLeft);
    assert.equal(style.getPropertyValue('padding-inline'), panelStyle.paddingRight);
  }
  const button = themeButton(h, 'memory');
  for (const selected of [false, true]) {
    if (selected) button.click();
    const style = computed(button);
    assert.equal(parseFloat(style.marginLeft) + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), 0);
    assert.equal(parseFloat(style.marginRight) + parseFloat(style.paddingRight), 0);
    assert.equal(style.maxWidth, 'none'); // Allow the grid button to extend into both negative margins.
    assert.equal(button.getAttribute('aria-pressed'), String(selected));
  }
});

const eventStory = (id, title, hour, overrides = {}) => financeArticle({event: id,
  event_size: 3, title, published: `2026-09-24T${String(hour).padStart(2, '0')}:00:00Z`, ...overrides});
const mainRows = h => [...h.container.querySelectorAll('.nw-list > .nw-row')];
const mainTitles = h => mainRows(h).map(row => row.querySelector('.nw-title').textContent);

test('events collapse to earliest report and toggle accessible other reports with correct count', t => {
  const h = setup(t);
  const id = 'abcdef012345';
  h.message(listing([eventStory(id, '最新', 12), eventStory(id, '最早', 8),
    eventStory(id, '中間', 10, {source: '乙'}), eventStory('111111111111', '單則', 9, {event_size: 1})]));
  assert.deepEqual(mainTitles(h), ['最早', '單則']);
  const row = mainRows(h)[0];
  const button = row.querySelector('.nw-expand');
  assert.equal(button.parentElement.className, 'nw-meta');
  assert.equal(button.parentElement.lastElementChild, button);
  assert.equal(button.textContent, '另 2 則報導');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  const reports = row.querySelector('.nw-reports');
  assert.equal(reports.hidden, true);
  assert.equal(h.window.getComputedStyle(reports).display, 'none');
  assert.equal(mainRows(h)[1].querySelector('button'), null);
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(reports.hidden, false);
  assert.deepEqual([...reports.querySelectorAll('.nw-report-title')].map(a => a.textContent), ['中間', '最新']);
  assert.deepEqual([...reports.querySelectorAll('.nw-source')].map(a => a.textContent), ['乙', '甲']);
  assert.ok([...reports.querySelectorAll('.nw-time')].every(time => /^(?:\d{1,2}\/\d{1,2} )?\d{2}:\d{2}$/.test(time.textContent)));
  for (const a of reports.querySelectorAll('a')) {
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener noreferrer');
    assert.equal(a.title, '摘要');
  }
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(reports.hidden, true);
});

test('source category and topic filter individual reports before selecting representative and N', t => {
  const h = setup(t);
  const id = '000000000001';
  h.message(listing([
    eventStory(id, '社會最早', 6, {category: 'society', event_size: 5}),
    eventStory(id, '甲代工', 7, {event_size: 5, analysis: analysis({theme: 'foundry'})}),
    eventStory(id, '乙記憶體', 8, {event_size: 5, source: '乙'}),
    eventStory(id, '甲記憶體', 9, {event_size: 5}),
    eventStory(id, '甲科技', 10, {event_size: 5, category: 'tech'}),
  ]));
  assert.deepEqual(mainTitles(h), ['社會最早']);
  assert.equal(h.container.querySelector('.nw-expand').textContent, '另 4 則報導');
  choose(h, h.categories, 'finance');
  assert.deepEqual(mainTitles(h), ['甲代工']);
  assert.equal(h.container.querySelector('.nw-expand').textContent, '另 2 則報導');
  choose(h, h.select, '乙');
  assert.deepEqual(mainTitles(h), ['乙記憶體']);
  assert.equal(h.container.querySelector('.nw-expand'), null);
  choose(h, h.select, '甲');
  // Another event supplies the memory button: event 1's panel analysis is foundry.
  const existing = [eventStory(id, '甲代工', 7, {analysis: analysis({theme: 'foundry'})}), eventStory(id, '甲記憶體', 9),
    eventStory('000000000002', '獨立記憶體', 10, {event_size: 1})];
  h.message(listing(existing));
  const before = panel(h).textContent;
  themeButton(h, 'memory').click();
  assert.deepEqual(mainTitles(h), ['甲記憶體', '獨立記憶體']);
  assert.equal(h.container.querySelector('.nw-expand'), null);
  assert.equal(panel(h).textContent, before);
});

test('expanded event survives same-at replacement, representative change and filters', t => {
  const h = setup(t);
  const id = '000000000003';
  const items = [eventStory(id, '晚', 12), eventStory(id, '早', 8)];
  h.message(listing(items));
  choose(h, h.select, '甲');
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  h.container.querySelector('.nw-expand').click();
  h.message(listing([...items, eventStory(id, '更早', 6)]));
  assert.equal(h.select.value, '甲');
  assert.equal(h.categories.value, 'finance');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(mainTitles(h), ['更早']);
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'), 'true');
  assert.equal(h.container.querySelector('.nw-expand').textContent, '另 2 則報導');
  assert.equal(h.container.querySelector('.nw-reports').hidden, false);
  choose(h, h.select, '乙');
  assert.equal(mainRows(h).length, 0);
  choose(h, h.select, '甲');
  assert.equal(h.container.querySelector('.nw-reports').hidden, false);
  h.message(listing(items.map(item => ({...item, event: '000000000004'}))));
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'), 'false');
});

test('panel counts events and takes earliest valid analysis while retaining report and source counts', t => {
  const h = setup(t);
  const items = [
    eventStory('aaaaaaaaaaaa', '無分析', 6, {analysis: null, event_size: 4}),
    eventStory('aaaaaaaaaaaa', '先分析負面', 8, {source: '乙', event_size: 4, analysis: analysis({market: 'negative', dir: 'bear'})}),
    ...[10, 12].map(hour => eventStory('aaaaaaaaaaaa', '後分析正面', hour, {event_size: 4})),
    ...[7, 9, 11].map(hour => eventStory('bbbbbbbbbbbb', '大盤', hour, {analysis: analysis({market: 'mixed', theme: 'macro'})})),
    ...[7, 9, 11].map(hour => eventStory('cccccccccccc', '未分析', hour, {analysis: null})),
  ];
  h.message(listing([...items].reverse()));
  choose(h, h.categories, 'finance');
  assert.equal(panel(h).querySelector('.nw-sample-count').textContent, '3 個事件（10 則報導），2 個來源');
  assert.equal(panel(h).querySelector('.nw-pending').textContent, '待分析 1');
  assert.equal(panel(h).querySelector('.nw-warning').hidden, false); // 10 reports but only 3 events.
  assert.equal(panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'), '正面 0、正反 1、無關 1、負面 1');
  assert.equal(panel(h).querySelector('.nw-macro').textContent, '大盤／總經  1 個事件利多 1利空 0');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-label'), '記憶體 1（▼1）');
  assert.equal(panel(h).querySelector('.nw-note').textContent, '同一事件多家報導只算一次。');
  choose(h, h.select, '甲');
  assert.equal(panel(h).querySelector('.nw-sample-count').textContent, '3 個事件（9 則報導），1 個來源');
  assert.equal(panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'), '正面 1、正反 1、無關 1、負面 0');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-label'), '記憶體 1（▲1）');
});

test('representative compares actual timestamps and uses source order on equal dates', t => {
  const h = setup(t);
  const id = 'dddddddddddd';
  h.message(listing([
    eventStory(id, '晚但字面早', 1, {published: '2026-09-24T01:00:00-08:00'}),
    eventStory(id, '乙同時', 8, {source: '乙'}), eventStory(id, '甲同時', 8),
  ]));
  assert.deepEqual(mainTitles(h), ['甲同時']);
  h.message(listing([eventStory(id, '壞日期', 1, {published: {}}), eventStory(id, '有效日期', 8)]));
  assert.deepEqual(mainTitles(h), ['有效日期']);
});

test('malformed event metadata always stays in separate singleton groups without coercion', t => {
  const h = setup(t);
  const throwing = {toString() { throw new Error('do not stringify'); }};
  const bad = [
    ...['', 'abc', 'gggggggggggg', '0000000000000', 'aaaaaaaaaaaa\n', '<img src=x>', null, undefined, 1, {}, [], throwing]
      .map(event => ({event, event_size: 2})),
    ...[undefined, null, 0, -1, .5, '2', true, NaN, Infinity, {}, [], throwing]
      .map(event_size => ({event: 'aaaaaaaaaaaa', event_size})),
  ];
  assert.doesNotThrow(() => h.message(listing(bad.map(overrides => financeArticle(overrides)))));
  assert.equal(mainRows(h).length, bad.length);
  assert.equal(h.container.querySelector('.nw-expand'), null);
  choose(h, h.categories, 'finance');
  assert.equal(themeButton(h, 'memory').querySelector('.nw-theme-count').textContent, String(bad.length));
  assert.equal(h.container.querySelector('img'), null);
  // Uppercase is still valid hex, and the supplied size never fabricates reports.
  h.message(listing([eventStory('ABCDEFABCDEF', '大寫', 8, {event_size: 999}),
    eventStory('abcdefabcdef', '小寫', 9, {event_size: 999})]));
  assert.equal(mainRows(h).length, 1);
  assert.equal(h.container.querySelector('.nw-expand').textContent, '另 1 則報導');
});

test('merging status shows only a positive integer and updates to zero safely', t => {
  const h = setup(t);
  choose(h, h.categories, 'finance');
  const merging = h.container.querySelector('.nw-merging');
  h.message({...listing([financeArticle()]), events: {pending: 17}});
  assert.equal(merging.hidden, false);
  assert.equal(merging.textContent, '・待合併 17');
  for (const pending of [0, -1, .5, '17', null, undefined, true, {}, [], NaN, Infinity]) {
    h.message({...listing([financeArticle()]), events: {pending}});
    assert.equal(merging.hidden, true);
    assert.equal(merging.textContent, '');
  }
  for (const events of [null, undefined, 'bad', false, []]) {
    assert.doesNotThrow(() => h.message({...listing([]), events}));
    assert.equal(merging.hidden, true);
  }
});

test('expanded reports retain text and URL defenses, muted styling and remove delegation on unmount', t => {
  const h = setup(t);
  const evil = '<img src=x onerror=alert(1)>';
  const id = 'eeeeeeeeeeee';
  h.message(listing([eventStory(id, '代表', 6),
    eventStory(id, evil, 8, {summary: evil, source: evil, link: 'javascript:alert(1)'}),
    eventStory(id, '安全連結', 9)]));
  const button = h.container.querySelector('.nw-expand');
  button.click();
  const reports = h.container.querySelector('.nw-reports');
  assert.equal(reports.querySelector('span.nw-report-title').textContent, evil);
  assert.equal(reports.querySelector('span.nw-report-title').title, evil);
  assert.equal(reports.querySelector('.nw-source').textContent, evil);
  assert.equal(reports.querySelectorAll('a').length, 1);
  assert.equal(h.container.querySelectorAll('img,script').length, 0);
  const rules = [...h.container.querySelector('style').sheet.cssRules];
  for (const selector of ['.nw .nw-report', '.nw .nw-report-title']) {
    const style = rules.find(rule => rule.selectorText === selector).style;
    assert.equal(style.fontSize, '12px');
    assert.equal(style.color, 'var(--nw-muted)');
  }
  h.handle.unmount();
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(reports.hidden, false);
  assert.equal(h.container.childNodes.length, 0);
});

const worldAnalysis = (overrides = {}) => ({kind: 'world', trend: 'escalation', region: 'asia_pacific', ...overrides});
const worldArticle = (overrides = {}) => article({category: 'world', analysis: worldAnalysis(), ...overrides});
const worldPanel = h => h.container.querySelector('[aria-label=國際局勢分析]');
const regionButtons = h => [...h.container.querySelectorAll('[aria-label=地區排行] button')];
const regionButton = (h, id) => regionButtons(h).find(b => b.dataset.topic === `region:${id}`);

test('world panel replaces finance panel only for world and restores finance presentation', t => {
  const h = setup(t);
  h.message(listing([worldArticle(), financeArticle()]));
  const surface = h.container.querySelector('.nw-panel');
  for (const category of ['', 'politics', 'life', 'society']) {
    choose(h, h.categories, category);
    assert.equal(surface.hidden, true);
    assert.equal(worldPanel(h), null);
  }
  choose(h, h.categories, 'world');
  assert.equal(worldPanel(h), surface);
  assert.equal(surface.hidden, false);
  assert.equal(surface.previousElementSibling.className, 'nw-focus-section');
  assert.equal(surface.previousElementSibling.previousElementSibling.className, 'nw-toolbar');
  assert.equal(surface.querySelector('.nw-heading').textContent, '局勢走向');
  assert.equal(surface.querySelector('.nw-macro').hidden, true);
  assert.equal(surface.querySelector('.nw-ranking-heading').textContent, '地區（點選篩選）');
  assert.equal(surface.querySelector('.nw-note').textContent, '同一事件多家報導只算一次。');
  choose(h, h.categories, 'finance');
  assert.equal(panel(h), surface);
  assert.equal(surface.querySelector('.nw-heading').textContent, '股市訊號');
  assert.equal(surface.querySelector('.nw-macro').hidden, false);
  assert.deepEqual([...surface.querySelector('.nw-market-bar').children].map(p => p.className),
    ['nw-segment nw-positive', 'nw-segment nw-mixed', 'nw-segment nw-idle', 'nw-segment nw-negative']);
});

test('world bar uses ordered escalation stalemate deescalation idle event counts and semantic tokens', t => {
  const h = setup(t);
  const shared = {event: 'aaaaaaaaaaaa', event_size: 2};
  const items = [worldArticle({...shared, analysis: null, published: '2026-09-24T01:00:00Z'}),
    worldArticle({...shared, published: '2026-09-24T02:00:00Z'}),
    ...['escalation', 'stalemate', 'deescalation', 'not_conflict', 'other'].map(trend => worldArticle({analysis: worldAnalysis({trend})})),
    worldArticle({analysis: null}), worldArticle({analysis: worldAnalysis({trend: 'deescalation'})}),
    financeArticle()];
  h.message({...listing(items), events: {pending: 7}});
  choose(h, h.categories, 'world');
  const surface = worldPanel(h);
  assert.equal(surface.querySelector('.nw-sample-count').textContent, '8 個事件（9 則報導），1 個來源');
  assert.equal(surface.querySelector('.nw-pending').textContent, '待分析 1');
  assert.equal(surface.querySelector('.nw-merging').textContent, '・待合併 7');
  const bar = surface.querySelector('.nw-market-bar');
  assert.equal(bar.getAttribute('aria-label'), '升級 2、僵持 1、緩和 2、無關 3');
  assert.deepEqual([...bar.children].map(p => p.style.width), ['25%', '12.5%', '25%', '37.5%']);
  assert.deepEqual([...bar.children].map(p => p.className),
    ['nw-segment nw-escalation', 'nw-segment nw-mixed', 'nw-segment nw-deescalation', 'nw-segment nw-idle']);
  assert.deepEqual([...surface.querySelectorAll('.nw-value')].map(p => p.textContent), ['2', '1', '2', '3']);
  const rules = [...h.container.querySelector('style').sheet.cssRules];
  const base = rules.find(rule => rule.selectorText === '.nw').style;
  assert.equal(base.getPropertyValue('--nw-danger'), 'var(--md-danger, light-dark(#b42318, #ff8b82))');
  for (const [selector, token] of [['.nw .nw-escalation', '--nw-danger'], ['.nw .nw-mixed', '--nw-mixed'],
    ['.nw .nw-deescalation', '--nw-accent'], ['.nw .nw-idle', '--nw-idle']]) {
    assert.equal(rules.find(rule => rule.selectorText === selector).style.background, `var(${token})`);
  }
  h.message(listing([]));
  assert.equal(bar.dataset.empty, 'true');
  assert.deepEqual([...bar.children].map(p => p.style.width), ['0%', '0%', '0%', '0%']);
});

test('regions rank by event count then fixed order, include other, hide zeros and segment mini-bars', t => {
  const h = setup(t);
  const regions = [['us_china', '美中'], ['asia_pacific', '亞太'], ['middle_east', '中東'],
    ['europe_russia', '歐洲／俄烏'], ['americas', '美洲'], ['other', '其他']];
  h.message(listing([...regions].reverse().map(([region]) => worldArticle({analysis: worldAnalysis({region})})).concat([
    worldArticle({analysis: worldAnalysis({trend: 'deescalation'})}),
    worldArticle({analysis: worldAnalysis({trend: 'stalemate'})}),
  ])));
  choose(h, h.categories, 'world');
  assert.deepEqual(regionButtons(h).map(b => b.dataset.topic),
    ['region:asia_pacific', 'region:us_china', 'region:middle_east', 'region:europe_russia', 'region:americas', 'region:other']);
  const asia = regionButton(h, 'asia_pacific');
  assert.equal(asia.getAttribute('aria-label'), '亞太 3（升級 1 緩和 1）');
  const bar = asia.querySelector('.nw-theme-bar');
  assert.equal(bar.style.width, '100%');
  assert.deepEqual([...bar.children].map(p => p.className), ['nw-segment nw-escalation', 'nw-segment nw-deescalation', 'nw-segment nw-idle']);
  for (const part of bar.children) assert.ok(Math.abs(parseFloat(part.style.width) - 100/3) < .0001);
  assert.ok(Math.abs(parseFloat(regionButton(h, 'us_china').querySelector('.nw-theme-bar').style.width) - 100/3) < .0001);
  h.message(listing(regions.map(([region]) => worldArticle({analysis: worldAnalysis({region})}))));
  assert.deepEqual(regionButtons(h).map(b => b.querySelector('.nw-theme-name').textContent), regions.map(([, name]) => name));
  h.message(listing([worldArticle()]));
  assert.deepEqual(regionButtons(h).map(b => b.dataset.topic), ['region:asia_pacific']);
  h.message(listing([]));
  assert.equal(worldPanel(h).querySelector('.nw-ranking').textContent, '地區：尚無');
});

test('region filter acts before event folding, preserves scope and selections on resend, and clears across kinds', t => {
  const h = setup(t);
  const id = 'bbbbbbbbbbbb';
  const items = [worldArticle({title: '早美中', event: id, event_size: 2, published: '2026-09-24T01:00:00Z', analysis: worldAnalysis({region: 'us_china'})}),
    worldArticle({title: '晚亞太', event: id, event_size: 2, published: '2026-09-24T02:00:00Z'}),
    worldArticle({title: '獨立亞太'}), worldArticle({title: '乙亞太', source: '乙'}), financeArticle()];
  h.message(listing(items));
  choose(h, h.categories, 'world');
  choose(h, h.select, '甲');
  const before = worldPanel(h).textContent;
  regionButton(h, 'asia_pacific').querySelector('.nw-theme-name').click();
  assert.deepEqual(mainTitles(h), ['晚亞太', '獨立亞太']);
  assert.equal(worldPanel(h).textContent, before);
  assert.equal(regionButton(h, 'asia_pacific').getAttribute('aria-pressed'), 'true');
  assert.equal(h.container.querySelector('.nw-filter').textContent, '已篩選：亞太清除');
  h.message(listing([...items, worldArticle({title: '新增亞太'})]));
  assert.equal(h.select.value, '甲');
  assert.equal(h.categories.value, 'world');
  assert.deepEqual(mainTitles(h), ['晚亞太', '獨立亞太', '新增亞太']);
  h.container.querySelector('[aria-label=取消地區篩選]').click();
  assert.ok(mainTitles(h).includes('早美中'));
  regionButton(h, 'asia_pacific').click();
  regionButton(h, 'asia_pacific').click();
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  regionButton(h, 'asia_pacific').click();
  choose(h, h.categories, 'finance');
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  assert.equal(mainRows(h).length, 1);
  themeButton(h, 'memory').click();
  choose(h, h.categories, 'world');
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  assert.ok(mainTitles(h).includes('早美中'));
});

test('world tags show region and only escalation or deescalation words with correct text colors', t => {
  const h = setup(t);
  h.message(listing(['escalation', 'deescalation', 'stalemate', 'not_conflict', 'other'].map(trend =>
    worldArticle({analysis: worldAnalysis({trend, region: 'middle_east'})}))));
  assert.deepEqual(mainRows(h).map(row => row.querySelector('.nw-tag').textContent), ['中東 升級', '中東 緩和', '中東', '中東', '中東']);
  assert.equal(mainRows(h)[0].querySelector('.nw-danger-text').textContent, ' 升級');
  assert.equal(mainRows(h)[1].querySelector('.nw-calm-text').textContent, ' 緩和');
  assert.equal(h.container.querySelectorAll('.nw-tag .nw-up, .nw-tag .nw-down').length, 0);
  const rules = [...h.container.querySelector('style').sheet.cssRules];
  assert.equal(rules.find(rule => rule.selectorText === '.nw .nw-danger-text').style.color, 'var(--nw-danger)');
  assert.equal(rules.find(rule => rule.selectorText === '.nw .nw-calm-text').style.color, 'var(--nw-accent)');
});

test('legacy finance stays supported but invalid kinds or mismatched categories are unanalysed', t => {
  const h = setup(t);
  const invalid = [null, undefined, '', 'other', {}, [], true, 1, {toString() { throw Error('do not coerce'); }}];
  h.message(listing([financeArticle(), financeArticle({analysis: analysis({kind: 'finance'})}),
    ...invalid.map(kind => financeArticle({analysis: analysis({kind})})),
    financeArticle({analysis: worldAnalysis()}), worldArticle({analysis: analysis()}),
    worldArticle({analysis: analysis({kind: 'finance'})})]));
  const rows = mainRows(h);
  assert.equal(rows[0].querySelector('.nw-tag').textContent, '記憶體 ▲');
  assert.equal(rows[1].querySelector('.nw-tag').textContent, '記憶體 ▲');
  assert.ok(rows.slice(2).every(row => row.querySelector('.nw-tag') === null));
});

test('invalid world analysis and hostile fields stay text-only and count as unanalysed', t => {
  const h = setup(t);
  const evil = '<img src=x onerror=alert(1)>';
  const values = [undefined, null, [], 1, true, 'bad', {},
    ...['trend', 'region'].flatMap(field => [undefined, null, [], {}, 1, true, evil, 'constructor', '__proto__']
      .map(value => worldAnalysis({[field]: value})))];
  assert.doesNotThrow(() => h.message(listing(values.map(analysis => worldArticle({analysis, title: evil, summary: evil})))));
  choose(h, h.categories, 'world');
  assert.equal(mainRows(h).length, values.length);
  assert.equal(h.container.querySelectorAll('.nw-tag').length, 0);
  assert.equal(regionButtons(h).length, 0);
  assert.equal(worldPanel(h).querySelector('.nw-pending').textContent, `待分析 ${values.length}`);
  assert.equal(worldPanel(h).querySelector('.nw-market-bar').getAttribute('aria-label'), `升級 0、僵持 0、緩和 0、無關 ${values.length}`);
  assert.equal(h.container.querySelectorAll('img,script').length, 0);
  assert.equal(h.container.querySelector('.nw-title').textContent, evil);
  assert.equal(h.container.querySelector('.nw-title').title, evil);
});

test('world region controls are inert after unmount', t => {
  const h = setup(t);
  h.message(listing([worldArticle(), worldArticle({analysis: worldAnalysis({region: 'other'})})]));
  choose(h, h.categories, 'world');
  regionButton(h, 'asia_pacific').click();
  const button = regionButton(h, 'other');
  const clear = h.container.querySelector('[aria-label=取消地區篩選]');
  const list = h.container.querySelector('.nw-list');
  h.handle.unmount();
  button.click();
  clear.click();
  assert.equal(list.children.length, 1);
  assert.equal(h.container.childNodes.length, 0);
});

test('news times use local calendar today, yesterday and guessed markers, including event reports', t => {
  const now = new Date(2026, 0, 1, 0, 30);
  t.mock.timers.enable({apis: ['Date'], now});
  const h = setup(t);
  const today = new Date(2026, 0, 1, 0, 5).toISOString();
  const yesterday = new Date(2025, 11, 31, 23, 55).toISOString();
  const event = 'abcdefabcdef';
  h.message(listing([
    article({published: today, link: 'https://example.com/today'}),
    article({published: yesterday, link: 'https://example.com/yesterday'}),
    article({published: today, time_guessed: true, link: 'https://example.com/guessed'}),
    article({published: yesterday, event, event_size: 2, link: 'https://example.com/old'}),
    article({published: today, time_guessed: true, event, event_size: 2, link: 'https://example.com/child'}),
    article({published: today, time_guessed: 'true', link: 'https://example.com/string'}),
  ]));
  const times = [...h.container.querySelectorAll('.nw-time')];
  assert.deepEqual(times.map(node => node.textContent), ['00:05', '12/31 23:55', '約00:05',
    '12/31 23:55', '約00:05', '00:05']);
  for (const index of [2, 4]) assert.equal(times[index].title, '來源沒有提供發布時間，以收錄時間代替');
  for (const index of [0, 1, 3, 5]) assert.equal(times[index].title, '');
  h.container.querySelector('.nw-expand').click();
  assert.equal(h.container.querySelector('.nw-reports .nw-time').textContent, '約00:05');
});

const focusReports = (id, count, hour = 10, overrides = {}) => Array.from({length: count}, (_,i) =>
  eventStory(id, `${id}-${i}`, hour + i, {source: `媒體${i}`, ...overrides}));
const focusArea = h => h.container.querySelector('.nw-focus-section');
const focusButtons = h => [...focusArea(h).querySelectorAll('button')];

test('focus requires three distinct named sources, ranks by count latest time and id, and caps at five', t => {
  const h = setup(t);
  assert.equal(focusArea(h).hidden, true);
  const groups = [focusReports('000000000006', 3), focusReports('000000000005', 3),
    focusReports('000000000004', 3), focusReports('000000000003', 3),
    focusReports('000000000002', 3, 11), focusReports('000000000001', 4, 5)];
  const two = focusReports('aaaaaaaaaaaa', 2);
  h.message(listing([...groups.flat(), ...two, ...two, ...focusReports('bbbbbbbbbbbb', 4, 10, {source: {}})]));
  assert.equal(focusArea(h).hidden, false);
  assert.deepEqual(focusButtons(h).map(b => b.dataset.event), ['000000000001', '000000000002',
    '000000000003', '000000000004', '000000000005']);
  assert.equal(focusButtons(h)[0].getAttribute('aria-label'), '展開 4 家媒體的報導');
  assert.equal(focusButtons(h)[0].querySelector('.nw-focus-long').textContent, '4 家媒體');
  assert.equal(focusButtons(h)[0].querySelector('.nw-focus-short').textContent, '4 家');
  assert.equal(focusArea(h).querySelector('a').textContent, '000000000001-0');
  assert.equal(h.window.document.getElementById(focusArea(h).getAttribute('aria-labelledby')).textContent, '焦點');
  const spanning = focusReports('ffffffffffff', 3, 5);
  spanning[2].published = '2026-09-24T23:00:00Z';
  h.message(listing([...focusReports('000000000001', 3, 10), ...spanning]));
  assert.deepEqual(focusButtons(h).map(b => b.dataset.event), ['ffffffffffff', '000000000001']);
  assert.equal(focusArea(h).querySelector('a').textContent, 'ffffffffffff-0');
  h.message(listing(two));
  assert.equal(focusArea(h).hidden, true);
  assert.equal(focusButtons(h).length, 0);
});

test('focus recomputes after source category and topic filters, including same-at replacement', t => {
  const h = setup(t);
  const reports = [...focusReports('111111111111', 3), ...focusReports('222222222222', 3, 10, {category: 'politics'})];
  const body = listing(reports, ['媒體0', '媒體1', '媒體2'].map(name => ({name, ok:true})));
  h.message(body);
  assert.equal(focusButtons(h).length, 2);
  h.select.value = '媒體0'; h.select.dispatchEvent(new h.window.Event('change'));
  assert.equal(focusArea(h).hidden, true);
  h.select.value = ''; h.select.dispatchEvent(new h.window.Event('change'));
  h.categories.value = 'finance'; h.categories.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(focusButtons(h).map(b => b.dataset.event), ['111111111111']);
  const topic = h.container.querySelector('.nw-theme').dataset.topic;
  h.container.querySelector('.nw-theme').click();
  assert.equal(focusButtons(h).length, 1);
  h.message({...body, items: reports.map((item,i) => i === 0 ? {...item, analysis:null} : item)});
  assert.equal(h.container.querySelector(`.nw-theme[data-topic="${topic}"]`).getAttribute('aria-pressed'), 'true');
  assert.equal(focusArea(h).hidden, true); // Only two matching sources remain.
});

test('focus expands scrolls and focuses existing event, preserves expansion and removes listener on unmount', t => {
  const h = setup(t), body = listing(focusReports('111111111111', 3));
  h.message(body);
  const button = focusButtons(h)[0], row = h.container.querySelector('.nw-row');
  const calls = [];
  row.scrollIntoView = options => calls.push(options);
  button.click();
  const toggle = row.querySelector('.nw-expand');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(row.querySelector('.nw-reports').hidden, false);
  assert.equal(h.window.document.activeElement, toggle);
  assert.deepEqual(calls, [{block:'nearest'}]);
  button.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  h.message(body);
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'), 'true');
  const retained = focusButtons(h)[0], currentRow = h.container.querySelector('.nw-row');
  let afterUnmount = 0;
  currentRow.scrollIntoView = () => { afterUnmount++; };
  h.handle.unmount(); retained.click();
  assert.equal(afterUnmount, 0);
});

test('focus titles keep text and URL defenses and responsive labels stay scoped', t => {
  const h = setup(t);
  h.message(listing(focusReports('111111111111', 3, 10, {title:'<img src=x onerror=alert(1)>', link:'javascript:alert(1)'})));
  assert.equal(focusArea(h).querySelector('img'), null);
  assert.equal(focusArea(h).querySelector('a'), null);
  assert.equal(focusArea(h).querySelector('.nw-title').textContent, '<img src=x onerror=alert(1)>');
  h.message(listing(focusReports('111111111111', 3)));
  const link = focusArea(h).querySelector('a');
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
  const css = h.container.querySelector('style').textContent;
  assert.match(css, /@container \(max-width: 419\.98px\)\s*\{[\s\S]*?\.nw \.nw-focus-long \{ display: none; \}\s*\.nw \.nw-focus-short \{ display: inline; \}/);
  const other = setup(t);
  assert.notEqual(focusArea(h).getAttribute('aria-labelledby'), focusArea(other).getAttribute('aria-labelledby'));
});

test('local midnight shows date only, including today guessed and expanded reports', t => {
  t.mock.timers.enable({apis:['Date'], now:new Date(2026, 0, 1, 12)});
  const h = setup(t);
  const today = new Date(2026, 0, 1).toISOString(), yesterday = new Date(2025, 11, 31).toISOString();
  h.message(listing([
    article({published:today}), article({published:yesterday}),
    article({published:today, time_guessed:true}),
    article({published:yesterday, time_guessed:true, event:'111111111111', event_size:2}),
    article({published:today, event:'111111111111', event_size:2}),
    article({published:new Date(2026, 0, 1, 0, 0, 1).toISOString()}),
  ]));
  const nodes = [...h.container.querySelectorAll('.nw-time')];
  assert.deepEqual(nodes.map(n => n.textContent), ['今天','12/31','約今天','約12/31','今天','00:00']);
  assert.equal(nodes[2].title, '來源沒有提供發布時間，以收錄時間代替');
  assert.equal(nodes[3].title, nodes[2].title);
});

const seenKey = 'modudock.module.news.lastSeen';
const seenAt = '2026-09-24T10:00:00.000Z';
const withSeen = value => window => window.localStorage.setItem(seenKey, JSON.stringify(value));

test('first visit has no new markers and only saves latest valid publication on unmount', t => {
  const h = setup(t);
  h.message(listing([article({published:'2026-09-25T00:00:00Z'}), article({published:'bad'}),
    article({published:'2026-09-24T00:00:00Z'})]));
  assert.equal(h.container.querySelector('.nw-new'), null);
  assert.ok(!h.container.querySelector('[role=status]').textContent.includes('則新'));
  assert.equal(h.window.localStorage.getItem(seenKey), null);
  h.handle.unmount();
  assert.equal(h.window.localStorage.getItem(seenKey), JSON.stringify('2026-09-25T00:00:00.000Z'));
  assert.equal(h.window.localStorage.length, 1);
});

test('new markers use frozen mount baseline, include focus and grouped reports, and count filtered events', t => {
  const h = setup(t, withSeen(seenAt));
  const reports = focusReports('111111111111', 3, 9); // 09:00 representative is old; 11:00 child is new.
  const body = listing([...reports, article({published:seenAt}),
    article({published:'2026-09-25T00:00:00Z', category:'world'})],
    ['媒體0','媒體1','媒體2','甲'].map(name => ({name, ok:true})));
  h.message(body);
  assert.equal(mainRows(h)[0].querySelector('.nw-title .nw-new').textContent, '新');
  assert.equal(focusArea(h).querySelector('.nw-title .nw-new').textContent, '新');
  assert.equal(mainRows(h)[0].querySelectorAll('.nw-report-title .nw-new').length, 1);
  assert.equal(mainRows(h)[1].querySelector('.nw-new'), null); // Equal is not new.
  assert.match(h.container.querySelector('[role=status]').textContent, /更新 · 2 則新/);
  h.window.localStorage.setItem(seenKey, JSON.stringify('2099-01-01T00:00:00Z'));
  h.message(body); // Same-at replacement must not re-read or advance L.
  assert.match(h.container.querySelector('[role=status]').textContent, /2 則新/);
  choose(h, h.categories, 'finance');
  assert.match(h.container.querySelector('[role=status]').textContent, /1 則新/);
  choose(h, h.select, '媒體0');
  assert.equal(h.container.querySelector('.nw-new'), null);
  assert.ok(!h.container.querySelector('[role=status]').textContent.includes('則新'));
  h.handle.unmount();
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), '2026-09-25T00:00:00.000Z'); // Whole list, not filtered scope.
});

test('malformed stored JSON dates and nonstrings are treated as no baseline', t => {
  for (const raw of ['broken JSON', '"bad date"', '123', '{}', '[]', 'null']) {
    const h = setup(t, window => window.localStorage.setItem(seenKey, raw));
    h.message(listing([article({published:'2026-09-25T00:00:00Z'})]));
    assert.equal(h.container.querySelector('.nw-new'), null, raw);
    assert.ok(!h.container.querySelector('[role=status]').textContent.includes('則新'), raw);
    h.handle.unmount();
  }
});

test('storage getter read and write exceptions do not break mount render pagehide or unmount', t => {
  for (const mode of ['getter', 'read', 'write']) {
    const h = setup(t, window => {
      if (mode === 'getter') Object.defineProperty(window, 'localStorage', {get(){throw Error('blocked');}});
      else Object.defineProperty(window, 'localStorage', {value:{
        getItem(){if(mode === 'read') throw Error('read blocked'); return JSON.stringify(seenAt);},
        setItem(){throw Error('quota');},
      }});
    });
    assert.doesNotThrow(() => h.message(listing([article({published:'2026-09-25T00:00:00Z'})])));
    assert.equal(mainRows(h).length, 1);
    assert.doesNotThrow(() => h.window.dispatchEvent(new h.window.Event('pagehide')));
    assert.doesNotThrow(() => h.handle.unmount());
  }
});

test('pagehide and unmount save max of baseline and current list candidate, without advancing markers', t => {
  const h = setup(t, withSeen(seenAt));
  h.message(listing([article({published:'2026-09-23T00:00:00Z'})]));
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), seenAt);
  h.message(listing([article({published:'2026-09-25T00:00:00Z'})]));
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), seenAt);
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), '2026-09-25T00:00:00.000Z');
  assert.equal(h.container.querySelector('.nw-new').textContent, '新');
  h.handle.unmount();
  h.window.localStorage.setItem(seenKey, JSON.stringify('sentinel'));
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  h.handle.unmount();
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), 'sentinel');
});

test('empty or invalid lists never persist invalid dates and preserve existing baseline', t => {
  for (const baseline of [null, seenAt]) {
    const h = setup(t, baseline ? withSeen(baseline) : undefined);
    h.message(listing([article({published:{}}), article({published:'invalid'})]));
    h.message(listing([]));
    h.handle.unmount();
    assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), baseline);
  }
});

const topicRecord = (overrides = {}) => ({id:'abcdef123456', title:'話題標題', sources:3, count:4, ...overrides});
const topicListing = (items, records = [topicRecord()]) => ({...listing(items), topics:{pending:0, list:records}});
const focusTopicButtons = h => [...focusArea(h).querySelectorAll('button[data-topic-id]')];

test('topic records require valid fields, take five valid unique entries, and fall back to event focus', t => {
  const h = setup(t);
  const invalid = [null, {}, topicRecord({id:'abcdef123456\n'}), topicRecord({id:'zzzdef123456'}),
    topicRecord({id:123}), topicRecord({title:{}}), topicRecord({sources:2}), topicRecord({sources:3.5}),
    topicRecord({sources:'3'}), topicRecord({count:0}), topicRecord({count:NaN}), topicRecord({count:true})];
  const reports = focusReports('111111111111', 3);
  h.message(topicListing(reports, invalid));
  assert.equal(focusTopicButtons(h).length, 0);
  assert.equal(focusButtons(h)[0].dataset.event, '111111111111');
  const good = Array.from({length:6}, (_,i) => topicRecord({id:String(i).padStart(12,'0')}));
  h.message(topicListing(reports, [...invalid, good[0], good[0], ...good.slice(1)]));
  assert.deepEqual(focusTopicButtons(h).map(b => b.dataset.topicId), good.slice(0,5).map(t => t.id));
  assert.equal(focusArea(h).querySelector('button[data-event]'), null);
  assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-long').textContent, '3 家媒體・4 則');
  assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-short').textContent, '3 家');
  h.message({...listing(reports), topics:{list:{}}});
  assert.equal(focusButtons(h)[0].dataset.event, '111111111111');
  h.message(topicListing([], invalid));
  assert.equal(focusArea(h).hidden, true);
});

test('topic title links require exact title in that topic and retain URL and text defenses', t => {
  const h = setup(t), topic = topicRecord();
  h.message(topicListing([article({title:topic.title, topic:'111111111111', link:'https://wrong.example/'})]));
  assert.equal(focusArea(h).querySelector('a'), null);
  const matching = article({title:topic.title, topic:topic.id, link:'https://example.com/right', summary:'摘要'});
  h.message(topicListing([matching]));
  const link = focusArea(h).querySelector('a');
  assert.equal(link.href, matching.link); assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.title, '摘要');
  const evil = '<img src=x onerror=alert(1)>';
  h.message(topicListing([{...matching, title:evil, link:'javascript:alert(1)'}], [topicRecord({title:evil})]));
  assert.equal(focusArea(h).querySelector('img'), null);
  assert.equal(focusArea(h).querySelector('a'), null);
  assert.equal(focusArea(h).querySelector('.nw-title').textContent, evil);
});

test('topic click resets other filters, keeps event grouping, toggles and survives same-at replacement', t => {
  const h = setup(t), id = topicRecord().id;
  const reports = [...focusReports('111111111111', 3, 10, {topic:id}),
    article({title:'另一事件', topic:id, category:'world'}), article({title:'外面', category:'politics'})];
  const body = topicListing(reports);
  h.message(body);
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  choose(h, h.select, '甲');
  focusTopicButtons(h)[0].click();
  assert.equal(h.categories.value, ''); assert.equal(h.select.value, '');
  assert.equal(h.container.querySelector('.nw-panel').hidden, true);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'true');
  assert.deepEqual(mainTitles(h), ['111111111111-0', '另一事件']);
  assert.equal(mainRows(h)[0].querySelector('.nw-expand').textContent, '另 2 則報導');
  assert.equal(h.container.querySelector('.nw-filter').hidden, false);
  assert.equal(h.container.querySelector('.nw-filter span').textContent, '話題：話題標題');
  h.message(body);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'true');
  focusTopicButtons(h)[0].click();
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'false');
  assert.equal(mainRows(h).length, 3);
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  choose(h, h.categories, 'finance');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-pressed'), 'false');
  const css = h.container.querySelector('style').textContent;
  assert.match(css, /\.nw \.nw-focus-count\[data-topic-id\]\[aria-pressed="true"\], \.nw \.nw-watch-only\[aria-pressed="true"\] \{ border-color: var\(--nw-accent\); box-shadow: inset 3px 0 0 var\(--nw-accent\); \}/);
});

test('topic filter cancels via clear button, source change, category change and empty clear all', t => {
  const h = setup(t), id = topicRecord().id;
  const body = topicListing([article({topic:id}), article({title:'外面', source:'乙', category:'politics'})]);
  h.message(body);
  for (const cancel of [
    () => h.container.querySelector('[aria-label="取消話題篩選"]').click(),
    () => choose(h, h.select, '乙'),
    () => choose(h, h.categories, 'politics'),
  ]) {
    focusTopicButtons(h)[0].click();
    assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'true');
    cancel();
    assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'false');
    assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  }
  h.message(topicListing([article({title:'外面'})]));
  focusTopicButtons(h)[0].click();
  assert.equal(mainRows(h).length, 0);
  h.container.querySelector('.nw-empty button').click();
  assert.equal(mainRows(h).length, 1);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'false');
});

test('topic disappears or becomes invalid on replacement cancels selection and truncation uses 24 characters', t => {
  const h = setup(t), id = topicRecord().id;
  const longTitle = '𠮷'.repeat(25);
  h.message(topicListing([article({topic:id}), article({title:'外面'})], [topicRecord({title:longTitle})]));
  focusTopicButtons(h)[0].click();
  assert.equal(h.container.querySelector('.nw-filter span').textContent, `話題：${'𠮷'.repeat(24)}…`);
  h.message(topicListing([article({topic:id}), article({title:'外面'})], [topicRecord({title:'𠮷'.repeat(24)})]));
  assert.equal(h.container.querySelector('.nw-filter span').textContent, `話題：${'𠮷'.repeat(24)}`);
  h.message(topicListing([article({topic:id}), article({title:'外面'})], [topicRecord({sources:2})]));
  assert.equal(mainRows(h).length, 2);
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  assert.equal(focusArea(h).hidden, true);
});

test('new topic badge comes from any member and topic listeners are inert after unmount', t => {
  const h = setup(t, withSeen(seenAt)), topic = topicRecord();
  const body = topicListing([article({title:topic.title, topic:topic.id, published:'2026-09-23T00:00:00Z'}),
    article({title:'後續', topic:topic.id, published:'2026-09-25T00:00:00Z'})]);
  h.message(body);
  assert.equal(focusArea(h).querySelectorAll('.nw-new').length, 1);
  focusTopicButtons(h)[0].click();
  const retained = focusTopicButtons(h)[0], clear = h.container.querySelector('[aria-label="取消話題篩選"]');
  h.handle.unmount();
  retained.click(); clear.click();
  assert.equal(h.container.children.length, 0);
  assert.equal(retained.getAttribute('aria-pressed'), 'true');
});

for (const kind of ['title', 'expand', 'eventFocus', 'topicFocus', 'theme']) {
  test(`same-at replacement preserves ${kind} keyboard focus without scrolling`, t => {
    const h = setup(t), id = '111111111111';
    const reports = focusReports(id, 3, 10, {topic:topicRecord().id});
    const body = kind === 'topicFocus' ? topicListing(reports) : listing(reports);
    h.message(body);
    if (kind === 'theme') choose(h, h.categories, 'finance');
    const selectors = {title:'.nw-list a.nw-title', expand:'.nw-list .nw-expand',
      eventFocus:'.nw-focus-count[data-event]', topicFocus:'.nw-focus-count[data-topic-id]', theme:'.nw-theme'};
    const selector = selectors[kind], before = h.container.querySelector(selector);
    before.focus();
    const calls = [], original = h.window.HTMLElement.prototype.focus;
    t.mock.method(h.window.HTMLElement.prototype, 'focus', function(options) {
      calls.push({node:this, options}); return original.call(this, options);
    });
    h.message({...body, items:reports.map(item => ({...item, summary:'補送內容'}))});
    const after = h.container.querySelector(selector);
    assert.equal(h.window.document.activeElement, after);
    assert.deepEqual(calls.at(-1), {node:after, options:{preventScroll:true}});
    if (kind !== 'theme') assert.notEqual(after, before);
  });
}

test('removed focus identity never focuses a different event with the same href or an unrelated button', t => {
  const h = setup(t);
  const reports = [...focusReports('111111111111', 3), ...focusReports('222222222222', 3)];
  h.message(listing(reports));
  const anchor = h.container.querySelector('.nw-list a.nw-title');
  anchor.focus();
  const calls = [], original = h.window.HTMLElement.prototype.focus;
  t.mock.method(h.window.HTMLElement.prototype, 'focus', function(options) {
    calls.push(this); return original.call(this, options);
  });
  assert.doesNotThrow(() => h.message(listing(reports.slice(3))));
  assert.equal(calls.length, 0); // Same link belongs to a different event.
  assert.notEqual(h.window.document.activeElement, h.container.querySelector('.nw-list a.nw-title'));
  const outside = h.window.document.createElement('button');
  h.window.document.body.append(outside); outside.focus(); calls.length = 0;
  h.message(listing(reports));
  assert.equal(h.window.document.activeElement, outside);
  assert.equal(calls.length, 0);
});

test('expanded report link keeps focus by href and containing event after replacement', t => {
  const h = setup(t), reports = focusReports('111111111111', 3).map((item,i) => ({...item, link:`https://example.com/${i}`}));
  h.message(listing(reports));
  h.container.querySelector('.nw-expand').click();
  const child = h.container.querySelector('.nw-report-title');
  child.focus();
  h.message(listing(reports));
  assert.equal(h.window.document.activeElement.href, child.href);
  assert.equal(h.window.document.activeElement.className, 'nw-report-title');
  assert.equal(h.window.document.activeElement.closest('.nw-reports').hidden, false);
});

const toneCounts = (overrides = {}) => ({positive:0, negative:0, neutral:0, mixed:0, ...overrides});

test('topic tone needs five judged reports, sorts positive counts and uses a decorative four-pixel bar', t => {
  const h = setup(t);
  h.message(topicListing([], [topicRecord({count:41, tone:toneCounts({negative:4})})]));
  assert.equal(focusArea(h).querySelector('.nw-tone'), null);
  h.message(topicListing([], [topicRecord({count:41, tone:toneCounts({negative:5})})]));
  assert.equal(focusArea(h).querySelector('.nw-tone .nw-hint').textContent, '報導基調：負面 5');
  assert.equal(focusArea(h).querySelectorAll('.nw-tone .nw-segment').length, 1);
  h.message(topicListing([], [topicRecord({count:41, tone:{positive:4, negative:17, neutral:15, mixed:5}})]));
  const tone = focusArea(h).querySelector('.nw-tone');
  assert.equal(tone.querySelector('.nw-hint').textContent, '報導基調：負面 17・中性 15・正反 5・正面 4');
  const bar = tone.querySelector('.nw-tone-bar');
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(h.window.getComputedStyle(bar).height, '4px');
  assert.equal(tone.hasAttribute('aria-hidden'), false);
  assert.deepEqual([...bar.children].map(n => n.className), ['nw-segment nw-tone-positive',
    'nw-segment nw-tone-mixed','nw-segment nw-tone-neutral','nw-segment nw-tone-negative']);
  [4,5,15,17].forEach((count,i) => assert.ok(Math.abs(parseFloat(bar.children[i].style.width)-count/41*100)<.001));
  const css = h.container.querySelector('style').textContent;
  for (const [id, token] of [['negative','danger'],['positive','accent'],['mixed','mixed'],['neutral','idle']]) {
    assert.ok(css.includes(`.nw .nw-tone-${id} { background: var(--nw-${token}); }`));
  }
});

test('bad topic tone is ignored without losing the topic or interpreting hostile values', t => {
  const h = setup(t);
  const bad = [null, [], 'bad', {}, toneCounts({negative:-1}), toneCounts({negative:'5'}),
    toneCounts({negative:5.5}), toneCounts({negative:Infinity}), toneCounts({negative:true}),
    toneCounts({negative:NaN}), toneCounts({negative:11}), toneCounts({negative:'<img src=x>'})];
  for (const tone of bad) {
    h.message(topicListing([], [topicRecord({count:10, tone})]));
    assert.equal(focusTopicButtons(h).length, 1);
    assert.equal(focusArea(h).querySelector('.nw-tone'), null);
    assert.equal(focusArea(h).querySelector('img'), null);
  }
  h.message(topicListing([], [topicRecord({count:10, tone:toneCounts({positive:5, neutral:5})})]));
  assert.equal(focusArea(h).querySelector('.nw-tone .nw-hint').textContent, '報導基調：中性 5・正面 5');
  focusTopicButtons(h)[0].focus();
  h.message(topicListing([], [topicRecord({count:10, tone:toneCounts({negative:5, neutral:5})})]));
  assert.equal(h.window.document.activeElement, focusTopicButtons(h)[0]);
});
const watchKey = 'modudock.module.news.watch';
const watchControls = h => ({input:h.container.querySelector('.nw-watch-input'),
  only:h.container.querySelector('.nw-watch-only'), settings:h.container.querySelector('.nw-watch-settings'),
  toggle:h.categories.nextElementSibling,
  save:h.container.querySelector('.nw-watch-settings button')});
function saveWatch(h, value, enter = false) {
  const controls = watchControls(h);
  controls.input.value = value;
  if (enter) controls.input.dispatchEvent(new h.window.KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  else controls.save.click();
}

test('watch settings normalize stored words and save with Enter for reload', t => {
  const raw = [' AI ', null, 3, '', 'ai', 'x'.repeat(21), '𠮷'.repeat(20),
    ...Array.from({length:12}, (_, i) => `詞${i}`)];
  const h = setup(t, window => window.localStorage.setItem(watchKey, JSON.stringify(raw)));
  const c = watchControls(h);
  assert.equal(c.toggle.textContent, '追蹤');
  assert.equal(c.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.window.getComputedStyle(c.settings).display, 'none');
  c.toggle.click();
  assert.equal(c.settings.hidden, false);
  assert.equal(c.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(c.settings.querySelector('label').htmlFor, c.input.id);
  assert.equal(c.input.placeholder, '以空白或逗號分隔，最多 10 個');
  assert.deepEqual(c.input.value.split(' '), ['AI', '𠮷'.repeat(20), ...Array.from({length:8}, (_, i) => `詞${i}`)]);
  saveWatch(h, '  AI,ai，台股  .*(', true);
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem(watchKey)), ['AI', '台股', '.*(']);
  const reloaded = setup(t, window => window.localStorage.setItem(watchKey, h.window.localStorage.getItem(watchKey)));
  assert.equal(watchControls(reloaded).input.value, 'AI 台股 .*(');
  saveWatch(h, raw.filter(v => typeof v === 'string').join(','));
  assert.equal(JSON.parse(h.window.localStorage.getItem(watchKey)).length, 10);
});

test('watch matches title or summary literally and tags group representative with first configured word', t => {
  const h = setup(t);
  saveWatch(h, 'AI,台股,.*(,<img>');
  h.message(listing([
    eventStory('111111111111', '最早', 8),
    eventStory('111111111111', '台股', 9, {summary:'ai 成長'}),
    article({title:'字元 .*( 原樣'}), article({title:'<img>'}),
    article({title:'不符合', summary:{}}), article({title:{}, summary:null}),
  ]));
  const rows = mainRows(h);
  assert.equal(rows[0].querySelector('.nw-meta').firstElementChild.textContent, '追蹤：AI');
  assert.equal(rows[0].querySelector('.nw-expand').textContent, '另 1 則報導');
  assert.equal(rows[1].querySelector('.nw-watch').textContent, '追蹤：.*(');
  assert.equal(rows[2].querySelector('.nw-watch').textContent, '追蹤：<img>');
  assert.equal(h.container.querySelector('img'), null);
  assert.equal(watchControls(h).only.textContent, '只看追蹤（3）');
  assert.match(h.container.querySelector('[role=status]').textContent, /追蹤 3/);
  watchControls(h).only.click();
  assert.deepEqual(mainTitles(h), ['最早', '字元 .*( 原樣', '<img>']);
});

test('watch button and status both count events, matching the list', t => {
  const h = setup(t, withSeen(seenAt));
  saveWatch(h, 'AI');
  h.message(listing([eventStory('111111111111', 'AI', 11), eventStory('111111111111', 'ai', 12)]));
  assert.equal(watchControls(h).only.textContent, '只看追蹤（1）');
  assert.match(h.container.querySelector('[role=status]').textContent, /1 則新 · 追蹤 1/);
});

test('watch filter combines with source category theme and topic and survives replacement', t => {
  const h = setup(t), id = topicRecord().id;
  saveWatch(h, 'AI');
  const body = topicListing([
    financeArticle({title:'AI 記憶體', topic:id}),
    financeArticle({title:'AI 晶圓', analysis:analysis({theme:'foundry'})}),
    financeArticle({title:'AI 乙', source:'乙'}),
    article({title:'AI 國際', category:'world'}), financeArticle({title:'普通'}),
  ]);
  h.message(body);
  watchControls(h).only.click();
  choose(h, h.categories, 'finance');
  choose(h, h.select, '甲');
  themeButton(h, 'memory').click();
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  h.message(body);
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'), 'true');
  focusTopicButtons(h)[0].click();
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  h.message(body);
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  saveWatch(h, '不存在');
  assert.equal(mainRows(h).length, 0);
  h.container.querySelector('.nw-empty button').click();
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'), 'false');
  assert.equal(mainRows(h).length, 5);
  saveWatch(h, '');
  assert.equal(watchControls(h).only.disabled, true);
  assert.doesNotMatch(h.container.querySelector('[role=status]').textContent, /追蹤/);
});

test('watch storage failures and malformed values are safe and empty words disable filtering', t => {
  for (const value of ['bad json', '{}', 'null', '"AI"']) {
    const h = setup(t, window => window.localStorage.setItem(watchKey, value));
    assert.equal(watchControls(h).only.disabled, true);
  }
  const h = setup(t, window => Object.defineProperty(window, 'localStorage', {
    configurable:true, get() { throw new Error('blocked'); },
  }));
  saveWatch(h, 'AI', true);
  h.message(listing([article({title:'ai'}), article()]));
  watchControls(h).only.click();
  assert.deepEqual(mainTitles(h), ['ai']);
  saveWatch(h, ' , ');
  assert.equal(watchControls(h).only.disabled, true);
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'), 'false');
  assert.equal(mainRows(h).length, 2);
});

test('watch unmount removes all settings listeners', t => {
  const h = setup(t), c = watchControls(h);
  h.handle.unmount();
  c.toggle.click(); c.input.value = 'AI'; c.save.click();
  c.input.dispatchEvent(new h.window.KeyboardEvent('keydown', {key:'Enter'}));
  c.only.dispatchEvent(new h.window.Event('click'));
  assert.equal(c.settings.hidden, true);
  assert.equal(c.only.getAttribute('aria-pressed'), 'false');
  assert.equal(h.window.localStorage.getItem(watchKey), null);
  assert.equal(h.container.childElementCount, 0);
});

test('failed source status names all failures with bounded safe error tooltips', t => {
  const h = setup(t), status = h.container.querySelector('[role=status]');
  h.message(listing([], [{name:'甲', ok:false, error:'𠮷'.repeat(81)},
    {name:'<img>', ok:false, error:'timeout'}, {name:'丙', ok:true, error:'ignored'}]));
  assert.match(status.textContent, /甲等 2 個來源失敗/);
  assert.equal(status.title, `甲：${'𠮷'.repeat(80)}\n<img>：timeout`);
  assert.equal(h.container.querySelector('img'), null);
  h.message(listing([], [{name:'乙', ok:false, error:{}}]));
  assert.match(status.textContent, /乙 失敗/);
  assert.equal(status.title, '乙');
  h.message(listing([], [{name:'乙', ok:true}]));
  assert.equal(status.title, '');
  assert.doesNotMatch(status.textContent, /失敗/);
});

const historyEnd = Date.parse('2026-09-25T12:00:00Z');
const historyRows = h => [...h.container.querySelectorAll('.nw-history-row')];
const historyResults = h => historyRows(h).map(row => row.querySelector('.nw-history-value').textContent);
const timedArticle = (hours, overrides = {}) => financeArticle({
  published:new Date(historyEnd + hours * 3600000).toISOString(), ...overrides,
});
const historyList = items => ({...listing(items), at:new Date(historyEnd).toISOString()});
const hhmm = stamp => {
  const date = new Date(stamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

test('history bins are left inclusive, exclude next boundary and include final endpoint', t => {
  const h = setup(t);
  const items = [-24, -18, -12, -6].flatMap((hour, i) => Array.from({length:5}, () =>
    timedArticle(hour, {analysis:analysis({market:i % 2 ? 'negative' : 'positive'})})));
  items.push(timedArticle(0), timedArticle(-24 - 1 / 3600000), timedArticle(1 / 3600000));
  h.message(historyList(items));
  choose(h, h.categories, 'finance');
  assert.deepEqual(historyResults(h), ['正面 100%', '正面 0%', '正面 100%', '正面 17%']);
  const rows = historyRows(h);
  assert.deepEqual(rows.map(row => row.getAttribute('aria-label').match(/樣本 (\d+)/)[1]), ['5', '5', '5', '6']);
  assert.equal(rows[0].getAttribute('role'), 'group');
  assert.equal(rows[0].getAttribute('aria-label'), `${hhmm(historyEnd - 24 * 3600000)}–${hhmm(historyEnd - 18 * 3600000)}，正面 100%，樣本 5 個事件`);
  assert.equal(rows[3].querySelector('.nw-history-long').textContent, `${hhmm(historyEnd - 6 * 3600000)}–現在`);
  assert.equal(rows[0].querySelector('.nw-history-short').textContent,
    `${hhmm(historyEnd - 24 * 3600000).slice(0,2)}–${hhmm(historyEnd - 18 * 3600000).slice(0,2)}`);
  const history = h.container.querySelector('.nw-history');
  assert.equal(history.previousElementSibling.className, 'nw-market');
  assert.equal(history.nextElementSibling.className, 'nw-macro');
  assert.equal(history.querySelector('.nw-hint').textContent, '每 6 小時一段，同一事件只算一次');
  const bar = rows[3].querySelector('.nw-history-bar');
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(h.window.getComputedStyle(bar).height, '6px');
  assert.deepEqual([...bar.children].map(node => node.className),
    ['nw-segment nw-positive', 'nw-segment nw-mixed', 'nw-segment nw-idle', 'nw-segment nw-negative']);
  assert.ok(Math.abs(parseFloat(bar.firstElementChild.style.width) - 100 / 6) < 0.001);
  const css = h.container.querySelector('style').textContent;
  assert.match(css, /@container \(max-width: 419\.98px\)\s*\{\s*\.nw \.nw-history-long \{ display: none; \}\s*\.nw \.nw-history-short \{ display: inline; \}/);
});

test('history requires five analyzed events and reports dash for no directional denominator', t => {
  const h = setup(t);
  h.message(historyList([
    ...Array.from({length:4}, () => timedArticle(-22)),
    timedArticle(-22, {analysis:null}), timedArticle(-22, {analysis:{market:'positive'}}),
    ...Array.from({length:5}, () => timedArticle(-16, {analysis:analysis({market:'not_market'})})),
    ...['positive','positive','mixed','negative','other'].map(market => timedArticle(-10, {analysis:analysis({market})})),
    timedArticle(-2, {published:'bad'}), timedArticle(-2, {published:{}}),
  ]));
  choose(h, h.categories, 'finance');
  assert.deepEqual(historyResults(h), ['樣本不足', '—', '正面 2/4', '樣本不足']);
  const rows = historyRows(h);
  assert.equal(rows[0].querySelector('.nw-history-bar').dataset.empty, 'true');
  assert.equal(rows[0].querySelector('.nw-history-bar').childElementCount, 0);
  assert.match(rows[0].getAttribute('aria-label'), /樣本 4 個事件/);
  assert.equal(rows[1].querySelector('.nw-history-bar').dataset.empty, 'false');
  assert.equal(rows[1].querySelector('.nw-idle').style.width, '100%');
});

test('history deduplicates using representative time and first valid analysis, respecting panel scope', t => {
  const h = setup(t);
  const body = historyList([
    ...Array.from({length:4}, () => timedArticle(-22)),
    timedArticle(-22, {event:'111111111111', event_size:3, analysis:null}),
    timedArticle(-16, {event:'111111111111', event_size:3, analysis:analysis({market:'negative'})}),
    timedArticle(-10, {event:'111111111111', event_size:3}),
    timedArticle(-22, {source:'乙', analysis:analysis({market:'negative'})}),
    timedArticle(-22, {category:'tech', analysis:analysis({market:'negative'})}),
  ]);
  h.message(body);
  choose(h, h.categories, 'finance');
  choose(h, h.select, '甲');
  assert.deepEqual(historyResults(h), ['正面 80%', '樣本不足', '樣本不足', '樣本不足']);
  const before = h.container.querySelector('.nw-history').textContent;
  themeButton(h, 'memory').click();
  assert.equal(h.container.querySelector('.nw-history').textContent, before);
  h.message(body);
  assert.equal(h.container.querySelector('.nw-history').textContent, before);
});

test('world history uses escalation denominator, world colors and unrelated idle events', t => {
  const h = setup(t);
  h.message(historyList(['escalation','escalation','stalemate','deescalation','not_conflict','other'].map(trend =>
    timedArticle(-2, {category:'world', analysis:{kind:'world', trend, region:'us_china'}}))));
  choose(h, h.categories, 'world');
  assert.equal(historyResults(h)[3], '升級 2/4');
  const row = historyRows(h)[3], bar = row.querySelector('.nw-history-bar');
  assert.match(row.getAttribute('aria-label'), /升級 2\/4，樣本 6 個事件/);
  assert.deepEqual([...bar.children].map(node => node.className),
    ['nw-segment nw-escalation', 'nw-segment nw-mixed', 'nw-segment nw-deescalation', 'nw-segment nw-idle']);
  assert.ok(Math.abs(parseFloat(bar.lastElementChild.style.width) - 100 / 3) < 0.001);
});

test('history falls back to current time for missing or invalid at and stays fixed during filtering', t => {
  t.mock.timers.enable({apis:['Date'], now:historyEnd});
  const h = setup(t);
  const items = Array.from({length:5}, () => timedArticle(-2));
  for (const at of [undefined, null, {}, 'bad']) {
    h.message({...listing(items), at});
    choose(h, h.categories, 'finance');
    assert.equal(historyResults(h)[3], '正面 100%');
  }
  const before = h.container.querySelector('.nw-history').textContent;
  t.mock.timers.tick(7 * 3600000);
  themeButton(h, 'memory').click();
  assert.equal(h.container.querySelector('.nw-history').textContent, before);
});
