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
  assert.equal(row.querySelector('.nw-meta').nextElementSibling.className, 'nw-summary');
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
  assert.deepEqual(options(), expected.map(([id,name]) => [id, `${name} 0`]));
  h.message(listing([article({category: 'zzz'})]));
  assert.deepEqual(options(), expected.map(([id,name]) => [id, `${name} ${id ? 0 : 1}`]));
  h.message(listing([]));
  assert.deepEqual(options(), expected.map(([id,name]) => [id, `${name} 0`]));
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
const rankLabel = button => `${button.querySelector('.nw-theme-name').textContent} ${button.querySelector('.nw-theme-count').textContent}`;
const described = (h, button) => h.window.document.getElementById(button.getAttribute('aria-describedby'))?.textContent;
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
  for (const category of ['', 'life', 'other', 'finance', 'tech']) {
    choose(h, h.categories, category);
    assert.equal(panel(h).hidden, !['finance', 'tech'].includes(category));
  }
  assert.equal(panel(h).nextElementSibling.className, 'nw-filter');
  const tools=panel(h).nextElementSibling.nextElementSibling;
  assert.equal(tools.className,'nw-topic-tools');
  assert.equal(tools.nextElementSibling.nextElementSibling.className, 'nw-hint nw-new-hint');
  assert.equal(tools.nextElementSibling.nextElementSibling.nextElementSibling.className, 'nw-shortcut-help');
  assert.ok(h.container.querySelector('.nw-shortcut-help').nextElementSibling === h.container.querySelector('.nw-list'));
  assert.equal(panel(h).previousElementSibling.className, 'nw-focus-section');
  assert.equal(panel(h).previousElementSibling.previousElementSibling.contains(h.categories), true);
  assert.equal(panel(h).querySelector('.nw-panel-content').children.length, 7);
  assert.equal(panel(h).querySelector('.nw-note').textContent, '同一事件多家報導只算一次。');
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
    '8 個事件（8 則報導），2 個來源・已分析 6／8', '待判定 2',
    '偏多 2、多空互見 1、與股市無關 2、偏空 1', '與股市無關 1、未明 1',
    '大盤方向：大盤／總經 2 個事件利多 0利空 1其餘 1 件無明確方向',
  ]);
  assert.deepEqual(themeButtons(h).map(rankLabel), ['記憶體 2', '光通訊 1', '能源 1']);
  choose(h, h.select, '甲');
  assert.equal(lines()[0], '7 個事件（7 則報導），1 個來源・已分析 5／7');
  assert.equal(lines()[1], '待判定 2');
  assert.equal(lines()[2], '偏多 1、多空互見 1、與股市無關 2、偏空 1');
  assert.equal(lines()[3], '與股市無關 1、未明 1');
  assert.equal(themeButton(h, 'optical'), undefined);
  h.message({...listing(items), classify: {enabled: false}});
  assert.equal(panel(h).querySelector('.nw-pending').hidden, true);
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
  assert.equal(rankLabel(themeButton(h, 'memory')), '記憶體 2');
  for (const group of [themes.slice(0, 10), themes.slice(10)]) {
    h.message(listing(group.map(([theme]) => financeArticle({analysis: analysis({theme, dir: 'neutral'})}))));
    assert.deepEqual(themeButtons(h).map(rankLabel), group.map(([, name]) => `${name} 1`));
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
  assert.equal(rankLabel(themeButton(h, 'memory')), '記憶體 6');
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
  const clear = h.container.querySelector('.nw-filter button');
  assert.equal(clear.parentElement.hidden, false);
  assert.equal(clear.parentElement.querySelector('span').textContent+clear.textContent, '已篩選：記憶體清除篩選');
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

test('selected theme automatically clears after it disappears from new data', t => {
  const h = setup(t);
  h.message(listing([financeArticle()]));
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  h.message(listing([financeArticle({analysis: analysis({theme: 'foundry'})})]));
  assert.deepEqual(rowTitles(h), ['新聞']);
  assert.equal(rankLabel(themeButton(h, 'foundry')), '晶圓代工 1');
  assert.equal(h.container.querySelector('.nw-filter').hidden, true);
  assert.equal(themeButton(h, 'foundry').getAttribute('aria-pressed'), 'false');
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
  assert.ok([...h.container.querySelectorAll('li')].every(li => li.querySelector('.nw-category') === null && !li.querySelector('.nw-tag')));
  assert.equal(panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'),
    `偏多 0、多空互見 0、與股市無關 0、偏空 0`);
  assert.equal(panel(h).querySelector('.nw-market').title, `與股市無關 0、未明 0`);
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
  assert.equal(rankLabel(themeButton(h, 'memory')), '記憶體 1');
  assert.equal(themeButtons(h).length, 1);
  assert.equal(h.container.querySelectorAll('li')[1].querySelector('.nw-category'), null);
  assert.equal(h.container.querySelectorAll('li')[1].querySelector('.nw-tag'), null);
});

test('unmount removes theme delegation and clear-filter listeners', t => {
  const h = setup(t);
  h.message(listing([financeArticle(), financeArticle({analysis: analysis({theme: 'foundry'})})]));
  choose(h, h.categories, 'finance');
  themeButton(h, 'memory').click();
  const button = themeButton(h, 'foundry');
  const clear = h.container.querySelector('.nw-filter button');
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
  assert.ok(selectors.includes('.nw.nw-wide-ranking .nw-ranking'));
  assert.ok(selectors.includes('.nw.nw-narrow .nw-actions'));
  assert.doesNotMatch(style.textContent, /@container/);
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
  assert.equal(bar.getAttribute('aria-label'), '偏多 0、多空互見 0、與股市無關 0、偏空 0');
  const parts = [...bar.children];
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(part => part.style.width), ['0%', '0%', '0%', '0%']);
  assert.deepEqual(parts.map(part => part.className),
    ['nw-segment nw-positive', 'nw-segment nw-mixed', 'nw-segment nw-idle', 'nw-segment nw-negative']);
  h.message(listing(['positive', 'positive', 'mixed', 'not_market', 'other', null, 'negative', 'negative']
    .map(market => financeArticle({analysis: market ? analysis({market}) : null}))));
  assert.equal(bar.dataset.empty, 'false');
  assert.equal(bar.getAttribute('aria-label'), '偏多 2、多空互見 1、與股市無關 2、偏空 2');
  assert.deepEqual(parts.map(part => part.style.width), [2, 1, 2, 2].map(n => `${n / 7 * 100}%`));
  assert.deepEqual([...panel(h).querySelectorAll('.nw-value')].map(value => value.textContent), ['2', '1', '2', '2']);
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
  const themeClear = h.container.querySelector('.nw-filter button');
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
  assert.deepEqual(visibleClearButtons(), ['清除篩選']);
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
  assert.equal(button.parentElement.className, 'nw-actions');
  assert.equal(button.parentElement.firstElementChild.className, 'nw-summary-toggle');
  assert.equal(button.textContent, '另 2 則報導');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  const reports = row.querySelector('.nw-reports');
  assert.equal(reports.hidden, true);
  assert.equal(h.window.getComputedStyle(reports).display, 'none');
  assert.equal(mainRows(h)[1].querySelector('.nw-expand'), null);
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
  // R48: the same reports keep expansion even when their event root changes.
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'), 'true');
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
  assert.equal(panel(h).querySelector('.nw-sample-count').textContent, '3 個事件（10 則報導），2 個來源・已分析 2／3');
  assert.equal(panel(h).querySelector('.nw-pending').textContent, '待判定 1');
  assert.equal(panel(h).querySelector('.nw-warning').hidden, false); // 10 reports but only 3 events.
  assert.equal(panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'), '偏多 0、多空互見 1、與股市無關 0、偏空 1');
  assert.equal(panel(h).querySelector('.nw-macro').textContent, '大盤方向：大盤／總經 1 個事件利多 1利空 0');
  assert.equal(rankLabel(themeButton(h, 'memory')), '記憶體 1');
  assert.equal(panel(h).querySelector('.nw-note').textContent, '同一事件多家報導只算一次。');
  choose(h, h.select, '甲');
  assert.equal(panel(h).querySelector('.nw-sample-count').textContent, '3 個事件（9 則報導），1 個來源・已分析 2／3');
  assert.equal(panel(h).querySelector('.nw-market-bar').getAttribute('aria-label'), '偏多 1、多空互見 1、與股市無關 0、偏空 0');
  assert.equal(rankLabel(themeButton(h, 'memory')), '記憶體 1');
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
  for (const category of ['', 'life', 'society']) {
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
  assert.equal(surface.querySelector('.nw-ranking-heading').textContent, '地區升級・緩和・無方向');
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
  assert.equal(surface.querySelector('.nw-sample-count').textContent, '8 個事件（9 則報導），1 個來源・已分析 7／8');
  assert.equal(surface.querySelector('.nw-pending').textContent, '待判定 1');
  assert.equal(surface.querySelector('.nw-merging').textContent, '・待合併 7');
  const bar = surface.querySelector('.nw-market-bar');
  assert.equal(bar.getAttribute('aria-label'), '升級 2、僵持 1、緩和 2、無關 2');
  assert.deepEqual([...bar.children].map(p => p.style.width), [2, 1, 2, 2].map(n => `${n / 7 * 100}%`));
  assert.deepEqual([...bar.children].map(p => p.className),
    ['nw-segment nw-escalation', 'nw-segment nw-mixed', 'nw-segment nw-deescalation', 'nw-segment nw-idle']);
  assert.deepEqual([...surface.querySelectorAll('.nw-value')].map(p => p.textContent), ['2', '1', '2', '2']);
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
  assert.equal(rankLabel(asia), '亞太 3');
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
  assert.equal(h.container.querySelector('.nw-filter > span').textContent, '已篩選：亞太');
  h.message(listing([...items, worldArticle({title: '新增亞太'})]));
  assert.equal(h.select.value, '甲');
  assert.equal(h.categories.value, 'world');
  assert.deepEqual(mainTitles(h), ['晚亞太', '獨立亞太', '新增亞太']);
  h.container.querySelector('.nw-filter button').click();
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
  assert.equal(worldPanel(h).querySelector('.nw-pending').textContent, `待判定 ${values.length}`);
  assert.equal(worldPanel(h).querySelector('.nw-market-bar').getAttribute('aria-label'), `升級 0、僵持 0、緩和 0、無關 0`);
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
  const clear = h.container.querySelector('.nw-filter button');
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
    '12/31 23:55–約00:05', '約00:05', '00:05']);
  for (const index of [2, 3, 4]) assert.equal(times[index].title, '來源沒有提供發布時間，以收錄時間代替');
  for (const index of [0, 1, 5]) assert.equal(times[index].title, '');
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
  assert.equal(described(h, focusButtons(h)[0]), '展開同事件的其他報導');
  assert.equal(focusButtons(h)[0].querySelector('.nw-focus-long').textContent, '看同事件・4 家');
  assert.equal(focusButtons(h)[0].querySelector('.nw-focus-short').textContent, '4 家');
  assert.equal(focusArea(h).querySelector('a').textContent, '000000000001-0');
  assert.equal(h.window.document.getElementById(focusArea(h).getAttribute('aria-labelledby')).textContent, '焦點');
  const spanning = focusReports('ffffffffffff', 3, 5);
  spanning[2].published = '2026-09-24T23:00:00Z';
  h.message(listing([...focusReports('000000000001', 3, 10), ...spanning]));
  assert.deepEqual(focusButtons(h).map(b => b.dataset.event), ['ffffffffffff', '000000000001']);
  assert.equal(focusArea(h).querySelector('a').textContent, 'ffffffffffff-0');
  h.message(listing(two));
  assert.equal(focusArea(h).hidden, false); // No unfiltered three-outlet event: show the hint.
  assert.equal(focusButtons(h).length, 0);
});

test('focus recomputes after source category and topic filters, including same-at replacement', t => {
  const h = setup(t);
  const reports = [...focusReports('111111111111', 3), ...focusReports('222222222222', 3, 10, {category: 'politics'})];
  const body = listing(reports, ['媒體0', '媒體1', '媒體2'].map(name => ({name, ok:true})));
  h.message(body);
  assert.equal(focusButtons(h).length, 2);
  h.select.value = '媒體0'; h.select.dispatchEvent(new h.window.Event('change'));
  assert.equal(focusArea(h).hidden, true); // R6: the filter hid existing event focus.
  h.select.value = ''; h.select.dispatchEvent(new h.window.Event('change'));
  h.categories.value = 'finance'; h.categories.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(focusButtons(h).map(b => b.dataset.event), ['111111111111']);
  const topic = h.container.querySelector('.nw-theme').dataset.topic;
  h.container.querySelector('.nw-theme').click();
  assert.equal(focusButtons(h).length, 1);
  h.message({...body, items: reports.map((item,i) => i === 0 ? {...item, analysis:null} : item)});
  assert.equal(h.container.querySelector(`.nw-theme[data-topic="${topic}"]`).getAttribute('aria-pressed'), 'true');
  assert.equal(focusArea(h).hidden, true); // Only two matching outlets remain under this filter.
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
  assert.match(css, /\.nw.nw-narrow \.nw-focus-long \{ display: none; \}\s*\.nw.nw-narrow \.nw-focus-short \{ display: inline; \}/);
  const other = setup(t);
  assert.notEqual(focusArea(h).getAttribute('aria-labelledby'), focusArea(other).getAttribute('aria-labelledby'));
});

test('mostly midnight source shows dates including today guessed and expanded reports', t => {
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
  assert.deepEqual(nodes.map(n => n.textContent), ['今天','12/31','約今天','約12/31–今天','今天','00:00']);
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
  assert.ok(!h.container.querySelector('[role=status]').textContent.includes('新增'));
  assert.equal(h.container.querySelector('.nw-new-only').hidden, true);
  assert.equal(h.container.querySelector('.nw-new-only').disabled, true);
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
  assert.equal(mainRows(h)[0].querySelector('.nw-title .nw-new'), null);
  assert.equal(focusArea(h).querySelector('.nw-title .nw-new').textContent, '新');
  assert.equal(mainRows(h)[0].querySelectorAll('.nw-report-title .nw-new').length, 0);
  assert.equal(mainRows(h)[1].querySelector('.nw-new'), null); // Equal is not new.
  assert.match(h.container.querySelector('[role=status]').textContent, /更新 · 新增 2 個事件/);
  h.window.localStorage.setItem(seenKey, JSON.stringify('2099-01-01T00:00:00Z'));
  h.message(body); // Same-at replacement must not re-read or advance L.
  assert.match(h.container.querySelector('[role=status]').textContent, /新增 2 個事件/);
  choose(h, h.categories, 'finance');
  assert.match(h.container.querySelector('[role=status]').textContent, /新增 1 個事件/);
  choose(h, h.select, '媒體0');
  assert.equal(h.container.querySelector('.nw-new'), null);
  assert.equal(h.container.querySelector('.nw-new-only').textContent, '');
  assert.equal(h.container.querySelector('.nw-new-only').hidden, true);
  assert.equal(h.container.querySelector('.nw-new-only').disabled, true);
  h.handle.unmount();
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), '2099-01-01T00:00:00.000Z'); // Persistence respects the newer stored value; display still uses frozen L.
});

test('malformed stored JSON dates and nonstrings are treated as no baseline', t => {
  for (const raw of ['broken JSON', '"bad date"', '123', '{}', '[]', 'null']) {
    const h = setup(t, window => window.localStorage.setItem(seenKey, raw));
    h.message(listing([article({published:'2026-09-25T00:00:00Z'})]));
    assert.equal(h.container.querySelector('.nw-new'), null, raw);
    assert.ok(!h.container.querySelector('[role=status]').textContent.includes('新增'), raw);
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
  assert.match(h.container.querySelector('[role=status]').textContent, /新增 1 個事件/);
  assert.equal(h.container.querySelector('.nw-new'), null);
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
  assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-long').textContent, '看話題・3 家');
  assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-short').textContent, '看話題・3 家');
  h.message({...listing(reports), topics:{list:{}}});
  assert.equal(focusButtons(h)[0].dataset.event, '111111111111');
  h.message(topicListing([], invalid));
  assert.equal(focusArea(h).hidden, false); // No unfiltered three-outlet event: show the hint.
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
  reports[0].source = '甲';
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
  assert.equal(mainRows(h).length, 1); // Restores the previous source/category scope.
  assert.equal(h.select.value, '甲');
  assert.equal(h.categories.value, 'finance');
  assert.equal(h.container.querySelector('.nw-filter').hidden, false);
  assert.equal(themeButton(h, 'memory').getAttribute('aria-pressed'), 'true');
  choose(h, h.select, '');
  choose(h, h.categories, 'finance');
  assert.equal(themeButton(h, 'memory').getAttribute('aria-pressed'), 'true');
  const css = h.container.querySelector('style').textContent;
  assert.match(css, /\.nw \.nw-focus-count\[data-topic-id\]\[aria-pressed="true"\], \.nw \.nw-watch-only\[aria-pressed="true"\] \{ border-color: var\(--nw-accent\); box-shadow: inset 3px 0 0 var\(--nw-accent\); \}/);
});

test('topic filter cancels via clear button, source change, category change and empty clear all', t => {
  const h = setup(t), id = topicRecord().id;
  const body = topicListing([article({topic:id}), article({title:'外面', source:'乙', category:'politics'})]);
  h.message(body);
  for (const cancel of [
    () => h.container.querySelector('.nw-filter button').click(),
    () => choose(h, h.select, '乙'),
    () => choose(h, h.categories, 'politics'),
  ]) {
    focusTopicButtons(h)[0].click();
    assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'), 'true');
    cancel();
    choose(h, h.select, '');
    choose(h, h.categories, '');
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
  assert.equal(focusArea(h).hidden, false); // No unfiltered three-outlet event: show the hint.
});

test('new topic badge comes from any member and topic listeners are inert after unmount', t => {
  const h = setup(t, withSeen(seenAt)), topic = topicRecord();
  const body = topicListing([article({title:topic.title, topic:topic.id, published:'2026-09-23T00:00:00Z'}),
    article({title:'後續', topic:topic.id, published:'2026-09-25T00:00:00Z'})]);
  h.message(body);
  assert.equal(focusArea(h).querySelectorAll('.nw-title > .nw-new').length, 1);
  assert.equal(focusArea(h).querySelectorAll('.nw-topic-latest > .nw-new').length, 0);
  focusTopicButtons(h)[0].click();
  const retained = focusTopicButtons(h)[0], clear = h.container.querySelector('.nw-filter button');
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
  assert.deepEqual(calls, [h.container.querySelector('.nw-list')]); // Never choose another event's link.
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

const toneListing = topic => topicListing(Object.entries(topic.tone).flatMap(([tone,count]) =>
  Array.from({length:count},(_,i)=>article({topic:topic.id,tone,title:`${tone}-${i}`,
    link:`https://example.com/${tone}/${i}`}))),[topic]);

test('topic tone needs five judged reports, sorts positive counts and uses a decorative four-pixel bar', t => {
  const h = setup(t);
  h.message(toneListing(topicRecord({count:41, tone:toneCounts({negative:4})})));
  assert.equal(focusArea(h).querySelector('.nw-tone'), null);
  h.message(toneListing(topicRecord({count:41, tone:toneCounts({negative:5})})));
  assert.equal(focusArea(h).querySelector('.nw-tone .nw-hint').textContent, '報導語氣（則）：負面 5');
  assert.equal(focusArea(h).querySelectorAll('.nw-tone .nw-segment').length, 1);
  h.message(toneListing(topicRecord({count:41, tone:{positive:4, negative:17, neutral:15, mixed:5}})));
  const tone = focusArea(h).querySelector('.nw-tone');
  assert.equal(tone.querySelector('.nw-hint').textContent, '報導語氣（則）：負面 17中性 15正反並陳 5正面 4');
  const bar = tone.querySelector('.nw-tone-bar');
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(h.window.getComputedStyle(bar).height, '4px');
  assert.equal(tone.hasAttribute('aria-hidden'), false);
  assert.deepEqual([...bar.children].map(n => n.className), ['nw-segment nw-tone-negative',
    'nw-segment nw-tone-neutral','nw-segment nw-tone-mixed','nw-segment nw-tone-positive']);
  [17,15,5,4].forEach((count,i) => assert.ok(Math.abs(parseFloat(bar.children[i].style.width)-count/41*100)<.001));
  const css = h.container.querySelector('style').textContent;
  for (const [id, token] of [['negative','tone-neg'],['positive','accent'],['mixed','mixed'],['neutral','idle']]) {
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
  h.message(toneListing(topicRecord({count:10, tone:toneCounts({positive:5, neutral:5})})));
  assert.equal(focusArea(h).querySelector('.nw-tone .nw-hint').textContent, '報導語氣（則）：中性 5正面 5');
  focusTopicButtons(h)[0].focus();
  h.message(toneListing(topicRecord({count:10, tone:toneCounts({negative:5, neutral:5})})));
  assert.equal(h.window.document.activeElement, focusTopicButtons(h)[0]);
});
const watchKey = 'modudock.module.news.watch';
const watchControls = h => ({input:h.container.querySelector('.nw-watch-input'),
  only:h.container.querySelector('.nw-watch-only'), settings:h.container.querySelector('.nw-watch-settings'),
  toggle:h.container.querySelector('.nw-watch-toggle'),
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
  assert.equal(c.toggle.textContent, '追蹤關鍵字');
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
  assert.equal(rows[0].querySelector('.nw-info').firstElementChild.textContent, '追蹤：AI');
  assert.equal(rows[0].querySelector('.nw-expand').textContent, '另 1 則報導');
  assert.equal(rows[1].querySelector('.nw-watch').textContent, '追蹤：.*(');
  assert.equal(rows[2].querySelector('.nw-watch').textContent, '追蹤：<img>');
  assert.equal(h.container.querySelector('img'), null);
  assert.equal(watchControls(h).only.textContent, '只看追蹤 3');
  assert.doesNotMatch(h.container.querySelector('[role=status]').textContent, /追蹤/);
  watchControls(h).only.click();
  assert.deepEqual(mainTitles(h), ['最早', '字元 .*( 原樣', '<img>']);
});

test('watch toolbar button counts events without duplicating the status', t => {
  const h = setup(t, withSeen(seenAt));
  saveWatch(h, 'AI');
  h.message(listing([eventStory('111111111111', 'AI', 11), eventStory('111111111111', 'ai', 12)]));
  assert.equal(watchControls(h).only.textContent, '只看追蹤 1');
  assert.match(h.container.querySelector('[role=status]').textContent, /新增 1 個事件/);
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
  choose(h, h.categories, 'finance');
  choose(h, h.select, '甲');
  themeButton(h, 'memory').click();
  watchControls(h).only.click();
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  h.message(body);
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'), 'true');
  watchControls(h).only.click();
  focusTopicButtons(h)[0].click();
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  h.message(body);
  assert.deepEqual(mainTitles(h), ['AI 記憶體']);
  saveWatch(h, '不存在');
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'), 'false');
  watchControls(h).only.click();
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
  assert.match(status.textContent, /尚未取得新聞：所有來源連線失敗/);
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

for (const category of ['finance', 'tech', 'world']) {
  test(`${category} history collapses with three insufficient bins and restores at two`, t => {
    const h = setup(t, w=>w.localStorage.setItem("modudock.module.news.history", "true"));
    const report = hour => timedArticle(hour, {category,
      analysis: category === 'world' ? worldAnalysis() : analysis()});
    const enough = Array.from({length:5}, () => report(-22));
    const nearly = Array.from({length:4}, () => report(-16));
    const body = historyList([...enough, ...nearly, report(-16)]);
    h.message(body);
    choose(h, h.categories, category);
    assert.equal(historyRows(h).length, 4);
    assert.equal(historyResults(h).filter(value => value === '樣本不足').length, 2);
    // A same-at replacement must remove old rows, not merely append a hint.
    h.message(historyList([...enough, ...nearly, {...report(-16), analysis:null}]));
    const history = h.container.querySelector('.nw-history');
    assert.equal(history.querySelector('.nw-heading').textContent, '近 24 小時變化');
    assert.equal(history.querySelector('.nw-hint').textContent, '樣本不足，無法比較 24 小時內的變化');
    assert.equal(history.querySelector(".nw-history-content").children.length, 1);
    assert.equal(historyRows(h).length, 0);
    assert.equal(history.querySelectorAll('.nw-history-bar').length, 0);
    h.message(body);
    assert.equal(historyRows(h).length, 4);
    assert.equal(history.querySelector('.nw-hint').textContent, '每 6 小時一段，同一事件只算一次');
    h.message(historyList([report(-22)]));
    assert.equal(historyRows(h).length, 0);
    assert.equal(history.querySelector('.nw-hint').textContent, '樣本不足，無法比較 24 小時內的變化');
  });
}

test('history bins are left inclusive, exclude next boundary and include final endpoint', t => {
  const h = setup(t, w=>w.localStorage.setItem("modudock.module.news.history", "true"));
  const items = [-24, -18, -12, -6].flatMap((hour, i) => Array.from({length:5}, () =>
    timedArticle(hour, {analysis:analysis({market:i % 2 ? 'negative' : 'positive'})})));
  items.push(timedArticle(0), timedArticle(-24 - 1 / 3600000), timedArticle(1 / 3600000));
  h.message(historyList(items));
  choose(h, h.categories, 'finance');
  assert.deepEqual(historyResults(h), ['偏多 100%', '偏多 0%', '偏多 100%', '偏多 17%']);
  const rows = historyRows(h);
  assert.deepEqual(rows.map(row => row.getAttribute('aria-label').match(/樣本 (\d+)/)[1]), ['5', '5', '5', '6']);
  assert.equal(rows[0].getAttribute('role'), 'group');
  assert.equal(rows[0].getAttribute('aria-label'), `${hhmm(historyEnd - 24 * 3600000)}–${hhmm(historyEnd - 18 * 3600000)}，偏多 100%，樣本 5 個事件`);
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
  assert.match(css, /\.nw.nw-narrow \.nw-history-long \{ display: none; \}\s*\.nw.nw-narrow \.nw-history-short \{ display: inline; \}/);
});

test('history requires five analyzed events and reports dash for no directional denominator', t => {
  const h = setup(t, w=>w.localStorage.setItem("modudock.module.news.history", "true"));
  h.message(historyList([
    ...Array.from({length:4}, () => timedArticle(-22)),
    timedArticle(-22, {analysis:null}), timedArticle(-22, {analysis:{market:'positive'}}),
    ...Array.from({length:5}, () => timedArticle(-16, {analysis:analysis({market:'not_market'})})),
    ...['positive','positive','mixed','negative','other'].map(market => timedArticle(-10, {analysis:analysis({market})})),
    timedArticle(-2, {published:'bad'}), timedArticle(-2, {published:{}}),
  ]));
  choose(h, h.categories, 'finance');
  assert.deepEqual(historyResults(h), ['樣本不足', '—', '偏多 2/4', '樣本不足']);
  const rows = historyRows(h);
  assert.equal(rows[0].querySelector('.nw-history-bar').dataset.empty, 'true');
  assert.equal(rows[0].querySelector('.nw-history-bar').childElementCount, 0);
  assert.match(rows[0].getAttribute('aria-label'), /樣本 4 個事件/);
  assert.equal(rows[1].querySelector('.nw-history-bar').dataset.empty, 'false');
  assert.equal(rows[1].querySelector('.nw-idle').style.width, '100%');
});

test('history deduplicates using representative time and first valid analysis, respecting panel scope', t => {
  const h = setup(t, w=>w.localStorage.setItem("modudock.module.news.history", "true"));
  const body = historyList([
    ...Array.from({length:4}, () => timedArticle(-22)),
    timedArticle(-22, {event:'111111111111', event_size:3, analysis:null}),
    timedArticle(-16, {event:'111111111111', event_size:3, analysis:analysis({market:'negative'})}),
    timedArticle(-10, {event:'111111111111', event_size:3}),
    timedArticle(-22, {source:'乙', analysis:analysis({market:'negative'})}),
    timedArticle(-22, {category:'tech', analysis:analysis({market:'negative'})}),
    ...Array.from({length:5}, () => timedArticle(-2)),
  ]);
  h.message(body);
  choose(h, h.categories, 'finance');
  choose(h, h.select, '甲');
  assert.deepEqual(historyResults(h), ['偏多 80%', '樣本不足', '樣本不足', '偏多 100%']);
  const before = h.container.querySelector('.nw-history').textContent;
  themeButton(h, 'memory').click();
  assert.equal(h.container.querySelector('.nw-history').textContent, before);
  h.message(body);
  assert.equal(h.container.querySelector('.nw-history').textContent, before);
});

test('world history uses escalation denominator, world colors and unrelated idle events', t => {
  const h = setup(t, w=>w.localStorage.setItem("modudock.module.news.history", "true"));
  h.message(historyList([
    ...Array.from({length:5}, () => timedArticle(-22, {category:'world', analysis:worldAnalysis()})),
    ...['escalation','escalation','stalemate','deescalation','not_conflict','other'].map(trend =>
      timedArticle(-2, {category:'world', analysis:{kind:'world', trend, region:'us_china'}})),
  ]));
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
  const h = setup(t, w=>w.localStorage.setItem("modudock.module.news.history", "true"));
  const items = [-22, -2].flatMap(hour => Array.from({length:5}, () => timedArticle(hour)));
  for (const at of [undefined, null, {}, 'bad']) {
    h.message({...listing(items), at});
    choose(h, h.categories, 'finance');
    assert.equal(historyResults(h)[3], '偏多 100%');
  }
  const before = h.container.querySelector('.nw-history').textContent;
  t.mock.timers.tick(7 * 3600000);
  themeButton(h, 'memory').click();
  assert.equal(h.container.querySelector('.nw-history').textContent, before);
});

for (const kind of ['topic', 'event']) {
  test(`focus ${kind} title link survives identical replacement`, t => {
    const h = setup(t), reports = focusReports('111111111111', 3, 10, {topic:topicRecord().id});
    const body = kind === 'topic' ? topicListing(reports, [topicRecord({title:reports[0].title})]) : listing(reports);
    h.message(body);
    const before = h.container.querySelector('.nw-focus-row a');
    before.focus();
    const calls = [], original = h.window.HTMLElement.prototype.focus;
    t.mock.method(h.window.HTMLElement.prototype, 'focus', function(options) {
      calls.push(options); return original.call(this, options);
    });
    h.message(body);
    const after = h.container.querySelector('.nw-focus-row a');
    assert.notEqual(after, before);
    assert.equal(h.window.document.activeElement, after);
    assert.deepEqual(calls, [{preventScroll:true}]);
  });
}

test('merged focused report follows unique href and opens its new group with synchronized aria', t => {
  const h = setup(t);
  const a = eventStory('111111111111', '較早', 8, {link:'https://example.com/a'});
  const b = eventStory('222222222222', '正在讀', 9, {link:'https://example.com/b'});
  h.message(listing([a,b]));
  h.container.querySelector('a[href="https://example.com/b"]').focus();
  const merged = listing([a, {...b,event:a.event}]);
  h.message(merged);
  const target = h.container.querySelector('a.nw-report-title[href="https://example.com/b"]');
  assert.equal(h.window.document.activeElement, target);
  assert.equal(target.closest('.nw-reports').hidden, false);
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'), 'true');
  h.message(merged);
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'), 'true');
  assert.equal(h.window.document.activeElement.href, b.link);
  const calls = [];
  t.mock.method(h.window.HTMLElement.prototype, 'focus', function() { calls.push(this); });
  h.message(listing([a]));
  assert.deepEqual(calls, [h.container.querySelector('.nw-list')]); // Never choose its former representative.
});

test('focus href fallback refuses ambiguous links after event identity changes', t => {
  const h = setup(t), link = 'https://example.com/shared';
  h.message(listing([eventStory('111111111111', '原報導', 8, {link})]));
  h.container.querySelector('.nw-list a').focus();
  const calls = [];
  t.mock.method(h.window.HTMLElement.prototype, 'focus', function() { calls.push(this); });
  h.message(listing([eventStory('222222222222', '甲', 8, {link}), eventStory('333333333333', '乙', 9, {link})]));
  assert.deepEqual(calls, [h.container.querySelector('.nw-list')]);
});

test('stale instance unmount cannot overwrite newer lastSeen saved by another instance', t => {
  const h = setup(t, withSeen('2026-09-24T07:00:00Z'));
  const container = h.window.document.createElement('div');
  h.window.document.body.append(container);
  let message;
  const second = mount({container, channel:{onMessage(fn) { message = fn; }, send() {}}, onUp() {}, report() {}});
  h.message(listing([article({published:'2026-09-24T12:00:00Z'})]));
  message(listing([article({published:'2026-09-24T08:00:00Z'})]));
  h.handle.unmount();
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), '2026-09-24T12:00:00.000Z');
  second.unmount();
  assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), '2026-09-24T12:00:00.000Z');
});

test('lastSeen reread ignores invalid values and read errors during persistence', t => {
  for (const stored of ['{bad', '{}', '"not a date"']) {
    const h = setup(t, withSeen('2026-09-24T07:00:00Z'));
    h.message(listing([article({published:'2026-09-24T08:00:00Z'})]));
    h.window.localStorage.setItem(seenKey, stored);
    h.window.dispatchEvent(new h.window.Event('pagehide'));
    assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)), '2026-09-24T08:00:00.000Z');
    h.handle.unmount();
  }
  const h = setup(t, withSeen('2026-09-24T07:00:00Z'));
  h.message(listing([article({published:'2026-09-24T08:00:00Z'})]));
  Object.defineProperty(h.window, 'localStorage', {configurable:true, get() { throw new Error('blocked'); }});
  assert.doesNotThrow(() => h.handle.unmount());
  assert.equal(h.container.childElementCount, 0);
});

const divider = h => h.container.querySelector('.nw-divider');
test('seen divider is absent without baseline, or with only new or only old groups', t => {
  for (const baseline of [false, true]) {
    const h = setup(t, baseline ? withSeen(seenAt) : () => {});
    for (const hours of baseline ? [[11,12], [8,10], []] : [[11,8]]) {
      h.message(listing(hours.map((hour,i) => eventStory(String(i).padStart(12,'0'), '報導', hour))));
      assert.equal(divider(h), null);
      assert.equal(h.container.querySelector('.nw-list .nw-title .nw-new, .nw-list .nw-report-title .nw-new'), null);
    }
  }
});

test('seen divider precedes first old group, omits child markers and retains focus markers', t => {
  const h = setup(t, withSeen(seenAt));
  const reports = focusReports('111111111111', 3, 9);
  h.message(listing([...reports, eventStory('222222222222', '舊', 10)]));
  const line = divider(h), rows = mainRows(h);
  assert.equal(line.previousElementSibling, rows[0]);
  assert.equal(line.nextElementSibling, rows[1]);
  assert.equal(line.textContent, '以下為上次離開前的新聞');
  assert.equal(line.getAttribute('role'), 'separator');
  assert.equal(line.getAttribute('aria-label'), '以下是上次離開前的新聞');
  assert.equal(line.querySelector('a,button,[tabindex]'), null);
  assert.equal(line.hasAttribute('tabindex'), false);
  assert.equal(h.container.querySelector('.nw-list .nw-title .nw-new, .nw-list .nw-report-title .nw-new'), null);
  assert.equal(focusArea(h).querySelectorAll('.nw-new').length, 1);
  assert.equal(mainRows(h)[0].querySelector('.nw-event-latest .nw-new'), null);
  assert.equal(mainRows(h).length, 2);
  assert.match(h.container.querySelector('[role=status]').textContent, /新增 1 個事件/);
  const css = h.container.querySelector('style').textContent;
  assert.match(css, /\.nw \.nw-divider \{[^}]*padding: 14px 16px;[^}]*font-size: 12px;[^}]*color: var\(--nw-accent\)/);
  assert.match(css, /\.nw \.nw-divider::after \{[^}]*flex: 1;[^}]*border-top: 1px solid var\(--nw-accent\)/);
});

test('out-of-order new groups below divider keep a representative new marker', t => {
  const h = setup(t, withSeen(seenAt));
  h.message(listing([eventStory('111111111111', '新', 12),
    article({title:'無日期', published:'bad'}),
    eventStory('222222222222', '例外新群', 11), eventStory('222222222222', '例外群舊報導', 8)]));
  assert.equal(divider(h).nextElementSibling, mainRows(h)[1]);
  assert.equal(mainRows(h)[0].querySelector('.nw-new'), null);
  assert.equal(mainRows(h)[2].querySelector('.nw-title .nw-new').textContent, '新');
  assert.equal(mainRows(h)[2].querySelector('.nw-report-title .nw-new'), null);
  assert.match(h.container.querySelector('[role=status]').textContent, /新增 2 個事件/);
});

test('replacement moves seen divider and preserves link focus without treating separator as news', t => {
  const h = setup(t, withSeen(seenAt));
  const a = eventStory('111111111111', 'A', 12, {link:'https://example.com/a'});
  const b = eventStory('222222222222', 'B', 9, {link:'https://example.com/b'});
  const c = eventStory('333333333333', 'C', 8, {link:'https://example.com/c'});
  h.message(listing([a,b,c]));
  assert.equal(divider(h).nextElementSibling, mainRows(h)[1]);
  h.container.querySelector('a[href="https://example.com/b"]').focus();
  h.message(listing([a,{...b,published:'2026-09-24T11:00:00Z'},c]));
  assert.equal(divider(h).nextElementSibling, mainRows(h)[2]);
  assert.equal(h.window.document.activeElement.href, b.link);
  assert.equal(h.container.querySelectorAll('.nw-divider').length, 1);
  h.message(listing([a,{...b,event:a.event},c]));
  assert.equal(mainRows(h).length, 2);
  assert.equal(divider(h).nextElementSibling, mainRows(h)[1]);
});

test('seen divider recomputes after source category theme topic and watch filters', t => {
  const h = setup(t, withSeen(seenAt)), id = topicRecord().id;
  const items = [eventStory('111111111111', 'AI 新', 12, {topic:id}),
    eventStory('222222222222', '舊', 8, {source:'乙', analysis:analysis({theme:'foundry'})}),
    article({title:'國際舊', category:'world'})];
  h.message(topicListing(items));
  assert.ok(divider(h));
  choose(h,h.select,'甲'); choose(h,h.categories,'finance');
  assert.equal(divider(h), null);
  choose(h,h.select,'');
  assert.ok(divider(h));
  themeButton(h,'memory').click();
  assert.equal(divider(h), null);
  themeButton(h,'memory').click();
  assert.ok(divider(h));
  focusTopicButtons(h)[0].click();
  assert.equal(divider(h), null);
  focusTopicButtons(h)[0].click();
  assert.ok(divider(h));
  saveWatch(h,'AI'); watchControls(h).only.click();
  assert.equal(divider(h), null);
  watchControls(h).only.click();
  assert.ok(divider(h));
});

test('an old group at the top suppresses the divider and new groups keep their markers', t => {
  const h = setup(t, withSeen(seenAt));
  h.message(listing([eventStory('000000000001', '舊', 8), eventStory('000000000002', '新甲', 11),
    eventStory('000000000003', '新乙', 12)]));
  assert.equal(divider(h), null);
  assert.equal(h.container.querySelectorAll('.nw-list .nw-row .nw-new').length, 2);
});

const localStamp = (day, hour, minute=0) => new Date(2026,8,day,hour,minute).toISOString();
test('event time range uses local dates, guessed endpoints and date-only labels', t => {
  t.mock.timers.enable({apis:['Date'], now:new Date(2026,8,25,23)});
  const h = setup(t), id='111111111111';
  const cases = [
    [localStamp(25,8), localStamp(25,20,20), false, false, '08:00–20:20'],
    [localStamp(24,8), localStamp(24,20), false, false, '9/24 08:00–20:00'],
    [localStamp(24,23), localStamp(25,1), false, false, '9/24 23:00–01:00'],
    [localStamp(23,23), localStamp(24,1), false, false, '9/23 23:00–9/24 01:00'],
    [localStamp(25,8), localStamp(25,20), true, true, '約08:00–約20:00'],
    [localStamp(25,0), localStamp(25,20), false, false, '00:00–20:00'],
    [localStamp(24,0), localStamp(25,0), false, true, '9/24 00:00–約00:00'],
    [localStamp(25,8), localStamp(25,8), false, false, '08:00'],
  ];
  for (const [start,end,guessStart,guessEnd,expected] of cases) {
    const first=eventStory(id,'代表',8,{published:start,time_guessed:guessStart});
    const last=eventStory(id,'子報導',9,{published:end,time_guessed:guessEnd});
    h.message(listing([last,first]));
    assert.equal(mainRows(h)[0].querySelector('.nw-info > .nw-time').textContent, expected);
    if (guessStart || guessEnd) assert.match(mainRows(h)[0].querySelector('.nw-time').title, /收錄時間/);
  }
  h.message(listing([eventStory(id,'單則',8,{published:localStamp(25,8)})]));
  assert.equal(mainRows(h)[0].querySelector('.nw-time').textContent,'08:00');
  h.message(listing([eventStory(id,'先',8,{published:localStamp(25,8)}),
    eventStory(id,'後',9,{published:localStamp(25,9)})]));
  h.container.querySelector('.nw-expand').click();
  assert.equal(h.container.querySelector('.nw-report .nw-time').textContent,'09:00');
});

test('per-report tone appears only in topic filter and validates ids without inheriting child tone', t => {
  const h=setup(t), topic=topicRecord(), id='111111111111';
  const tones=['negative','positive','mixed','neutral',{},'__proto__','<img>',null];
  const reports=tones.map((tone,i)=>eventStory(id,`報導${i}`,8+i,{topic:topic.id,tone}));
  h.message(topicListing(reports));
  assert.equal(h.container.querySelector('.nw-tone-tag'),null);
  focusTopicButtons(h)[0].click();
  assert.equal(mainRows(h)[0].querySelector('.nw-info > .nw-tone-tag').textContent,'負 1・中 1・兩面 1・正 1');
  h.container.querySelector('.nw-expand').click();
  assert.deepEqual([...h.container.querySelectorAll('.nw-report .nw-tone-tag')].map(n=>n.textContent),['正面','正反並陳','中性']);
  assert.equal(h.container.querySelector('img'),null);
  h.message(topicListing(reports.map((item,i)=>i===0?{...item,tone:null}:item)));
  assert.equal(mainRows(h)[0].querySelector('.nw-info > .nw-tone-tag').textContent,'中 1・兩面 1・正 1');
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'),'true');
  focusTopicButtons(h)[0].click();
  assert.equal(h.container.querySelector('.nw-tone-tag'),null);
});

test('topic source distribution counts reports, orders feed ties, limits five and updates on resend', t => {
  const h=setup(t), topic=topicRecord();
  const names=['B','A','C','D','E','F','G'];
  const reports=names.flatMap((source,i)=>Array.from({length:i<2?3:1},(_,j)=>
    article({source,topic:topic.id,event:'111111111111',event_size:11,title:`${source}${j}`})));
  const body={...topicListing(reports),sources:['A','B','C','D','E','F','G'].map(name=>({name,ok:true}))};
  h.message(body);
  const hint=h.container.querySelector('.nw-topic-sources');
  assert.equal(hint.hidden,true);
  focusTopicButtons(h)[0].click();
  assert.equal(hint.hidden,false);
  assert.equal(outletDistribution(h),'A 3・B 3・C 1・D 1・E 1');
  assert.equal(h.container.querySelector('.nw-outlet-more').textContent,'另 2 家（共 7 家）');
  h.message({...body,items:[...reports,article({source:'G',topic:topic.id}),article({source:'G',topic:topic.id}),article({source:'G',topic:topic.id})]});
  assert.equal(outletDistribution(h),'G 4・A 3・B 3・C 1・D 1');
  saveWatch(h,'A0'); watchControls(h).only.click();
  assert.equal(outletDistribution(h),'A 3・B 0・C 0・D 0・E 0');
  focusTopicButtons(h)[0].click();
  assert.equal(hint.hidden,true);
  assert.equal(hint.querySelectorAll('.nw-outlet').length,0);
});

test('politics panel ranks neutral issues by events, filters and clears incompatible selections', t => {
  const h=setup(t);
  const political=(issue,extra={})=>article({category:'politics',analysis:{kind:'politics',issue},...extra});
  const body=listing([political('budget',{event:'111111111111',event_size:2}),
    political('budget',{event:'111111111111',event_size:2}), political('budget'),
    political('cross_strait'),political('other'),political('zzz'),political({}),financeArticle(),worldArticle()]);
  h.message(body); choose(h,h.categories,'politics');
  const surface=h.container.querySelector('[aria-label="政治議題分析"]');
  assert.equal(surface.hidden,false);
  assert.equal(surface.querySelector('.nw-market').hidden,true);
  assert.equal(surface.querySelector('.nw-history').hidden,true);
  assert.equal(surface.querySelector('.nw-macro').hidden,true);
  assert.match(surface.querySelector('.nw-sample-count').textContent,/6 個事件（7 則報導）/);
  assert.equal(surface.querySelector('.nw-pending').textContent,'待判定 2');
  const buttons=()=>[...surface.querySelectorAll('button[data-topic]')];
  assert.deepEqual(buttons().map(b=>b.dataset.topic),['issue:budget','issue:cross_strait','issue:other']);
  assert.deepEqual(buttons().map(b=>b.querySelector('.nw-theme-count').textContent),['2','1','1']);
  assert.ok(buttons().every(b=>b.querySelectorAll('.nw-segment').length===1));
  assert.equal(buttons()[0].querySelector('.nw-segment').className,'nw-segment nw-issue-count');
  assert.equal(mainRows(h)[0].querySelector('.nw-tag').textContent,'預算與補貼');
  buttons()[0].click(); assert.equal(mainRows(h).length,2);
  assert.equal(buttons()[0].getAttribute('aria-pressed'),'true');
  h.message(body); assert.equal(mainRows(h).length,2);
  h.container.querySelector('.nw-filter button').click(); assert.equal(mainRows(h).length,6);
  buttons()[0].click(); buttons()[0].click(); assert.equal(mainRows(h).length,6);
  buttons()[0].click(); choose(h,h.categories,'finance');
  assert.equal(mainRows(h).length,1); assert.equal(surface.querySelector('.nw-market').hidden,false);
  themeButton(h,'memory').click(); choose(h,h.categories,'politics');
  assert.equal(mainRows(h).length,6);
  choose(h,h.categories,'world'); regionButton(h,'asia_pacific').click();
  choose(h,h.categories,'politics'); assert.equal(mainRows(h).length,6);
});

test('issue "other" ranks last even when it has more events', t => {
  const h=setup(t);
  const political=issue=>article({category:'politics',analysis:{kind:'politics',issue}});
  h.message(listing([political('other'),political('other'),political('other'),political('energy_env')]));
  choose(h,h.categories,'politics');
  const surface=h.container.querySelector('[aria-label="政治議題分析"]');
  assert.deepEqual([...surface.querySelectorAll('button[data-topic]')].map(b=>b.dataset.topic),
    ['issue:energy_env','issue:other']);
});

test('text buttons use visible names and external descriptions survive redraws and unmount cleanly', t => {
  const h=setup(t), topic=topicRecord({title:'<img src=x> 完整話題標題'});
  const reports=[...focusReports('111111111111',3,10,{topic:topic.id}),
    financeArticle({analysis:analysis({dir:'bear'})}),worldArticle(),
    article({category:'politics',analysis:{kind:'politics',issue:'budget'}})];
  const scan=()=>{
    for (const button of h.container.querySelectorAll('button')) {
      if (button.matches('.nw-tone-button')) assert.equal(button.getAttribute('aria-label'),`${button.textContent} 則報導`);
      else if (button.matches('.nw-topic-outlet-clear')) assert.equal(button.getAttribute('aria-label'),'清除媒體篩選');
      else if (button.matches('.nw-shortcut-toggle')) assert.equal(button.getAttribute('aria-label'),'快捷鍵說明');
      else if (button.textContent.trim()) assert.equal(button.hasAttribute('aria-label'),false);
      const id=button.getAttribute('aria-describedby');
      if (id) {
        const node=h.window.document.getElementById(id);
        assert.ok(node && h.container.contains(node));
        assert.equal(node.className,button.matches('.nw-outlet')?'nw-hint nw-outlet-small':'nw-sr');
        assert.equal(button.contains(node),false);
        assert.ok(node.textContent);
        assert.doesNotMatch(node.textContent,/[▲▼]/);
        assert.equal(node.hidden,false);
      }
    }
    const ids=[...h.container.querySelectorAll('.nw-sr, .nw-outlet-small')].map(node=>node.id);
    assert.equal(new Set(ids).size,ids.length);
    assert.equal(ids.length,h.container.querySelectorAll('[aria-describedby]').length);
  };
  h.message(listing(reports));
  assert.equal(described(h,focusButtons(h)[0]),'展開同事件的其他報導');
  scan();
  const body=topicListing(reports,[topic]);
  h.message(body);
  assert.equal(described(h,focusTopicButtons(h)[0]),`進入話題：${topic.title}，${topic.count} 則報導`);
  assert.equal(h.container.querySelector('img'),null);
  choose(h,h.categories,'finance');
  assert.equal(described(h,themeButton(h,'memory')),'利多 1、利空 1');
  themeButton(h,'memory').click();
  assert.equal(h.container.querySelector('.nw-filter button').textContent,'清除篩選');
  scan();
  // Dynamic button descriptions rebuild; source select and watch-only keep stable descriptions.
  const oldIds=[...h.container.querySelectorAll('button[aria-describedby]:not(.nw-watch-only)')].map(node=>node.getAttribute('aria-describedby'));
  h.message(body); scan();
  for (const id of oldIds) assert.equal(h.window.document.getElementById(id),null);
  choose(h,h.categories,'world');
  assert.equal(described(h,regionButton(h,'asia_pacific')),'升級 1、緩和 0');
  scan();
  choose(h,h.categories,'politics');
  assert.equal(h.container.querySelector('[data-topic="issue:budget"]').hasAttribute('aria-describedby'),false);
  scan();
  choose(h,h.categories,'');
  focusTopicButtons(h)[0].click();
  assert.equal(h.container.querySelector('.nw-filter button').textContent,'返回原檢視');
  scan();
  const finalIds=[...h.container.querySelectorAll('.nw-sr')].map(node=>node.id);
  h.handle.unmount();
  for (const id of finalIds) assert.equal(h.window.document.getElementById(id),null);
});

test('a feed timestamp in the future never pushes lastSeen past the current time', t => {
  const h = setup(t, withSeen(seenAt));
  const future = new Date(Date.now() + 5 * 3600e3).toISOString();
  h.message(listing([article({published: future})]));
  const before = Date.now();
  h.handle.unmount();
  const stored = Date.parse(JSON.parse(h.window.localStorage.getItem(seenKey)));
  assert.ok(stored <= Date.now() && stored >= before - 1000);
});

test('summary toggles safe full source text with aria, survives resend and preserves keyboard focus', t => {
  const h=setup(t), id='111111111111', summary='<img src=x> '+ '完整摘要'.repeat(120);
  const body=listing([eventStory(id,'代表',8,{summary}),eventStory(id,'子報導',9,{summary:'另一份摘要'})]);
  h.message(body);
  let button=h.container.querySelector('.nw-summary-toggle');
  const paragraph=()=>h.window.document.getElementById(button.getAttribute('aria-controls'));
  assert.equal(button.parentElement.firstElementChild,button);
  assert.equal(button.textContent,'摘要');
  assert.equal(button.hasAttribute('aria-label'),false);
  assert.equal(paragraph().previousElementSibling.className,'nw-meta');
  assert.equal(paragraph().hidden,true);
  assert.equal(button.getAttribute('aria-expanded'),'false');
  assert.equal(paragraph().querySelector('small').textContent,'來源摘要');
  assert.equal(paragraph().lastChild.textContent,summary);
  assert.equal(h.container.querySelector('img'),null);
  assert.equal(mainRows(h)[0].querySelector('.nw-title').title,summary);
  button.click(); button.focus();
  assert.equal(paragraph().hidden,false);
  h.message(body); button=h.container.querySelector('.nw-summary-toggle');
  assert.equal(button.getAttribute('aria-expanded'),'true');
  assert.equal(paragraph().hidden,false);
  assert.equal(h.window.document.activeElement,button);
  button.click(); assert.equal(paragraph().hidden,true);
  button.click();
  const retained=button;
  h.handle.unmount(); retained.click();
  assert.equal(retained.getAttribute('aria-expanded'),'true');
  assert.equal(h.container.childElementCount,0);
});

test('summary handles missing text, link fallback and forgets rows that disappear', t => {
  const h=setup(t);
  for(const summary of ['',null,{},42]) {
    h.message(listing([article({summary})]));
    assert.equal(h.container.querySelector('.nw-summary-toggle'),null);
  }
  const body=listing([article({summary:'來源內容'})]);
  h.message(body); h.container.querySelector('.nw-summary-toggle').click();
  h.message(body);
  assert.equal(h.container.querySelector('.nw-summary').hidden,false);
  h.message(listing([])); h.message(body);
  assert.equal(h.container.querySelector('.nw-summary').hidden,true);
  h.container.querySelector('.nw-summary-toggle').click();
  choose(h,h.categories,'world'); choose(h,h.categories,'');
  assert.equal(h.container.querySelector('.nw-summary').hidden,false);
});

test('watch toggle stays on toolbar while settings close and disappears with empty keywords', t => {
  const h=setup(t), c=watchControls(h);
  assert.equal(c.toggle.textContent,'追蹤關鍵字');
  assert.equal(c.toggle.nextElementSibling,c.only);
  assert.equal(c.only.hidden,true);
  assert.equal(c.settings.querySelector('.nw-watch-only'),null);
  saveWatch(h,'AI');
  h.message(listing([article({title:'AI'}),article()]));
  assert.equal(c.only.hidden,false);
  assert.equal(c.only.textContent,'只看追蹤 1');
  c.toggle.click(); c.only.click(); c.toggle.click();
  assert.equal(c.settings.hidden,true);
  assert.equal(c.only.hidden,false);
  assert.equal(c.only.getAttribute('aria-pressed'),'true');
  assert.equal(mainRows(h).length,1);
  assert.doesNotMatch(h.container.querySelector('[role=status]').textContent,/追蹤/);
  saveWatch(h,'');
  assert.equal(c.only.hidden,true);
  assert.equal(c.only.getAttribute('aria-pressed'),'false');
  assert.equal(mainRows(h).length,2);
});

test('topic progress counts new events with old representatives and coexists with tone', t => {
  const id=topicRecord().id;
  const reports=[eventStory('111111111111','old representative',8,{topic:id}),
    eventStory('111111111111','new child',11,{topic:id}),eventStory('111111111111','new sibling',12,{topic:id}),
    eventStory('222222222222','new event',11,{topic:id}),eventStory('333333333333','old event',7,{topic:id})];
  const body=topicListing(reports.map((item,i)=>({...item,tone:i<2?'positive':'negative'})),[topicRecord({count:5,tone:{positive:2,negative:3,neutral:0,mixed:0}})]);
  const first=setup(t); first.message(body);
  assert.equal(first.container.querySelector('.nw-topic-new'),null);
  const h=setup(t,withSeen(seenAt)); h.message(body);
  const hint=h.container.querySelector('.nw-topic-new');
  assert.equal(hint.textContent,'+2 新事件');
  assert.equal(hint.getAttribute('aria-label'),'上次之後新增 2 個事件');
  assert.equal(hint.previousElementSibling.className,'nw-tone');
  h.message({...body,topics:{list:[topicRecord()]}});
  assert.equal(h.container.querySelector('.nw-topic-new').previousElementSibling.className,'nw-hint nw-topic-latest');
  assert.equal(h.container.querySelector('.nw-topic-latest').previousElementSibling.className,'nw-title');
  h.message({...body,items:reports.map(item=>({...item,published:seenAt}))});
  assert.equal(h.container.querySelector('.nw-topic-new'),null);
});

test('model status shows working and paused, with focus hint only while topics are absent', t => {
  const h=setup(t);
  for (const [state,label] of [['working','新聞已可閱讀・整理分類與話題中'],['paused','整理暫停，下次更新繼續'],['done',''],['off','']]) {
    h.message({...listing([]),model:{state,reason:'ignored'}});
    const status=h.container.querySelector('[role=status]').textContent;
    if(label) assert.ok(status.includes(`更新 · ${label}`));
    else assert.doesNotMatch(status,/整理/);
    const focus=focusArea(h);
    assert.equal(focus.hidden,false);
    if(state!=='working') assert.match(focus.textContent,/目前沒有多家媒體同時報導的新聞/);
    if(state==='working') assert.match(focus.textContent,/正在整理多家媒體同報的話題/);
  }
  h.message({...topicListing([article({topic:topicRecord().id})]),model:{state:'working'}});
  assert.equal(focusTopicButtons(h).length,1);
  assert.doesNotMatch(focusArea(h).textContent,/正在整理/);
  for (const model of [null,{},'working',{state:{}},{state:'<img>'}]) {
    assert.doesNotThrow(()=>h.message({...listing([]),model}));
    assert.doesNotMatch(h.container.querySelector('[role=status]').textContent,/整理/);
  }
});

for (const exit of ['return','same-topic','disappear']) {
  test(`topic ${exit} restores filters scroll and focus across topic switches`, t => {
    const h=setup(t), first=topicRecord(), second=topicRecord({id:'bbbbbbbbbbbb',title:'另一話題'});
    const body=topicListing([financeArticle({title:'AI 原檢視',source:'甲',link:'https://example.com/original',topic:first.id}),
      article({topic:first.id,title:first.title}),article({topic:second.id,title:second.title})],[first,second]);
    const outer=h.window.document.createElement('div');
    outer.style.overflowY='auto';
    Object.defineProperties(outer,{scrollHeight:{value:1000},clientHeight:{value:200}});
    h.window.document.body.append(outer); outer.append(h.container);
    outer.scrollTop=123;
    h.message(body); saveWatch(h,'AI');
    choose(h,h.categories,'finance'); choose(h,h.select,'甲'); themeButton(h,'memory').click();
    h.container.querySelector('.nw-list a').focus();
    focusTopicButtons(h)[0].click();
    assert.equal(h.categories.value,''); assert.equal(h.select.value,'');
    watchControls(h).only.click();
    watchControls(h).only.click(); // Restore the visible topic controls before switching.
    outer.scrollTop=456;
    focusTopicButtons(h)[1].click();
    h.message(body);
    if(exit==='return') {
      const button=h.container.querySelector('.nw-filter button');
      assert.equal(button.textContent,'返回原檢視');
      assert.equal(described(h,button),'回到進入話題前的篩選與位置');
      button.click();
    } else if(exit==='same-topic') focusTopicButtons(h)[1].click();
    else h.message({...body,topics:{list:[first]}});
    assert.equal(h.categories.value,'finance'); assert.equal(h.select.value,'甲');
    assert.equal(themeButton(h,'memory').getAttribute('aria-pressed'),'true');
    assert.equal(watchControls(h).only.getAttribute('aria-pressed'),'false');
    assert.equal(outer.scrollTop,123);
    assert.equal(h.window.document.activeElement.href,'https://example.com/original');
  });
}

test('manual source and clear-all discard saved topic view', t => {
  for(const action of ['source','clear']) {
    const h=setup(t), id=topicRecord().id;
    const body=topicListing([financeArticle({source:'甲',topic:id}),article({topic:id,source:'乙',category:'world'})]);
    h.message(body); choose(h,h.categories,'finance'); choose(h,h.select,'甲');
    focusTopicButtons(h)[0].click();
    if(action==='source') choose(h,h.select,'乙');
    if(action==='clear') {
      saveWatch(h,'absent'); watchControls(h).only.click();
      h.container.querySelector('.nw-empty button').click();
    }
    const source=h.select.value, category=h.categories.value;
    focusTopicButtons(h)[0].click(); h.container.querySelector('.nw-filter button').click();
    assert.equal(h.select.value,source); assert.equal(h.categories.value,category);
    assert.notEqual(h.categories.value,'finance');
  }
});

test('return skips removed source and theme options and tolerates vanished focus', t => {
  const h=setup(t), id=topicRecord().id;
  h.message(topicListing([financeArticle({source:'乙',link:'https://example.com/removed',topic:id}),article({topic:id})]));
  choose(h,h.categories,'finance'); choose(h,h.select,'乙'); themeButton(h,'memory').click();
  h.container.querySelector('.nw-list a').focus(); focusTopicButtons(h)[0].click();
  h.message({...topicListing([financeArticle({analysis:analysis({theme:'foundry'})}),article({topic:id})]),sources:[{name:'甲',ok:true}]});
  const calls=[];
  t.mock.method(h.window.HTMLElement.prototype,'focus',function(){calls.push(this);});
  h.container.querySelector('.nw-filter button').click();
  assert.equal(h.select.value,''); assert.equal(h.categories.value,'finance');
  assert.equal(h.container.querySelector('.nw-filter').hidden,true);
  assert.equal(mainRows(h).length,1); assert.deepEqual(calls,[h.container.querySelector('.nw-list')]);
});

test('category and political issue tags add information only in appropriate views', t => {
  const h=setup(t), topic=topicRecord();
  const political=article({category:'politics',analysis:{kind:'politics',issue:'us_intl'},topic:topic.id});
  h.message(topicListing([political,financeArticle({topic:topic.id}),worldArticle({topic:topic.id})]));
  assert.deepEqual(mainRows(h).map(row=>row.querySelector('.nw-category').textContent),['政治','財經','國際']);
  assert.equal(mainRows(h)[0].querySelector('.nw-tag'),null);
  assert.equal(mainRows(h)[1].querySelector('.nw-tag').textContent,'記憶體 ▲');
  assert.ok(mainRows(h)[2].querySelector('.nw-tag'));
  for(const category of ['politics','finance','world']) {
    choose(h,h.categories,category);
    assert.equal(mainRows(h).length,1);
    assert.equal(mainRows(h)[0].querySelector('.nw-category'),null);
    assert.ok(mainRows(h)[0].querySelector('.nw-tag'));
    if(category==='politics') assert.equal(mainRows(h)[0].querySelector('.nw-tag').textContent,'美國與國際');
  }
  focusTopicButtons(h)[0].click();
  assert.equal(mainRows(h)[0].querySelector('.nw-category').textContent,'政治');
  assert.equal(mainRows(h)[0].querySelector('.nw-tag'),null);
  assert.equal(mainRows(h)[1].querySelector('.nw-tag').textContent,'記憶體 ▲');
});

test('row separates ordered information from right-aligned actions with narrow layout fallback', t => {
  const h=setup(t), topic=topicRecord(), id='111111111111';
  saveWatch(h,'AI');
  h.message(topicListing([eventStory(id,'AI 代表',8,{topic:topic.id,tone:'negative'}),
    eventStory(id,'子報導',9,{topic:topic.id})]));
  focusTopicButtons(h)[0].click();
  const row=mainRows(h)[0], meta=row.querySelector('.nw-meta');
  assert.deepEqual([...meta.children].map(node=>node.className),['nw-info','nw-actions']);
  const info=meta.firstElementChild, actions=meta.lastElementChild;
  assert.deepEqual([...info.children].map(node=>node.className.split(' ')[0]),
    ['nw-watch','nw-tag','nw-category','nw-source','nw-time','nw-tone-tag']);
  assert.equal(info.querySelector('button'),null);
  assert.deepEqual([...actions.children].map(node=>node.className),['nw-summary-toggle','nw-expand']);
  assert.equal(actions.children[1].textContent,'另 1 則報導');
  assert.equal(actions.children[0].textContent,'摘要');
  actions.children[0].click(); actions.children[1].click();
  assert.equal(row.querySelector('.nw-reports').hidden,false);
  assert.equal(row.querySelector('.nw-summary').hidden,false);
  const style=h.window.getComputedStyle(actions);
  assert.equal(style.marginLeft,'auto'); assert.equal(style.gap,'6px');
  const css=h.container.querySelector('style').textContent;
  assert.match(css,/\.nw.nw-narrow \.nw-actions \{ margin-left: 0; \}/);
  h.message(listing([article({summary:''})]));
  assert.equal(mainRows(h)[0].querySelector('.nw-actions'),null);
});

test('topic focus follows source and category on the same report and retains whole-topic counts', t => {
  const h=setup(t), first=topicRecord({sources:4,count:9}), second=topicRecord({id:'bbbbbbbbbbbb'});
  const body=topicListing([
    financeArticle({topic:first.id,source:'甲'}), worldArticle({topic:first.id,source:'乙'}),
    worldArticle({topic:second.id,source:'甲'}), article({topic:second.id,source:'乙',category:'politics'}),
  ],[first,second]);
  const ids=()=>focusTopicButtons(h).map(button=>button.dataset.topicId);
  h.message(body);
  assert.deepEqual(ids(),[first.id,second.id]);
  choose(h,h.categories,'finance');
  assert.deepEqual(ids(),[first.id]);
  assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-long').textContent,'看話題・4 家');
  choose(h,h.categories,'world');
  choose(h,h.select,'乙');
  assert.deepEqual(ids(),[first.id]); // Second has world and 乙, but not on the same report.
  h.message(body);
  assert.deepEqual(ids(),[first.id]);
  focusTopicButtons(h)[0].click();
  assert.deepEqual(ids(),[first.id,second.id]); // Topic view still offers every topic.
  assert.equal(mainRows(h).length,2); // Clicking includes members outside the former scope.
  assert.equal(h.categories.value,'');
  assert.equal(h.select.value,'');
  h.container.querySelector('.nw-filter button').click();
  assert.deepEqual(ids(),[first.id]);
  choose(h,h.categories,'');
  choose(h,h.select,'甲');
  assert.deepEqual(ids(),[first.id,second.id]);
  choose(h,h.categories,'politics');
  assert.deepEqual(ids(),[]);
  assert.equal(focusArea(h).hidden,true);
  choose(h,h.select,'乙');
  assert.deepEqual(ids(),[second.id]);
  assert.equal(focusArea(h).hidden,false);
});

test('filtered-out topics hide focus without event fallback or working hint', t => {
  const h=setup(t), topic=topicRecord();
  const reports=[article({topic:topic.id,category:'world'}),
    ...focusReports('111111111111',3)];
  for (const state of ['done','working']) {
    h.message({...topicListing(reports),model:{state}});
    choose(h,h.categories,'finance');
    assert.equal(focusArea(h).hidden,true);
    assert.equal(focusButtons(h).length,0);
    assert.doesNotMatch(focusArea(h).textContent,/正在整理/);
    h.message({...listing(reports),model:{state:'done'}});
    assert.equal(focusArea(h).hidden,false); // Genuine absence still uses scoped event fallback.
    assert.equal(focusButtons(h)[0].dataset.event,'111111111111');
  }
});

test('working suppresses pending classification count while paused and done retain it', t => {
  const h=setup(t), status=()=>h.container.querySelector('[role=status]').textContent;
  for (const state of ['working','paused','done']) {
    h.message({...listing([article()]),classify:{enabled:true,pending:7},model:{state}});
    if (state==='working') {
      assert.match(status(),/新聞已可閱讀・整理分類與話題中/);
      assert.doesNotMatch(status(),/未分類/);
    } else assert.match(status(),/未分類：7/);
    h.message({...listing([]),classify:{enabled:true,pending:0},model:{state}});
    assert.doesNotMatch(status(),/未分類/);
  }
  h.message({...listing([]),classify:{enabled:false,pending:7},model:{state:'off'}});
  assert.match(status(),/分類：關閉/);
  assert.doesNotMatch(status(),/未分類/);
});

test('source alone filters topic focus and clearing it restores every topic', t => {
  const h=setup(t), first=topicRecord(), second=topicRecord({id:'bbbbbbbbbbbb'});
  h.message(topicListing([article({topic:first.id,source:'甲'}),article({topic:second.id,source:'乙'})],[first,second]));
  for (const [source,ids] of [['甲',[first.id]],['乙',[second.id]],['',[first.id,second.id]]]) {
    choose(h,h.select,source);
    assert.deepEqual(focusTopicButtons(h).map(button=>button.dataset.topicId),ids);
  }
});

test('entering a topic disables watch-only and returning restores it', t => {
  const h=setup(t), id=topicRecord().id;
  h.message(topicListing([article({title:'AI',topic:id,link:'https://e.com/a'}),
    article({title:'其他',topic:id,link:'https://e.com/b'})]));
  saveWatch(h,'AI'); watchControls(h).only.click();
  assert.equal(mainRows(h).length,1);
  focusTopicButtons(h)[0].click();
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'),'false');
  assert.equal(mainRows(h).length,2);
  h.container.querySelector('.nw-filter button').click();
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'),'true');
  assert.equal(mainRows(h).length,1);
});

test('summary state survives filters and a topic round trip with restored scroll', t => {
  const h=setup(t), id=topicRecord().id;
  const body=topicListing([article({title:'原檢視',link:'https://e.com/a'}),article({topic:id,link:'https://e.com/b'})]);
  h.container.style.overflowY='auto';
  Object.defineProperties(h.container,{scrollHeight:{value:2000},clientHeight:{value:200}});
  h.message(body);
  h.container.querySelector('.nw-summary-toggle').click();
  h.container.scrollTop=1500;
  focusTopicButtons(h)[0].click();
  h.message(body); // Hidden reports must remain in the summary-state set on resend too.
  h.container.scrollTop=0;
  h.container.querySelector('.nw-filter button').click();
  assert.equal(h.container.querySelector('.nw-summary').hidden,false);
  assert.equal(h.container.scrollTop,1500);
  choose(h,h.select,'乙'); h.message(body); choose(h,h.select,'');
  assert.equal(h.container.querySelector('.nw-summary').hidden,false);
  h.message(topicListing(body.items.slice(1))); h.message(body);
  assert.equal(h.container.querySelector('.nw-summary').hidden,true);
});

test('disappearing topic restores current report focus when saved topic button is gone', t => {
  const h=setup(t), id=topicRecord().id;
  const items=[article({topic:id,link:'https://e.com/a'})];
  h.message(topicListing(items));
  focusTopicButtons(h)[0].focus(); focusTopicButtons(h)[0].click();
  h.container.querySelector('.nw-list a').focus();
  h.message(listing(items.map(item=>({...item,topic:undefined}))));
  assert.equal(h.window.document.activeElement,h.container.querySelector('.nw-list a'));
  assert.equal(h.window.document.activeElement.href,'https://e.com/a');
});

test('automatic topic return preserves outside focus and scroll while explicit return restores both', t => {
  const h=setup(t), id=topicRecord().id;
  const body=topicListing([article({link:'https://e.com/original'}),article({topic:id,link:'https://e.com/topic'})]);
  h.container.style.overflowY='auto';
  Object.defineProperties(h.container,{scrollHeight:{value:2000},clientHeight:{value:200}});
  const outside=h.window.document.createElement('input'); h.window.document.body.append(outside);
  for(const automatic of [true,false]) {
    h.message(body);
    h.container.scrollTop=1500;
    h.container.querySelector('.nw-list a').focus();
    focusTopicButtons(h)[0].click();
    h.container.scrollTop=300; outside.focus();
    if(automatic) h.message(listing(body.items));
    else h.container.querySelector('.nw-filter button').click();
    assert.equal(h.container.scrollTop,automatic?300:1500);
    assert.equal(h.window.document.activeElement,automatic?outside:h.container.querySelector('.nw-list a'));
  }
});

test('summary fallback distinguishes same-link reports and does not persist linkless expansion', t => {
  const h=setup(t);
  const body=listing([article({title:'A',source:'甲'}),article({title:'B',source:'甲'}),
    article({title:'A',source:'乙'}),article({title:'X',link:''}),article({title:'Y',link:''})]);
  const buttons=()=>[...h.container.querySelectorAll('.nw-summary-toggle')];
  const hidden=()=>[...h.container.querySelectorAll('.nw-summary')].map(node=>node.hidden);
  h.message(body);
  buttons()[0].click(); buttons()[3].click();
  assert.deepEqual(hidden(),[false,true,true,false,true]);
  buttons()[3].click(); assert.deepEqual(hidden(),[false,true,true,true,true]);
  buttons()[3].click(); h.message(body);
  assert.deepEqual(hidden(),[false,true,true,true,true]);
});

test('category option counts are events scoped by source, including zero categories', t => {
  const h=setup(t), id=topicRecord().id;
  const body=topicListing([
    eventStory('111111111111','AI',8,{source:'甲',topic:id}),
    eventStory('111111111111','同事件',9,{source:'乙',topic:id}),
    eventStory('222222222222','其他財經',10,{source:'乙'}),
    article({source:'甲',category:'world',link:'https://e.com/world'}),
  ]);
  const labels=()=>Object.fromEntries([...h.categories.options].map(o=>[o.value,o.textContent]));
  h.message(body);
  assert.equal(labels()[''],'全部類別 3');
  assert.equal(labels().finance,'財經 2');
  assert.equal(labels().world,'國際 1');
  assert.equal(labels().entertainment,'娛樂 0');
  assert.ok([...h.categories.options].every(o=>!o.disabled && !o.hidden));
  choose(h,h.select,'甲');
  assert.equal(labels()[''],'全部類別 2');
  assert.equal(labels().finance,'財經 1');
  choose(h,h.categories,'finance'); themeButton(h,'memory').click();
  saveWatch(h,'AI'); watchControls(h).only.click();
  assert.equal(labels()[''],'全部類別 2');
  assert.equal(labels().world,'國際 1');
  focusTopicButtons(h)[0].click(); // Topic entry clears source; counts still include non-topic reports.
  assert.equal(labels()[''],'全部類別 3');
  assert.equal(labels().finance,'財經 2');
  h.container.querySelector('.nw-filter button').click();
  assert.equal(labels()[''],'全部類別 2');
  choose(h,h.select,'乙');
  assert.equal(labels().finance,'財經 2');
  assert.equal(labels().world,'國際 0');
});

test('source counts and failure labels update existing options without losing selection or focus', t => {
  const h=setup(t), evil='<img src=x onerror=alert(1)>';
  const body=listing([financeArticle(),worldArticle({source:'乙'})],
    [{name:'甲',count:1,ok:true},{name:'乙',count:1,ok:false},{name:evil,count:0,ok:true}]);
  h.message(body);
  const options=[...h.select.options], categories=[...h.categories.options];
  assert.deepEqual(options.map(o=>o.textContent),['全部來源 2','甲 1','乙 1（失敗）',`${evil} 0`]);
  assert.equal(h.container.querySelector('img'),null);
  choose(h,h.select,'甲'); choose(h,h.categories,'finance');
  for(const control of [h.select,h.categories]) {
    control.focus();
    h.message({...body,items:[...body.items,financeArticle({link:'https://e.com/new'})],
      sources:[{name:'甲',count:2,ok:false},{name:'乙',count:1,ok:true},{name:evil,count:-1}]});
    assert.equal(h.window.document.activeElement,control);
    assert.equal(h.select.value,'甲'); assert.equal(h.categories.value,'finance');
    assert.deepEqual([...h.select.options],options);
    assert.deepEqual([...h.categories.options],categories);
    assert.deepEqual([...h.select.options].map(o=>o.textContent),['全部來源 2','甲 2（失敗）','乙 0',`${evil} 0`]);
    assert.equal(h.categories.selectedOptions[0].textContent,'財經 2');
  }
  h.message({...body,sources:[{name:'乙',count:null},{name:'新來源',count:'4'},{name:'乙',count:99}]});
  assert.equal(h.select.value,'');
  assert.equal(h.select.options[1],options[2]);
  assert.deepEqual([...h.select.options].map(o=>o.textContent),['全部來源 1','乙 0','新來源 0']);
});

function refreshClock(t,h) {
  let now=0, next=0;
  const timers=new Map();
  t.mock.method(h.window,'setTimeout',(callback,delay)=>{
    const id=++next; timers.set(id,{callback,at:now+delay}); return id;
  });
  t.mock.method(h.window,'clearTimeout',id=>timers.delete(id));
  return {timers, tick(ms) {
    now+=ms;
    for(const [id,timer] of [...timers]) if(timer.at<=now) {
      timers.delete(id); timer.callback();
    }
  }};
}

test('refresh is immediately busy and only a different list at completes it', t => {
  const h=setup(t), clock=refreshClock(t,h), body=listing([article()]);
  const list=h.container.querySelector('.nw-list');
  h.up(); h.message(body); h.button.focus(); h.button.click();
  assert.equal(h.button.disabled,false);
  assert.equal(h.window.document.activeElement,h.button);
  h.button.click();
  assert.equal(h.button.getAttribute('aria-disabled'),'true');
  assert.equal(h.button.textContent,'↻ 更新中…');
  assert.equal(list.getAttribute('aria-busy'),'true');
  assert.deepEqual(h.sent,[{op:'refresh'}]);
  h.button.dispatchEvent(new h.window.Event('click'));
  assert.equal(h.sent.length,1);
  h.message({...body,classify:{enabled:true,pending:0}});
  assert.equal(h.button.getAttribute('aria-disabled'),'true');
  assert.equal(list.getAttribute('aria-busy'),'true');
  assert.equal(clock.timers.size,1);
  h.message({...body,at:'2026-09-21T02:05:00Z'});
  assert.equal(h.button.disabled,false);
  assert.equal(h.button.textContent,'↻ 重新整理');
  assert.equal(list.hasAttribute('aria-busy'),false);
  assert.equal(clock.timers.size,0);
  clock.tick(30000);
  assert.doesNotMatch(h.container.querySelector('[role=status]').textContent,/更新未完成/);
});

test('refresh timeout releases busy state and keeps notice until a different list at', t => {
  for(const initial of [false,true]) {
    const h=setup(t), clock=refreshClock(t,h), body=listing([article()]);
    const status=()=>h.container.querySelector('[role=status]').textContent;
    h.up(); if(initial) h.message(body);
    h.button.click(); clock.tick(29999);
    assert.equal(h.button.getAttribute('aria-disabled'),'true');
    assert.doesNotMatch(status(),/更新未完成/);
    clock.tick(1);
    assert.equal(h.button.disabled,false);
    assert.equal(h.button.textContent,'↻ 重新整理');
    assert.equal(h.container.querySelector('.nw-list').hasAttribute('aria-busy'),false);
    assert.match(status(),/更新未完成，稍後自動重試/);
    choose(h,h.categories,'finance');
    assert.match(status(),/更新未完成，稍後自動重試/);
    h.button.click();
    assert.equal(h.sent.length,2);
    assert.match(status(),/更新未完成/);
    h.message(body);
    if(initial) assert.match(status(),/更新未完成/);
    else assert.doesNotMatch(status(),/更新未完成/);
    assert.equal(h.button.getAttribute('aria-disabled'),initial ? 'true' : null);
    h.message({...body,at:'2026-09-21T02:05:00Z'});
    assert.doesNotMatch(status(),/更新未完成/);
    assert.equal(h.button.getAttribute('aria-disabled'),null);
    h.handle.unmount();
  }
});

test('unmount cancels refresh timer and late messages cannot restart UI', t => {
  const h=setup(t), clock=refreshClock(t,h);
  h.up(); h.button.click();
  assert.equal(clock.timers.size,1);
  h.handle.unmount();
  assert.equal(clock.timers.size,0);
  clock.tick(30000); h.up(); h.message(listing([]));
  assert.equal(h.button.disabled,true);
  assert.equal(h.container.childElementCount,0);
  h.button.dispatchEvent(new h.window.Event('click'));
  assert.equal(h.sent.length,1);
});

test('paused waiting explains next update and validates reason without retaining it', t => {
  const h = setup(t);
  for (const reason of ['waiting', 'budget', 'failed', {}, undefined]) {
    h.message({...listing([]), model:{state:'paused', reason}});
    const status = h.container.querySelector('[role="status"]');
    assert.match(status.textContent, reason === 'waiting' ? /整理暫停，等待下次更新/ : /整理暫停，下次更新繼續/);
  }
});

test('topic and original link disappearing falls back to the list without scrolling', t => {
  const h = setup(t), id = topicRecord().id;
  h.message(topicListing([article({topic:id, link:'https://e.com/gone'})]));
  focusTopicButtons(h)[0].focus();
  focusTopicButtons(h)[0].click();
  h.container.querySelector('.nw-list a').focus();
  const list = h.container.querySelector('.nw-list');
  const calls = [], original = list.focus;
  t.mock.method(list, 'focus', function(options) { calls.push(options); return original.call(this, options); });
  h.message(listing([article({link:'https://e.com/replacement'})]));
  assert.equal(list.getAttribute('tabindex'), '-1');
  assert.equal(h.window.document.activeElement, list);
  assert.deepEqual(calls, [{preventScroll:true}]);
});

test('ordinary replacement falls back to the list for a removed focused report, including empty lists', t => {
  const h = setup(t);
  for (const replacement of [[], [article({link:'https://e.com/new'})]]) {
    h.message(listing([article({link:'https://e.com/old'})]));
    h.container.querySelector('.nw-list a').focus();
    h.message(listing(replacement));
    assert.equal(h.window.document.activeElement, h.container.querySelector('.nw-list'));
  }
  h.select.focus();
  h.message(listing([]));
  assert.equal(h.window.document.activeElement, h.select); // A surviving control is not displaced.
});

for (const outside of ['input', 'body']) {
  test(`replacement and automatic return do not steal ${outside} focus for the fallback`, t => {
    const h = setup(t), id = topicRecord().id;
    const target = outside === 'body' ? h.window.document.body : h.window.document.createElement('input');
    if (outside === 'input') h.window.document.body.append(target);
    else target.tabIndex = -1;
    h.container.style.overflowY = 'auto';
    Object.defineProperties(h.container, {scrollHeight:{value:2000},clientHeight:{value:200}});
    h.message(topicListing([article({topic:id,link:'https://e.com/gone'})]));
    h.container.scrollTop = 1200;
    focusTopicButtons(h)[0].focus(); focusTopicButtons(h)[0].click();
    h.container.scrollTop = 300;
    target.focus();
    h.message(listing([]));
    assert.equal(h.window.document.activeElement, target);
    // §18.25 R25-4: body focus (typical for mouse readers) still gets the saved scroll back;
    // focus inside another control does not.
    assert.equal(h.container.scrollTop, outside === 'body' ? 1200 : 300);
    h.message(listing([article()]));
    assert.equal(h.window.document.activeElement, target);
  });
}

test('topic latest selects newest member across filters and renders before tone with safe ellipsis', t => {
  const h = setup(t), topic = topicRecord({count:5, tone:toneCounts({neutral:5})});
  const title = '<img src=x onerror=alert(1)>' + '最新進展'.repeat(100);
  const seed = article({title:topic.title, topic:topic.id, category:'finance', published:'2026-09-24T08:00:00Z'});
  const newest = article({title, topic:topic.id, source:'乙', category:'world', published:'2026-09-24T12:00:00Z'});
  const middle = article({title:'較舊', topic:topic.id, published:'2026-09-24T10:00:00Z'});
  const outside = article({title:'不屬於話題', published:'2026-09-25T12:00:00Z'});
  h.message(topicListing([newest, seed, middle, {...middle,link:'https://example.com/4'}, {...middle,link:'https://example.com/5'}].map(item=>({...item,tone:'neutral'})).concat(outside), [topic]));
  choose(h, h.categories, 'finance');
  choose(h, h.select, '甲');
  const row = h.container.querySelector('.nw-topic-latest');
  assert.equal(row.textContent, `最新：${title}`);
  assert.equal(row.title, title);
  assert.equal(row.previousElementSibling.className, 'nw-title');
  assert.equal(row.nextElementSibling.className, 'nw-tone');
  assert.equal(row.querySelector('img'), null);
  const style = h.window.getComputedStyle(row);
  assert.equal(style.whiteSpace, 'nowrap');
  assert.equal(style.overflow, 'hidden');
  assert.equal(style.textOverflow, 'ellipsis');
  assert.equal(h.window.getComputedStyle(row.parentElement).minWidth, '0');
  h.message(topicListing([seed, middle], [topic])); // Same at: latest headline is replaced.
  assert.equal(h.container.querySelector('.nw-topic-latest').textContent, '最新：較舊');
});

test('topic latest is absent for seed title, no dated member or invalid title', t => {
  const h = setup(t), topic = topicRecord();
  const seed = article({topic:topic.id, title:topic.title, published:'2026-09-24T12:00:00Z'});
  for (const items of [[], [seed], [seed, {...seed, title:'較舊', published:'2026-09-24T08:00:00Z'}],
    [article({topic:topic.id, published:'bad'})], [article({topic:topic.id, published:{}})],
    [{...seed, title:{}}], [{...seed, title:''}]]) {
    h.message(topicListing(items, [topic]));
    assert.equal(h.container.querySelector('.nw-topic-latest'), null);
  }
});

test('topic latest has no duplicate new marker regardless of saved baseline', t => {
  const baseline = '2026-09-24T10:00:00Z';
  for (const saved of [false, true]) {
    const h = saved ? setup(t, withSeen(baseline)) : setup(t);
    const topic = topicRecord();
    for (const published of ['2026-09-24T09:00:00Z', baseline, '2026-09-24T10:00:01Z']) {
      h.message(topicListing([article({topic:topic.id, title:'新進展', published})]));
      const row = h.container.querySelector('.nw-topic-latest');
      assert.equal(row.querySelector('.nw-new'), null);
      assert.equal(row.title, '新進展');
    }
  }
});

test('topic latest line is hidden when the newest report belongs to the seed event', t => {
  const h = setup(t), id = topicRecord().id, ev = 'abcabcabcabc';
  h.message(topicListing([
    article({topic:id, title:topicRecord().title, event:ev, event_size:2, published:'2026-09-24T08:00:00Z', link:'https://e.com/a'}),
    article({topic:id, title:'同一事件另一家的寫法', event:ev, event_size:2, published:'2026-09-24T09:00:00Z', link:'https://e.com/b'}),
  ], [topicRecord()]));
  assert.equal(h.container.querySelector('.nw-topic-latest'), null);
});

const browseKey = (h, target, key, options = {}) => {
  const event = new h.window.KeyboardEvent('keydown', {key, bubbles:true, cancelable:true, ...options});
  target.dispatchEvent(event);
  return event;
};

test('browse j/k navigate main titles, skip divider and children, and stop at boundaries', t => {
  const h = setup(t, withSeen(seenAt));
  const items = [eventStory('111111111111','new',11), eventStory('111111111111','child',10),
    eventStory('222222222222','old',7)];
  h.message(listing(items));
  const list = h.container.querySelector('.nw-list');
  assert.equal(list.getAttribute('aria-keyshortcuts'), 'j k s e');
  assert.ok(list.querySelector('.nw-divider'));
  const titles = [...list.querySelectorAll('a.nw-title')];
  const scrolled = [];
  t.mock.method(h.window.HTMLElement.prototype, 'scrollIntoView', function(options) { scrolled.push({node:this,options}); });
  list.focus();
  assert.equal(browseKey(h, list, 'j').defaultPrevented, true);
  assert.equal(h.window.document.activeElement, titles[0]);
  assert.equal(browseKey(h, titles[0], 'k').defaultPrevented, false);
  assert.equal(h.window.document.activeElement, titles[0]);
  assert.equal(browseKey(h, titles[0], 'j').defaultPrevented, true);
  assert.equal(h.window.document.activeElement, titles[1]);
  assert.equal(browseKey(h, titles[1], 'j').defaultPrevented, false);
  assert.equal(h.window.document.activeElement, titles[1]);
  browseKey(h, titles[1], 'k');
  assert.equal(h.window.document.activeElement, titles[0]);
  list.querySelector('.nw-expand').click();
  const child = list.querySelector('.nw-report-title'); child.focus();
  browseKey(h, child, 'j');
  assert.equal(h.window.document.activeElement, titles[1]);
  assert.deepEqual(scrolled.map(call => call.node), [titles[0], titles[1], titles[0], titles[1]]);
  assert.ok(scrolled.every(call => call.options.block === 'nearest'));
});

test('browse s/e toggle current row controls and leave missing actions untouched', t => {
  const h = setup(t);
  h.message(listing([eventStory('111111111111','first',8,{summary:'摘要'}),
    eventStory('111111111111','child',9), eventStory('222222222222','plain',10,{summary:''})]));
  const rows = mainRows(h), title = rows[0].querySelector('a.nw-title'); title.focus();
  for (const key of ['s','e']) {
    const button = rows[0].querySelector(key === 's' ? '.nw-summary-toggle' : '.nw-expand');
    const content = rows[0].querySelector(key === 's' ? '.nw-summary' : '.nw-reports');
    for (const expanded of [true,false]) {
      assert.equal(browseKey(h,title,key).defaultPrevented,true);
      assert.equal(button.getAttribute('aria-expanded'),String(expanded));
      assert.equal(content.hidden,!expanded);
      assert.equal(h.window.document.activeElement,title);
    }
  }
  const plain = rows[1].querySelector('a.nw-title');
  for (const key of ['s','e','x']) assert.equal(browseKey(h,plain,key).defaultPrevented,false);
  assert.equal(browseKey(h,h.container.querySelector('.nw-list'),'s').defaultPrevented,false);
});

test('browse keys ignore editing, modifiers, composition and outside targets', t => {
  const h = setup(t);
  h.message(listing([article()]));
  const root = h.container.querySelector('.nw'), title = root.querySelector('a.nw-title');
  const outside = h.window.document.createElement('button'); h.window.document.body.append(outside);
  const editable = h.window.document.createElement('div'); editable.contentEditable='true';
  const nested = h.window.document.createElement('span'); editable.append(nested); root.append(editable);
  const textarea = h.window.document.createElement('textarea'); root.append(textarea);
  for (const target of [h.select, h.categories, root.querySelector('input'), textarea, nested, outside]) {
    for (const key of ['j','k','s','e']) assert.equal(browseKey(h,target,key).defaultPrevented,false);
  }
  title.focus();
  for (const modifier of ['ctrlKey','metaKey','altKey','shiftKey','isComposing']) {
    for (const key of ['j','k','s','e']) assert.equal(browseKey(h,title,key,{[modifier]:true}).defaultPrevented,false);
  }
  assert.equal(h.window.document.activeElement,title);
  assert.equal(root.querySelector('.nw-summary-toggle').getAttribute('aria-expanded'),'false');
});

test('browse skips non-link titles, tolerates empty lists and removes root listener on unmount', t => {
  const h = setup(t);
  h.message(listing([article({link:'javascript:alert(1)'}), article({link:'https://e.com/valid'})]));
  const list = h.container.querySelector('.nw-list'); list.focus();
  browseKey(h,list,'j');
  assert.equal(h.window.document.activeElement.href,'https://e.com/valid');
  h.message(listing([]));
  assert.equal(browseKey(h,list,'j').defaultPrevented,false);
  h.message(listing([article()]));
  const root = h.container.querySelector('.nw'), title = root.querySelector('a.nw-title');
  h.handle.unmount();
  for (const key of ['j','k','s','e']) assert.equal(browseKey(h,title,key).defaultPrevented,false);
  assert.equal(root.querySelector('.nw-summary-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(h.container.children.length,0);
});

test('collapsing reports moves their focus to the expand button and stays collapsed on resend', t => {
  for (const keyboard of [true, false]) {
    const h=setup(t), body=listing([
      article({event:'aaaaaaaaaaaa',event_size:2}),
      article({event:'aaaaaaaaaaaa',event_size:2,title:'另一篇',link:'https://example.com/second'}),
    ]);
    h.message(body);
    const toggle=h.container.querySelector('.nw-expand');
    toggle.click();
    const sub=h.container.querySelector('.nw-reports a');
    sub.focus();
    if(keyboard) assert.equal(browseKey(h,sub,'e').defaultPrevented,true);
    else toggle.click();
    assert.equal(h.window.document.activeElement,toggle);
    assert.equal(toggle.getAttribute('aria-expanded'),'false');
    assert.equal(h.container.querySelector('.nw-reports').hidden,true);
    h.message(body);
    assert.equal(h.container.querySelector('.nw-reports').hidden,true);
    assert.equal(h.window.document.activeElement,h.container.querySelector('.nw-expand'));
  }
});

test('redraw focus fallback covers hidden ancestors and disabled controls', t => {
  const h=setup(t), body=listing([article()]);
  h.message(body);
  choose(h,h.select,'乙');
  const clear=h.container.querySelector('.nw-empty button');
  clear.focus(); clear.click();
  assert.equal(h.container.querySelector('.nw-empty').hidden,true);
  assert.equal(h.window.document.activeElement,h.container.querySelector('.nw-list'));
  h.categories.focus(); h.categories.disabled=true;
  h.message(body);
  assert.equal(h.window.document.activeElement,h.container.querySelector('.nw-list'));
});

test('identical resends never mutate option text but changed counts and failures update it', async t => {
  const h=setup(t), body=listing([article({category:'tech'})],[{name:'甲',ok:true,count:1}]);
  h.message(body); choose(h,h.categories,'tech'); h.categories.focus();
  const options=[...h.select.options,...h.categories.options];
  const mutations=[];
  const observer=new h.window.MutationObserver(records=>mutations.push(...records));
  for(const select of [h.select,h.categories]) observer.observe(select,{subtree:true,childList:true,characterData:true});
  t.after(()=>observer.disconnect());
  h.message(body);
  await new Promise(resolve=>h.window.setTimeout(resolve,0));
  assert.equal(mutations.length,0);
  assert.deepEqual([...h.select.options,...h.categories.options],options);
  assert.equal(h.categories.value,'tech');
  assert.equal(h.window.document.activeElement,h.categories);
  h.message({...body,items:[],sources:[{name:'甲',ok:false,count:0}]});
  await new Promise(resolve=>h.window.setTimeout(resolve,0));
  assert.ok(mutations.length>0);
  assert.equal(h.select.options[0].textContent,'全部來源 0');
  assert.equal(h.select.options[1].textContent,'甲 0（失敗）');
  assert.equal([...h.categories.options].find(o=>o.value==='tech').textContent,'科技 0');
});

test('date-only detection is per source, needs three reports and recomputes on each list', t => {
  t.mock.timers.enable({apis:['Date'], now:new Date(2026,8,25,12)});
  const h=setup(t);
  const makeReports=(source,total,midnights)=>Array.from({length:total},(_,i)=>article({
    source, title:`${source}${i}`, link:`https://example.com/${source}/${i}`,
    category:i===0 ? 'tech' : 'world',
    published:localStamp(25,i<midnights ? 0 : 10),
  }));
  const reporters=makeReports('報導者',3,3), liberty=makeReports('自由時報',40,1), small=makeReports('少量',2,2);
  const body=listing([...reporters,...liberty,...small],['報導者','自由時報','少量'].map(name=>({name,ok:true})));
  h.message(body);
  const times=()=>mainRows(h).map(row=>row.querySelector('.nw-info > .nw-time').textContent);
  assert.deepEqual(times().slice(0,5),['今天','今天','今天','00:00','10:00']);
  assert.deepEqual(times().slice(-2),['00:00','00:00']);
  choose(h,h.categories,'tech');
  assert.deepEqual(times(),['今天','00:00','00:00']); // Filtering must not change source evidence.
  choose(h,h.select,'自由時報');
  assert.deepEqual(times(),['00:00']);
  choose(h,h.select,'報導者');
  h.message({...body,items:makeReports('報導者',5,4)}); // Exactly 80%.
  assert.deepEqual(times(),['今天']);
  h.message({...body,items:makeReports('報導者',4,3)}); // Same-at resend drops below 80%.
  assert.deepEqual(times(),['00:00']);
  h.message({...body,items:reporters.slice(0,2)});
  assert.deepEqual(times(),['00:00']);
  h.message(body);
  assert.deepEqual(times(),['今天']);
});

test('date-only event endpoints use each reports source evidence including child reports', t => {
  t.mock.timers.enable({apis:['Date'], now:new Date(2026,8,25,12)});
  const h=setup(t), event='111111111111';
  const dated=[24,25,23].map((day,i)=>article({source:'日期來源',title:`日期${i}`,
    published:localStamp(day,0),link:`https://example.com/date/${i}`,
    ...(i<2 ? {event,event_size:2} : {})}));
  h.message(listing(dated));
  assert.equal(mainRows(h)[0].querySelector('.nw-time').textContent,'9/24–今天');
  h.container.querySelector('.nw-expand').click();
  assert.equal(h.container.querySelector('.nw-report .nw-time').textContent,'今天');
  h.message(listing(dated.slice(0,2)));
  assert.equal(mainRows(h)[0].querySelector('.nw-time').textContent,'9/24 00:00–00:00');
  assert.equal(h.container.querySelector('.nw-report .nw-time').textContent,'00:00');
});

test('history disclosure defaults closed, shares saved state across categories and survives resends', t => {
  const h=setup(t), body=listing([financeArticle(),worldArticle()]);
  h.message(body); choose(h,h.categories,'finance');
  const button=h.container.querySelector('.nw-history button');
  const content=h.container.querySelector('.nw-history-content');
  assert.equal(button.textContent,'近 24 小時變化');
  assert.equal(button.getAttribute('aria-expanded'),'false');
  assert.equal(content.hidden,true); assert.equal(content.childElementCount,0);
  assert.equal(panel(h).querySelector('.nw-pending').hidden,true);
  button.focus(); button.click();
  assert.equal(h.window.document.activeElement,button);
  assert.equal(button.getAttribute('aria-expanded'),'true');
  assert.equal(content.hidden,false);
  assert.match(content.textContent,/樣本不足/);
  assert.equal(h.window.localStorage.getItem('modudock.module.news.history'),'true');
  choose(h,h.categories,'world'); h.message(body);
  assert.equal(button.getAttribute('aria-expanded'),'true');
  const other=setup(t,w=>w.localStorage.setItem('modudock.module.news.history','true'));
  other.message(body); choose(other,other.categories,'tech');
  assert.equal(other.container.querySelector('.nw-history button').getAttribute('aria-expanded'),'true');
  button.click();
  assert.equal(content.childElementCount,0);
  assert.equal(h.window.localStorage.getItem('modudock.module.news.history'),'false');
  h.message(listing([financeArticle({analysis:null})])); choose(h,h.categories,'finance');
  assert.equal(panel(h).querySelector('.nw-pending').hidden,false);
  h.handle.unmount(); button.click();
  assert.equal(h.window.localStorage.getItem('modudock.module.news.history'),'false');
});

test('history storage malformed values and read write exceptions never prevent disclosure', t => {
  for(const raw of ['"true"','1','{}','broken',null]) {
    const h=setup(t,w=>{if(raw!==null) w.localStorage.setItem('modudock.module.news.history',raw);});
    h.message(listing([financeArticle()])); choose(h,h.categories,'finance');
    assert.equal(h.container.querySelector('.nw-history button').getAttribute('aria-expanded'),'false');
  }
  const h=setup(t,w=>{
    t.mock.method(w.localStorage,'getItem',()=>{throw new Error('denied');});
    t.mock.method(w.localStorage,'setItem',()=>{throw new Error('full');});
  });
  h.message(listing([financeArticle()])); choose(h,h.categories,'finance');
  const button=h.container.querySelector('.nw-history button');
  assert.doesNotThrow(()=>button.click());
  assert.equal(button.getAttribute('aria-expanded'),'true');
  assert.doesNotThrow(()=>button.click());
  assert.equal(button.getAttribute('aria-expanded'),'false');
});

test('watch-only hides focus and every analysis panel, restores them and safely shows keywords', t => {
  const h=setup(t), topic=topicRecord();
  const body=topicListing([financeArticle({title:'AI',topic:topic.id}),worldArticle({title:'AI',topic:topic.id}),
    article({title:'AI',category:'politics',topic:topic.id,analysis:{kind:'politics',issue:'defense'}})]);
  saveWatch(h,'AI,<img>'); h.message(body);
  for(const category of ['finance','world','politics']) {
    choose(h,h.categories,category);
    assert.equal(h.container.querySelector('.nw-panel').hidden,false); assert.equal(focusArea(h).hidden,false);
    watchControls(h).only.click();
    h.message(body);
    assert.equal(h.container.querySelector('.nw-panel').hidden,true); assert.equal(focusArea(h).hidden,true);
    const hint=h.container.querySelector('.nw-watch-hint');
    assert.equal(hint.hidden,false); assert.equal(hint.textContent,'只看追蹤：AI、<img>');
    assert.equal(hint.nextElementSibling.className,'nw-hint nw-new-hint');
    assert.equal(hint.nextElementSibling.nextElementSibling.className,'nw-shortcut-help');
    assert.equal(hint.nextElementSibling.nextElementSibling.nextElementSibling.className,'nw-list');
    assert.equal(hint.querySelector('img'),null);
    assert.equal(mainRows(h).length,1);
    watchControls(h).only.click();
    assert.equal(h.container.querySelector('.nw-panel').hidden,false); assert.equal(focusArea(h).hidden,false);
    assert.equal(hint.hidden,true);
  }
});

test('disabled classification explains fixed reasons and clears stale titles on later lists', t => {
  const h=setup(t), status=h.container.querySelector('[role=status]');
  const cases=[
    ['no_key','分類未啟用：未設定 API 金鑰','設定 TYPESAFE_API_KEY 後重新載入模組'],
    ['auth','分類已停用：API 金鑰無效','請確認金鑰後重新載入模組'],
    [undefined,'分類：關閉',''], ['unknown','分類：關閉',''],
    [{secret:'do not show'},'分類：關閉',''], ['__proto__','分類：關閉',''],
  ];
  for(const [reason,label,title] of cases) {
    h.message({...listing([],[{name:'甲',ok:true}]),classify:{enabled:false},model:{state:'off',reason}});
    assert.match(status.textContent,new RegExp(label));
    assert.equal(status.title,title);
  }
  h.message({...listing([],[{name:'甲',ok:false,error:'timeout'}]),classify:{enabled:false},model:{state:'off',reason:'auth'}});
  assert.equal(status.title,'甲：timeout\n請確認金鑰後重新載入模組');
  h.message({...listing([],[{name:'甲',ok:true}]),classify:{enabled:true},model:{state:'done',reason:''}});
  assert.doesNotMatch(status.textContent,/金鑰|分類：關閉/); assert.equal(status.title,'');
});

const viewKey='modudock.module.news.view';
test('manual source/category choices persist and restore once after first list on remount', t => {
  const h=setup(t), body=listing([financeArticle(),worldArticle({source:'乙'})]);
  h.message(body);
  choose(h,h.select,'乙'); choose(h,h.categories,'world');
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem(viewKey)),{source:'乙',category:'world'});
  const next=setup(t,w=>w.localStorage.setItem(viewKey,h.window.localStorage.getItem(viewKey)));
  assert.equal(next.select.value,''); assert.equal(next.categories.value,'');
  next.message(body);
  assert.equal(next.select.value,'乙'); assert.equal(next.categories.value,'world');
  assert.equal(mainRows(next).length,1);
  next.message({...body,sources:[{name:'甲',ok:true}]});
  assert.equal(next.select.value,'');
  next.message(body); assert.equal(next.select.value,''); // Never reapply on resends.
  choose(next,next.categories,'');
  assert.deepEqual(JSON.parse(next.window.localStorage.getItem(viewKey)),{source:'乙',category:''}); // Missing live source does not overwrite its saved preference.
});

test('stored view validates fields independently and does not revive missing options', t => {
  for(const [stored,source,category] of [
    [{source:'missing',category:'finance'},'','finance'],
    [{source:'甲',category:'missing'},'甲',''],
    [{source:{},category:['finance']},'',''],
    [['甲','finance'],'',''], ['finance','',''], [null,'',''],
  ]) {
    const h=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify(stored)));
    h.message(listing([financeArticle()]));
    assert.equal(h.select.value,source); assert.equal(h.categories.value,category);
  }
  const h=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify({source:'乙',category:'finance'})));
  h.message(listing([] ,[])); h.message(listing([financeArticle({source:'乙'})]));
  assert.equal(h.select.value,''); assert.equal(h.categories.value,'finance');
  const early=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify({source:'乙',category:'finance'})));
  choose(early,early.categories,'world'); early.message(listing([worldArticle()]));
  assert.equal(early.categories.value,'world'); assert.equal(early.select.value,'乙');
});

test('topic returns persist restored view; entry theme and clear filters do not save view', t => {
  const h=setup(t), topic=topicRecord(), body=topicListing([financeArticle({topic:topic.id})]);
  h.message(body); choose(h,h.categories,'finance'); choose(h,h.select,'甲');
  const saved=h.window.localStorage.getItem(viewKey);
  const writes=[];
  const original=h.window.localStorage.setItem.bind(h.window.localStorage);
  t.mock.method(h.window.localStorage,'setItem',(key,value)=>{if(key===viewKey) writes.push(value); original(key,value);});
  themeButton(h,'memory').click();
  focusTopicButtons(h)[0].click();
  assert.equal(h.categories.value,'');
  h.container.querySelector('.nw-filter button').click();
  assert.equal(h.categories.value,'finance');
  focusTopicButtons(h)[0].click(); h.message({...body,topics:{list:[]}});
  assert.equal(h.categories.value,'finance');
  saveWatch(h,'nothing'); watchControls(h).only.click();
  h.container.querySelector('.nw-empty button').click();
  assert.equal(h.select.value,''); assert.equal(h.categories.value,'');
  assert.deepEqual(writes,[saved,saved]); assert.equal(h.window.localStorage.getItem(viewKey),saved);
});

test('view storage failures are silent and manual selection still works', t => {
  for(const failure of ['invalid','read','write']) {
    const h=setup(t,w=>{
      w.localStorage.setItem(viewKey,'invalid-json');
      if(failure==='read') t.mock.method(w.localStorage,'getItem',()=>{throw new Error('denied');});
      if(failure==='write') t.mock.method(w.localStorage,'setItem',()=>{throw new Error('full');});
    });
    assert.doesNotThrow(()=>h.message(listing([financeArticle()])));
    assert.equal(h.categories.value,'');
    assert.doesNotThrow(()=>choose(h,h.categories,'finance'));
    assert.equal(h.categories.value,'finance'); assert.equal(mainRows(h).length,1);
  }
});

test('remembered category waits for classified items while source restores immediately', t => {
  const h=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify({source:'乙',category:'finance'})));
  const raw=listing([article({source:'乙',category:''})]);
  h.message({...raw,model:{state:'working'},classify:{enabled:true}});
  assert.equal(h.select.value,'乙'); assert.equal(h.categories.value,'');
  assert.equal(mainRows(h).length,1);
  choose(h,h.select,'甲'); // Source edits do not cancel pending category restoration.
  h.message({...raw,items:[financeArticle()]});
  assert.equal(h.select.value,'甲'); assert.equal(h.categories.value,'finance');
  h.message({...raw,model:{state:'working'}});
  assert.equal(h.container.querySelector('.nw-empty').hidden,false);
  assert.equal(h.container.querySelector('.nw-empty span').textContent,'分類中，稍後出現');
  h.message({...raw,model:{state:'done'}});
  assert.equal(h.container.querySelector('.nw-empty span').textContent,'這個條件下沒有新聞');
});

test('disabled classification and manual category edits cancel remembered category restoration', t => {
  for(const action of ['off','manual']) {
    const h=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify({source:'',category:'finance'})));
    const body={...listing([article({category:''})]),model:{state:'working'},classify:{enabled:true}};
    h.message(action==='off' ? {...body,classify:{enabled:false},model:{state:'off',reason:'no_key'}} : body);
    assert.equal(h.categories.value,''); assert.equal(mainRows(h).length,1);
    if(action==='manual') choose(h,h.categories,'tech');
    h.message({...body,items:[financeArticle()]});
    assert.equal(h.categories.value,action==='off' ? '' : 'tech');
  }
});

test('manual view changes merge only that field with stored preferences during topic view', t => {
  for(const field of ['source','category']) {
    const h=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify({source:'乙',category:'finance'})));
    const topic=topicRecord();
    h.message(topicListing([financeArticle({source:'乙',topic:topic.id})]));
    focusTopicButtons(h)[0].click();
    assert.equal(h.select.value,''); assert.equal(h.categories.value,'');
    if(field==='category') choose(h,h.categories,'tech');
    else choose(h,h.select,'甲');
    assert.deepEqual(JSON.parse(h.window.localStorage.getItem(viewKey)),field==='category'
      ? {source:'乙',category:'finance'} : {source:'甲',category:'finance'});
  }
});

test('event root changes transfer expansion summary and either action focus by shared report', t => {
  for(const action of ['.nw-expand','.nw-summary-toggle']) {
    const h=setup(t), old='bbbbbbbbbbbb', next='aaaaaaaaaaaa';
    const reports=[article({event:old,event_size:2,link:'https://e/1',published:localStamp(25,9)}),
      article({event:old,event_size:2,link:'https://e/2',published:localStamp(25,10)})];
    h.message(listing(reports));
    h.container.querySelector('.nw-expand').click(); h.container.querySelector('.nw-summary-toggle').click();
    h.container.querySelector(action).focus();
    h.message(listing([...reports.map(i=>({...i,event:next,event_size:3})),
      article({event:next,event_size:3,link:'https://e/earlier',published:localStamp(25,8)})]));
    const row=mainRows(h)[0];
    assert.equal(row.dataset.event,next);
    assert.equal(row.querySelector('.nw-expand').getAttribute('aria-expanded'),'true');
    assert.equal(row.querySelector('.nw-summary-toggle').getAttribute('aria-expanded'),'true');
    assert.equal(row.querySelector('.nw-reports').hidden,false);
    assert.equal(row.querySelector('.nw-summary').hidden,false);
    assert.ok(h.window.document.activeElement === row.querySelector(action), `focus must follow ${action}, got ${h.window.document.activeElement.className}`);
    // Reusing an old ID without a shared report must not resurrect old state.
    h.message(listing([article({event:old,event_size:2,link:'https://e/unrelated'}),
      article({event:old,event_size:2,link:'https://e/unrelated2'})]));
    assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'),'false');
    assert.equal(h.container.querySelector('.nw-summary-toggle').getAttribute('aria-expanded'),'false');
  }
});

test('deferred category stays out of topic and survives manual or automatic return', t => {
  for(const exit of ['return','disappear','before-classification']) {
    const h=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify({source:'',category:'finance'})));
    const topic=topicRecord(), raw=topicListing([article({topic:topic.id,category:''})]);
    h.message(raw); focusTopicButtons(h)[0].click();
    if(exit==='before-classification') h.container.querySelector('.nw-filter button').click();
    const body={...raw,items:[worldArticle({topic:topic.id})],
      ...(exit==='disappear' ? {topics:{list:[]}} : {})};
    h.message(body);
    if(exit==='return') {
      assert.equal(h.categories.value,''); assert.equal(mainRows(h).length,1);
      assert.equal(h.container.querySelector('.nw-filter').hidden,false);
      h.container.querySelector('.nw-filter button').click();
    }
    assert.equal(h.categories.value,'finance');
    h.message(body); assert.equal(h.categories.value,'finance');
  }
});

test('clear all cancels deferred view for this mount without overwriting storage', t => {
  const saved=JSON.stringify({source:'乙',category:'finance'});
  const h=setup(t,w=>w.localStorage.setItem(viewKey,saved));
  h.message(listing([article({category:''})]));
  assert.equal(mainRows(h).length,0);
  h.container.querySelector('.nw-empty button').click();
  h.message(listing([financeArticle()]));
  assert.equal(h.select.value,''); assert.equal(h.categories.value,'');
  assert.equal(mainRows(h).length,1);
  assert.equal(h.window.localStorage.getItem(viewKey),saved);
});

// Include the walk suite in npm test without changing the package script.
import './front.walk.test.mjs';

test('resends clear empty theme region and issue selections within panel scope even when hidden', t => {
  const cases=[
    ['finance','memory', financeArticle(), financeArticle({analysis:analysis({theme:'energy'})})],
    ['world','region:other',worldArticle({analysis:worldAnalysis({region:'other'})}),worldArticle({analysis:worldAnalysis({region:'us_china'})})],
    ['politics','issue:other',article({category:'politics',analysis:{kind:'politics',issue:'other'}}),article({category:'politics',analysis:{kind:'politics',issue:'defense'}})],
  ];
  for(const [category,id,original,replacement] of cases) for(const watched of [false,true]) {
    const h=setup(t);
    const outside={...original,source:'乙',link:'https://e/outside'};
    const body=listing([original,outside]);
    h.message(body); choose(h,h.categories,category); choose(h,h.select,'甲');
    h.container.querySelector(`[data-topic="${id}"]`).click();
    assert.equal(h.container.querySelector('.nw-filter').hidden,false);
    if(watched) {saveWatch(h,'新聞'); watchControls(h).only.click();}
    h.message(body); // A still-present event must keep the selection.
    assert.equal(h.container.querySelector('.nw-filter').hidden,false);
    h.message({...body,items:[replacement,outside]});
    assert.equal(h.container.querySelector('.nw-filter').hidden,true);
    assert.equal(mainRows(h).length,1);
    assert.equal(h.select.value,'甲'); assert.equal(h.categories.value,category);
    if(watched) watchControls(h).only.click();
    assert.equal(h.container.querySelectorAll('.nw-theme[aria-pressed=true]').length,0);
    h.message(body); // Reappearance does not reselect a cancelled filter.
    assert.equal(h.container.querySelector('.nw-filter').hidden,true);
  }
});

test('other filter labels distinguish regions and issues without changing ranking names', t => {
  const h=setup(t);
  for(const [category,id,analysisValue,label] of [
    ['world','region:other',worldAnalysis({region:'other'}),'其他地區'],
    ['politics','issue:other',{kind:'politics',issue:'other'},'其他議題'],
  ]) {
    h.message(listing([article({category,analysis:analysisValue})]));
    choose(h,h.categories,category);
    const button=h.container.querySelector(`[data-topic="${id}"]`);
    assert.equal(button.querySelector('.nw-theme-name').textContent,'其他');
    button.click();
    assert.equal(h.container.querySelector('.nw-filter > span').textContent,`已篩選：${label}`);
    button.click(); assert.equal(h.container.querySelector('.nw-filter').hidden,true);
  }
});

// §20.1: counts and their drill-downs share event-level analysis selection.
const countButton = (h, id) => h.container.querySelector(`button[data-count="${id}"]`);
const countFixture = category => {
  const report = (id, source, hour, market, theme = 'memory', dir = 'bull', dir_p = .8) => {
    const value = market === null ? null : category === 'world'
      ? {kind:'world', trend:{positive:'escalation',mixed:'stalemate',negative:'deescalation',not_market:'not_conflict',other:'other'}[market], region:'asia_pacific'}
      : analysis({market,theme,dir,dir_p});
    return eventStory(String(id).repeat(12), `report-${id}-${source}-${hour}`, hour,
      {category, source, analysis:value, link:`https://example.com/${id}/${source}/${hour}`});
  };
  return [report(1,'甲',8,null),report(1,'乙',9,'positive'),report(1,'甲',10,'negative'),
    report(2,'甲',9,'mixed','energy'),report(3,'甲',9,'not_market','macro','neutral'),
    report(4,'乙',9,'other'),report(5,'甲',9,'negative','macro','bear',.6),
    report(6,'乙',9,'positive','macro','bull',.59),report(7,'乙',9,null),
    report(8,'甲',9,'positive','macro','bull',.6)];
};
for (const category of ['finance','tech','world']) for (const source of ['', '甲', '乙']) {
  test(`panel count drill-down matches all event contributions: ${category}/${source || 'all'}`, t => {
    const h=setup(t), body=listing(countFixture(category)); h.message(body);
    choose(h,h.categories,category); choose(h,h.select,source);
    const expected = source === '甲' ? [[8],[2],[3],[1,5]]
      : source === '乙' ? [[1,6],[],[4],[]] : [[1,6,8],[2],[3,4],[5]];
    if(category==='world') [expected[2],expected[3]]=[expected[3],expected[2]];
    const cases = expected.map((ids,i)=>[`signal:${i}`,ids]);
    if(category!=='world') cases.push(['macro:all',source==='甲'?[3,5,8]:source==='乙'?[6]:[3,5,6,8]],
      ['macro:bull',source==='乙'?[]:[8]],['macro:bear',source==='乙'?[]:[5]]);
    const sample=h.container.querySelector('.nw-sample-count').textContent;
    for(const [id,ids] of cases) {
      const button=countButton(h,id);
      const displayed=Number(button.textContent.match(/\d+/)[0]);
      assert.equal(displayed,ids.length);
      assert.equal(button.tagName,'BUTTON'); assert.equal(button.type,'button');
      assert.equal(button.getAttribute('aria-label'),null); // Visible label includes count.
      button.focus(); button.click(); // Native button also supports Enter/Space in browsers.
      assert.deepEqual(mainRows(h).map(row=>row.dataset.event).sort(),ids.map(n=>String(n).repeat(12)).sort());
      assert.equal(mainRows(h).length,displayed);
      assert.equal(countButton(h,id).getAttribute('aria-pressed'),'true');
      assert.equal(h.window.document.activeElement,countButton(h,id));
      assert.equal(h.container.querySelector('.nw-sample-count').textContent,sample);
      assert.equal(h.container.querySelector('.nw-filter').hidden,false);
      // Same-at updates retain selection and keyboard focus.
      h.message(body);
      assert.equal(mainRows(h).length,displayed);
      assert.equal(countButton(h,id).getAttribute('aria-pressed'),'true');
      assert.equal(h.window.document.activeElement,countButton(h,id));
      countButton(h,id).click();
      assert.equal(h.container.querySelector('.nw-filter').hidden,true);
      assert.equal(countButton(h,id).getAttribute('aria-pressed'),'false');
    }
  });
}

test('count selection replaces theme, preserves whole contributing events, and theme replaces count', t => {
  const h=setup(t); h.message(listing(countFixture('finance'))); choose(h,h.categories,'finance');
  themeButton(h,'memory').click();
  assert.equal(countButton(h,'signal:0').textContent.trim(),'3 偏多');
  countButton(h,'signal:0').click();
  assert.equal(themeButton(h,'memory').getAttribute('aria-pressed'),'false');
  assert.equal(mainRows(h).length,3);
  const mixedReports=mainRows(h).find(row=>row.dataset.event==='111111111111');
  assert.equal(mixedReports.querySelector('.nw-expand').textContent,'另 2 則報導');
  assert.match(mixedReports.querySelector('.nw-title').textContent,/report-1-甲-8/);
  themeButton(h,'energy').click();
  assert.equal(countButton(h,'signal:0').getAttribute('aria-pressed'),'false');
  assert.deepEqual(mainRows(h).map(row=>row.dataset.event),['222222222222']);
  countButton(h,'macro:bear').click();
  h.container.querySelector('.nw-filter button').click();
  assert.equal(mainRows(h).length,8);
  countButton(h,'signal:0').click(); choose(h,h.categories,'world');
  assert.equal(h.container.querySelector('.nw-filter').hidden,true);
});

for(const exit of ['clear','disappear','same-topic']) test(`count inside topic preserves scope and returns original view: ${exit}`, t => {
  const h=setup(t), topic=topicRecord();
  const items=countFixture('finance').map(item=>({...item,topic:topic.id}));
  const body=topicListing([...items,eventStory('999999999999','outside',12,{analysis:analysis()})]);
  h.message(body); choose(h,h.categories,'finance');
  countButton(h,'signal:0').focus(); countButton(h,'signal:0').click();
  assert.equal(mainRows(h).length,4);
  focusTopicButtons(h)[0].click();
  // R6: a real category change now keeps the topic scope and reveals its panel.
  choose(h,h.categories,'finance');
  assert.equal(countButton(h,'signal:0').textContent.trim(),'3 偏多');
  countButton(h,'signal:0').click();
  assert.equal(mainRows(h).length,3);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'),'false');
  assert.equal(h.container.querySelector('.nw-filter > span').textContent,'已篩選：話題內・偏多');
  h.message(body); assert.equal(mainRows(h).length,3);
  if(exit==='clear') h.container.querySelector('.nw-filter button').click();
  if(exit==='disappear') h.message({...body,topics:{list:[]}});
  if(exit==='same-topic') { focusTopicButtons(h)[0].click(); focusTopicButtons(h)[0].click(); }
  assert.equal(h.categories.value,'finance');
  assert.equal(countButton(h,'signal:0').getAttribute('aria-pressed'),'true');
  assert.equal(mainRows(h).length,4); // Restored original count filter.
});

test('count controls remove listener on unmount and stay safe for malicious input', t => {
  const h=setup(t); h.message(listing([financeArticle({analysis:{market:'<img>',theme:{}}})]));
  choose(h,h.categories,'finance'); const button=countButton(h,'signal:2');
  assert.equal(h.container.querySelector('img'),null);
  const root=h.container.querySelector('.nw'); h.handle.unmount(); button.click();
  assert.equal(root.querySelector('.nw-filter').hidden,true);
});

test('empty focus distinguishes no multi-source event, working, filtered topics and watch-only', t => {
  const h=setup(t); const hint='目前沒有多家媒體同時報導的新聞';
  for(const state of ['done','paused','off']) {
    h.message({...listing([financeArticle()]),model:{state}});
    assert.equal(focusArea(h).hidden,false);
    assert.equal(focusArea(h).querySelector('h3').textContent,'焦點');
    assert.equal(focusArea(h).querySelector('.nw-focus-list .nw-hint').textContent,hint);
  }
  h.message({...listing([]),model:{state:'working'}});
  assert.equal(focusArea(h).hidden,false); assert.doesNotMatch(focusArea(h).textContent,/目前沒有/);
  h.message(topicListing([article({category:'world',topic:topicRecord().id})]));
  choose(h,h.categories,'finance'); assert.equal(focusArea(h).hidden,true);
  const watched=setup(t,w=>w.localStorage.setItem('modudock.module.news.watch',JSON.stringify(['新聞'])));
  watched.message(listing([article()])); watched.container.querySelector('.nw-watch-only').click();
  assert.equal(focusArea(watched).hidden,true);
});

test('count controls allow native keyboard activation and update membership after replacement', t => {
  const h=setup(t), body=listing(countFixture('finance')); h.message(body); choose(h,h.categories,'finance');
  for(const key of ['Enter',' ']) {
    const button=countButton(h,'signal:0'); button.focus();
    const event=new h.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
    button.dispatchEvent(event);
    assert.equal(event.defaultPrevented,false); // Do not intercept native button keys.
    // happy-dom has no browser default key activation: deliver its resulting click.
    button.dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,detail:0}));
    assert.equal(mainRows(h).length,3);
    assert.equal(countButton(h,'signal:0').getAttribute('aria-pressed'),'true');
    button.dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,detail:0}));
    assert.equal(mainRows(h).length,8);
  }
  countButton(h,'signal:0').click();
  const next={...body,items:body.items.map(item=>item.event==='888888888888'
    ? {...item,analysis:analysis({market:'negative'})}:item)};
  h.message(next);
  assert.equal(countButton(h,'signal:0').textContent.trim(),'2 偏多');
  assert.equal(mainRows(h).length,2);
  choose(h,h.select,'乙');
  assert.equal(mainRows(h).length,2);
  assert.equal(countButton(h,'signal:0').getAttribute('aria-pressed'),'true');
  h.container.querySelector('.nw-empty button').click(); // Same clear-all handler, even when hidden.
  assert.equal(h.categories.value,'');
  choose(h,h.categories,'finance');
  assert.equal(countButton(h,'signal:0').getAttribute('aria-pressed'),'false');
});

test('source confirmation success failure failure and 304 display freshness independently of article age', t => {
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,8,26,12)});
  const h=setup(t), status=()=>h.container.querySelector('[role=status]');
  const first='2026-09-26T01:00:00Z', confirmed='2026-09-26T01:30:00Z';
  const hhmm=stamp=>{const d=new Date(stamp);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
  const old=article({published:'2000-01-01T00:00:00Z'});
  for(const [index,ok,last_success] of [[0,true,first],[1,false,first],[2,false,first],[3,true,confirmed],[4,false,confirmed]]) {
    h.message({...listing([old],[{name:'甲',count:1,ok,last_success,error:ok?null:'HTTP 503'},
      {name:'乙',count:0,ok:false,last_success:null,error:'no data'}]),at:`2026-09-26T01:${String(index*10).padStart(2,'0')}:00Z`});
    const option=[...h.select.options].find(o=>o.value==='甲');
    assert.equal(option.textContent,`甲 1${ok?'':`（${hhmm(last_success)} 資料）`}`);
    assert.equal(h.select.options[2].textContent,'乙 0（失敗）');
    if(ok) assert.match(status().textContent,/乙 失敗/);
    else assert.match(status().title,/乙/);
    if(ok) assert.doesNotMatch(status().textContent,/沿用舊資料/);
    else {
      assert.match(status().textContent,/更新失敗，沿用/);
      assert.match(status().title,/甲：沿用舊資料；最後成功確認：2026-09-26/);
      assert.ok(status().title.includes(hhmm(last_success)));
    }
    choose(h,h.select,'甲');
    const details=h.window.document.getElementById(h.select.getAttribute('aria-describedby'));
    assert.equal(details.textContent,option.title);
    assert.match(details.textContent,/最後成功確認：2026-09-26/);
    assert.ok(details.textContent.includes(hhmm(last_success)));
    assert.equal(mainRows(h).length,1);
    choose(h,h.select,'乙'); assert.match(details.textContent,/失敗/);
    choose(h,h.select,'');
  }
  h.message(listing([old],[{name:'甲',ok:true,count:1,last_success:confirmed}]));
  assert.doesNotMatch(status().textContent,/失敗|沿用舊資料/);
  assert.equal(status().title,'');
});

test('malformed confirmation times stay failures; stale source names remain text and descriptions are unique', t => {
  const h=setup(t), other=setup(t), evil='<img src=x onerror=alert(1)>';
  assert.notEqual(h.select.getAttribute('aria-describedby'),other.select.getAttribute('aria-describedby'));
  for(const value of [null,{},[],123,'bad-date','']) {
    h.message(listing([], [{name:'甲',ok:false,last_success:value}]));
    assert.match(h.container.querySelector('[role=status]').textContent,/所有來源連線失敗/);
    assert.equal(h.select.options[1].textContent,'甲 0（失敗）');
  }
  h.message(listing([], [{name:evil,ok:false,last_success:'2026-09-25T23:59:59Z'},
    {name:'乙',ok:false,last_success:'2026-09-25T23:58:00Z'}]));
  assert.match(h.container.querySelector('[role=status]').textContent,/更新失敗，沿用/);
  assert.equal(h.container.querySelector('img'),null);
  choose(h,h.select,evil);
  const description=h.window.document.getElementById(h.select.getAttribute('aria-describedby'));
  assert.ok(description.textContent.includes(evil));
  h.handle.unmount(); assert.equal(description.isConnected,false);
});


test('source data note gains local M/D after midnight even on same-at replacement', t => {
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,8,25,23,50)});
  const h=setup(t);
  const stamp=new Date(2026,8,25,23,10).toISOString();
  const body={...listing([article()],[{name:'甲',count:1,ok:false,last_success:stamp}]),at:stamp};
  h.message(body);
  const option=h.select.options[1];
  assert.equal(option.textContent,'甲 1（23:10 資料）');
  t.mock.timers.setTime(new Date(2026,8,26,0,1).getTime());
  h.message(body);
  assert.equal(h.select.options[1],option);
  assert.equal(option.textContent,'甲 1（9/25 23:10 資料）');
  assert.match(option.title,/2026-09-25 23:10:00/);
  choose(h,h.select,'甲');
  assert.equal(h.window.document.getElementById(h.select.getAttribute('aria-describedby')).textContent,option.title);
  // Compare year too: the same month/day in another year is not today.
  t.mock.timers.setTime(new Date(2027,8,25,23,50).getTime());
  h.message(body);
  assert.equal(option.textContent,'甲 1（9/25 23:10 資料）');
});

test('event focus counts publishers: three CNA feeds are one, CNA PTS BBC are three', t => {
  const h=setup(t);
  const names=['中央社 政治','中央社 財經','中央社 國際','公視','BBC'];
  const sources=names.map((name,i)=>({name,ok:true,outlet:i<3?'中央社':name}));
  const reports=names.map((source,i)=>eventStory('111111111111',`headline-${i}`,8+i,{source}));
  h.message(listing(reports.slice(0,3),sources));
  assert.equal(focusButtons(h).length,0);
  assert.match(focusArea(h).textContent,/目前沒有多家媒體/);
  h.message(listing(reports,sources));
  assert.equal(focusButtons(h).length,1);
  assert.equal(focusButtons(h)[0].querySelector('.nw-focus-long').textContent,'看同事件・3 家');
  choose(h,h.select,'中央社 政治'); assert.equal(focusButtons(h).length,0);
  choose(h,h.select,''); assert.equal(focusButtons(h).length,1);
  // Missing/invalid metadata safely falls back to the feed name.
  h.message(listing(reports.slice(0,3),sources.map(s=>({...s,outlet:{bad:true}}))));
  assert.equal(focusButtons(h)[0].querySelector('.nw-focus-long').textContent,'看同事件・3 家');
});

test('topic heading and distribution show outlets while the source selector retains feeds', t => {
  const h=setup(t), topic=topicRecord({sources:3,count:5});
  const names=['中央社 政治','中央社 財經','中央社 國際','公視','BBC'];
  const sources=names.map((name,i)=>({name,ok:true,outlet:i<3?'中央社':name}));
  const reports=names.map((source,i)=>article({source,title:`report-${i}`,topic:topic.id}));
  const body={...topicListing(reports,[topic]),sources};
  h.message(body);
  assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-long').textContent,'看話題・3 家');
  focusTopicButtons(h)[0].click();
  assert.equal(outletDistribution(h),'中央社 3・公視 1・BBC 1');
  assert.deepEqual([...h.select.options].slice(1).map(o=>o.value),names);
  h.message(body);
  assert.equal(outletDistribution(h),'中央社 3・公視 1・BBC 1');
  const extra=Array.from({length:4},(_,i)=>({name:`來源${i}`,outlet:`媒體${i}`,ok:true}));
  h.message({...body,sources:[...sources,...extra],items:[...reports,...extra.map(s=>article({source:s.name,topic:topic.id}))],
    topics:{list:[{...topic,sources:7,count:9}]}});
  assert.equal(h.container.querySelector('.nw-outlet-more').textContent,'另 2 家（共 7 家）');
});

const search = (h, value) => {
  const input = h.container.querySelector('.nw-search-input');
  input.value = value;
  input.dispatchEvent(new h.window.Event('input', {bubbles:true}));
  return input;
};
test('temporary search folds fullwidth and invisible separators, preserves ZWJ, searches safe summaries', async t => {
  const {searchText} = await import('../front/labels.js');
  assert.equal(searchText('ＡＩ　a\u200bb\u200cc\u2060d\ufeff👩\u200d💻'), 'ai abcd👩\u200d💻');
  const h=setup(t);
  h.message(listing([article({title:'ＡＩ\u200bChip',summary:'<img src=x>\n更多',link:'https://e.test/a'}),
    article({title:{bad:1},summary:[],link:'https://e.test/b'})]));
  assert.equal(h.container.querySelector('.nw-search-box').hidden,true);
  const toggle=h.container.querySelector('.nw-search-toggle'); toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(h.window.document.activeElement,h.container.querySelector('.nw-search-input'));
  search(h,'aichip'); assert.equal(mainRows(h).length,1);
  search(h,'<img'); assert.equal(mainRows(h).length,1); assert.equal(h.container.querySelector('img'),null);
  assert.equal(h.container.querySelector('.nw-search-hint').textContent,'搜尋「<img」：1 個事件');
  toggle.click(); assert.equal(h.container.querySelector('.nw-search-box').hidden,true);
  assert.equal(mainRows(h).length,2); // §20.14: closing search also clears its filter.
  assert.equal(h.container.querySelector('.nw-search-input').value,'');
  toggle.click();
  search(h,'none'); assert.equal(mainRows(h).length,0);
  assert.match(h.container.querySelector('.nw-empty').textContent,/沒有符合搜尋/);
  h.container.querySelector('.nw-empty button').click(); assert.equal(mainRows(h).length,2);
  assert.equal(h.window.localStorage.length,0);
});

test('search finds child report, expands and marks it, survives both resend kinds and leaves manual expansion intact', t => {
  const h=setup(t), reports=[eventStory('111111111111','代表',8,{link:'https://e.test/a'}),
    eventStory('111111111111','子報導',9,{summary:'Needle',link:'https://e.test/b'})];
  h.message(listing(reports)); const input=search(h,'needle');
  assert.equal(mainRows(h).length,1); assert.deepEqual(mainTitles(h),['代表']);
  assert.equal(h.container.querySelector('.nw-reports').hidden,false);
  assert.equal(h.container.querySelector('.nw-report .nw-search-match').textContent,'搜尋命中');
  const expand=h.container.querySelector('.nw-expand');
  assert.equal(expand.getAttribute('aria-expanded'),'true'); expand.click();
  assert.equal(h.container.querySelector('.nw-reports').hidden,true);
  for (const at of ['2026-09-21T02:04:00Z','2026-09-26T02:04:00Z']) {
    h.message({...listing(reports),at}); assert.equal(input.value,'needle');
    assert.equal(mainRows(h).length,1); assert.equal(h.container.querySelector('.nw-reports').hidden,false);
  }
  h.message(listing(reports.map(i=>({...i,summary:'changed'})))); assert.equal(mainRows(h).length,0);
  search(h,''); assert.equal(mainRows(h).length,1); assert.equal(h.container.querySelector('.nw-reports').hidden,true);
  h.container.querySelector('.nw-expand').click(); search(h,'代表'); search(h,'');
  assert.equal(h.container.querySelector('.nw-reports').hidden,false);
});

test('search intersects source category theme count and topic without replacing those selections', t => {
  const h=setup(t), topic=topicRecord();
  const items=countFixture('finance').map(item=>({...item,title:item.source==='甲'?'needle':'other',topic:topic.id}));
  h.message(topicListing([...items,eventStory('999999999999','needle outside',12)]));
  choose(h,h.categories,'finance'); choose(h,h.select,'甲'); search(h,'needle');
  assert.equal(mainRows(h).length,6);
  h.container.querySelector('[data-topic="memory"]').click(); assert.equal(mainRows(h).length,2);
  countButton(h,'signal:3').click(); assert.equal(mainRows(h).length,2);
  search(h,'absent'); assert.equal(mainRows(h).length,0);
  assert.equal(countButton(h,'signal:3').getAttribute('aria-pressed'),'true');
  search(h,'needle'); focusTopicButtons(h)[0].click();
  assert.ok(mainRows(h).length>0);
  assert.ok(!mainTitles(h).some(title=>title.includes('outside')));
  assert.equal(h.container.querySelector('.nw-search-input').value,'needle');
  h.container.querySelector('.nw-filter button').click();
  assert.equal(h.container.querySelector('.nw-search-input').value,'needle');
});

test('search keyboard is scoped, Esc clears, typing does not browse, listeners removed on unmount', t => {
  const h=setup(t); h.message(listing([article()]));
  const root=h.container.querySelector('.nw'), toggle=h.container.querySelector('.nw-search-toggle');
  const key=(node,value,extra={})=>node.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra}));
  key(h.window.document.body,'/'); assert.equal(toggle.getAttribute('aria-expanded'),'false');
  key(root,'/',{ctrlKey:true}); assert.equal(toggle.getAttribute('aria-expanded'),'false');
  key(root,'/'); const input=search(h,'新聞');
  assert.equal(h.window.document.activeElement,input);
  for(const k of ['j','k','s','e','/']) { key(input,k); assert.equal(h.window.document.activeElement,input); }
  key(input,'Escape'); assert.equal(input.value,''); assert.equal(mainRows(h).length,1);
  key(input,'Escape',{isComposing:true});
  h.handle.unmount(); toggle.click(); input.value='retained';
  input.dispatchEvent(new h.window.Event('input')); key(input,'Escape');
  assert.equal(input.value,'retained'); assert.equal(h.container.children.length,0);
});

test('300 reports search input including render stays below 50ms per input', t => {
  const h=setup(t), items=Array.from({length:300},(_,i)=>eventStory(i.toString(16).padStart(12,'0'),`Search ${i}`,8,
    {link:`https://e.test/${i}`, summary:`${'摘要'.repeat(100)} ${i%2?'odd':'even'}`,event_size:1}));
  h.message(listing(items));
  const elapsed=[];
  for (const query of ['search','odd','even','missing','search 1','']) {
    const start=performance.now(); search(h,query); elapsed.push(performance.now()-start);
  }
  t.diagnostic(`300 reports input+render ms: ${elapsed.map(n=>n.toFixed(2)).join(', ')}`);
  assert.ok(elapsed.every(n=>n<50),JSON.stringify(elapsed));
  assert.equal(mainRows(h).length,300);
});

test('search intersects watch-only, clears via Escape outside input and never restores on remount', t => {
  const h=setup(t); saveWatch(h,'AI');
  h.message(listing([article({title:'AI needle',link:'https://e.test/a'}),article({title:'needle',link:'https://e.test/b'})]));
  search(h,'needle'); watchControls(h).only.click(); assert.equal(mainRows(h).length,1);
  search(h,'absent'); assert.equal(mainRows(h).length,0);
  search(h,'needle'); const root=h.container.querySelector('.nw');
  root.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(h.container.querySelector('.nw-search-input').value,'');
  assert.equal(watchControls(h).only.getAttribute('aria-pressed'),'true');
  search(h,'needle'); h.handle.unmount();
  const again=setup(t,w=>{for(let i=0;i<h.window.localStorage.length;i++) {
    const key=h.window.localStorage.key(i); w.localStorage.setItem(key,h.window.localStorage.getItem(key));
  }});
  assert.equal(again.container.querySelector('.nw-search-input').value,'');
});

test('search row reuse recomputes new badges and keeps invalid duplicate events separate', t => {
  const h=setup(t,withSeen('2026-09-24T08:30:00Z'));
  const old=eventStory('111111111111','old',8,{link:'https://e.test/old'});
  const fresh=eventStory('222222222222','fresh',9,{link:'https://e.test/fresh'});
  h.message(listing([old,fresh]));
  assert.equal(h.container.querySelectorAll('.nw-new').length,1);
  search(h,'fresh'); assert.equal(h.container.querySelectorAll('.nw-new').length,0);
  search(h,''); assert.equal(h.container.querySelectorAll('.nw-new').length,1);
  const duplicate=article({title:'duplicate',event:'invalid'});
  h.message(listing([duplicate,duplicate])); search(h,'duplicate');
  assert.equal(mainRows(h).length,2);
  assert.equal(h.container.querySelector('.nw-search-hint').textContent,'搜尋「duplicate」：2 個事件');
});

test('R6 topic category count theme path is reachable via UI and returns original scope', t => {
  const h=setup(t), topic=topicRecord();
  const report=(id,source,theme,market='positive',inside=true)=>eventStory(String(id).repeat(12),`t${id}`,9,
    {source,link:`https://e.test/${id}`,analysis:analysis({theme,market}),...(inside?{topic:topic.id}:{})});
  const body=topicListing([report(1,'甲','memory'),report(2,'乙','energy'),report(3,'甲','memory','negative'),
    report(4,'乙','memory','positive',false),report(5,'甲','energy','negative',false)]);
  h.message(body); choose(h,h.categories,'finance'); choose(h,h.select,'乙');
  assert.equal(mainRows(h).length,2);
  focusTopicButtons(h)[0].click(); choose(h,h.categories,'finance');
  assert.equal(panel(h).hidden,false);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'),'true');
  assert.equal(countButton(h,'signal:0').textContent.trim(),'2 偏多');
  countButton(h,'signal:0').click(); assert.equal(mainRows(h).length,2);
  h.container.querySelector('[data-topic="energy"]').click();
  assert.deepEqual(mainTitles(h),['t2']);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'),'true');
  assert.match(h.container.querySelector('.nw-filter').textContent,/返回/);
  h.message(body); assert.deepEqual(mainTitles(h),['t2']);
  h.container.querySelector('.nw-filter button').click();
  assert.equal(h.select.value,'乙'); assert.equal(h.categories.value,'finance');
  assert.deepEqual(mainTitles(h),['t2','t4']);
});

test('R6 topic category changes retain return state while source changes exit topic', t => {
  const h=setup(t), topic=topicRecord();
  h.message(topicListing([financeArticle({topic:topic.id}),worldArticle({topic:topic.id,source:'乙',link:'https://e.test/world'})]));
  choose(h,h.select,'甲'); choose(h,h.categories,'finance');
  focusTopicButtons(h)[0].click(); choose(h,h.categories,'world');
  assert.equal(mainRows(h).length,1); assert.equal(h.container.querySelector('.nw-panel').hidden,false);
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'),'true');
  h.container.querySelector('.nw-filter button').click();
  assert.equal(h.select.value,'甲'); assert.equal(h.categories.value,'finance');
  focusTopicButtons(h)[0].click(); choose(h,h.categories,'finance');
  countButton(h,'signal:0').click(); choose(h,h.categories,'world');
  assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'),'true');
  assert.equal(mainRows(h).length,1);
  choose(h,h.select,'乙'); assert.equal(focusTopicButtons(h)[0].getAttribute('aria-pressed'),'false');
});

test('R6 focus empty message is reserved for unfiltered data without a three-outlet event', t => {
  for(const filter of ['source','category','count','theme','search']) {
    const h=setup(t), reports=focusReports('111111111111',3);
    // An energy event exists but only has one outlet.
    reports.push(eventStory('222222222222','other',8,{source:'媒體0',analysis:analysis({theme:'energy'})}));
    h.message({...listing(reports,['媒體0','媒體1','媒體2'].map(name=>({name,ok:true}))),model:{state:'done'}});
    assert.equal(focusArea(h).hidden,false);
    if(filter==='source') choose(h,h.select,'媒體0');
    if(filter==='category') choose(h,h.categories,'world');
    if(filter==='count') { choose(h,h.categories,'finance'); countButton(h,'signal:3').click(); }
    if(filter==='theme') { choose(h,h.categories,'finance'); h.container.querySelector('[data-topic="energy"]').click(); }
    if(filter==='search') search(h,'no match');
    assert.equal(focusArea(h).hidden,true,filter);
    assert.doesNotMatch(focusArea(h).textContent,/目前沒有多家媒體/);
  }
  const h=setup(t); h.message({...listing([article()]),model:{state:'done'}});
  assert.equal(focusArea(h).hidden,false); assert.match(focusArea(h).textContent,/目前沒有多家媒體/);
});

test('R6 search count is live beside input with only one clear control', t => {
  const h=setup(t); h.message(listing([article({title:'needle'})]));
  h.container.querySelector('.nw-search-toggle').click(); search(h,'needle');
  const box=h.container.querySelector('.nw-search-box'), hint=h.container.querySelector('.nw-search-hint');
  assert.equal(hint.parentNode,box); assert.equal(hint.getAttribute('aria-live'),'polite');
  assert.equal(box.querySelector('input').type,'text'); // No native search cancel affordance.
  assert.equal(box.querySelectorAll('button').length,1);
  assert.equal(hint.textContent,'搜尋「needle」：1 個事件');
  box.querySelector('button').click(); assert.equal(hint.hidden,true); assert.equal(box.querySelector('input').value,'');
});

const eventLatest = h => h.container.querySelector('.nw-event-latest');
const latestReports = () => [
  eventStory('123456abcdef','最早報導',8,{link:'https://e.test/first',source:'甲'}),
  eventStory('123456abcdef','最新報導',12,{link:'https://e.test/latest',source:'乙'}),
  eventStory('123456abcdef','中間報導',10,{link:'https://e.test/middle',source:'甲'}),
];
test('R7 latest event report is a safe muted link below representative without duplicate new badge and with native tab order', t => {
  const h=setup(t,withSeen('2026-09-24T09:00:00Z'));
  h.message(listing(latestReports()));
  const row=mainRows(h)[0], link=eventLatest(h);
  assert.equal(row.querySelector('.nw-title').textContent,'最早報導');
  assert.equal(link.textContent,'最新：最新報導（乙）');
  assert.equal(link.title,'最新報導'); assert.equal(link.href,'https://e.test/latest');
  assert.equal(link.target,'_blank'); assert.equal(link.rel,'noopener noreferrer');
  assert.equal(row.querySelector('.nw-title').nextElementSibling,link);
  const controls=[...row.querySelectorAll('a,button')].filter(node=>!node.closest('[hidden]'));
  assert.deepEqual(controls.map(node=>node.className),['nw-title','nw-hint nw-event-latest','nw-summary-toggle','nw-expand']);
  assert.ok(controls.every(node=>node.getAttribute('tabindex')===null));
  for(const node of controls) { node.focus(); assert.equal(h.window.document.activeElement,node); }
  const css=h.window.getComputedStyle(link);
  assert.equal(css.whiteSpace,'nowrap'); assert.equal(css.overflow,'hidden'); assert.equal(css.textOverflow,'ellipsis');
  row.querySelector('.nw-expand').click();
  assert.deepEqual([...row.querySelectorAll('.nw-report-title')].map(node=>node.textContent),['中間報導','最新報導']);
});

test('R7 latest requires a different title and strictly later valid time, in the filtered group', t => {
  const h=setup(t), [first,latest]=latestReports();
  for(const reports of [[first], [first,{...latest,title:first.title}],
    [first,{...latest,published:first.published}], [first,{...latest,published:'bad'}],
    [first,{...latest,link:'javascript:alert(1)'}]]) {
    h.message(listing(reports)); assert.equal(Boolean(eventLatest(h)),false);
  }
  h.message(listing([latest,first])); assert.equal(eventLatest(h).title,latest.title);
  assert.equal(eventLatest(h).querySelector('.nw-new'),null); // No saved lastSeen.
  choose(h,h.select,'乙'); assert.equal(Boolean(eventLatest(h)),false); assert.deepEqual(mainTitles(h),[latest.title]);
});

test('R7 resend updates latest and keeps focused latest distinct from its child copy', t => {
  const h=setup(t), reports=latestReports(); h.message(listing(reports));
  eventLatest(h).focus(); h.message(listing(reports));
  assert.equal(h.window.document.activeElement,eventLatest(h));
  h.container.querySelector('.nw-expand').click();
  const child=[...h.container.querySelectorAll('.nw-report-title')].find(n=>n.href==='https://e.test/latest');
  child.focus(); h.message(listing(reports));
  assert.ok(h.window.document.activeElement.classList.contains('nw-report-title'));
  const newest={...reports[1],title:'<img src=x>後續',published:'2026-09-24T14:00:00Z',link:'https://e.test/new'};
  h.message(listing([...reports,newest]));
  assert.equal(eventLatest(h).textContent,'最新：<img src=x>後續（乙）');
  assert.equal(eventLatest(h).title,newest.title); assert.equal(h.container.querySelector('img'),null);
});

test('R7 search hides only a matching latest preview and recomputes it on cached input and resends', t => {
  const h=setup(t), reports=latestReports(); h.message(listing(reports));
  search(h,'最新報導'); assert.equal(eventLatest(h).hidden,true);
  assert.equal(h.container.querySelector('.nw-reports').hidden,false);
  assert.equal(h.container.querySelectorAll('.nw-report .nw-search-match').length,1);
  search(h,'最早報導'); assert.equal(eventLatest(h).hidden,false);
  search(h,'摘要'); assert.equal(eventLatest(h).hidden,true); // Summary matches the latest too.
  h.message({...listing(reports),at:'2026-09-26T00:00:00Z'}); assert.equal(eventLatest(h).hidden,true);
  search(h,''); assert.equal(eventLatest(h).hidden,false);
});

for (const [category,name,report] of [['finance','財經',financeArticle()],['tech','科技',financeArticle({category:'tech'})],
  ['world','國際',worldArticle()],['politics','政治',article({category:'politics',analysis:{kind:'politics',issue:'budget'}})]]) {
  test(`R8 search scope hint updates without changing panel counts: ${category}`, t => {
    const h=setup(t); const body=listing([report,{...report,link:'https://e.test/other',title:'another'}]);
    h.message(body); choose(h,h.categories,category);
    const p=h.container.querySelector('.nw-panel'), hint=p.querySelector('.nw-search-scope');
    const before=p.querySelector('.nw-sample-count').textContent;
    assert.equal(hint.hidden,true);
    search(h,'nothing'); assert.equal(mainRows(h).length,0);
    assert.equal(hint.hidden,false); assert.equal(hint.textContent,`統計為全部${name}，未套用搜尋`);
    assert.equal(hint.nextElementSibling.className,'nw-sample');
    assert.equal(p.querySelector('.nw-sample-count').textContent,before);
    h.message(body); assert.equal(hint.hidden,false);
    h.message({...body,at:'2026-09-26T01:00:00Z'}); assert.equal(hint.hidden,false);
    search(h,''); assert.equal(hint.hidden,true);
    p.querySelector('[data-topic]').click(); assert.equal(hint.hidden,true);
  });
}

test('R8 finance labels and macro controls explain news impact while report tone stays unchanged', t => {
  const h=setup(t), topic=topicRecord({count:10,tone:{positive:2,negative:1,mixed:1,neutral:6}});
  h.message(topicListing(countFixture('finance').map((i,n)=>({...i,topic:topic.id,tone:n<2?'positive':n===2?'negative':n===3?'mixed':'neutral'})),[topic]));
  choose(h,h.categories,'finance');
  const p=panel(h), expected=['偏多','多空互見','與股市無關','偏空'];
  assert.equal(p.querySelector('.nw-signal-heading small').textContent,'依新聞內容判斷對股市的影響，非行情');
  for (let i=0;i<4;i++) {
    const button=countButton(h,`signal:${i}`);
    assert.ok(button.textContent.endsWith(expected[i])); assert.equal(button.hasAttribute('aria-label'),false);
    button.click(); assert.equal(h.container.querySelector('.nw-filter > span').textContent,`已篩選：${expected[i]}`);
  }
  assert.doesNotMatch(p.querySelector('.nw-market-bar').getAttribute('aria-label'),/正面|負面|正反/);
  assert.match(p.querySelector('.nw-market').title,/與股市無關/);
  assert.equal(p.querySelector('.nw-macro').textContent,'大盤方向：大盤／總經 4 個事件利多 1利空 1其餘 2 件無明確方向');
  for(const id of ['macro:all','macro:bull','macro:bear']) {
    const button=countButton(h,id); assert.equal(button.hasAttribute('aria-label'),false);
    button.click(); assert.equal(countButton(h,id).getAttribute('aria-pressed'),'true');
  }
  assert.match(focusArea(h).querySelector('.nw-tone').textContent,/正面/);
  assert.match(focusArea(h).querySelector('.nw-tone').textContent,/負面/);
});

test('R8 row theme keeps visible label and has safe directional or neutral descriptions', t => {
  const h=setup(t);
  h.message(listing([financeArticle({analysis:analysis({theme:'macro',dir:'bear'})}),
    financeArticle({link:'https://e.test/2',analysis:analysis({theme:'foundry'})}),
    financeArticle({link:'https://e.test/3',analysis:analysis({dir:'neutral'})}),
    financeArticle({link:'https://e.test/4',analysis:analysis({dir:'bear',dir_p:.59})})]));
  const tags=mainRows(h).map(row=>row.querySelector('.nw-tag'));
  assert.deepEqual(tags.map(n=>n.textContent),['大盤 ▼','晶圓代工 ▲','記憶體','記憶體']);
  const expected=['這則新聞對大盤偏空（依新聞內容判斷，非行情）','這則新聞對晶圓代工偏多（依新聞內容判斷，非行情）',
    '題材：記憶體','題材：記憶體'];
  tags.forEach((tag,i)=>{assert.equal(tag.title,expected[i]); assert.equal(described(h,tag),expected[i]);
    assert.equal(tag.contains(h.window.document.getElementById(tag.getAttribute('aria-describedby'))),false);});
});

test('R8 theme legends switch semantic labels and color tokens; politics has no direction legend', t => {
  const h=setup(t); h.message(listing([financeArticle(),worldArticle(),article({category:'politics',analysis:{kind:'politics',issue:'budget'}})]));
  const p=h.container.querySelector('.nw-panel'), legend=p.querySelector('.nw-ranking-legend');
  choose(h,h.categories,'finance');
  assert.equal(legend.textContent,'紅＝偏多・綠＝偏空・灰＝無方向');
  assert.deepEqual([...legend.querySelectorAll('.nw-dot')].map(n=>n.className),['nw-dot nw-bull','nw-dot nw-bear','nw-dot nw-idle']);
  choose(h,h.categories,'world');
  assert.equal(legend.textContent,'升級・緩和・無方向');
  assert.deepEqual([...legend.querySelectorAll('.nw-dot')].map(n=>n.className),['nw-dot nw-escalation','nw-dot nw-deescalation','nw-dot nw-idle']);
  assert.equal(p.querySelector('.nw-signal-heading small').hidden,true);
  choose(h,h.categories,'politics'); assert.equal(legend.hidden,true); assert.equal(legend.textContent,'');
  choose(h,h.categories,'finance'); assert.equal(legend.hidden,false);
});

test('R9 faceted source and category menus count events, ignore backend report counts and update on resend', t => {
  const h=setup(t), id='123456abcdef';
  const items=[eventStory(id,'A',8,{source:'甲'}),eventStory(id,'B',9,{source:'甲'}),
    eventStory(id,'C',10,{source:'乙'}),worldArticle({source:'乙'}),
    article({event:'bad',source:'甲',category:'world'})];
  const body=listing(items,[{name:'甲',ok:true,count:999},{name:'乙',ok:false,count:888}]);
  h.message(body);
  const labels=()=>[...h.select.options].map(o=>o.textContent);
  assert.deepEqual(labels(),['全部來源 3','甲 2','乙 2（失敗）']);
  const categories=[...h.categories.options].map(o=>o.textContent);
  assert.equal(categories[0],'全部類別 3');
  assert.equal(h.categories.querySelector('[value=finance]').textContent,'財經 1');
  // Each option's displayed count predicts the list after a real change event.
  const optionCount=o=>Number(o.textContent.match(/ (\d+)(?:（.*）)?$/)[1]);
  for (const source of ['', '甲', '乙']) {
    choose(h,h.select,source);
    for (const option of h.categories.options) {
      const expected=optionCount(option);
      choose(h,h.categories,option.value);
      assert.equal(mainRows(h).length,expected,`${source}/${option.value}`);
    }
  }
  for (const category of ['', 'finance', 'world', 'sports']) {
    choose(h,h.categories,category);
    for (const option of h.select.options) {
      const expected=optionCount(option);
      choose(h,h.select,option.value);
      assert.equal(mainRows(h).length,expected,`${option.value}/${category}`);
    }
  }
  choose(h,h.select,''); choose(h,h.categories,'');
  search(h,'absent'); assert.deepEqual(labels(),['全部來源 3','甲 2','乙 2（失敗）']);
  h.message({...body,items:[items[0],items[2]]});
  assert.deepEqual(labels(),['全部來源 1','甲 1','乙 1（失敗）']);
  assert.equal(h.categories.options[0].textContent,'全部類別 1');
});

test('R9 empty focus is a compact hint with threshold title and resets when data arrives', t => {
  const h=setup(t); h.message({...listing([article()]),model:{state:'done'}});
  const focus=focusArea(h), hint=focus.querySelector('.nw-focus-list .nw-hint');
  assert.equal(hint.textContent,'目前沒有多家媒體同時報導的新聞');
  assert.match(hint.title,/至少 3 家不同媒體/);
  assert.equal(focus.querySelector('.nw-focus-heading').hidden,true);
  assert.equal(h.window.getComputedStyle(focus).backgroundColor,'transparent');
  assert.equal(h.window.getComputedStyle(focus).paddingTop,'0px');
  assert.equal(h.window.getComputedStyle(hint).marginTop,'0px');
  h.message(listing(focusReports('111111111111',3)));
  assert.equal(focus.classList.contains('nw-focus-empty'),false);
  assert.equal(focus.querySelector('.nw-focus-heading').hidden,false);
  assert.equal(focusButtons(h).length,1);
  h.message({...listing([]),model:{state:'working'}});
  assert.equal(focus.classList.contains('nw-focus-empty'),false);
  assert.match(focus.textContent,/正在整理/);
});

test('R9 watch keyword guidance and accessible event count stay synchronized', t => {
  const h=setup(t); h.message(listing([article({title:'AI'})]));
  const {toggle,only}=watchControls(h);
  assert.equal(toggle.textContent,'追蹤關鍵字'); assert.equal(only.hidden,true); assert.equal(only.disabled,true);
  only.dispatchEvent(new h.window.Event('click'));
  assert.equal(only.getAttribute('aria-pressed'),'false');
  toggle.click(); const guide=h.container.querySelector('.nw-watch-guide');
  assert.equal(guide.hidden,false); assert.match(guide.textContent,/先輸入並儲存關鍵字/);
  saveWatch(h,'AI');
  const check=n=>{const expected=`只顯示標題或摘要含你的關鍵字的新聞（${n} 個事件）`;
    assert.equal(only.title,expected); assert.equal(described(h,only),expected); assert.equal(only.textContent,`只看追蹤 ${n}`);};
  check(1); assert.equal(guide.hidden,true);
  h.message(listing([eventStory('111111111111','AI',8),eventStory('111111111111','AI again',9)])); check(1);
  choose(h,h.categories,'world'); check(0);
  h.handle.unmount(); assert.equal(h.container.childElementCount,0);
});

test('R9 macro buttons use gap without floating separators and keep visible accessible names', t => {
  const h=setup(t); h.message(listing([financeArticle({analysis:analysis({theme:'macro'})})]));
  choose(h,h.categories,'finance');
  const macro=h.container.querySelector('.nw-macro');
  assert.doesNotMatch(macro.textContent,/・/);
  assert.deepEqual([...macro.querySelectorAll('button')].map(n=>n.textContent),['大盤／總經 1 個事件','利多 1','利空 0']);
  assert.ok([...macro.querySelectorAll('button')].every(n=>!n.hasAttribute('aria-label')));
  assert.equal(h.window.getComputedStyle(macro).gap,'6px 16px');
});

// §20.11: missing analysis is not an unrelated signal.
for (const category of ['finance', 'world']) {
  test(`R11 analysis coverage and count drill-down conserve events through resends: ${category}`, t => {
    const h=setup(t), rows=countFixture(category).slice(0,5).map(item=>({...item,analysis:null}));
    const send=items=>h.message({...listing(items), classify:{enabled:true},model:{state:'working'}});
    const values=()=>[0,1,2,3].map(i=>Number(countButton(h,`signal:${i}`).querySelector('.nw-value').textContent));
    send(rows); choose(h,h.categories,category);
    assert.deepEqual(values(),[0,0,0,0]);
    assert.match(h.container.querySelector('.nw-sample-count').textContent,/已分析 0／3/);
    assert.equal(h.container.querySelector('.nw-pending').textContent,'待判定 3');
    assert.equal(h.container.querySelector('.nw-pending').hidden,false);
    assert.equal(h.container.querySelector('.nw-market-bar').dataset.empty,'true');
    for(const [index,covered] of [[1,1],[3,2],[4,3]]) {
      rows[index]={...countFixture(category)[index]}; send(rows);
      assert.equal(values().reduce((a,b)=>a+b,0),covered);
      if(covered<3) assert.match(h.container.querySelector('.nw-sample-count').textContent,new RegExp(`已分析 ${covered}／3`));
      else assert.doesNotMatch(h.container.querySelector('.nw-sample-count').textContent,/已分析/);
      assert.equal(h.container.querySelector('.nw-pending').textContent,`待判定 ${3-covered}`);
      for(let i=0;i<4;i++) {
        const count=values()[i]; countButton(h,`signal:${i}`).click();
        assert.equal(mainRows(h).length,count);
        countButton(h,`signal:${i}`).click();
      }
    }
    assert.equal(h.container.querySelector('.nw-pending').hidden,true);
    for(const [state,reason,enabled] of [['off','auth',false],['off','no_key',false],['paused','failed',true]]) {
      h.message({...listing(rows.map(item=>({...item,analysis:null}))),classify:{enabled},model:{state,reason}});
      assert.deepEqual(values(),[0,0,0,0]);
      assert.equal(h.container.querySelector('.nw-pending').hidden,true);
      assert.match(h.container.querySelector('.nw-status').textContent,state==='paused'?/整理暫停/:/分類.*金鑰/);
    }
  });
}

const r11Rows=()=>[
  eventStory('111111111111','舊代表',9,{category:'finance',analysis:analysis(),source:'甲'}),
  eventStory('111111111111','台積電新進展',11,{category:'finance',analysis:analysis(),source:'乙'}),
  eventStory('222222222222','舊事件',8,{category:'finance',analysis:analysis(),source:'甲'}),
  eventStory('333333333333','能源新進展',12,{category:'finance',analysis:analysis({theme:'energy',market:'negative'}),source:'甲'}),
];

test('R11 new progress keeps old representatives, marks new children, survives resends and clears', t=>{
  const h=setup(t,withSeen(seenAt)); h.message(listing(r11Rows()));
  const toggle=h.container.querySelector('.nw-new-only');
  assert.equal(toggle.textContent,'新增 2 個事件'); assert.equal(toggle.tagName,'BUTTON');
  assert.equal(toggle.getAttribute('aria-pressed'),'false');
  toggle.focus(); toggle.click();
  assert.ok(h.window.document.activeElement===toggle);
  assert.equal(toggle.getAttribute('aria-pressed'),'true');
  assert.deepEqual(mainTitles(h),['舊代表','能源新進展']);
  assert.match(h.container.querySelector('.nw-new-hint').textContent,/只看上次離開後的新進展（2 個事件）/);
  mainRows(h)[0].querySelector('.nw-expand').click();
  assert.equal(mainRows(h)[0].querySelectorAll('.nw-report-title .nw-new').length,1);
  for(const at of ['2026-09-21T02:04:00Z','2026-09-26T01:00:00Z']) {
    h.message({...listing(r11Rows()),at});
    assert.equal(toggle.getAttribute('aria-pressed'),'true'); assert.equal(mainRows(h).length,2);
  }
  h.container.querySelector('.nw-new-hint button').click();
  assert.equal(toggle.getAttribute('aria-pressed'),'false'); assert.equal(mainRows(h).length,3);
  assert.equal(h.container.querySelectorAll('.nw-report-title .nw-new').length,0);
  assert.ok(h.window.document.activeElement===toggle);
  h.handle.unmount(); toggle.click();
  assert.equal(h.container.childElementCount,0);
  assert.equal(h.window.localStorage.getItem('modudock.module.news.onlyNew'),null);
});

test('R11 new progress intersects source category theme signal search and watch filters', t=>{
  const h=setup(t,withSeen(seenAt)); h.message(listing(r11Rows()));
  const toggle=h.container.querySelector('.nw-new-only'); toggle.click();
  choose(h,h.categories,'finance');
  assert.doesNotMatch(panel(h).querySelector('.nw-sample-count').textContent,/已分析/);
  countButton(h,'signal:0').click(); assert.equal(mainRows(h).length,1);
  assert.equal(countButton(h,'signal:0').querySelector('.nw-value').textContent,'1');
  countButton(h,'signal:0').click(); themeButton(h,'memory').click(); assert.equal(mainRows(h).length,1);
  search(h,'台積電'); assert.equal(mainRows(h).length,1);
  choose(h,h.select,'甲'); assert.equal(mainRows(h).length,0); assert.equal(toggle.disabled,true);
  choose(h,h.select,''); search(h,'');
  if(themeButton(h,'memory').getAttribute('aria-pressed')==='true') themeButton(h,'memory').click();
  const watch=watchControls(h); watch.input.value='能源'; watch.save.click(); watch.only.click();
  assert.equal(mainRows(h).length,1); assert.equal(toggle.textContent,'新增 1 個事件');
  search(h,'台積電'); assert.equal(mainRows(h).length,0);
  h.container.querySelector('.nw-new-hint button').click();
  assert.equal(toggle.getAttribute('aria-pressed'),'false');
  assert.equal(watch.only.getAttribute('aria-pressed'),'true');
});

test('R11 zero and absent baseline cannot activate new filter; zero while active still has an exit',t=>{
  const fresh=setup(t); fresh.message(listing(r11Rows()));
  assert.equal(fresh.container.querySelector('.nw-new-only').hidden,true);
  const h=setup(t,withSeen(seenAt)); h.message(listing(r11Rows()));
  const toggle=h.container.querySelector('.nw-new-only'); toggle.click();
  h.message(listing([r11Rows()[2]]));
  assert.equal(toggle.disabled,true); assert.equal(toggle.hidden,true);
  assert.equal(toggle.getAttribute('aria-pressed'),'true');
  assert.equal(h.container.querySelector('.nw-new-hint').hidden,false);
  assert.equal(h.container.querySelector('.nw-new-hint button').disabled,false);
  assert.equal(mainRows(h).length,0);
  h.container.querySelector('.nw-new-hint button').click(); assert.equal(mainRows(h).length,1);
  toggle.dispatchEvent(new h.window.Event('click'));
  assert.equal(toggle.getAttribute('aria-pressed'),'false');
});

test('R11 history bars and theme ratios exclude missing analysis without changing directional denominators',t=>{
  const h=setup(t), at='2026-09-25T00:00:00Z', rows=[];
  for(let bucket=0;bucket<4;bucket++) for(let i=0;i<6;i++) rows.push(financeArticle({
    published:`2026-09-24T${String(bucket*6+1).padStart(2,'0')}:00:00Z`,
    analysis:i===5?null:analysis({market:i===4?'not_market':'positive',theme:'memory'})}));
  h.message({...listing(rows),at}); choose(h,h.categories,'finance');
  h.container.querySelector('.nw-history-toggle').click();
  const history=[...h.container.querySelectorAll('.nw-history-row')];
  assert.equal(history.length,4);
  for(const row of history) {
    assert.deepEqual([...row.querySelector('.nw-history-bar').children].map(node=>node.style.width),['80%','0%','20%','0%']);
    assert.match(row.textContent,/偏多 4\/4/);
  }
  assert.equal(rankLabel(themeButton(h,'memory')),'記憶體 20');
  assert.match(h.container.querySelector('.nw-sample-count').textContent,/已分析 20／24/);
});

test('R11 topic return preserves new filter and clearing all cancels it',t=>{
  const h=setup(t,withSeen(seenAt)), topic=topicRecord();
  h.message(topicListing(r11Rows().map(item=>({...item,topic:topic.id})),[topic]));
  const toggle=h.container.querySelector('.nw-new-only'); toggle.click();
  focusTopicButtons(h)[0].click(); choose(h,h.categories,'finance');
  h.container.querySelector('.nw-filter button').click();
  assert.equal(toggle.getAttribute('aria-pressed'),'true');
  search(h,'不存在的新聞');
  h.container.querySelector('.nw-empty button').click();
  assert.equal(toggle.getAttribute('aria-pressed'),'false');
  assert.equal(mainRows(h).length,3);
});

for (const [category,name] of [['finance','財經'],['tech','科技'],['world','國際'],['politics','政治']]) {
  test(`R11 panel states new-progress scope alongside search exclusion: ${category}`,t=>{
    const h=setup(t,withSeen(seenAt));
    const rows=r11Rows().map(item=>({...item,category,analysis:category==='world'?worldAnalysis():
      category==='politics'?{kind:'politics',issue:'budget'}:item.analysis}));
    const body=listing(rows); h.message(body); choose(h,h.categories,category);
    const p=h.container.querySelector('.nw-panel'), sample=p.querySelector('.nw-sample-count');
    const full=sample.textContent;
    assert.match(full,/^3 個事件（4 則報導）/);
    h.container.querySelector('.nw-new-only').click();
    const narrowed=sample.textContent;
    assert.match(narrowed,/^上次離開後的新進展：2 個事件（3 則報導）/);
    assert.equal(h.categories.selectedOptions[0].textContent,`${name} 3`);
    search(h,'台積電'); assert.equal(mainRows(h).length,1);
    assert.equal(sample.textContent,narrowed);
    const hint=p.querySelector('.nw-search-scope');
    assert.equal(hint.hidden,false); assert.equal(hint.textContent,`統計為全部${name}，未套用搜尋`);
    for(const at of [body.at,'2026-09-26T01:00:00Z']) {
      h.message({...body,at}); assert.equal(sample.textContent,narrowed);
      assert.equal(hint.hidden,false); assert.equal(mainRows(h).length,1);
    }
    h.container.querySelector('.nw-new-hint button').click();
    assert.equal(sample.textContent,full); assert.equal(hint.hidden,false);
    search(h,''); assert.equal(hint.hidden,true); assert.equal(sample.textContent,full);
  });
}

// §20.12: complete per-report evidence, including different tones in one event.
function auditFixture() {
  const topics=[topicRecord({count:8,tone:toneCounts({negative:2,neutral:1,mixed:1,positive:2})}),
    topicRecord({id:'fedcba654321',title:'第二話題',count:6,tone:toneCounts({negative:1,neutral:2,mixed:1,positive:2})})];
  const items=topics.flatMap((topic,t)=>['negative','positive','negative','neutral','mixed','positive',null,'invalid']
    .slice(0,t?6:8).map((tone,i)=>article({topic:topic.id,tone:t&&i===2?'neutral':tone,
      event:(t?'bbbbbbbbbbbb':'aaaaaaaaaaaa'),event_size:t?6:8,
      title:i?`話題${t}報導${i}`:topic.title,source:['甲','乙','丙'][i%3],
      link:`https://example.com/audit/${t}/${i}`,summary:`來源摘要 ${t}-${i}`,
      published:`2026-09-24T${String(8+i).padStart(2,'0')}:00:00Z`})));
  return topicListing(items,topics);
}
const auditButton=(h,topic,tone)=>[...h.container.querySelectorAll('.nw-tone-button')]
  .find(button=>button.dataset.toneKey===`${topic}:${tone}`);
const auditRows=h=>[...h.container.querySelectorAll('.nw-tone-audit .nw-tone-report')];

test('R12 every visible tone count opens exactly its contributing reports, including same-event disagreement',t=>{
  const h=setup(t),body=auditFixture(); h.message(body);
  for(const topic of body.topics.list) for(const tone of ['negative','neutral','mixed','positive']) {
    const button=auditButton(h,topic.id,tone), expected=body.items.filter(item=>item.topic===topic.id&&item.tone===tone);
    assert.equal(button.tagName,'BUTTON'); assert.equal(button.getAttribute('aria-label'),`${button.textContent} 則報導`);
    assert.match(button.textContent,new RegExp(` ${expected.length}$`));
    button.focus(); button.click();
    assert.equal(h.container.querySelectorAll('.nw-tone-audit').length,1);
    assert.equal(auditRows(h).length,expected.length);
    assert.deepEqual(auditRows(h).map(row=>row.querySelector('a').href),expected.map(item=>item.link));
    assert.equal(h.container.querySelector('.nw-tone-audit h4').textContent,'依標題與摘要判斷的報導語氣・按報導計');
    for(const [i,row] of auditRows(h).entries()) {
      assert.equal(row.querySelector('.nw-source').textContent,expected[i].source);
      assert.ok(row.querySelector('.nw-time').textContent); assert.equal(row.querySelector('a').target,'_blank');
      assert.equal(row.querySelector('a').rel,'noopener noreferrer');
    }
    assert.equal(h.container.querySelectorAll('.nw-tone-button[aria-expanded="true"]').length,1);
    assert.ok(h.window.document.activeElement===auditButton(h,topic.id,tone));
    assert.equal(auditButton(h,topic.id,tone).getAttribute('aria-controls'),h.container.querySelector('.nw-tone-audit').id);
  }
  assert.equal(h.container.querySelector('.nw-tone-pending').textContent,'待判定 2 則');
});

test('R12 same button and Escape collapse and return focus; evidence summaries use individual report identity',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id; h.message(body);
  auditButton(h,id,'negative').click();
  const first=auditRows(h)[0].querySelector('.nw-summary-toggle'); first.click();
  assert.equal(first.getAttribute('aria-expanded'),'true');
  assert.equal(h.window.document.getElementById(first.getAttribute('aria-controls')).hidden,false);
  assert.equal(auditRows(h)[1].querySelector('.nw-summary').hidden,true);
  first.focus(); first.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(auditRows(h).length,0);
  assert.equal(auditButton(h,id,'negative').getAttribute('aria-expanded'),'false');
  assert.ok(h.window.document.activeElement===auditButton(h,id,'negative'));
  auditButton(h,id,'negative').click(); assert.equal(auditRows(h)[0].querySelector('.nw-summary').hidden,false);
  auditButton(h,id,'negative').click(); assert.equal(auditRows(h).length,0);
  assert.ok(h.window.document.activeElement===auditButton(h,id,'negative'));
});

test('R12 resends refresh evidence counts and preserve focused report; disappearance closes the audit',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id; h.message(body);
  auditButton(h,id,'negative').click(); const link=auditRows(h)[0].querySelector('a'); link.focus();
  const updated={...body,items:body.items.map((item,i)=>i===6?{...item,tone:'negative'}:item),
    topics:{list:body.topics.list.map((topic,i)=>i?topic:{...topic,tone:toneCounts({negative:3,neutral:1,mixed:1,positive:2})})}};
  for(const at of [body.at,'2026-09-26T01:00:00Z']) {
    h.message({...updated,at}); assert.equal(auditRows(h).length,3);
    assert.match(auditButton(h,id,'negative').getAttribute('aria-label'),/3 則報導/);
    assert.equal(h.window.document.activeElement.href,link.href);
    assert.equal(h.container.querySelector('.nw-tone-pending').textContent,'待判定 1 則');
  }
  h.message({...body,topics:{list:[body.topics.list[1]]}});
  assert.equal(auditRows(h).length,0);
  h.message(body); assert.equal(auditRows(h).length,0); // Never revive a disappeared topic's open audit.
});

test('R12 topic view uses the same full-topic evidence even with category and search restrictions',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id;
  body.items=body.items.map((item,i)=>({...item,category:i%2?'world':'finance'})); h.message(body);
  focusTopicButtons(h)[0].click(); choose(h,h.categories,'finance'); search(h,'不存在');
  assert.equal(mainRows(h).length,0);
  h.container.querySelector('.nw-focus-toggle').click();
  auditButton(h,id,'positive').click(); assert.equal(auditRows(h).length,2);
  assert.equal(h.container.querySelectorAll('.nw-tone-audit').length,1);
  const anchor=auditRows(h)[0].querySelector('a'); anchor.focus();
  anchor.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(auditRows(h).length,0); assert.equal(h.container.querySelector('.nw-search-input').value,'不存在');
});

test('R12 pending reports stay out of counts, malformed aggregate is safe and mismatches cannot invent evidence',t=>{
  const h=setup(t),body=auditFixture();
  h.message({...body,items:body.items.map(item=>({...item,tone:null}))});
  assert.equal(h.container.querySelectorAll('.nw-tone-button').length,0);
  assert.deepEqual([...h.container.querySelectorAll('.nw-tone-pending')].map(node=>node.textContent),['待判定 8 則','待判定 6 則']);
  h.message({...body,topics:{list:[{...body.topics.list[0],tone:toneCounts({negative:8})}]}});
  assert.match(auditButton(h,body.topics.list[0].id,'negative').getAttribute('aria-label'),/2 則報導/);
  auditButton(h,body.topics.list[0].id,'negative').click(); assert.equal(auditRows(h).length,2);
});

test('R12 long and hostile evidence stays safe, wraps on narrow layouts and removes listeners on unmount',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id;
  body.items[0]={...body.items[0],title:'<img src=x>'+ 'W'.repeat(1000),source:'來源'.repeat(200),summary:'<script>bad</script>\n純文字'};
  h.message(body); auditButton(h,id,'negative').click();
  assert.equal(h.container.querySelector('img'),null); assert.equal(h.container.querySelector('script'),null);
  const row=auditRows(h)[0],button=row.querySelector('.nw-summary-toggle'); button.click();
  assert.ok(row.querySelector('.nw-summary').textContent.includes('<script>bad</script>'));
  assert.equal(h.window.getComputedStyle(row).overflowWrap,'anywhere');
  assert.equal(h.window.getComputedStyle(h.container.querySelector('.nw-tone-labels')).flexWrap,'wrap');
  const root=h.container.querySelector('.nw'), toneButton=auditButton(h,id,'negative');
  h.handle.unmount(); toneButton.click(); button.click();
  root.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(h.container.childElementCount,0);
});

test('R12 removed tone or filtered-out topic closes evidence without reviving it on return',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id; h.message(body);
  auditButton(h,id,'negative').click();
  h.message({...body,items:body.items.map(item=>item.topic===id&&item.tone==='negative'?{...item,tone:'positive'}:item)});
  assert.equal(auditRows(h).length,0);
  h.message(body); assert.equal(auditRows(h).length,0);
  auditButton(h,id,'negative').click(); choose(h,h.categories,'world');
  assert.equal(auditRows(h).length,0);
  choose(h,h.categories,''); assert.equal(auditRows(h).length,0);
});

test('R12 tone controls are light text buttons with bold counts and synchronized pressed state',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id; h.message(body);
  for(const tone of ['negative','neutral','mixed','positive']) {
    const button=auditButton(h,id,tone),style=h.window.getComputedStyle(button);
    assert.equal(style.borderTopWidth,'0px'); assert.equal(style.backgroundColor,'transparent');
    assert.equal(style.paddingLeft,'0px'); assert.equal(style.paddingRight,'0px');
    assert.equal(style.whiteSpace,'nowrap');
    assert.equal(button.querySelector('strong').textContent,String(body.items.filter(item=>item.topic===id&&item.tone===tone).length));
    assert.equal(h.window.getComputedStyle(button.querySelector('strong')).fontWeight,'700');
    assert.ok(button.classList.contains(`nw-tone-text-${tone}`));
    assert.equal(button.getAttribute('aria-pressed'),'false');
  }
  auditButton(h,id,'negative').click();
  assert.equal(auditButton(h,id,'negative').getAttribute('aria-pressed'),'true');
  auditButton(h,id,'positive').click();
  assert.equal(auditButton(h,id,'negative').getAttribute('aria-pressed'),'false');
  assert.equal(auditButton(h,id,'positive').getAttribute('aria-pressed'),'true');
  auditButton(h,id,'positive').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(auditButton(h,id,'positive').getAttribute('aria-pressed'),'false');
  const css=h.container.querySelector('style').textContent;
  assert.ok(css.includes('.nw .nw-tone-button:hover { text-decoration: underline; }'));
  assert.ok(css.includes('text-decoration-thickness: 2px'));
  assert.ok(css.includes('.nw button:focus-visible'));
  assert.ok(css.includes('outline: 2px solid var(--nw-focus)'));
});

test('R11 absent baseline and zero new events leave no new button text or orphan status separator',t=>{
  for(const prepare of [()=>{},withSeen(seenAt)]) {
    const h=setup(t,prepare), status=()=>h.container.querySelector('.nw-status');
    const zero=listing([r11Rows()[2]],[{name:'甲',ok:true}]);
    h.message(zero);
    const button=h.container.querySelector('.nw-new-only');
    assert.equal(button.hidden,true); assert.equal(button.textContent,'');
    assert.match(status().textContent,/更新$/);
    assert.doesNotMatch(status().textContent,/新增|·/);
    h.message({...zero,classify:{enabled:false}});
    assert.match(status().textContent,/更新 · 分類：關閉$/);
    assert.equal((status().textContent.match(/·/g)||[]).length,1);
    h.message({...zero,at:''}); assert.equal(status().textContent,'');
    h.message({...zero,at:'',classify:{enabled:false}});
    assert.equal(status().textContent,'分類：關閉');
  }
  const h=setup(t,withSeen(seenAt));
  h.message(listing(r11Rows(),[{name:'甲',ok:true},{name:'乙',ok:true}]));
  const toggle=h.container.querySelector('.nw-new-only'); assert.equal(toggle.hidden,false);
  toggle.click();
  h.message(listing([r11Rows()[2]],[{name:'甲',ok:true}]));
  assert.equal(toggle.hidden,true); assert.doesNotMatch(h.container.querySelector('.nw-status').textContent,/新增|·/);
  h.container.querySelector('.nw-new-hint button').click();
  assert.equal(mainRows(h).length,1);
  h.message(listing(r11Rows()));
  assert.equal(toggle.hidden,false); assert.equal(toggle.getAttribute('aria-pressed'),'false');
  assert.equal(toggle.textContent,'新增 2 個事件');
});

// §20.13: the overview uses the same category-first event analysis as the panel.
const overviewButton=(h,category)=>h.container.querySelector(`[data-overview="${category}"]`);
function overviewFixture() {
  return ['finance','world'].flatMap((category,c)=>{
    const rows=countFixture(category).map((item,i)=>({...item,event:(c?'b':'a')+item.event.slice(1),
      published:`2026-09-24T${item.event==='888888888888'?'08':i===0?'11':'12'}:00:00Z`,
      link:`https://example.com/overview/${category}/${i}`}));
    for(const [n,signal] of [[9,'positive'],[0,'negative']]) rows.push(eventStory((c?'b':'a')+String(n).repeat(11),`extra-${category}-${n}`,12,
      {source:'乙',category,analysis:category==='world'?worldAnalysis({trend:signal==='positive'?'escalation':'deescalation'}):analysis({market:signal})}));
    return rows;
  }).concat(financeArticle({category:'tech',title:'不算入財經速覽',published:'2026-09-24T12:00:00Z'}));
}
for(const source of ['', '甲', '乙']) for(const newOnly of [false,true]) {
  test(`R13 overview counts equal destination panel: source=${source||'all'} new=${newOnly}`,t=>{
    const h=setup(t,withSeen(seenAt)); h.message(listing(overviewFixture()));
    choose(h,h.select,source); if(newOnly) h.container.querySelector('.nw-new-only').click();
    for(const category of ['finance','world']) {
      const button=overviewButton(h,category), world=category==='world';
      assert.equal(h.container.querySelector('.nw-overview').hidden,false);
      const match=button.textContent.match(world?/升級 (\d+) 件・緩和 (\d+) 件/:/偏多 (\d+) 件・偏空 (\d+) 件/);
      assert.ok(match); // Even small samples retain explicit event counts.
      assert.equal(button.tagName,'BUTTON'); assert.equal(button.getAttribute('aria-label'),null);
      button.focus(); button.click();
      assert.equal(h.categories.value,category); assert.equal(h.select.value,source);
      assert.ok(h.window.document.activeElement===h.categories);
      assert.equal(h.container.querySelector('.nw-overview').hidden,true);
      if(match) {
        assert.equal(countButton(h,'signal:0').querySelector('.nw-value').textContent,match[1]);
        assert.equal(countButton(h,world?'signal:2':'signal:3').querySelector('.nw-value').textContent,match[2]);
      } else {
        const sample=h.container.querySelector('.nw-sample-count').textContent.match(/已分析 (\d+)／/);
        assert.ok(Number(sample[1])<5);
      }
      assert.equal(JSON.parse(h.window.localStorage.getItem(viewKey)).category,category);
      if(newOnly) assert.match(button.textContent,/新進展/);
      choose(h,h.categories,'');
    }
  });
}

test('R13 partial coverage is visible, sample threshold is ten, and resends recompute',t=>{
  const h=setup(t),rows=Array.from({length:10},(_,i)=>financeArticle({title:`coverage-${i}`,link:`https://example.com/cov/${i}`,analysis:null}));
  h.message(listing(rows)); const button=overviewButton(h,'finance');
  assert.equal(button.textContent,'財經 偏多 0 件・偏空 0 件（已分析 0／10）（樣本少）');
  assert.equal(overviewButton(h,'world').textContent,'國際 升級 0 件・緩和 0 件（樣本少）');
  for(const count of [4,5,9,10]) {
    const items=rows.map((item,i)=>({...item,analysis:i<count?analysis({market:i%2?'negative':'positive'}):null}));
    h.message({...listing(items),model:{state:'working'}});
    assert.equal(button.textContent,`財經 偏多 ${Math.ceil(count/2)} 件・偏空 ${Math.floor(count/2)} 件${count<10?`（已分析 ${count}／10）（樣本少）`:''}`);
    h.message({...listing(items),at:'2026-09-26T03:00:00Z',model:{state:'paused'}});
    if(count<10) assert.match(button.title,new RegExp(`已分析 ${count}／10`));
    else assert.doesNotMatch(button.title,/已分析/);
  }
  h.message({...listing(rows),classify:{enabled:false},model:{state:'off',reason:'auth'}});
  assert.equal(h.container.querySelector('.nw-overview').hidden,true);
});

test('R13 overview visibility follows category topic search and watch, and cleanup removes its listener',t=>{
  const h=setup(t),overview=h.container.querySelector('.nw-overview');
  assert.equal(overview.hidden,true); h.message(listing(overviewFixture())); assert.equal(overview.hidden,false);
  search(h,'不存在'); assert.equal(overview.hidden,true); search(h,''); assert.equal(overview.hidden,false);
  choose(h,h.categories,'politics'); assert.equal(overview.hidden,true); choose(h,h.categories,'');
  saveWatch(h,'新聞'); watchControls(h).only.click(); assert.equal(overview.hidden,true);
  watchControls(h).only.click(); assert.equal(overview.hidden,false);
  const topic=topicRecord(); h.message(topicListing(overviewFixture().map(item=>({...item,topic:topic.id})),[topic]));
  focusTopicButtons(h)[0].click(); assert.equal(h.categories.value,''); assert.equal(overview.hidden,true);
  h.container.querySelector('.nw-filter button').click(); assert.equal(overview.hidden,false);
  assert.equal(h.window.getComputedStyle(overview).flexWrap,'wrap');
  assert.equal(h.window.getComputedStyle(overviewButton(h,'finance')).whiteSpace,'normal');
  assert.equal(overview.querySelector('.nw-overview-heading').textContent,'新聞風向（非行情）');
  assert.deepEqual([...overview.querySelectorAll('.nw-overview-separator')].map(node=>node.textContent),['｜','｜']);
  assert.equal(overview.querySelectorAll('button').length,2);
  assert.equal(h.window.getComputedStyle(overviewButton(h,'finance')).overflowWrap,'anywhere');
  assert.equal(overview.querySelectorAll('.nw-overview-segment').length,2); // Break before the international segment; no clipping.
  const button=overviewButton(h,'finance'); h.handle.unmount(); button.click();
  assert.equal(h.container.childElementCount,0); assert.equal(h.categories.value,'');
});

// §20.14: regressions reproduced by the independent fdf1381 review.
for(const exit of ['return','disappear','count']) test(`R14 topic category remains temporary and restored view persists: ${exit}`,t=>{
  const h=setup(t),topic=topicRecord(),body=topicListing([
    financeArticle({topic:topic.id}),worldArticle({topic:topic.id,source:'乙',link:'https://e/world'}),financeArticle({link:'https://e/outside'})]);
  h.message(body); choose(h,h.categories,'finance'); choose(h,h.select,'甲');
  const before=JSON.parse(h.window.localStorage.getItem(viewKey));
  focusTopicButtons(h)[0].click(); choose(h,h.categories,'world');
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem(viewKey)),before);
  if(exit==='count') countButton(h,'signal:0').click();
  if(exit==='disappear') h.message({...body,topics:{list:[]}});
  else h.container.querySelector('.nw-filter button').click();
  assert.equal(h.categories.value,'finance'); assert.equal(h.select.value,'甲');
  const saved=JSON.parse(h.window.localStorage.getItem(viewKey));
  assert.deepEqual(saved,{source:h.select.value,category:h.categories.value});
  const reload=setup(t,w=>w.localStorage.setItem(viewKey,JSON.stringify(saved))); reload.message(body);
  assert.equal(reload.categories.value,'finance'); assert.equal(reload.select.value,'甲');
});

test('R14 hiding search clears its filter and all cues; reopening and resends do not revive it',t=>{
  const h=setup(t),body=listing([article({title:'台積電'}),article({title:'聯發科',link:'https://e/2'})]);
  h.message(body); const toggle=h.container.querySelector('.nw-search-toggle'); toggle.click(); search(h,'台積');
  assert.equal(mainRows(h).length,1); toggle.click();
  assert.equal(mainRows(h).length,2); assert.equal(h.container.querySelector('.nw-search-input').value,'');
  assert.equal(toggle.getAttribute('aria-pressed'),'false'); assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(h.container.querySelector('.nw-search-hint').hidden,true);
  h.message(body); toggle.click(); assert.equal(mainRows(h).length,2);
  assert.equal(h.container.querySelector('.nw-search-input').value,'');
});

function r14ThemeRows() {
  const row=(title,hour,event,theme='memory',source='甲')=>eventStory(event,title,hour,
    {source,link:`https://e/${title}`,analysis:analysis({theme})});
  return [row('E-old',10,'aaaaaaaaaaaa','ai_server'),row('E-new',14,'aaaaaaaaaaaa','memory','乙'),
    row('F-old',9,'bbbbbbbbbbbb'),row('G-new',15,'cccccccccccc','ai_server')];
}
test('R14 individual-report theme intersects new progress, keeps count and restores old matching events',t=>{
  const h=setup(t,withSeen('2026-09-24T12:00:00Z')),body=listing(r14ThemeRows()); h.message(body);
  choose(h,h.categories,'finance'); themeButton(h,'memory').click();
  const titles=()=>mainTitles(h).map(value=>value.replace(/^新/,''));
  assert.deepEqual(titles(),['E-new','F-old']); const button=h.container.querySelector('.nw-new-only');
  assert.equal(button.textContent,'新增 1 個事件'); button.click();
  assert.deepEqual(titles(),['E-new']); assert.equal(button.textContent,'新增 1 個事件');
  assert.match(h.container.querySelector('.nw-filter').textContent,/已篩選：記憶體/);
  h.message(body); assert.deepEqual(titles(),['E-new']);
  h.container.querySelector('.nw-new-hint button').click(); assert.deepEqual(titles(),['E-new','F-old']);
  assert.equal(themeButton(h,'memory').getAttribute('aria-pressed'),'true');
});

test('R14 new progress reaching zero preserves theme until the unfiltered theme itself disappears',t=>{
  const h=setup(t,withSeen('2026-09-24T12:00:00Z')),rows=r14ThemeRows(); h.message(listing(rows));
  choose(h,h.categories,'finance'); themeButton(h,'memory').click(); h.container.querySelector('.nw-new-only').click();
  h.message(listing(rows.filter(item=>item.title!=='E-new')));
  assert.equal(mainRows(h).length,0); assert.match(h.container.querySelector('.nw-filter').textContent,/已篩選：記憶體/);
  h.container.querySelector('.nw-new-hint button').click(); assert.deepEqual(mainTitles(h),['F-old']);
  h.message(listing(rows.filter(item=>item.analysis.theme!=='memory')));
  assert.equal(h.container.querySelector('.nw-filter').hidden,true);
});

for(const manual of [false,true]) test(`R14 Escape clears search expansion without changing manual expansion: ${manual}`,t=>{
  const h=setup(t),body=listing([article({title:'代表',event:'aaaaaaaaaaaa',event_size:2,link:'https://e/1',published:'2026-09-24T10:00:00Z'}),
    article({title:'子報導關鍵',event:'aaaaaaaaaaaa',event_size:2,link:'https://e/2',published:'2026-09-24T11:00:00Z'})]);
  h.message(body); if(manual) h.container.querySelector('.nw-expand').click();
  h.container.querySelector('.nw-search-toggle').click(); search(h,'關鍵');
  const child=h.container.querySelector('.nw-reports a'); child.focus();
  child.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(h.container.querySelector('.nw-search-input').value,'');
  const toggle=h.container.querySelector('.nw-expand'); assert.equal(toggle.getAttribute('aria-expanded'),String(manual));
  if(!manual) assert.ok(h.window.document.activeElement===toggle);
  else assert.equal(h.window.document.activeElement.href,child.href);
  choose(h,h.select,''); h.message(body);
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'),String(manual));
});

// §20.15: discoverability without a modal, focus trap, or persisted preference.
const shortcutArea=h=>h.container.querySelector('[role=region][aria-label="鍵盤快捷鍵"]');
const pressKey=(h,node,key,extra={})=>{
  const event=new h.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});
  node.dispatchEvent(event); return event;
};
test('R15 question mark toggles nonmodal help and restores focus across list replacement',t=>{
  const h=setup(t),body=listing([article()]); h.message(body);
  const title=mainRows(h)[0].querySelector('a'),help=shortcutArea(h); title.focus();
  assert.equal(help.hidden,true);
  assert.equal(pressKey(h,title,'?',{shiftKey:true}).defaultPrevented,true);
  assert.equal(help.hidden,false); assert.ok(h.window.document.activeElement===help);
  assert.equal(help.getAttribute('aria-modal'),null); assert.equal(help.getAttribute('role'),'region');
  assert.equal(h.container.querySelector('.nw-shortcut-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(h.container.querySelector('.nw-shortcut-toggle').getAttribute('aria-controls'),help.id);
  h.message({...body,at:'2026-09-26T01:00:00Z'}); assert.equal(help.hidden,false);
  pressKey(h,help,'?',{shiftKey:true}); assert.equal(help.hidden,true);
  assert.equal(h.window.document.activeElement.href,title.href);
  assert.equal(h.container.querySelector('.nw-shortcut-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(h.window.localStorage.length,0);
});

test('R15 visible shortcut entry lists only existing keys and Escape returns to the entry',t=>{
  const h=setup(t); h.message(listing([article()]));
  const toggle=h.container.querySelector('.nw-shortcut-toggle'),help=shortcutArea(h);
  assert.equal(toggle.querySelector('.nw-shortcut-name').textContent,'快捷鍵');
  assert.equal(toggle.querySelector('.nw-shortcut-icon').getAttribute('aria-hidden'),'true');
  assert.equal(toggle.tagName,'BUTTON');
  assert.equal(toggle.parentElement.className,'nw-status-group');
  assert.equal(toggle.previousElementSibling.className,'nw-undo-read'); // R21 reading controls precede help.
  toggle.focus(); toggle.click();
  assert.deepEqual([...help.querySelectorAll('dt')].map(node=>node.textContent),['j／k','s','e','/','Esc','?（Shift+/）']);
  assert.match(help.textContent,/下一則／上一則新聞/);
  assert.equal(pressKey(h,help,'Tab').defaultPrevented,false); // No focus trap.
  pressKey(h,help,'Escape'); assert.equal(help.hidden,true);
  assert.ok(h.window.document.activeElement===toggle);
});

test('R15 question mark does not intercept editing, modifiers, composition or events outside this module',t=>{
  const h=setup(t); h.message(listing([article()]));
  const input=h.container.querySelector('.nw-search-input'); input.value='?';
  for(const node of [input,h.categories,h.container.querySelector('.nw-watch-input')]) {
    assert.equal(pressKey(h,node,'?',{shiftKey:true}).defaultPrevented,false);
    assert.equal(shortcutArea(h).hidden,true);
  }
  assert.equal(input.value,'?');
  const editable=h.window.document.createElement('div'); editable.contentEditable='true'; h.container.querySelector('.nw').append(editable);
  assert.equal(pressKey(h,editable,'?',{shiftKey:true}).defaultPrevented,false);
  const title=mainRows(h)[0].querySelector('a');
  for(const extra of [{ctrlKey:true},{altKey:true},{metaKey:true},{isComposing:true},{repeat:true}]) {
    pressKey(h,title,'?',{shiftKey:true,...extra}); assert.equal(shortcutArea(h).hidden,true);
  }
  assert.equal(pressKey(h,h.window.document.body,'?',{shiftKey:true}).defaultPrevented,false);
  assert.equal(shortcutArea(h).hidden,true);
});

for(const fromInput of [false,true]) test(`R15 Escape priority is tone audit then search then help: input=${fromInput}`,t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id; h.message(body);
  h.container.querySelector('.nw-search-toggle').click(); search(h,'話題');
  auditButton(h,id,'negative').click(); const opener=auditButton(h,id,'negative'); opener.focus();
  pressKey(h,opener,'?',{shiftKey:true}); const help=shortcutArea(h),input=h.container.querySelector('.nw-search-input');
  assert.equal(help.hidden,false); assert.ok(auditRows(h).length>0);
  const escape=()=>{if(fromInput) input.focus(); pressKey(h,h.window.document.activeElement,'Escape');};
  escape(); assert.equal(auditRows(h).length,0); assert.equal(input.value,'話題'); assert.equal(help.hidden,false);
  escape(); assert.equal(input.value,''); assert.equal(help.hidden,false);
  escape(); assert.equal(help.hidden,true); assert.ok(h.window.document.activeElement===auditButton(h,id,'negative'));
});

test('R15 missing return target falls back to shortcut entry and unmount removes help listeners',t=>{
  const h=setup(t); h.message(listing([article()])); const title=mainRows(h)[0].querySelector('a'); title.focus();
  pressKey(h,title,'?',{shiftKey:true}); h.message(listing([]));
  pressKey(h,shortcutArea(h),'Escape');
  const toggle=h.container.querySelector('.nw-shortcut-toggle'); assert.ok(h.window.document.activeElement===toggle);
  toggle.click(); const help=shortcutArea(h),root=h.container.querySelector('.nw'); h.handle.unmount();
  toggle.click(); pressKey(h,root,'?',{shiftKey:true}); pressKey(h,help,'Escape');
  assert.equal(h.container.childElementCount,0);
});

test('R15 closing help after clearing search returns to expand control without reviving temporary expansion',t=>{
  const h=setup(t),body=listing([eventStory('aaaaaaaaaaaa','代表',8,{link:'https://e/1'}),
    eventStory('aaaaaaaaaaaa','子報導關鍵',9,{link:'https://e/2'})]);
  h.message(body); h.container.querySelector('.nw-search-toggle').click(); search(h,'關鍵');
  const child=h.container.querySelector('.nw-reports a'); child.focus(); pressKey(h,child,'?',{shiftKey:true});
  const help=shortcutArea(h); pressKey(h,help,'Escape');
  assert.equal(help.hidden,false); assert.equal(h.container.querySelector('.nw-reports').hidden,true);
  pressKey(h,help,'Escape'); assert.equal(help.hidden,true);
  assert.ok(h.window.document.activeElement===h.container.querySelector('.nw-expand'));
  assert.equal(h.container.querySelector('.nw-expand').getAttribute('aria-expanded'),'false');
  h.message(body); assert.equal(h.container.querySelector('.nw-reports').hidden,true);
});

test('R17 module root contains visually hidden absolute positioning', t => {
  const h = setup(t);
  const root = h.container.querySelector('.nw');
  const rules = [...root.querySelector('style').sheet.cssRules];
  const base = rules.find(rule => rule.selectorText === '.nw').style;
  assert.equal(base.position, 'relative');
  assert.equal(h.window.getComputedStyle(root).position, 'relative');
  // Establish a containing block without offsets or a new scrolling container.
  for (const property of ['top', 'right', 'bottom', 'left', 'inset', 'overflow', 'z-index'])
    assert.equal(base.getPropertyValue(property), '');
  const sr = rules.find(rule => rule.selectorText === '.nw .nw-sr').style;
  for (const [property, value] of Object.entries({
    position: 'absolute', width: '1px', height: '1px', padding: '0px', margin: '-1px',
    overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', 'clip-path': 'inset(50%)',
    'white-space': 'nowrap', border: '0px',
  })) assert.equal(sr.getPropertyValue(property), value, property);
});

for (const mode of ['search', 'theme-new']) test(`R19 watched count equals clicked rows: ${mode}`, t => {
  const h = setup(t, w => {
    w.localStorage.setItem('modudock.module.news.watch', JSON.stringify(['AI']));
    w.localStorage.setItem('modudock.module.news.lastSeen', JSON.stringify('2026-09-21T02:00:00Z'));
  });
  const make = (n, event, theme, published, title) => financeArticle({link:`https://e.test/${n}`,
    event, event_size:2, title, published, analysis:analysis({theme})});
  h.message(listing(mode === 'search' ? [article({title:'AI needle',link:'https://e.test/1'}),
    article({title:'AI other',link:'https://e.test/2'})] : [
    make(1,'000000000001','memory','2026-09-21T01:00:00Z','AI old'),
    make(2,'000000000001','foundry','2026-09-21T03:00:00Z','AI new'),
    make(3,'000000000002','memory','2026-09-21T03:00:00Z','AI memory')]));
  if (mode === 'search') {
    h.container.querySelector('.nw-search-toggle').click(); search(h,'needle');
  } else {
    h.categories.value='finance'; h.categories.dispatchEvent(new h.window.Event('change'));
    h.container.querySelector('[data-topic="memory"]').click();
    h.container.querySelector('.nw-new-only').click();
  }
  const button=h.container.querySelector('.nw-watch-only');
  const count=Number(button.textContent.match(/\d+/)[0]);
  button.click(); assert.equal(mainRows(h).length,1);
  assert.equal(count,mainRows(h).length);
  assert.equal(button.textContent,'只看追蹤 1');
});

for (const category of ['world','politics']) test(`R19 largest other bar scales to maximum: ${category}`, t => {
  const h=setup(t);
  h.message(listing(Array.from({length:6},(_,i)=>article({link:`https://e.test/${i}`,category,
    analysis:category==='world'?{kind:'world',region:i?'other':'us_china',trend:'escalation'}
      :{kind:'politics',issue:i?'other':'budget'}}))));
  h.categories.value=category; h.categories.dispatchEvent(new h.window.Event('change'));
  const buttons=[...h.container.querySelectorAll('button[data-topic]')];
  assert.equal(buttons.length,2); assert.ok(buttons[1].dataset.topic.endsWith(':other'));
  assert.deepEqual(buttons.map(b=>b.querySelector('.nw-theme-bar').style.width),['20%','100%']);
});

test('R20 all-source outage uses newest confirmation, local date, and recovers on 304', t => {
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,8,26,23,50)});
  const h=setup(t),status=()=>h.container.querySelector('[role=status]');
  const older=new Date(2026,8,26,22,0).toISOString(),newer=new Date(2026,8,26,23,10).toISOString();
  const records=ok=>[{name:'甲',ok,last_success:older},{name:'乙',ok,last_success:newer}];
  const body=ok=>({...listing([article({published:'2000-01-01T00:00:00Z'})],records(ok)),at:new Date().toISOString()});
  h.message(body(true)); assert.match(status().textContent,/23:50 更新/);
  h.message(body(false)); assert.match(status().textContent,/^更新失敗，沿用 23:10 的資料/);
  assert.doesNotMatch(status().textContent,/23:50 更新|個來源沿用/);
  assert.match(status().title,/甲：.*22:00:00/); assert.match(status().title,/乙：.*23:10:00/);
  t.mock.timers.setTime(new Date(2026,8,27,0,5).getTime());
  h.message(body(false)); assert.match(status().textContent,/^更新失敗，沿用 9\/26 23:10 的資料/);
  // A 304 is delivered as ok=true with a fresh last_success, despite old articles.
  const recovered=body(false); recovered.sources[1]={name:'乙',ok:true,last_success:new Date().toISOString()};
  h.message(recovered); assert.match(status().textContent,/^00:05 更新/);
  assert.match(status().textContent,/1 個來源沿用舊資料/);
  assert.doesNotMatch(status().textContent,/更新失敗/);
});

test('R20 first all-source failure offers refresh and does not use packet time as freshness', t=>{
  const h=setup(t);h.up();
  h.message(listing([],[{name:'甲',ok:false,last_success:null},{name:'乙',ok:false,last_success:'invalid'}]));
  const status=h.container.querySelector('[role=status]');
  assert.match(status.textContent,/^尚未取得新聞：所有來源連線失敗；請按「重新整理」重試/);
  assert.doesNotMatch(status.textContent,/\d\d:\d\d 更新/);
  assert.equal(h.button.disabled,false);h.button.click();assert.deepEqual(h.sent,[{op:'refresh'}]);
  h.message(listing([],[]));assert.doesNotMatch(status.textContent,/所有來源連線失敗/);
});

test('R21 mark read morning noon evening, undo once, and expire undo on same-at resend', t=>{
  const morning=new Date(2026,8,26,8).getTime(), noon=new Date(2026,8,26,12).getTime(), evening=new Date(2026,8,26,18).getTime();
  t.mock.timers.enable({apis:['Date'],now:morning});
  const h=setup(t,w=>w.localStorage.setItem(seenKey,JSON.stringify(new Date(morning-3600000).toISOString())));
  const mark=()=>h.container.querySelector('.nw-mark-read'),undo=()=>h.container.querySelector('.nw-undo-read');
  const body=time=>({...listing([article({published:new Date(time).toISOString()})]),at:new Date(time).toISOString()});
  h.message(body(morning));assert.equal(h.container.querySelector('.nw-new-only').textContent,'新增 1 個事件');
  mark().click();assert.equal(h.container.querySelector('.nw-new-only').hidden,true);
  assert.equal(Date.parse(JSON.parse(h.window.localStorage.getItem(seenKey))),morning);
  assert.equal(h.window.document.activeElement,undo());
  undo().click();assert.equal(h.container.querySelector('.nw-new-only').hidden,false);assert.equal(undo().hidden,true);
  const restored=h.window.localStorage.getItem(seenKey);undo().click();assert.equal(h.window.localStorage.getItem(seenKey),restored);
  t.mock.timers.setTime(noon);h.message(body(noon));mark().click();
  assert.equal(h.container.querySelectorAll('.nw-new,.nw-divider').length,0);
  h.message(body(noon));assert.equal(undo().hidden,true);assert.ok(!h.window.document.activeElement.closest('[hidden]'));
  t.mock.timers.setTime(evening);h.message(body(evening));
  assert.equal(h.container.querySelector('.nw-new-only').textContent,'新增 1 個事件');
  mark().click();assert.equal(h.container.querySelector('.nw-new-only').hidden,true);
  const stored=h.window.localStorage.getItem(seenKey), detachedUndo=undo();h.handle.unmount();detachedUndo.click();
  assert.equal(h.window.localStorage.getItem(seenKey),stored);
});

test('R21 manual reading writes last-writer wins, restores baseline, tolerates storage errors and clamps future',t=>{
  const now=new Date(2026,8,26,12).getTime();t.mock.timers.enable({apis:['Date'],now});
  const baseline=new Date(now-3600000).toISOString();
  const h=setup(t,w=>w.localStorage.setItem(seenKey,JSON.stringify(baseline))),body={...listing([article({published:new Date(now+600000).toISOString()})]),at:new Date(now).toISOString()};
  h.message(body);h.window.localStorage.setItem(seenKey,JSON.stringify(new Date(now+3600000).toISOString()));
  h.container.querySelector('.nw-mark-read').click();
  assert.equal(Date.parse(JSON.parse(h.window.localStorage.getItem(seenKey))),now);
  assert.equal(h.container.querySelector('.nw-new-only').textContent,'新增 1 個事件');
  h.container.querySelector('.nw-undo-read').click();assert.equal(JSON.parse(h.window.localStorage.getItem(seenKey)),baseline);
  assert.equal(h.container.querySelector('.nw-new-only').hidden,false);
  h.window.localStorage.setItem=()=>{throw new Error('blocked')};
  assert.doesNotThrow(()=>h.container.querySelector('.nw-mark-read').click());
  assert.equal(h.container.querySelector('.nw-undo-read').hidden,false);
});

for(const [reason,failure,phrase] of [['failed','busy','服務忙碌'],['failed','connection','檢查網路'],
  ['failed','response','回應無法使用'],['failed','other','聯絡模組維護者'],['budget',null,'預算用完'],['waiting',null,'等待下次更新'],
  ['failed',{secret:'<img src=x>'},'聯絡模組維護者'],['failed','toString','聯絡模組維護者'],
  ['failed','__proto__','聯絡模組維護者']]) test(`R21 paused advice ${reason}/${JSON.stringify(failure)}`,t=>{
  const h=setup(t);h.message({...listing([article()]),model:{state:'paused',reason,failure}});
  const status=h.container.querySelector('[role=status]');
  assert.match(status.textContent,/整理暫停/);assert.ok(status.title.includes(phrase));
  const detail=h.window.document.getElementById(status.getAttribute('aria-describedby'));
  assert.ok(detail.textContent.includes(phrase));assert.equal(h.container.querySelector('img'),null);
  assert.ok(!detail.textContent.includes('<img'));
  h.message({...listing([article()]),model:{state:'done',reason:''}});assert.equal(detail.textContent,'');
  h.handle.unmount();assert.equal(detail.isConnected,false);
});

test('R21 mark inside new-only can undo or close empty view, and undo expires on a new-at list',t=>{
  const now=new Date(2026,8,26,12).getTime();t.mock.timers.enable({apis:['Date'],now});
  const h=setup(t,w=>w.localStorage.setItem(seenKey,JSON.stringify(new Date(now-3600000).toISOString())));
  const body={...listing([article({published:new Date(now).toISOString()})]),at:new Date(now).toISOString()};
  h.message(body);h.container.querySelector('.nw-new-only').click();
  h.container.querySelector('.nw-mark-read').click();assert.equal(mainRows(h).length,0);
  assert.equal(h.container.querySelector('.nw-new-hint').hidden,false);
  h.container.querySelector('.nw-undo-read').click();assert.equal(mainRows(h).length,1);
  h.container.querySelector('.nw-mark-read').click();h.container.querySelector('.nw-new-hint button').click();
  assert.equal(mainRows(h).length,1);
  h.message({...body,at:new Date(now+1000).toISOString()});
  assert.equal(h.container.querySelector('.nw-undo-read').hidden,true);
});


test('R21 mark-read follows new-count visibility while undo remains available at zero',t=>{
  const now=new Date(2026,8,26,12).getTime();t.mock.timers.enable({apis:['Date'],now});
  const body={...listing([article({published:new Date(now).toISOString()})]),at:new Date(now).toISOString()};
  for(const baseline of [null,new Date(now).toISOString(),new Date(now-3600000).toISOString()]) {
    const h=setup(t,w=>{if(baseline!==null)w.localStorage.setItem(seenKey,JSON.stringify(baseline));});
    h.message(body);
    const mark=h.container.querySelector('.nw-mark-read'),undo=h.container.querySelector('.nw-undo-read'),fresh=h.container.querySelector('.nw-new-only');
    assert.equal(mark.hidden,fresh.hidden);
    if(mark.hidden) {
      const stored=h.window.localStorage.getItem(seenKey);mark.click();
      assert.equal(h.window.localStorage.getItem(seenKey),stored);assert.equal(undo.hidden,true);
    } else {
      mark.click();assert.equal(fresh.hidden,true);assert.equal(mark.hidden,true);assert.equal(undo.hidden,false);
      undo.click();assert.equal(mark.hidden,false);assert.equal(fresh.hidden,false);assert.equal(undo.hidden,true);
      // The count uses current filters, so filtering all new events away also hides mark-read.
      search(h,'no matching title');assert.equal(fresh.hidden,true);assert.equal(mark.hidden,true);
    }
  }
});

test('R23 macro remainder explains all events without adding a fourth filter button',t=>{
  const h=setup(t);
  const items=[['bull',.8],['bear',.8],['bull',.59],['neutral',.9]].map(([dir,dir_p],i)=>
    financeArticle({link:`https://e.test/${i}`,analysis:analysis({theme:'macro',dir,dir_p})}));
  h.message(listing(items));choose(h,h.categories,'finance');
  const macro=()=>h.container.querySelector('.nw-macro');
  assert.equal(macro().querySelectorAll('button').length,3);
  const rest=macro().querySelector('.nw-macro-rest');
  assert.equal(rest.textContent,'其餘 2 件無明確方向');assert.equal(rest.tagName,'SPAN');
  assert.equal(rest.hasAttribute('tabindex'),false);
  h.message(listing(items.map(i=>({...i,analysis:analysis({theme:'macro',dir:'bull',dir_p:.8})}))));
  assert.equal(macro().querySelector('.nw-macro-rest'),null);
  assert.equal(countButton(h,'macro:bull').textContent,'利多 4');
});

test('R23 reading and shortcut entries share secondary button height and narrow shortcut has a circle',t=>{
  const h=setup(t),css=h.container.querySelector('style').textContent;
  h.message(listing([article()]));
  for(const selector of ['.nw-new-only','.nw-mark-read','.nw-undo-read','.nw-shortcut-toggle']) {
    const node=h.container.querySelector(selector),style=h.window.getComputedStyle(node);
    assert.equal(style.minHeight,'30px');assert.equal(style.borderTopWidth,'1px');
    assert.equal(style.paddingTop,'5px');assert.equal(style.paddingBottom,'5px');
  }
  const shortcut=h.container.querySelector('.nw-shortcut-toggle');
  assert.equal(shortcut.getAttribute('aria-label'),'快捷鍵說明');assert.equal(shortcut.title,'快捷鍵說明');
  assert.match(css,/\.nw.nw-narrow \.nw-shortcut-toggle \{ border-radius: 50%; width: 30px; height: 30px; padding: 0; \}/);
  assert.ok(css.includes('.nw .nw-mark-read:hover'));
});

test('R23 mixed tone uses one display name in compact buttons, audit and report tags',t=>{
  const h=setup(t),body=auditFixture(),id=body.topics.list[0].id;h.message(body);
  const button=auditButton(h,id,'mixed');
  const count=body.items.filter(i=>i.topic===id&&i.tone==='mixed').length;
  assert.equal(button.textContent,`正反並陳 ${count}`);
  assert.equal(button.getAttribute('aria-label'),`正反並陳 ${count} 則報導`);
  assert.ok(button.closest('.nw-tone-labels').textContent.startsWith('報導語氣（則）：'));
  button.click();assert.equal(h.container.querySelector('.nw-tone-audit > p').textContent,`正反並陳 ${count} 則報導`);
  focusTopicButtons(h)[0].click();
  assert.ok([...h.container.querySelectorAll('.nw-tone-tag')].some(node=>node.textContent==='正反並陳'));
  assert.doesNotMatch(h.container.textContent,/正負並陳/);
});

function responsiveSetup(t) {
  let callback, target, disconnected=false;
  const h=setup(t,w=>{w.ResizeObserver=class {
    constructor(fn){callback=fn;} observe(node){target=node;} disconnect(){disconnected=true;}
  };});
  return {...h, resize(width){callback([{target,contentRect:{width}}]);}, disconnected:()=>disconnected};
}
test('R24 panel uses module width, defaults closed and preserves only mounted disclosure across categories and resends',t=>{
  const h=responsiveSetup(t),body=listing([financeArticle(),worldArticle(),article({category:'politics',analysis:{kind:'politics',issue:'other'}})]);
  h.message(body);choose(h,h.categories,'finance');
  const toggle=h.container.querySelector('.nw-panel-toggle'),content=h.container.querySelector('.nw-panel-content');
  assert.equal(toggle.hidden,true);assert.equal(content.hidden,false);
  h.window.innerWidth=1400;h.resize(480);
  assert.equal(toggle.hidden,false);assert.equal(content.hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.match(toggle.textContent,/股市訊號：偏多 1・偏空 0/);
  assert.equal(mainRows(h).length,1);
  toggle.click();assert.equal(content.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  h.message({...body,at:'2026-09-22T00:00:00Z'});assert.equal(content.hidden,false);
  choose(h,h.categories,'world');assert.equal(content.hidden,false);assert.match(toggle.textContent,/局勢走向：升級/);
  toggle.click();choose(h,h.categories,'politics');assert.equal(content.hidden,true);assert.match(toggle.textContent,/議題分布：1 個事件/);
  h.resize(500);assert.equal(content.hidden,false);assert.equal(toggle.hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  h.resize(380);assert.equal(content.hidden,true);
  const stored=[...Array(h.window.localStorage.length)].map((_,i)=>h.window.localStorage.key(i));
  assert.ok(stored.every(key=>!key.includes('panel')));
  h.handle.unmount();assert.equal(h.disconnected(),true);h.resize(600);toggle.click();assert.equal(content.hidden,true);
  const next=responsiveSetup(t);next.message(body);choose(next,next.categories,'finance');next.resize(380);
  assert.equal(next.container.querySelector('.nw-panel-content').hidden,true);
});
test('R24 summary updates incomplete analysis and resize never strands focus in collapsed content',t=>{
  const h=responsiveSetup(t);h.message(listing([financeArticle({analysis:null})]));choose(h,h.categories,'finance');
  const toggle=h.container.querySelector('.nw-panel-toggle');
  const focused=countButton(h,'signal:0');focused.focus();h.resize(380);assert.equal(h.window.document.activeElement,focused);
  assert.equal(h.container.querySelector('.nw-panel-content').hidden,false);
  assert.match(toggle.textContent,/已分析 0／1/);
  h.message(listing([financeArticle()]));assert.doesNotMatch(toggle.textContent,/已分析/);
  h.resize(800);assert.equal(h.window.document.activeElement,countButton(h,'signal:0'));
});
test('R24 narrow CSS keeps select row, action row and two-column non-breaking signals',t=>{
  const h=setup(t),css=h.container.querySelector('style').textContent;
  assert.doesNotMatch(css,/@container/);
  assert.match(css,/\.nw.nw-narrow \.nw-toolbar > select \{[^}]*50%/);
  assert.match(css,/\.nw.nw-narrow \.nw-toolbar-actions \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/);
  assert.match(css,/\.nw.nw-narrow \.nw-legend \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css,/\.nw.nw-narrow \.nw-legend-item \{ white-space: nowrap; word-break: keep-all;/);
  h.message(auditFixture());
  const button=focusTopicButtons(h)[0];
  assert.equal(button.querySelector('.nw-focus-short').textContent,button.querySelector('.nw-focus-long').textContent);
  assert.match(button.querySelector('.nw-focus-short').textContent,/看話題/);
});

test('R25 toolbar DOM and tab order follow wide and narrow visual rows, preserving nodes and focus',t=>{
  const h=responsiveSetup(t);h.up();
  const toolbar=h.container.querySelector('.nw-toolbar');
  const refresh=h.container.querySelector('.nw-refresh'),watch=h.container.querySelector('.nw-watch-toggle'),search=h.container.querySelector('.nw-search-toggle');
  const primary=()=>[...toolbar.querySelectorAll('button,select')].filter(n=>[refresh,h.select,h.categories,watch,search].includes(n));
  const wide=[refresh,h.select,h.categories,watch,search],narrow=[h.select,h.categories,refresh,watch,search];
  assert.deepEqual(primary(),wide);h.resize(744);assert.deepEqual(primary(),wide);
  h.categories.focus();h.resize(380);assert.deepEqual(primary(),narrow);
  assert.equal(h.window.document.activeElement,h.categories);
  assert.deepEqual([...h.container.querySelector('.nw-toolbar-actions').children].filter(n=>!n.hidden),[refresh,watch,search]);
  for(const n of primary())assert.equal(n.tabIndex,0);
  search.focus();h.resize(744);assert.deepEqual(primary(),wide);assert.equal(h.window.document.activeElement,search);
  h.resize(480);assert.deepEqual(primary(),narrow);h.resize(500);assert.deepEqual(primary(),wide);
  assert.doesNotMatch(h.container.querySelector('style').textContent,/order:\s*-?[12];/);
});
test('R25 truncated source distribution states remaining and total outlet counts and titles every outlet',t=>{
  const h=setup(t),names=['中央社 政治','中央社 財經',...Array.from({length:9},(_,i)=>`媒體${i}`)];
  const sources=names.map((name,i)=>({name,ok:true,outlet:i<2?'中央社':name}));
  const topic=topicRecord({sources:10,count:11});
  const body={...topicListing(names.map(source=>article({source,topic:topic.id})),[topic]),sources};
  h.message(body);assert.equal(focusTopicButtons(h)[0].querySelector('.nw-focus-long').textContent,'看話題・10 家');
  focusTopicButtons(h)[0].click();
  const hint=h.container.querySelector('.nw-topic-sources');
  assert.equal(outletDistribution(h),'中央社 2・媒體0 1・媒體1 1・媒體2 1・媒體3 1');
  assert.equal(h.container.querySelector('.nw-outlet-more').textContent,'另 5 家（共 10 家）');
  assert.equal(hint.title,'中央社 2・'+Array.from({length:9},(_,i)=>`媒體${i} 1`).join('・')+'（共 10 家）');
  focusTopicButtons(h)[0].click();assert.equal(hint.hasAttribute('title'),false);
});

function readingTopic() {
  const topic=topicRecord({count:5,sources:3});
  const data=[['new','公視','2026-09-26T04:00:00Z','222222222222'],['old-copy','中央社 財經','2026-09-26T03:00:00Z','111111111111'],
    ['middle','中央社 政治','2026-09-26T02:00:00Z','333333333333'],['old','中央社 國際','2026-09-25T02:00:00Z','111111111111'],['earliest','BBC','2026-09-24T02:00:00Z','444444444444']];
  return {...topicListing(data.map(([title,source,published,event])=>financeArticle({title,source,published,event,event_size:2,topic:topic.id,link:`https://e.test/${title}`})),[topic]),
    sources:['中央社 政治','中央社 財經','中央社 國際','公視','BBC'].map(name=>({name,ok:true,outlet:name.startsWith('中央社')?'中央社':name}))};
}
test('R26 chronological topic reading orders earliest reports, dates, keyboard and resets on return',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,8,26,12)});
  const h=setup(t),body=readingTopic();h.message(body);focusTopicButtons(h)[0].click();
  const button=h.container.querySelector('.nw-topic-order');
  assert.equal(button.getAttribute('aria-pressed'),'false');
  button.click();assert.deepEqual(mainTitles(h),['earliest','old','middle','new']);
  assert.deepEqual([...h.container.querySelectorAll('.nw-date-divider')].map(n=>n.textContent),['9/24','9/25','9/26']);
  assert.ok([...h.container.querySelectorAll('.nw-date-divider')].every(n=>n.title==='依發布時間，非事件發生時間'));
  const links=[...h.container.querySelectorAll('.nw-list > .nw-row > a.nw-title')];
  links[0].focus();links[0].dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'j',bubbles:true}));assert.equal(h.window.document.activeElement,links[1]);
  h.message(body);assert.deepEqual(mainTitles(h),['earliest','old','middle','new']);
  search(h,'middle');assert.deepEqual(mainTitles(h),['middle']);search(h,'');
  h.container.querySelector('.nw-filter > button').click();assert.equal(h.container.querySelector('.nw-topic-tools').hidden,true);
  focusTopicButtons(h)[0].click();assert.equal(button.getAttribute('aria-pressed'),'false');assert.deepEqual(mainTitles(h),['new','old','middle','earliest']);
});
test('R26 outlet combines feeds, matches button report count through intersections and restores original view',t=>{
  const h=setup(t),body=readingTopic();h.message(body);choose(h,h.select,'公視');choose(h,h.categories,'finance');
  focusTopicButtons(h)[0].click();
  const outlet=()=>[...h.container.querySelectorAll('.nw-outlet')].find(b=>b.dataset.outlet==='中央社');
  const reportCount=()=>mainRows(h).length+h.container.querySelectorAll('.nw-report').length;
  assert.equal(outlet().textContent,'中央社 3');outlet().click();assert.equal(reportCount(),3);
  assert.equal(h.select.value,'');assert.equal(outlet().getAttribute('aria-pressed'),'true');
  assert.equal(h.container.querySelector('.nw-topic-outlet-label').textContent,'只看：中央社');
  outlet().click();assert.equal(reportCount(),5);
  choose(h,h.categories,'finance');themeButton(h,'memory').click();search(h,'middle');
  assert.equal(outlet().textContent,'中央社 1');outlet().click();assert.equal(reportCount(),1);
  h.container.querySelector('.nw-topic-outlet-clear').click();assert.equal(reportCount(),1);
  search(h,'');countButton(h,'signal:0').click();
  assert.equal(outlet().textContent,'中央社 3');outlet().click();assert.equal(reportCount(),3);
  h.container.querySelector('.nw-filter > button').click();assert.equal(h.select.value,'公視');assert.equal(h.categories.value,'finance');
});

test('R26 chronological outlet reading retains new-progress scope, survives resend and releases listeners',t=>{
  const h=setup(t,w=>w.localStorage.setItem(seenKey,JSON.stringify('2026-09-26T01:00:00Z'))),body=readingTopic();
  h.message(body);focusTopicButtons(h)[0].click();
  const order=h.container.querySelector('.nw-topic-order');order.click();
  const outlet=()=>[...h.container.querySelectorAll('.nw-outlet')].find(b=>b.dataset.outlet==='中央社');
  h.container.querySelector('.nw-new-only').click();
  assert.equal(outlet().textContent,'中央社 3');outlet().click();
  assert.deepEqual(mainTitles(h).map(s=>s.replace(/^新/,'')),['old','middle']);
  h.message({...body,at:'2026-09-26T05:00:00Z'});
  assert.equal(order.getAttribute('aria-pressed'),'true');assert.equal(outlet().getAttribute('aria-pressed'),'true');
  assert.equal(h.container.querySelectorAll('.nw-divider').length,0);
  const oldOutlet=outlet(),clear=h.container.querySelector('.nw-topic-outlet-clear');
  h.handle.unmount();order.click();oldOutlet.click();clear.click();assert.equal(h.container.children.length,0);
});

test('R27 chronological toggle has a fixed visible name and pressed state explains the mode',t=>{
  const h=setup(t);h.message(readingTopic());focusTopicButtons(h)[0].click();
  const button=h.container.querySelector('.nw-topic-order');
  assert.equal(button.textContent,'時間順序');assert.equal(button.getAttribute('aria-pressed'),'false');
  assert.match(button.title,/由舊到新/);button.click();
  assert.equal(button.textContent,'時間順序');assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.match(button.title,/依發布時間/);h.container.querySelector('.nw-topic-latest-order').click();assert.equal(button.textContent,'時間順序');
});
test('R27 20px hysteresis stabilizes scrollbar width feedback without moving focus',t=>{
  const h=responsiveSetup(t);h.message(listing([financeArticle()]));choose(h,h.categories,'finance');
  const root=h.container.querySelector('.nw'),toggle=h.container.querySelector('.nw-panel-toggle');
  h.resize(600);h.categories.focus();h.resize(480);
  assert.equal(root.classList.contains('nw-narrow'),true);
  let moves=0;h.container.addEventListener('focusin',()=>moves++);
  for(let i=0;i<120;i++)h.resize(i%2?496:480);
  assert.equal(moves,0);assert.equal(h.window.document.activeElement,h.categories);
  assert.equal(root.classList.contains('nw-narrow'),true);assert.equal(toggle.hidden,false);
  h.resize(499.9);assert.equal(root.classList.contains('nw-narrow'),true);
  h.resize(500);assert.equal(root.classList.contains('nw-narrow'),false);
  h.resize(484);assert.equal(root.classList.contains('nw-narrow'),false);
  const signal=countButton(h,'signal:0');signal.focus();h.resize(480);
  assert.equal(h.window.document.activeElement,signal);assert.equal(h.container.querySelector('.nw-panel-content').hidden,false);
  toggle.focus();h.resize(500);assert.equal(h.window.document.activeElement,toggle);assert.equal(toggle.hidden,false);
  h.categories.focus();assert.equal(toggle.hidden,true);
  h.resize(560);assert.equal(root.classList.contains('nw-wide-ranking'),true);
  h.resize(544);assert.equal(root.classList.contains('nw-wide-ranking'),true);
  h.resize(540);assert.equal(root.classList.contains('nw-wide-ranking'),false);
});
test('R27 search-only redraw updates collapsed panel title scope immediately on input and clear',t=>{
  const h=responsiveSetup(t);h.message(listing([financeArticle({title:'台積電'})]));choose(h,h.categories,'finance');h.resize(380);
  const toggle=h.container.querySelector('.nw-panel-toggle');
  assert.doesNotMatch(toggle.title,/未套用搜尋/);
  search(h,'台積');assert.match(toggle.title,/未套用搜尋/);assert.equal(toggle.getAttribute('aria-expanded'),'false');
  search(h,'');assert.doesNotMatch(toggle.title,/未套用搜尋/);
  search(h,'無命中');assert.match(toggle.title,/未套用搜尋/);
  h.container.querySelector('.nw-search-input').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.doesNotMatch(toggle.title,/未套用搜尋/);
});

function scrollHarness(t) {
  const h=setup(t),scroller=h.container;
  scroller.style.overflowY='auto';
  Object.defineProperty(scroller,'scrollHeight',{value:3000});Object.defineProperty(scroller,'clientHeight',{value:200});
  scroller.getBoundingClientRect=()=>({top:100,bottom:300});scroller.scrollTop=500;
  const body=listing(['a','b','c'].map(title=>article({title,link:`https://e.test/${title}`})));
  h.message(body);
  let positions={a:640,b:700,c:760};
  const rect=function(){const key=this.href?.split('/').pop();const top=(positions[key]??0)-scroller.scrollTop;return {top,bottom:top+20};};
  h.window.HTMLAnchorElement.prototype.getBoundingClientRect=rect;
  function freezeOld(){for(const link of scroller.querySelectorAll('a.nw-title')) {
    const base=positions[link.href.split('/').pop()];link.getBoundingClientRect=()=>({top:base-scroller.scrollTop,bottom:base-scroller.scrollTop+20});
  }}
  return {...h,body,scroller, shift(next){freezeOld();positions=next;}};
}
test('R28 list deliveries retain visible report offset, fall forward when removed and accept new at',t=>{
  for(const kind of ['same','new','removed']) {
    const h=scrollHarness(t);h.shift({a:800,b:860,c:920});
    const next={...h.body,at:kind==='new'?'2026-09-22T00:00:00Z':h.body.at};
    if(kind==='removed')next.items=next.items.slice(1);
    h.message(next);assert.equal(h.scroller.scrollTop,660,kind);
    const title=h.container.querySelector('a.nw-title');assert.equal(title.getBoundingClientRect().top,kind==='removed'?200:140);
  }
});
test('R28 user edits and keyboard reading skip anchoring; wheel restores mouse reading',t=>{
  const h=scrollHarness(t);h.shift({a:800,b:860,c:920});
  search(h,'b');assert.equal(h.scroller.scrollTop,500);
  search(h,'');h.container.querySelector('.nw-list').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'j',bubbles:true}));
  h.shift({a:960,b:1020,c:1080});h.message(h.body);assert.equal(h.scroller.scrollTop,500);
  // Put a visible row back into the viewport before exercising the wheel path.
  h.scroller.scrollTop=820;h.window.dispatchEvent(new h.window.WheelEvent('wheel'));
  h.shift({a:1120,b:1180,c:1240});h.message(h.body);assert.equal(h.scroller.scrollTop,980);
  assert.match(h.container.querySelector('style').textContent,/overflow-anchor: none/);
});
test('R28 first loading stage gains a 30 second hint without a delivery, clears on completion and cleans timer',t=>{
  const start=Date.parse('2026-09-26T04:00:00Z');t.mock.timers.enable({apis:['Date'],now:start});
  let callback,cleared=false;
  const h=setup(t,w=>{w.setTimeout=(fn,ms)=>{if(ms===30000)callback=fn;return 19;};w.clearTimeout=()=>{cleared=true;};});
  h.up();const status=()=>h.container.querySelector('.nw-status').textContent;
  assert.equal(status(),'等待新聞更新');
  const body={...listing([article()]),model:{state:'working'}};h.message(body);
  assert.match(status(),/新聞已可閱讀・整理分類與話題中/);assert.doesNotMatch(status(),/可按重新整理/);
  t.mock.timers.setTime(start+30000);callback();assert.match(status(),/可按重新整理/);
  h.message({...body,model:{state:'done'}});assert.doesNotMatch(status(),/新聞已可閱讀|可按重新整理/);
  h.message(body);assert.match(status(),/整理中/);assert.doesNotMatch(status(),/新聞已可閱讀/);
  h.handle.unmount();callback();assert.equal(h.container.children.length,0);
  const next=setup(t,w=>{w.setTimeout=()=>19;w.clearTimeout=()=>{cleared=true;};});next.message(body);next.handle.unmount();assert.equal(cleared,true);
});

test('R28 a visible report merged into a child stays visible at its reading offset',t=>{
  const h=scrollHarness(t);h.shift({a:800,b:740,c:920});
  h.message({...h.body,items:h.body.items.map((item,i)=>i<2?{...item,event:'111111111111',event_size:2,
    published:i===1?'2026-09-20T00:00:00Z':item.published}:item)});
  const child=[...h.container.querySelectorAll('.nw-report-title')].find(a=>a.href==='https://e.test/a');
  assert.equal(child.closest('.nw-reports').hidden,false);
  assert.equal(child.closest('.nw-row').querySelector('.nw-expand').getAttribute('aria-expanded'),'true');
  assert.equal(h.scroller.scrollTop,660);assert.equal(child.getBoundingClientRect().top,140);
});

test('R29 topic totals use full members while visible events follow combined filters and resends',t=>{
  const h=setup(t),body=readingTopic();h.message(body);focusTopicButtons(h)[0].click();
  const total=h.container.querySelector('.nw-topic-totals'),shown=h.container.querySelector('.nw-topic-visible');
  assert.equal(total.textContent,'整個話題：4 個事件・5 則・3 家');assert.equal(shown.hidden,true);
  const check=()=>{assert.equal(total.textContent,'整個話題：4 個事件・5 則・3 家');assert.equal(shown.textContent,`目前顯示：${mainRows(h).length} 個事件・${mainRows(h).length+h.container.querySelectorAll('.nw-report').length} 則`);};
  choose(h,h.categories,'finance');assert.equal(shown.hidden,true); // A filter alone does not imply a smaller scope.
  [...h.container.querySelectorAll('.nw-outlet')].find(n=>n.dataset.outlet==='中央社').click();check();assert.equal(mainRows(h).length,2);
  themeButton(h,'memory').click();search(h,'middle');check();assert.equal(mainRows(h).length,1);
  h.message({...body,at:'2026-09-27T00:00:00Z'});check();
  search(h,'none');check();assert.equal(mainRows(h).length,0);
  search(h,'');h.container.querySelector('.nw-topic-outlet-clear').click();assert.equal(shown.hidden,true);
  h.container.querySelector('.nw-filter > button').click();assert.equal(total.hidden,true);assert.equal(shown.hidden,true);
});
test('R29 removing reports without reducing event count still discloses the smaller scope',t=>{
  const h=setup(t),topic=topicRecord({count:3,sources:3});
  const body=topicListing(['甲','乙','丙'].map(source=>article({source,topic:topic.id,event:'111111111111',event_size:3})),[topic]);
  h.message(body);focusTopicButtons(h)[0].click();
  const shown=h.container.querySelector('.nw-topic-visible');assert.equal(shown.hidden,true);
  h.container.querySelector('.nw-outlet').click();assert.equal(shown.hidden,false);assert.equal(shown.textContent,'目前顯示：1 個事件・1 則');
  assert.equal(h.container.querySelector('.nw-topic-totals').textContent,'整個話題：1 個事件・3 則・3 家');
});
test('R29 tone scope explicitly remains whole topic before and after topic filtering',t=>{
  const h=setup(t),body=auditFixture();h.message(body);
  const label=()=>h.container.querySelector('.nw-tone-labels');
  assert.match(label().title,/^整個話題：按報導計，不隨清單篩選變動/);const text=label().textContent;
  focusTopicButtons(h)[0].click();search(h,'no result');
  assert.match(label().title,/^整個話題：按報導計，不隨清單篩選變動/);assert.equal(label().textContent,text);
});

test('R29 full topic totals stay constant through new-progress and numeric/media intersections',t=>{
  const h=setup(t,w=>w.localStorage.setItem(seenKey,JSON.stringify('2026-09-26T01:00:00Z')));h.message(readingTopic());focusTopicButtons(h)[0].click();
  h.container.querySelector('.nw-new-only').click();choose(h,h.categories,'finance');countButton(h,'signal:0').click();
  const total=h.container.querySelector('.nw-topic-totals'),shown=h.container.querySelector('.nw-topic-visible');
  assert.equal(total.textContent,'整個話題：4 個事件・5 則・3 家');assert.equal(shown.textContent,'目前顯示：3 個事件・4 則');
  [...h.container.querySelectorAll('.nw-outlet')].find(b=>b.dataset.outlet==='中央社').click();
  assert.equal(total.textContent,'整個話題：4 個事件・5 則・3 家');assert.equal(shown.textContent,`目前顯示：${mainRows(h).length} 個事件・${mainRows(h).length+h.container.querySelectorAll('.nw-report').length} 則`);assert.equal(mainRows(h).length,2);
});

test('R30 top and 4px tolerance never compensate inserted reports; scrolling beyond it still anchors',t=>{
  for(const offset of [0,1,4,4.1,5])for(const delivery of ['same','new']) {
    const h=scrollHarness(t);h.scroller.scrollTop=offset;
    // Ensure an original report is visible even at the top: the guard, not lack of candidates, must stop correction.
    for(const [index,link] of [...h.container.querySelectorAll('a.nw-title')].entries())
      link.getBoundingClientRect=()=>({top:140+60*index,bottom:160+60*index});
    const added=Array.from({length:8},(_,i)=>article({title:`new${i}`,link:`https://e.test/new${i}`}));
    h.message({...h.body,at:delivery==='new'?'2026-09-27T00:00:00Z':h.body.at,items:[...added,...h.body.items]});
    if(offset<=4)assert.equal(h.scroller.scrollTop,offset,`${delivery} ${offset}`);
    else assert.equal(h.scroller.scrollTop,500,`${delivery} ${offset}`);
    assert.equal(mainRows(h)[0].querySelector('.nw-title').textContent,'new0');
  }
});

test('R26 switching directly to another topic resets chronological reading without requiring return',t=>{
  const h=setup(t),body=readingTopic(),second=topicRecord({id:'bbbbbbbbbbbb',title:'另一話題',count:3,sources:3});
  body.topics.list.push(second);
  body.items.push(...['公視','BBC','中央社 政治'].map((source,i)=>article({source,topic:second.id,title:`另一話題${i}`,link:`https://e.test/second${i}`})));
  h.message(body);focusTopicButtons(h)[0].click();
  const order=h.container.querySelector('.nw-topic-order');order.click();assert.equal(order.getAttribute('aria-pressed'),'true');
  focusTopicButtons(h).find(b=>b.dataset.topicId===second.id).click();
  assert.equal(order.getAttribute('aria-pressed'),'false');assert.equal(h.container.querySelectorAll('.nw-date-divider').length,0);
});
test('R28 keyboard exemption is tested with a visible anchor that would otherwise need correction',t=>{
  const h=scrollHarness(t);
  h.container.querySelector('.nw-list').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'j',bubbles:true}));
  h.shift({a:800,b:860,c:920});h.message(h.body);
  assert.equal(h.scroller.scrollTop,500);
  assert.equal(h.window.document.activeElement.href,'https://e.test/a');
});
test('R28 explicit search never corrects scroll even when a surviving visible row moves, including microtasks',async t=>{
  const h=scrollHarness(t);
  for(const link of h.container.querySelectorAll('a.nw-title'))link.getBoundingClientRect=()=>{
    const index=mainRows(h).indexOf(link.closest('.nw-row'));
    const top=640+index*60-h.scroller.scrollTop;return {top,bottom:top+20};
  };
  search(h,'b');await new Promise(resolve=>h.window.queueMicrotask(resolve));
  assert.deepEqual(mainTitles(h),['b']);assert.equal(h.scroller.scrollTop,500);
  assert.equal(h.container.querySelector('a.nw-title').getBoundingClientRect().top,140);
});

function outletDistribution(h) { return [...h.container.querySelector(".nw-outlet-rows").querySelectorAll(".nw-outlet")].map(n=>n.textContent).join("・"); }

function outletToneFixture() {
  const names=['中央社 政治','中央社 財經','公視','BBC','D','E','F','G'];
  const topic=topicRecord({count:40,sources:7,tone:{negative:8,neutral:8,mixed:8,positive:8}});
  const reports=names.flatMap((source,i)=>['negative','neutral','mixed','positive',null].map((tone,j)=>article({
    title:`報導${i}-${j}`,link:`https://e.test/${i}/${j}`,source,topic:topic.id,tone,event:'111111111111',event_size:40})));
  return {...topicListing(reports,[topic]),sources:names.map((name,i)=>({name,ok:true,outlet:i<2?'中央社':name}))};
}
test('R32 outlet tone rows conserve judged counts, pending and proportions; every outlet click matches reports',t=>{
  const h=setup(t),body=outletToneFixture();h.message(body);focusTopicButtons(h)[0].click();
  const section=h.container.querySelector('.nw-topic-sources'),more=section.querySelector('.nw-outlet-more');
  assert.equal(section.querySelector('h3').textContent,'各家報導語氣（則）');
  assert.equal(more.textContent,'另 2 家（共 7 家）');assert.equal(more.getAttribute('aria-expanded'),'false');
  assert.equal(h.window.document.getElementById(more.getAttribute('aria-controls')).hidden,true);
  more.click();assert.equal(more.getAttribute('aria-expanded'),'true');
  for(const name of ['中央社','公視','BBC','D','E','F','G']) {
    const button=[...section.querySelectorAll('.nw-outlet')].find(b=>b.dataset.outlet===name),row=button.closest('.nw-outlet-row');
    const total=name==='中央社'?10:5,known=total*4/5;
    assert.equal(button.textContent,`${name} ${total}`);
    const values=[...row.querySelectorAll('.nw-outlet-tone')];
    assert.deepEqual(values.map(v=>v.dataset.tone),['negative','neutral','mixed','positive']);
    assert.equal(values.reduce((sum,v)=>sum+Number(v.dataset.count),0),known);
    assert.equal(row.querySelector('.nw-outlet-pending').textContent,`待判定 ${total-known}`);
    assert.deepEqual([...row.querySelectorAll('.nw-outlet-bar .nw-segment')].map(v=>v.style.width),['25%','25%','25%','25%']);
    assert.ok(values.every(v=>v.querySelector('.nw-tone-swatch').getAttribute('aria-hidden')==='true'));
    button.click();assert.equal(mainRows(h).length+h.container.querySelectorAll('.nw-report').length,total);
    const chip=h.container.querySelector('.nw-outlet-chip'),clear=chip.querySelector('button');
    assert.equal(chip.hidden,false);assert.equal(clear.textContent,'✕');assert.equal(clear.getAttribute('aria-label'),'清除媒體篩選');
    assert.equal(chip.closest('.nw-topic-sources'),section);assert.equal(h.container.querySelector('.nw-topic-tools').contains(chip),false);
    clear.click();assert.equal(mainRows(h).length+h.container.querySelectorAll('.nw-report').length,40);
  }
  h.message(body);assert.equal(more.getAttribute('aria-expanded'),'true');more.click();assert.equal(more.getAttribute('aria-expanded'),'false');
  h.handle.unmount();more.click();assert.equal(more.getAttribute('aria-expanded'),'false');
});
test('R32 focus and outlet bars/legends share fixed order and palette even when larger counts come last',t=>{
  const h=setup(t),body=outletToneFixture();body.items=body.items.map((item,i)=>({...item,tone:i%5===0?'negative':i%5===1?'neutral':i%5===2?'mixed':'positive'}));
  body.topics.list[0].tone={negative:8,neutral:8,mixed:8,positive:16};h.message(body);focusTopicButtons(h)[0].click();
  const ids=['negative','neutral','mixed','positive'];
  assert.deepEqual([...h.container.querySelectorAll('.nw-tone-bar .nw-segment')].map(n=>n.className.split('nw-tone-')[1]),ids);
  assert.deepEqual([...h.container.querySelectorAll('.nw-tone-button')].map(n=>n.dataset.toneKey.split(':')[1]),ids);
  assert.deepEqual([...h.container.querySelectorAll('.nw-outlet-legend-item')].map(n=>n.textContent),['負面','中性','正反並陳','正面']);
  for(const swatch of h.container.querySelectorAll('.nw-tone-swatch'))assert.equal(swatch.getAttribute('aria-hidden'),'true');
  const fresh=structuredClone(body);fresh.items=fresh.items.map(i=>({...i,tone:{bad:true}}));fresh.topics.list[0].tone={negative:0,neutral:0,mixed:0,positive:0};h.message(fresh);
  assert.equal(h.container.querySelectorAll('.nw-outlet-tone').length,0);
  assert.ok([...h.container.querySelectorAll('.nw-outlet-bar')].every(n=>!n.hidden && n.childElementCount===0));
  assert.equal(h.container.querySelector('.nw-outlet-pending').textContent,'待判定 10');
});

test('R32 narrow outlet groups keep the button above its bar and counts, with larger spacing between outlets', t => {
  const h = setup(t);
  const css = h.container.querySelector('style').textContent;
  assert.match(css, /\.nw\.nw-narrow \.nw-outlet-rows \{ gap: 12px; \}/);
  assert.match(css, /\.nw\.nw-narrow \.nw-outlet-rows \+ \.nw-outlet-rows \{ margin-top: 12px; \}/);
  assert.match(css, /\.nw\.nw-narrow \.nw-outlet-row \{[^}]*gap: 3px 8px;/);
  assert.match(css, /\.nw\.nw-narrow \.nw-outlet \{ grid-column: 1 \/ -1; \}/);
  assert.doesNotMatch(css, /\.nw\.nw-narrow \.nw-outlet-values \{[^}]*grid-column:/);
  assert.match(css, /\.nw \.nw-outlet-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(36px, \.6fr\) minmax\(0, 1.5fr\)/);
});

test('R33 topic focus collapses on entry, preserves disclosure on resend and restores on exit', t => {
  const h=setup(t),body=auditFixture();h.message(body);
  focusTopicButtons(h)[0].focus();focusTopicButtons(h)[0].click();
  const toggle=h.container.querySelector('.nw-focus-toggle'),cards=h.container.querySelector('.nw-focus-list');
  assert.equal(toggle.textContent,'焦點：2 個話題 ▸');
  assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(cards.hidden,true);
  toggle.click();assert.equal(cards.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  h.message(body);assert.equal(cards.hidden,false);
  toggle.click();assert.equal(cards.hidden,true);
  h.container.querySelector('.nw-filter > button').click();
  assert.equal(cards.hidden,false);assert.equal(h.container.querySelector('.nw-focus-toggle'),null);
});

test('R33 ordering is an exclusive fixed-name group with chronological hint and resets on exit', t => {
  const h=setup(t);h.message(readingTopic());focusTopicButtons(h)[0].click();
  const group=h.container.querySelector('.nw-topic-order-group'),latest=group.children[0],chrono=group.children[1];
  assert.equal(group.getAttribute('role'),'group');assert.equal(group.getAttribute('aria-label'),'報導排序');
  assert.deepEqual([...group.children].map(n=>n.textContent),['最新更新','時間順序']);
  assert.equal(latest.getAttribute('aria-pressed'),'true');assert.equal(chrono.getAttribute('aria-pressed'),'false');
  chrono.click();chrono.click();
  assert.equal(chrono.getAttribute('aria-pressed'),'true');assert.equal(latest.getAttribute('aria-pressed'),'false');
  assert.equal(h.container.querySelector('.nw-order-hint').hidden,false);
  assert.equal(h.container.querySelector('.nw-order-hint').textContent,'由舊到新，依發布時間');
  latest.click();assert.equal(h.container.querySelector('.nw-order-hint').hidden,true);
  assert.deepEqual(mainTitles(h),['new','old','middle','earliest']);
});

test('R33 tone explanations quote criteria and mixed event tags expose report composition', t => {
  const h=setup(t),body=outletToneFixture();h.message(body);focusTopicButtons(h)[0].click();
  for(const node of [h.container.querySelector('.nw-topic-sources h3'),h.container.querySelector('.nw-tone-labels')])
    assert.match(node.title,/正面＝強調成果、進展、合作或利多；負面＝強調分歧、受挫、風險、抗議或批評/);
  assert.match(h.container.querySelector('.nw-topic-sources h3').title,/非媒體立場/);
  assert.equal(mainRows(h)[0].querySelector('.nw-tone-composition').textContent,'負 8・中 8・兩面 8・正 8');
});

test('R34 outlet tone wording and small samples use judged reports, preserve proportions and update at five', t => {
  const h=setup(t),body=outletToneFixture();h.message(body);focusTopicButtons(h)[0].click();
  const section=h.container.querySelector('.nw-topic-sources');
  assert.equal(section.querySelector('h3').textContent,'各家報導語氣（則）');
  assert.equal(section.querySelector('.nw-outlet-explanation').textContent,'依每則標題與摘要判讀對此事件的語氣（AI 判定），不代表媒體整體立場');
  const row=()=>[...section.querySelectorAll('.nw-outlet-row')].find(n=>n.querySelector('button').dataset.outlet==='公視');
  assert.equal(row().querySelector('button').textContent,'公視 5');
  assert.equal(row().querySelector('.nw-outlet-small').textContent,'樣本少');
  assert.match(row().getAttribute('aria-label'),/樣本少/);
  assert.equal(h.window.document.getElementById(row().querySelector('button').getAttribute('aria-describedby')).textContent,'樣本少');
  assert.ok(row().querySelector('.nw-outlet-bar').classList.contains('nw-small-sample'));
  assert.deepEqual([...row().querySelectorAll('.nw-segment')].map(n=>n.style.width),['25%','25%','25%','25%']);
  assert.equal(row().querySelector('[data-tone="mixed"]').textContent,'兩面 1');
  assert.equal(row().querySelector('[data-tone="mixed"]').title,'正反並陳 1 則報導');
  body.items=body.items.map(i=>i.source==='公視'&&!i.tone?{...i,tone:'positive'}:i);h.message(body);
  assert.equal(row().querySelector('.nw-outlet-small'),null);
  assert.equal(row().querySelector('button').hasAttribute('aria-describedby'),false);
  assert.doesNotMatch(row().getAttribute('aria-label'),/樣本少/);
  assert.equal(row().querySelector('.nw-outlet-bar').classList.contains('nw-small-sample'),false);
  assert.deepEqual([...row().querySelectorAll('.nw-segment')].map(n=>n.style.width),['20%','20%','20%','40%']);
  const css=h.container.querySelector('style').textContent;
  assert.match(css,/\.nw \.nw-outlet-bar\.nw-small-sample \{ opacity: \.45; \}/);
});


test('R34 all-pending outlets retain an empty bar cell before the pending numbers in both layouts', t => {
  const h=setup(t),body=outletToneFixture();
  body.items=body.items.map(item=>({...item,tone:null}));
  h.message(body);focusTopicButtons(h)[0].click();
  const root=h.container.querySelector('.nw');
  for(const narrow of [false,true]) {
    root.classList.toggle('nw-narrow',narrow);
    for(const row of h.container.querySelectorAll('.nw-outlet-row')) {
      const [button,bar,values]=row.children;
      assert.ok(button.matches('.nw-outlet'));assert.ok(bar.matches('.nw-outlet-bar'));
      assert.equal(bar.hidden,false);assert.equal(bar.style.display,'');
      assert.equal(bar.childElementCount,0);assert.equal(bar.getAttribute('aria-hidden'),'true');
      assert.ok(values.matches('.nw-outlet-values'));
      assert.equal(values.querySelector('.nw-outlet-pending').parentElement,values);
      assert.match(values.textContent,/待判定 (5|10)/);
    }
  }
  assert.match(h.container.querySelector('.nw-topic-sources h3').title,/各家則數只算該家符合目前篩選的報導，清單會保留整個事件，所以加總可能與目前顯示不同/);
});
