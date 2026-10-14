import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };

async function load(mock) {
  let source = await readFile(new URL('../../src/state/paseo.ts', import.meta.url), 'utf8');
  source = source.replace('private listeners', 'listeners')
    .replace('constructor(private value: T) {}', 'value; constructor(value) { this.value = value; }')
    .replace('constructor(private value: T, private deferWhenHidden = false) { this.snapshot = value; }', 'value; deferWhenHidden; constructor(value, deferWhenHidden = false) { this.value = value; this.deferWhenHidden = deferWhenHidden; this.snapshot = value; }')
    .replace(/^import .*$/gm, '')
    .replace('new DaemonClient(', 'new globalThis.__M.DaemonClient(')
    .replace('createPaseoApi(driver)', 'globalThis.__M.api');
  source = 'const useEffect = globalThis.__M.useEffect, useSyncExternalStore = () => {};' + source;
  globalThis.__M = mock;
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}#${Math.random()}`);
}

function harness({ autoConnect = true, agents = [] } = {}) {
  const mock = {
    state: { status: 'idle' }, lastError: null, autoConnect, connectionListeners: [], connectionReads: 0,
    connectCalls: 0, listCalls: [], agentListeners: [], listObservers: [], timelineHandles: new Map(),
    agents, intervals: [], cleanups: [], metadata: new Map(),
    emitConnection(state) {
      this.state = state;
      this.lastError = state.status === 'disconnected' ? (state.reason ?? null) : null;
      for (const listener of this.connectionListeners) listener(state);
    },
    getHandle(id) {
      if (!this.timelineHandles.has(id)) {
        const entry = { fetches: [], sub: null, agentListeners: new Set(), refreshCalls: 0, current: this.metadata.get(id) ?? null };
        const handle = {
          timeline: {
            refetch: () => { const d = defer(); entry.fetches.push(d); return d.promise; },
            subscribe: (listener) => { entry.sub = listener; const off = () => { if (entry.sub === listener) entry.sub = null; }; off.ready = Promise.resolve(); return off; },
          },
          subscribe: (listener) => { entry.agentListeners.add(listener); return () => entry.agentListeners.delete(listener); },
          refresh: async () => { entry.refreshCalls++; entry.current = this.metadata.get(id) ?? entry.current; return entry.current; },
          current: () => entry.current,
        };
        entry.handle = handle;
        this.timelineHandles.set(id, entry);
      }
      return this.timelineHandles.get(id).handle;
    },
    DaemonClient: class {
      constructor() { this.owner = mock; }
      get lastError() { return this.owner.lastError; }
      getConnectionState() { this.owner.connectionReads++; return this.owner.state; }
      subscribeConnectionStatus(listener) {
        this.owner.connectionListeners.push(listener);
        listener(this.owner.state);
        return () => {};
      }
      connect() {
        this.owner.connectCalls++;
        if (this.owner.autoConnect) this.owner.emitConnection({ status: 'connected' });
        return Promise.resolve();
      }
    },
  };
  mock.useEffect = (effect) => { mock.cleanups.push(effect() ?? (() => {})); };
  mock.api = {
    agents: {
      subscribe: (listener) => (mock.agentListeners.push(listener), () => {}),
      list: (options) => {
        mock.listCalls.push(options);
        const entries = mock.agents.map((agent) => ({ agent }));
        const result = { entries };
        if (options?.subscribe) result.subscription = { subscribe: (observer) => {
          mock.listObservers.push(observer);
          observer.snapshot({ entries });
        } };
        return Promise.resolve(result);
      },
      ref: (id) => mock.getHandle(id),
    },
  };
  return mock;
}

async function withGlobals(mock, run) {
  const old = {
    document: globalThis.document, window: globalThis.window,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  };
  const documentListeners = new Map(), windowListeners = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  globalThis.window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  globalThis.setInterval = (callback, delay) => {
    const timer = { callback, delay, active: true };
    mock.intervals.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => { if (timer) timer.active = false; };
  const cleanup = () => {
    for (const dispose of mock.cleanups.splice(0)) dispose();
    if (old.document === undefined) delete globalThis.document; else globalThis.document = old.document;
    if (old.window === undefined) delete globalThis.window; else globalThis.window = old.window;
    globalThis.setInterval = old.setInterval;
    globalThis.clearInterval = old.clearInterval;
  };
  try { await run({ documentListeners, windowListeners, cleanup }); }
  finally { cleanup(); }
}

async function mountedTimeline(mock, p, agentId) {
  p.useTimeline(agentId);
  const store = p.timelineStore(agentId);
  store.subscribe(() => {});
  const entry = mock.timelineHandles.get(agentId);
  await tick();
  assert.equal(entry.fetches.length, 1);
  entry.fetches[0].resolve({ entries: [], agent: mock.metadata.get(agentId) ?? undefined, epoch: 'e1', endCursor: { seq: 0 } });
  await tick();
  return { store, entry };
}

test('visible timeline text/reasoning/tools batch at 250ms and turn-end flushes pending state immediately', async () => {
  const mock = harness();
  await withGlobals(mock, async () => {
    const p = await load(mock);
    const { store, entry } = await mountedTimeline(mock, p, 'stream');
    let publications = 0;
    store.subscribe(() => publications++);
    const timeline = (item) => entry.sub({ event: { type: 'timeline', item } });
    timeline({ type: 'assistant_message', text: 'hello ' });
    timeline({ type: 'assistant_message', text: 'world' });
    timeline({ type: 'reasoning', text: 'thinking' });
    timeline({ type: 'tool_call', callId: 'tool-1', name: 'Read', status: 'running' });
    assert.equal(publications, 0, 'text deltas are batched');
    assert.notEqual(store.getSnapshot(), store.get(), 'React snapshot remains stable while get() exposes current state');
    assert.deepEqual(store.get().blocks.map((block) => block.kind), ['assistant', 'reasoning', 'tool']);
    assert.equal(store.get().blocks[0].text, 'hello world');
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.equal(publications, 1);

    timeline({ type: 'assistant_message', text: ' final' });
    timeline({ type: 'assistant_message', text: ' block' });
    entry.sub({ event: { type: 'turn_completed' } });
    assert.equal(publications, 2, 'turn completion publishes pending text and status without waiting');
    assert.equal(store.get().blocks.at(-1).text, ' final block');
    assert.equal(store.get().running, false);
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.equal(publications, 2, 'the canceled batch timer does not publish twice');
  });
});

test('ordinary Store subscribers publish while hidden; hidden timeline defers and visibility resumes once', async () => {
  const initial = { id: 'hidden', updatedAt: '1', status: 'running', model: 'old', pendingPermissions: [] };
  const mock = harness({ agents: [initial] });
  mock.metadata.set('hidden', initial);
  await withGlobals(mock, async ({ documentListeners }) => {
    const p = await load(mock);
    const { store, entry } = await mountedTimeline(mock, p, 'hidden');
    let publications = 0;
    store.subscribe(() => publications++);
    const visibility = documentListeners.get('visibilitychange');
    globalThis.document.hidden = true;
    visibility();
    assert.equal(mock.intervals.filter((timer) => timer.active).length, 0, 'the 3s fallback is suspended while hidden');
    entry.sub({ event: { type: 'timeline', item: { type: 'assistant_message', text: 'latest ' } } });
    entry.sub({ event: { type: 'permission_requested', request: { id: 'permission-1' } } });
    entry.sub({ event: { type: 'timeline', item: { type: 'assistant_message', text: 'text' } } });
    assert.equal(publications, 0);
    assert.equal(store.get().blocks[0].text, 'latest text');
    const ordinary = new p.Store(0);
    let ordinaryPublications = 0;
    ordinary.subscribe(() => ordinaryPublications++);
    ordinary.set(1);
    assert.equal(ordinaryPublications, 1, 'generic side effects are never deferred while the document is hidden');
    assert.equal(store.get().permissions[0].id, 'permission-1');

    globalThis.document.hidden = false;
    visibility();
    assert.equal(publications, 1, 'visibility publishes the newest complete snapshot once');
    assert.equal(mock.intervals.filter((timer) => timer.active).length, 1, 'one metadata timer resumes for this mounted agent');
    assert.equal(entry.refreshCalls, 1, 'metadata reconciliation starts immediately on resume');
    await tick();
  });
});

test('mounted panels share one metadata poll; deep equality dedups without treating equal timestamps as equal contents', async () => {
  const original = { id: 'agent', updatedAt: 'same-time', model: 'one', config: { mode: 'plan' }, pendingPermissions: [] };
  const mock = harness({ agents: [original] });
  mock.metadata.set('agent', original);
  await withGlobals(mock, async ({ windowListeners }) => {
    const p = await load(mock);
    const { store, entry } = await mountedTimeline(mock, p, 'agent');
    p.agentsStore.set([original]);
    store.set({ ...store.get(), agent: original });
    let timelinePublications = 0, agentPublications = 0;
    store.subscribe(() => timelinePublications++);
    p.agentsStore.subscribe(() => agentPublications++);
    p.useTimeline('agent');
    assert.equal(mock.intervals.filter((timer) => timer.active).length, 1);
    const timer = mock.intervals.find((candidate) => candidate.active);
    assert.equal(timer.delay, 3000);

    const gate = defer();
    entry.handle.refresh = async () => { entry.refreshCalls++; await gate.promise; entry.current = mock.metadata.get('agent'); return entry.current; };
    mock.metadata.set('agent', structuredClone(original));
    timer.callback();
    timer.callback();
    assert.equal(entry.refreshCalls, 1, 'overlapping visibility/interval checks share one RPC');
    gate.resolve();
    await tick(); await tick();
    assert.equal(timelinePublications, 0);
    assert.equal(agentPublications, 0);

    mock.metadata.set('agent', { ...original, model: 'two' });
    timer.callback();
    await tick(); await tick();
    assert.equal(store.get().agent.model, 'two', 'same updatedAt does not suppress changed metadata');
    assert.equal(p.agentsStore.get()[0].model, 'two');
    assert.equal(timelinePublications, 1);
    assert.equal(agentPublications, 1);

    mock.cleanups.shift()();
    assert.equal(mock.intervals.filter((candidate) => candidate.active).length, 1, 'one mounted panel keeps the shared timer alive');
    mock.cleanups.shift()();
    assert.equal(mock.intervals.filter((candidate) => candidate.active).length, 0, 'last unmount clears the timer');

    const staleGate = defer(), stale = { ...original, model: 'stale' }, latest = { ...original, model: 'latest' };
    let request = 0;
    entry.handle.refresh = async () => {
      entry.refreshCalls++;
      if (++request === 1) { await staleGate.promise; entry.current = stale; }
      else entry.current = latest;
      return entry.current;
    };
    p.useTimeline('agent');
    mock.intervals.find((candidate) => candidate.active).callback();
    mock.cleanups.shift()();
    mock.metadata.set('agent', latest);
    mock.agents[0] = latest;
    p.useTimeline('agent');
    windowListeners.get('focus')();
    await tick(); await tick();
    assert.equal(store.get().agent.model, 'latest');
    staleGate.resolve();
    await tick(); await tick();
    assert.equal(store.get().agent.model, 'latest', 'a prior mount cannot apply metadata after unmount/remount');
    mock.cleanups.shift()();
  });
});

test('connection store follows SDK status events and preserves reconnect refresh without polling', async () => {
  const mock = harness({ autoConnect: false });
  await withGlobals(mock, async () => {
    const p = await load(mock);
    p.ensureConnected();
    await tick();
    assert.equal(mock.connectionListeners.length, 1);
    assert.equal(mock.connectionReads, 0);
    assert.equal(mock.intervals.length, 0);
    mock.emitConnection({ status: 'disconnected', reason: 'socket closed' });
    assert.deepEqual(p.connStore.get(), { status: 'disconnected', error: 'socket closed' });
    mock.emitConnection({ status: 'connected' });
    await tick(); await tick();
    assert.equal(p.connStore.get().status, 'connected');
    assert.equal(mock.listCalls.length, 2, 'reconnect event refreshes the existing agent subscription snapshot');
    assert.equal(mock.connectionReads, 0, 'no connection-state polling remains');
  });
});
