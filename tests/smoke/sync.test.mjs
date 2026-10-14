// Races in src/state/paseo.ts with a mocked driver (no real daemon or user agents).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const defer = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };
async function load(mock) {
  let src = await readFile(new URL('../../src/state/paseo.ts', import.meta.url), 'utf8');
  src = src.replace('private listeners','listeners').replace('constructor(private value: T) {}', 'value; constructor(value) { this.value = value; }').replace('constructor(private value: T, private deferWhenHidden = false) { this.snapshot = value; }', 'value; deferWhenHidden; constructor(value, deferWhenHidden = false) { this.value = value; this.deferWhenHidden = deferWhenHidden; this.snapshot = value; }').replace(/^import .*$/gm, '').replace('new DaemonClient(', 'new globalThis.__M.DaemonClient(').replace('createPaseoApi(driver)', 'globalThis.__M.api');
  src = src.replace(/export function ensureConnected\(\) \{[\s\S]*?\n\}/, 'export function ensureConnected() {}');
  src = 'const useEffect = () => {}, useSyncExternalStore = () => {};\n' + src;
  globalThis.__M = mock;
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(src)).toString('base64')}#${Math.random()}`);
}
const ag = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });

function mockApi() {
  const m = { listeners: [], lists: [], snapObs: [], subscribeCalls: 0, timelines: {} };
  m.DaemonClient = class { getConnectionState() { return { status: 'connected' }; } connect() { return Promise.resolve(); } };
  m.api = {
    agents: {
      subscribe: (h) => (m.listeners.push(h), () => {}),
      list: (o) => {
        const d = defer(); m.lists.push({ o, d });
        if (o?.subscribe) m.subscribeCalls++;
        return d.promise.then((entries) => ({ entries: entries.map((agent) => ({ agent })), ...(o?.subscribe ? { subscription: { subscribe: (obs) => { m.snapObs.push(obs); obs.snapshot({ entries: entries.map(agent => ({ agent })) }); } } } : {}) }));
      },
      ref: (id) => (m.timelines[id] ??= (() => {
        const t = { fetches: [], sub: null, subscriptions: 0, releases: 0, agentSubscriptions: 0, agentReleases: 0 };
        t.handle = {
          timeline: {
            refetch: () => { const d = defer(); t.fetches.push(d); return d.promise; },
            subscribe: (h) => { t.subscriptions++; t.sub = h; const off = () => { t.releases++; if (t.sub === h) t.sub = null; }; off.ready = Promise.resolve(); return off; },
          },
          subscribe: () => { t.agentSubscriptions++; return () => t.agentReleases++; },
        };
        return t;
      })()).handle,
    },
  };
  return m;
}
const tick = () => new Promise((r) => setImmediate(r));

test('one retained subscription; refreshes are ordinary lists; stale snapshot cannot undo newer events', async () => {
  const m = mockApi(); const p = await load(m);
  const first = p.refreshAgents();
  m.listeners[0]({ kind: 'upsert', agent: ag('a', '2', { title: 'initial rename' }) });
  m.lists[0].d.resolve([ag('a', '1', { title: 'old' })]); await first;
  assert.equal(p.agentsStore.get()[0].title, 'initial rename', 'cached subscription snapshot cannot undo bootstrap events');
  assert.equal(m.subscribeCalls, 1);
  const second = p.refreshAgents(); await tick();
  assert.equal(m.lists.length, 2); assert.equal(m.lists[1].o, undefined, 'ordinary list, no new subscription');
  m.listeners[0]({ kind: 'upsert', agent: ag('a', '2', { title: 'renamed' }) }); // arrives during fetch
  m.listeners[0]({ kind: 'remove', agentId: 'b' });
  m.lists[1].d.resolve([ag('a', '1', { title: 'old' }), ag('b', '1')]); await second;
  assert.deepEqual(p.agentsStore.get().map((a) => [a.id, a.title]), [['a', 'renamed']]);
  const third = p.refreshAgents(); await tick();
  m.lists[2].d.resolve([ag('a', '2', { title: 'renamed' })]); await third;
  assert.equal(m.subscribeCalls, 1);
});

test('reconnect snapshot from the owned subscription converges removals and refreshes mounted metadata', async () => {
  const m = mockApi(); const p = await load(m);
  const first = p.refreshAgents(); m.lists[0].d.resolve([ag('a', '1'), ag('gone', '1')]); await first;
  p.timelineStore('a').set({ ...p.timelineStore('a').get(), agent: ag('a', '1', { model: 'x' }) });
  assert.equal(m.snapObs.length, 1);
  p.applyAgentSnapshot([ag('a', '1', { model: 'y' })]); // as delivered on restore
  assert.deepEqual(p.agentsStore.get().map((a) => a.id), ['a']);
});

test('timeline observers share lifecycle; reopen refetches and ignores late results from prior observation', async () => {
  const m = mockApi(); const p = await load(m);
  const store = p.timelineStore('life');
  const first = store.subscribe(() => {}), second = store.subscribe(() => {});
  const t = m.timelines.life;
  await tick();
  assert.equal(t.subscriptions, 1);
  assert.equal(t.agentSubscriptions, 1);
  assert.equal(t.fetches.length, 1);
  first();
  await tick();
  assert.equal(t.releases, 0, 'one observer keeps both SDK subscriptions alive');
  second();
  await tick();
  assert.equal(t.releases, 1);
  assert.equal(t.agentReleases, 1);

  const third = store.subscribe(() => {});
  await tick();
  assert.equal(t.subscriptions, 2);
  assert.equal(t.fetches.length, 2, 'reopening fetches a fresh tail');
  t.fetches[1].resolve({ entries: [{ item: { type: 'user_message', text: 'latest' } }], epoch: 'new' });
  await tick();
  t.fetches[0].resolve({ entries: [{ item: { type: 'user_message', text: 'stale' } }], epoch: 'old' });
  await tick();
  assert.deepEqual(store.get().blocks.map((b) => b.text), ['latest']);
  third();
  await tick();
  assert.equal(t.releases, 2);
  assert.equal(t.agentReleases, 2);
});

test('timeline: replacement during fetch queues one refetch, old epoch is not replayed', async () => {
  const m = mockApi(); const p = await load(m);
  const store = p.timelineStore('t'); const off = store.subscribe(() => {}); const t = m.timelines.t; await tick();
  assert.equal(t.fetches.length, 1);
  const item = (text, seq, epoch) => ({ seq, epoch, event: { type: 'timeline', item: { type: 'assistant_message', text } } });
  t.sub(item('old-epoch', 5, 'e1'));
  t.sub(item('new', 3, 'e2'));
  t.sub({ event: { type: 'replacement' } }); // while fetching
  t.fetches[0].resolve({ epoch: 'e2', endCursor: { seq: 2 }, entries: [{ item: { type: 'user_message', text: 'hi' } }] });
  await tick(); await tick();
  assert.equal(t.fetches.length, 2, 'exactly one queued refetch');
  assert.deepEqual(store.get().blocks.map((b) => b.text), ['hi', 'new']);
  t.fetches[1].resolve({ epoch: 'e3', endCursor: { seq: 0 }, entries: [{ item: { type: 'user_message', text: 'fresh' } }] });
  await tick(); await tick();
  assert.deepEqual(store.get().blocks.map((b) => b.text), ['fresh']);
  assert.equal(t.fetches.length, 2);
});

test('equivalent cursor objects permit paging; stale cursors release the loading flag', async () => {
  const m = mockApi(); const p = await load(m);
  const store = p.timelineStore('t'); const off = store.subscribe(() => {}); const t = m.timelines.t; await tick();
  t.fetches[0].resolve({ epoch: 'e', startCursor: { epoch: 'e', seq: 10 }, hasOlder: true, entries: [{ item: { type: 'user_message', text: 'tail' } }] }); await tick();
  const early = p.loadEarlier('t'); await tick();
  store.set({ ...store.get(), startCursor: { epoch: 'e', seq: 10 } });
  t.fetches[1].resolve({ entries: [{ item: { type: 'user_message', text: 'older' } }], startCursor: { epoch: 'e', seq: 1 }, hasOlder: true }); await early;
  assert.deepEqual(store.get().blocks.map(b => b.text), ['older', 'tail']);
  assert.equal(store.get().loadingEarlier, false);
  const stale = p.loadEarlier('t'); await tick();
  store.set({ ...store.get(), startCursor: { epoch: 'replacement', seq: 1 } });
  t.fetches[2].resolve({ entries: [{ item: { type: 'user_message', text: 'discard' } }], startCursor: { epoch: 'e', seq: 0 }, hasOlder: false }); await stale;
  assert.equal(store.get().loadingEarlier, false);
  assert(!store.get().blocks.some(b => b.text === 'discard'));
});

test('loadEarlier result is discarded when a refetch replaced the history', async () => {
  const m = mockApi(); const p = await load(m);
  const store = p.timelineStore('t'); const off = store.subscribe(() => {}); const t = m.timelines.t; await tick();
  t.fetches[0].resolve({ epoch: 'e', startCursor: { seq: 10 }, hasOlder: true, entries: [{ item: { type: 'user_message', text: 'tail' } }] });
  await tick();
  const early = p.loadEarlier('t'); await tick();
  const page = t.fetches[1];
  p.retryTimeline('t'); await tick(); // refetch starts (new fetch #3)
  page.resolve({ entries: [{ item: { type: 'user_message', text: 'older' } }], startCursor: { seq: 1 }, hasOlder: false });
  t.fetches[2].resolve({ epoch: 'e2', startCursor: { seq: 20 }, hasOlder: true, entries: [{ item: { type: 'user_message', text: 'new tail' } }] });
  await early; await tick();
  assert.deepEqual(store.get().blocks.map((b) => b.text), ['new tail']);
});
