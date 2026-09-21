import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const expected = JSON.parse(readFileSync(new URL('../modudock.json', import.meta.url)));
const timer = setTimeout(() => { console.error('FAIL: catalog timeout'); process.exit(1); }, 5000);
const ws = new WebSocket('ws://127.0.0.1:8731/ws');
ws.addEventListener('error', () => { console.error('FAIL: WebSocket error'); process.exit(1); });
ws.addEventListener('message', ({ data }) => {
  try {
    const packet = JSON.parse(data);
    if (packet.t !== 'catalog') return;
    const news = packet.modules.filter(m => m.id === 'news');
    assert.equal(news.length, 1);
    assert.deepEqual(news[0], expected);
    console.log('PASS: /ws catalog contains exactly one news; all manifest fields match');
    clearTimeout(timer);
    ws.close(1000);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
