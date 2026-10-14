import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/state/visibleInterval.ts', import.meta.url), 'utf8');
function fixture(hidden) {
  const document = new EventTarget();
  document.hidden = hidden;
  const timers = new Map();
  let id = 0;
  const context = vm.createContext({ document, setInterval: fn => (timers.set(++id, fn), id), clearInterval: n => timers.delete(n) });
  vm.runInContext(stripTypeScriptTypes(source).replace('export function', 'function') + '\nglobalThis.start = visibleInterval;', context);
  return { document, timers, start: context.start, reveal(value) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')); } };
}

test('polling stops while hidden, resumes with one immediate refresh, and cleans up', () => {
  const f = fixture(false);
  let reads = 0;
  const stop = f.start(() => reads++, 3000);
  assert.equal(f.timers.size, 1);
  assert.equal(reads, 0, 'callers already perform initial load');
  [...f.timers.values()][0]();
  assert.equal(reads, 1);
  f.reveal(true);
  assert.equal(f.timers.size, 0);
  assert.equal(reads, 1);
  f.reveal(false);
  assert.equal(reads, 2, 'fresh state immediately when shown');
  assert.equal(f.timers.size, 1);
  f.reveal(false);
  assert.equal(f.timers.size, 1, 'no timer accumulation');
  stop();
  assert.equal(f.timers.size, 0);
  const final = reads;
  f.reveal(false);
  assert.equal(reads, final);
});

test('a panel initially mounted hidden creates no polling timer', () => {
  const f = fixture(true);
  let reads = 0;
  const stop = f.start(() => reads++, 5000);
  assert.equal(f.timers.size, 0);
  f.reveal(false);
  assert.equal(reads, 1);
  assert.equal(f.timers.size, 1);
  stop();
});

test('native background throttling stays enabled; activity indicators do not loop', async () => {
  const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const sidebar = await readFile(new URL('../../src/sidebar/sidebar.css', import.meta.url), 'utf8');
  assert.match(main, /backgroundThrottling: true/);
  assert.doesNotMatch(sidebar, /animation:.*infinite/);
});
