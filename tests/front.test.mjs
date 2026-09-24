import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import mount from '../front/front.js';

function setup(t) {
  const window = new Window();
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
  assert.equal(row.querySelector('.nw-time').textContent, local);
  const updated = new Date('2026-09-21T02:04:00Z');
  assert.equal(h.container.querySelector('[role=status]').textContent,
    `${pad(updated.getHours())}:${pad(updated.getMinutes())} 更新 · 失敗來源：1`);
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
  assert.equal(h.container.querySelector('span[title]').title, '');
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
const themeButton = (h, id) => themeButtons(h).find(button => button.dataset.theme === id);
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
  assert.equal(panel(h).previousElementSibling.contains(h.categories), true);
  assert.equal(panel(h).children.length, 5);
  assert.equal(panel(h).querySelector('small').textContent, '篇數是報導數，同一事件多家報導會重複計算。');
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
    '8 則，2 個來源', '分析中 2',
    '正面 2、正反 1、無關 4、負面 1', '無關 1、未明 3',
    '大盤／總經  2 則利多 0利空 1',
  ]);
  assert.deepEqual(themeButtons(h).map(b => b.getAttribute('aria-label')), ['記憶體 2（▲1）', '光通訊 1（▲1）', '能源 1']);
  choose(h, h.select, '甲');
  assert.equal(lines()[0], '7 則，1 個來源');
  assert.equal(lines()[1], '分析中 2');
  assert.equal(lines()[2], '正面 1、正反 1、無關 4、負面 1');
  assert.equal(lines()[3], '無關 1、未明 3');
  assert.equal(themeButton(h, 'optical'), undefined);
  h.message({...listing(items), classify: {enabled: false}});
  assert.equal(lines()[1], '分析中 0');
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
  assert.deepEqual(themeButtons(h).map(b => b.dataset.theme),
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
          // The only prefix exception is the exact dark-theme override mandated by §14.2.
          assert.ok(/^\.nw(?:\b|\s)/.test(value) || value === ':root[data-theme="dark"] .nw', value);
          selectors.push(value);
        }
      } else {
        assert.ok(rule.cssRules, rule.cssText);
        groups.push(rule.cssText);
        inspect(rule.cssRules);
      }
    }
  }
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

test('palette inherits shell tokens with specified light fallbacks and dark semantic colors', t => {
  const h = setup(t);
  const rules = [...h.container.querySelector('style').sheet.cssRules];
  const base = rules.find(rule => rule.selectorText === '.nw').style;
  const dark = rules.find(rule => rule.selectorText === ':root[data-theme="dark"] .nw').style;
  for (const [token, shell, fallback] of [['bg', 'bg', '#ffffff'], ['fg', 'fg', '#242424'],
    ['muted', 'fg-muted', '#616161'], ['line', 'border', '#c7c7c7'], ['surface', 'surface', '#f3f3f3'],
    ['accent', 'accent', '#005fb8'], ['focus', 'focus', '#005fb8']]) {
    assert.equal(base.getPropertyValue(`--nw-${token}`), `var(--md-${shell}, ${fallback})`);
  }
  for (const [token, light, night] of [['up', '#c8102e', '#ff6b6b'], ['down', '#0f7b3f', '#4fd18b'], ['mixed', '#b7791f', '#f0b429']]) {
    assert.equal(base.getPropertyValue(`--nw-${token}`), light);
    assert.equal(dark.getPropertyValue(`--nw-${token}`), night);
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
  assert.equal(status(), `${hhmm} 更新 · 失敗來源：1 · 未分類：3`);
  h.message({...listing([], [{ok: false}, {ok: false}, {ok: 'false'}]), classify: {enabled: false}});
  assert.equal(status(), `${hhmm} 更新 · 失敗來源：2 · 分類：關閉`);
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
