import { Window } from 'happy-dom';
import mount from '../front/front.js';
import { topicNames, themeNames, regionNames, issueNames, eventId, validAnalysis, topicOf } from '../front/labels.js';

import test from 'node:test';
import assert from 'node:assert/strict';

// Deterministic actions with real mount/unmount and DOM event handlers.
const seeds = Number(process.env.NEWS_WALK_SEEDS || 20);
const steps = Number(process.env.NEWS_WALK_STEPS || 300);
const firstSeed = Number(process.env.NEWS_WALK_SEED || 1);
assert.ok(Number.isSafeInteger(seeds) && seeds > 0);
assert.ok(Number.isSafeInteger(steps) && steps > 0);
assert.ok(Number.isSafeInteger(firstSeed));
for (let i=0; i<seeds; i++) test(`front walk seed=${firstSeed+i}`, async () => {
let seed = firstSeed+i;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const SRC = ['甲', '乙', '丙', '丁'];
const CATS = ['finance', 'tech', 'world', 'politics', 'sports', ''];
const hex = n => n.toString(16).padStart(12, '0');
const themes = [...themeNames.keys()], regions = [...regionNames.keys()], issues = [...issueNames.keys()];

function genList(n) {
  const items = [];
  const cnt = 5 + Math.floor(rnd() * 25);
  for (let i = 0; i < cnt; i++) {
    const cat = n < 2 && rnd()<0.8 ? '' : pick(CATS);
    const ev = rnd() < 0.6 ? hex(1 + Math.floor(rnd() * 8)) : null;
    const it = { title: `t${i}${rnd() < 0.3 ? ' 台積電' : ''}`, source: pick(SRC), summary: rnd() < 0.7 ? `s${i}` : '',
      link: `https://e.com/${Math.floor(rnd() * 40)}`,
      published: new Date(Date.UTC(2026, 8, 21, 0, Math.floor(rnd() * 600))).toISOString(), category: cat };
    if (ev) { it.event = ev; it.event_size = 2; }
    if (rnd() < 0.7) {
      if (cat === 'world') it.analysis = { kind: 'world', trend: pick(['escalation', 'stalemate', 'deescalation', 'not_conflict']), region: pick(regions) };
      else if (cat === 'politics') it.analysis = { kind: 'politics', issue: pick(issues) };
      else if (cat === 'finance' || cat === 'tech') it.analysis = { kind: 'finance', market: pick(['positive', 'negative', 'mixed', 'not_market']), theme: pick(themes.slice(0, 5)), dir: pick(['bull', 'bear']), dir_p: rnd() };
    }
    if (rnd() < 0.4) it.topic = hex(0x100 + Math.floor(rnd() * 3));
    items.push(it);
  }
  // dedupe links like backend
  const seen = new Set(); const out = items.filter(i => !seen.has(i.link) && seen.add(i.link));
  const topicIds = [...new Set(out.map(i => i.topic).filter(Boolean))];
  const topics = topicIds.filter(() => rnd() < 0.85).map(id => ({ id, title: 'topic ' + id.slice(-2), sources: 3, count: out.filter(i => i.topic === id).length }));
  return { op: 'list', at: `2026-09-21T0${n % 10}:00:00Z`, items: out,
    sources: SRC.map(name => ({ name, ok: true, count: out.filter(i => i.source === name).length })),
    topics: { list: topics }, model: { state: pick(['working', 'done', 'paused', 'off']) }, classify: { enabled: rnd()<0.9, pending: Math.floor(rnd()*3) }, events: { pending: Math.floor(rnd()*2) } };
}

const window = new Window();
window.localStorage.setItem('modudock.module.news.lastSeen', JSON.stringify('2026-09-21T05:00:00Z'));
window.localStorage.setItem('modudock.module.news.watch', JSON.stringify(['台積電']));
const document = window.document;
let inst;
function mk() {
  window.localStorage.setItem('modudock.module.news.view', JSON.stringify({source: pick(['',...SRC,'X']), category: pick(CATS)}));
  const container = document.createElement('div'); document.body.append(container);
  let message, up;
  const handle = mount({ container, channel: { onMessage(f) { message = f; }, send() {} }, onUp(f) { up = f; }, report() {} });
  up();
  return { container, handle, message, q: s => container.querySelector(s), qa: s => [...container.querySelectorAll(s)] };
}
inst = mk();
let last = null, n = 0;
const log = [];
function act() {
  const h = inst; const r = rnd();
  const click = (sel, name) => { const els = h.qa(sel).filter(e => !e.closest('[hidden]')); if (els.length) { const e = pick(els); log.push(name + ':' + (e.dataset.topic || e.dataset.topicId || e.dataset.event || e.textContent).slice(0, 30)); e.click(); } };
  if (r < 0.25) { last = genList(rnd()<0.3? n : n++); log.push('resend'); h.message(last); }
  else if (r < 0.32) { const s = h.q('[aria-label=新聞來源]'); s.value = pick(['', ...SRC]); log.push('source=' + s.value); s.dispatchEvent(new window.Event('change')); }
  else if (r < 0.42) { const s = h.q('[aria-label=新聞類別]'); s.value = pick(CATS); log.push('cat=' + s.value); s.dispatchEvent(new window.Event('change')); }
  else if (r < 0.50) click('.nw-theme', 'theme');
  else if (r < 0.58) click('.nw-focus-count', 'focusbtn');
  else if (r < 0.62) click('.nw-filter > button', 'clearTheme');
  else if (r < 0.64) click('.nw-empty button', 'clearAll');
  else if (r < 0.70) click('.nw-watch-only', 'watchOnly');
  else if (r < 0.71) click('.nw-history-toggle', 'history');
  else if (r < 0.72) { log.push('refresh'); h.q('.nw-toolbar > button').click(); }
  else if (r < 0.78) click('.nw-list .nw-expand, .nw-list .nw-summary-toggle', 'rowbtn');
  else if (r < 0.88) { const els = h.qa('.nw-list a, .nw-focus-row a, .nw-list button, .nw-theme, .nw-focus-count').filter(e => !e.closest('[hidden]')); if (els.length) { const e = pick(els); e.focus(); log.push('focus ' + e.className); } }
  else if (r < 0.96) { const key = pick(['j', 'k', 's', 'e']); const t = document.activeElement && h.container.contains(document.activeElement) ? document.activeElement : h.q('.nw-list'); log.push('key ' + key); t.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }
  else if (r < 0.98) { log.push('remount'); h.handle.unmount(); h.container.remove(); inst = mk(); if (last) inst.message(last); }
  else { const w = pick([['台積電'], [], ['t1']]); h.q('.nw-watch-input').value = w.join(' '); log.push('watch=' + w); h.q('.nw-watch-settings button').click(); }
}

function check() {
  const h = inst; const errs = [];
  if (!last) return errs;
  const src = h.q('[aria-label=新聞來源]').value, cat = h.q('[aria-label=新聞類別]').value;
  const pressedTheme = h.qa('.nw-theme[aria-pressed=true]').map(b => b.dataset.topic);
  const label = h.q('.nw-filter > span').textContent;
  const filterVisible = !h.q('.nw-filter').hidden;
  const topicMode = filterVisible && label.startsWith('話題');
  const themeMode = filterVisible && label.startsWith('已篩選');
  const watchOn = h.q('.nw-watch-only').getAttribute('aria-pressed') === 'true';
  const panelVisible = !h.q('.nw-panel').hidden;
  if (pressedTheme.length > 1) errs.push('multiple pressed themes');
  
  if (watchOn && (panelVisible || !h.q('.nw-focus-section').hidden)) errs.push('watch-only but panel/focus visible');
  if (watchOn !== !h.q('.nw-watch-hint').hidden) errs.push('watch hint mismatch');
  const pressedTopic = h.qa('.nw-focus-count[aria-pressed=true]');
  if (!topicMode && !h.q('.nw-focus-section').hidden && pressedTopic.length) errs.push('topic pressed but not topic mode');
  if (topicMode && !h.q('.nw-focus-section').hidden && pressedTopic.length !== 1) errs.push('topic mode but pressed topics=' + pressedTopic.length);
  // R6 allows category changes inside a topic; source changes still leave it.
  if (topicMode && src) errs.push(`topic mode with source=${src}`);
  const topicId = topicMode ? pressedTopic[0]?.dataset.topicId : '';
  // expected groups
  const ns = cat==='world'?'region:':cat==='politics'?'issue:':''; const theme = themeMode ? (pressedTheme[0] || [...topicNames].find(([id,n])=>label==='已篩選：'+(id==='region:other'?'其他地區':id==='issue:other'?'其他議題':n) && (ns? id.startsWith(ns): !id.includes(':')))?.[0]) : '';
  const items = last.items.filter(i => (!src || i.source === src) && (!cat || i.category === cat) && (!topicId || i.topic === topicId)
    && (!theme || topicOf(validAnalysis(i)) === theme));
  const words = JSON.parse(window.localStorage.getItem('modudock.module.news.watch') || '[]');
  const gm = new Map();
  for (const i of items) { const id = eventId(i); if (id) { if (!gm.has(id)) gm.set(id, []); gm.get(id).push(i); } else gm.set(Symbol(), [i]); }
  let exp = 0; for (const g of gm.values()) if (!watchOn || g.some(i => words.some(w => (i.title + i.summary).toLowerCase().includes(w.toLowerCase())))) exp++;
  const rows = h.qa('.nw-list .nw-row').length;
  if (!(topicMode && !topicId)) if (rows !== exp) errs.push(`rows ${rows} expected ${exp} (src=${src} cat=${cat} theme=${theme} topic=${topicId} watch=${watchOn})`);
  if ((rows > 0) === !h.q('.nw-empty').hidden) errs.push('empty mismatch');
  // category counts
  for (const o of h.q('[aria-label=新聞類別]').options) {
    const its = last.items.filter(i => (!src || i.source === src) && (!o.value || i.category === o.value));
    const s = new Set(); let c = 0; for (const i of its) { const id = eventId(i); if (!id) c++; else if (!s.has(id)) { s.add(id); c++; } }
    if (!o.textContent.endsWith(' ' + c)) errs.push(`cat option ${o.value} "${o.textContent}" expected ${c}`);
  }
  // R9: faceted menus count events within the other selected dimension.
  for (const o of h.q('[aria-label=新聞來源]').options) {
    const its = last.items.filter(i => (!cat || i.category === cat) && (!o.value || i.source === o.value));
    const seen = new Set(); let count = 0;
    for (const item of its) { const id = eventId(item); if (!id) count++; else if (!seen.has(id)) { seen.add(id); count++; } }
    if (o.textContent !== `${o.value || '全部來源'} ${count}`) errs.push(`source option ${o.value} expected ${count}`);
  }
  const a = document.activeElement;
  if (a && h.container.contains(a) && (a.closest('[hidden]') || a.disabled)) errs.push('focus in hidden/disabled: ' + a.className + ' ' + a.textContent.slice(0, 20));
  for (const b of h.qa('.nw-list .nw-expand')) if ((b.getAttribute('aria-expanded') === 'true') === b.closest('.nw-row').querySelector('.nw-reports').hidden) errs.push('expand aria mismatch');
  for (const b of h.qa('.nw-list .nw-summary-toggle')) if ((b.getAttribute('aria-expanded') === 'true') === document.getElementById(b.getAttribute('aria-controls')).hidden) errs.push('summary aria mismatch');
  if (h.qa('.nw-divider').length > 1) errs.push('multiple dividers');
  return errs;
}

try {
  for (let step=0; step<steps; step++) {
    try {
      act();
      assert.deepEqual(check(), []);
    } catch (error) {
      throw new Error(`seed=${firstSeed+i} step=${step} actions=${log.slice(-15).join('; ')}: ${error.message}`, {cause:error});
    }
  }
} finally {
  inst.handle.unmount();
  inst.container.remove();
  await window.happyDOM.abort();
}
});
