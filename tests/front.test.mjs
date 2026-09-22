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
  const local = `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  assert.equal(h.container.querySelector('li').textContent, `[未分類] 甲 · ${local} · 新聞`);
  assert.equal(h.container.querySelector('[role=status]').textContent,
    '更新：2026-09-21T02:04:00Z · 失敗來源：1 · 未分類：0');
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
  assert.equal(h.container.querySelector('li').textContent, '[未分類]  ·  · ');
  assert.equal(h.container.querySelector('span[title]').title, '');
  assert.equal(h.select.options.length, 1);
  h.message({op: 'list', items: {}, sources: {}, at: {}});
  assert.equal(h.container.querySelectorAll('li').length, 0);
  assert.equal(h.container.querySelector('[role=status]').textContent, '更新： · 失敗來源：0 · 未分類：0');
});

test('source filter is rebuilt, selection preserved or reset when removed', t => {
  const h = setup(t);
  const items = [article(), article({source: '乙'})];
  h.message(listing(items));
  h.select.value = '乙';
  h.select.dispatchEvent(new h.window.Event('change'));
  assert.equal(h.container.querySelectorAll('li').length, 1);
  assert.ok(h.container.querySelector('li').textContent.startsWith('[未分類] 乙 ·'));
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
  known.forEach(([, name], i) => assert.ok(rows[i].textContent.startsWith(`[${name}] `)));
  rows.slice(known.length).forEach(row => assert.ok(row.textContent.startsWith('[未分類] ')));
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
    assert.ok(status().endsWith(` · 未分類：${pending}`));
  }
  for (const pending of [-1, 0.5, '3', true, null, undefined, {}, [], NaN, Infinity]) {
    h.message({...listing([]), classify: {enabled: true, pending}});
    assert.ok(status().endsWith(' · 未分類：0'));
  }
  for (const classify of [undefined, null, false, 'bad', [], {}]) {
    assert.doesNotThrow(() => h.message({...listing([]), classify}));
    assert.ok(status().endsWith(' · 未分類：0'));
  }
  for (const enabled of [0, 'false', null]) {
    h.message({...listing([]), classify: {enabled, pending: 2}});
    assert.ok(status().endsWith(' · 未分類：2'));
  }
});
