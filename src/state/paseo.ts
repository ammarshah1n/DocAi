// Single Paseo daemon connection shared by the whole app, plus React hooks over it.
// The daemon owns all state (agents, history, permissions); this file only mirrors it.
import { useEffect, useSyncExternalStore } from "react";
import { createPaseoApi, type PaseoAgent, type PaseoAgentTimelineEvent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const DAEMON_URL = "ws://127.0.0.1:6767/ws";

export const driver = new DaemonClient({
  url: DAEMON_URL,
  clientId: `docai-${crypto.randomUUID()}`,
  clientType: "cli",
  appVersion: "docai-0.1.0",
  reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 5000 },
});
export const api = createPaseoApi(driver);

const deferredStores = new Set<{ publish: () => void }>();
const isDocumentHidden = () => typeof document !== "undefined" && document.hidden;

function publishDeferredStores() {
  if (isDocumentHidden()) return;
  for (const store of [...deferredStores]) store.publish();
}

/** Tiny observable value; the building block for every hook below. */
export class Store<T> {
  private listeners = new Set<() => void>();
  private snapshot: T;
  onFirstSubscribe?: () => void;
  onLastUnsubscribe?: () => void;
  constructor(private value: T, private deferWhenHidden = false) { this.snapshot = value; }
  get = () => this.value;
  getSnapshot = () => this.snapshot;
  set = (next: T, notify = true) => {
    this.value = next;
    if (!notify || (this.deferWhenHidden && isDocumentHidden())) return void deferredStores.add(this);
    this.publish();
  };
  publish = () => {
    if (this.deferWhenHidden && isDocumentHidden()) return void deferredStores.add(this);
    deferredStores.delete(this);
    this.snapshot = this.value;
    this.listeners.forEach((l) => l());
  };
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    if (this.listeners.size === 1) this.onFirstSubscribe?.();
    return () => {
      this.listeners.delete(l);
      if (!this.listeners.size) this.onLastUnsubscribe?.();
    };
  };
}
export const useStore = <T,>(s: Store<T>) => useSyncExternalStore(s.subscribe, s.getSnapshot);

// ---------- connection ----------

export type Conn = { status: "connecting" | "connected" | "disconnected"; error?: string };
export const connStore = new Store<Conn>({ status: "connecting" }, true);

let connectStarted = false;
let visibilityListenerStarted = false;
export function ensureConnected() {
  if (connectStarted) return;
  connectStarted = true;
  let lost = false;
  startAgentListener();
  installVisibilityListeners();
  driver.subscribeConnectionStatus((state) => {
    const status = state.status === "connected" ? "connected" : state.status === "connecting" || state.status === "idle" ? "connecting" : "disconnected";
    const error = status === "disconnected" ? driver.lastError ?? ("reason" in state ? state.reason : undefined) : undefined;
    const cur = connStore.get();
    if (cur.status !== status || cur.error !== error) connStore.set({ status, ...(error ? { error } : {}) });
    if (status === "disconnected") lost = true;
    else if (status === "connected" && lost) {
      lost = false;
      void refreshAgents().catch(() => {});
      reconcileMountedMetadata();
    }
  });
  const attempt = () =>
    driver.connect().then(
      () => { void refreshAgents().catch(() => {}); },
      (e: unknown) => {
        connStore.set({ status: "disconnected", error: String((e as Error)?.message ?? e) });
        setTimeout(attempt, 2000);
      },
    );
  attempt();
}

// ---------- agents (the "docs" in the sidebar) ----------

export const agentsStore = new Store<PaseoAgent[]>([], true);

const sortAgents = (list: PaseoAgent[]) =>
  [...list].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

function sameValue(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

const notOlder = (a?: PaseoAgent, b?: PaseoAgent) => !!a && (!b || String(a.updatedAt ?? "") >= String(b.updatedAt ?? ""));

// Live updates seen while a list request is in flight; replayed over its (possibly older) snapshot.
let inflight = 0;
const liveLog: { id: string; agent: PaseoAgent | null }[] = [];
const mounted = new Map<string, number>(); // agentId -> mounted view count

/** Apply a list snapshot (ordinary or subscription restore). `from` = liveLog index when the request began. */
export function applyAgentSnapshot(entries: PaseoAgent[], from = liveLog.length) {
  const current = new Map(agentsStore.get().map(a => [a.id, a]));
  const byId = new Map(entries.map(a => {
    const newer = current.get(a.id);
    return [a.id, newer && String(newer.updatedAt ?? "") > String(a.updatedAt ?? "") ? newer : a];
  }));
  for (const { id, agent } of liveLog.slice(from)) agent ? byId.set(id, agent) : byId.delete(id);
  const list = sortAgents([...byId.values()]);
  if (!sameValue(list, agentsStore.get())) agentsStore.set(list);
  // Mounted views pick up metadata (model/mode/thinking) the daemon did not broadcast.
  for (const id of mounted.keys()) {
    const fresh = byId.get(id), store = timelines.get(id);
    if (store && fresh && notOlder(fresh, store.get().agent) && !sameValue(fresh, store.get().agent)) updateTimelineAgent(store, fresh);
  }
}

function applyAgentUpdate(u: any) {
  const id = u.kind === "remove" ? u.agentId : u.agent.id;
  if (inflight) liveLog.push({ id, agent: u.kind === "remove" ? null : u.agent });
  const current = agentsStore.get();
  if (u.kind === "remove") {
    const next = current.filter((x) => x.id !== id);
    if (!sameValue(next, current)) agentsStore.set(next);
    return;
  }
  if (sameValue(current.find((x) => x.id === id), u.agent)) return;
  agentsStore.set(sortAgents([u.agent, ...current.filter((x) => x.id !== id)]));
}

let agentListener = false;
function startAgentListener() {
  if (agentListener) return;
  agentListener = true;
  api.agents.subscribe(applyAgentUpdate);
}

// One retained owned subscription: the SDK re-establishes it on reconnect and re-delivers its snapshot.
let agentSub: Promise<unknown> | null = null;
let agentRefresh: Promise<void> | null = null;
const tracked = async <T,>(run: () => Promise<T>, apply: (r: T, from: number) => void) => {
  const from = liveLog.length;
  inflight++;
  try { apply(await run(), from); } finally { if (!--inflight) liveLog.length = 0; }
};
const unwrap = (r: any): PaseoAgent[] => r.entries.map((e: any) => e.agent ?? e);

export async function refreshAgents() {
  startAgentListener();
  if (!agentSub) {
    // subscribe: {} opts this connection into live agent updates; without it agents.subscribe() never fires.
    agentSub = tracked(() => api.agents.list({ subscribe: {} }), (r, from) => {
      applyAgentSnapshot(unwrap(r), from);
      // subscribe() immediately replays the initial snapshot; it was already merged above.
      let initial = true;
      r.subscription.subscribe({ snapshot: (snap: any) => {
        if (initial) { initial = false; return; }
        applyAgentSnapshot(unwrap(snap), 0);
      }, update: () => {}, error: () => {
        agentSub = null;
        connStore.set({ ...connStore.get(), error: "Document-list subscription failed. Reconnect or retry to restore sync." });
      } });
    }).catch((e) => { agentSub = null; throw e; });
    return agentSub as Promise<void>;
  }
  await agentSub;
  // ponytail: one snapshot request at a time prevents older refreshes finishing last.
  agentRefresh ??= tracked(() => api.agents.list(), (r, from) => applyAgentSnapshot(unwrap(r), from)).finally(() => { agentRefresh = null; });
  await agentRefresh;
}

export function useAgents() {
  useEffect(() => { ensureConnected(); }, []);
  return useStore(agentsStore);
}

// ---------- timeline (the page contents) ----------

/** One rendered block on the page. Streaming deltas of the same kind are merged. */
export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; synthetic?: string; id?: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; id: string; name: string; status: string; item: any }
  | { kind: "todo"; items: { text: string; completed: boolean }[] }
  | { kind: "notice"; level: "info" | "warning" | "error"; text: string };

type TimelineCursor = NonNullable<Parameters<ReturnType<typeof api.agents.ref>["timeline"]["refetch"]>[0]>["cursor"];

export type Timeline = {
  blocks: Block[];
  loading: boolean;
  running: boolean;
  error?: string;
  agent?: PaseoAgent;
  startCursor?: TimelineCursor | null;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  permissions?: PaseoAgent["pendingPermissions"];
};

/** Pure reducer: fold one timeline item into the block list (also used for sub-agent timelines). */
export function applyItem(blocks: Block[], item: any): Block[] {
  const last = blocks[blocks.length - 1];
  switch (item?.type) {
    case "user_message":
      return [...blocks, { kind: "user", text: item.text ?? "" }];
    case "assistant_message":
      // On cancel the daemon streams the tail as synthetic-message-N deltas, then repeats it as one real item.
      // Prompts without a user_message (e.g. scheduled runs) start a reply with a new real messageId: new block.
      if (last?.kind === "assistant") {
        const synthetic = String(item.messageId ?? "").startsWith("synthetic-");
        const id = synthetic ? last.id : item.messageId ?? last.id;
        if (!synthetic && last.synthetic && last.synthetic === item.text) return [...blocks.slice(0, -1), { kind: "assistant", text: last.text, id }];
        if (!synthetic && item.messageId && last.id && item.messageId !== last.id && !last.synthetic) return [...blocks, { kind: "assistant", text: item.text ?? "", id: item.messageId }];
        return [...blocks.slice(0, -1), { kind: "assistant", text: last.text + (item.text ?? ""), synthetic: synthetic ? (last.synthetic ?? "") + (item.text ?? "") : undefined, id }];
      }
      return [...blocks, { kind: "assistant", text: item.text ?? "", id: String(item.messageId ?? "").startsWith("synthetic-") ? undefined : item.messageId }];
    case "reasoning":
      if (last?.kind === "reasoning") return [...blocks.slice(0, -1), { kind: "reasoning", text: last.text + (item.text ?? "") }];
      return [...blocks, { kind: "reasoning", text: item.text ?? "" }];
    case "tool_call": {
      const previous = blocks.find((b) => b.kind === "tool" && b.id === item.callId);
      const merged = { ...(previous?.kind === "tool" ? previous.item : {}), ...item };
      const block: Block = { kind: "tool", id: item.callId, name: merged.name ?? "Tool", status: merged.status ?? "running", item: merged };
      const i = blocks.findIndex((b) => b.kind === "tool" && b.id === item.callId);
      if (i === -1) return [...blocks, block];
      const next = blocks.slice();
      next[i] = block;
      return next;
    }
    case "todo": {
      // Each todo item is the whole list again: update this turn's list in place rather than repeating it.
      const todo: Block = { kind: "todo", items: item.items ?? [] };
      const kinds = blocks.map((b) => b.kind);
      const i = kinds.lastIndexOf("todo") > kinds.lastIndexOf("user") ? kinds.lastIndexOf("todo") : -1;
      return i === -1 ? [...blocks, todo] : blocks.map((b, j) => (j === i ? todo : b));
    }
    case "error":
      return [...blocks, { kind: "notice", level: "error", text: item.message }];
    case "notification":
      return [...blocks, { kind: "notice", level: item.level, text: item.message }];
    default:
      return blocks;
  }
}

const timelines = new Map<string, Store<Timeline>>();
const timelineRefresh = new Map<string, () => Promise<void>>();
const timelineGenerations = new Map<string, number>();
const timelinePublishTimers = new Map<Store<Timeline>, ReturnType<typeof setTimeout>>();
const metadataTimers = new Map<string, ReturnType<typeof setInterval>>();
const metadataRefreshes = new Map<string, Promise<void>>();
const metadataGenerations = new Map<string, number>();

function setTimeline(store: Store<Timeline>, next: Timeline, immediate = true) {
  const timer = timelinePublishTimers.get(store);
  if (immediate) {
    if (timer) clearTimeout(timer);
    timelinePublishTimers.delete(store);
    store.set(next);
    return;
  }
  store.set(next, false);
  if (isDocumentHidden() || timer) return;
  // Four document repaints per second are enough for streamed prose; input and final/status events stay immediate.
  timelinePublishTimers.set(store, setTimeout(() => {
    timelinePublishTimers.delete(store);
    store.publish();
  }, 250));
}

function updateTimelineAgent(store: Store<Timeline>, agent: PaseoAgent) {
  const current = store.get();
  const permissions = agent.pendingPermissions ?? [];
  const running = agent.status === "running";
  if (sameValue(current.agent, agent) && sameValue(current.permissions, permissions) && current.running === running) return;
  setTimeline(store, { ...current, agent, permissions, running });
}

function isBatchedTimelineItem(item: any) {
  return ["user_message", "assistant_message", "reasoning", "tool_call"].includes(item?.type);
}

function stopMetadataPolling(agentId: string) {
  const timer = metadataTimers.get(agentId);
  if (timer) clearInterval(timer);
  metadataTimers.delete(agentId);
}

function startMetadataPolling(agentId: string) {
  if (!mounted.has(agentId) || isDocumentHidden() || metadataTimers.has(agentId)) return;
  metadataTimers.set(agentId, setInterval(() => { void refreshMountedMetadata(agentId); }, 3000));
}

async function refreshMountedMetadata(agentId: string): Promise<void> {
  if (!mounted.has(agentId) || isDocumentHidden() || connStore.get().status !== "connected") return;
  const existing = metadataRefreshes.get(agentId);
  if (existing) return existing;
  const generation = metadataGenerations.get(agentId) ?? 0;
  const request = (async () => {
    try {
      const handle = api.agents.ref(agentId);
      await handle.refresh();
      const fresh = handle.current();
      if (!mounted.has(agentId) || (metadataGenerations.get(agentId) ?? 0) !== generation || isDocumentHidden() || !fresh) return;
      const timeline = timelines.get(agentId);
      const listed = agentsStore.get().find((agent) => agent.id === agentId);
      if (!notOlder(fresh, timeline?.get().agent) || !notOlder(fresh, listed)) return;
      if (timeline) updateTimelineAgent(timeline, fresh);
      const next = sortAgents([fresh, ...agentsStore.get().filter((agent) => agent.id !== agentId)]);
      if (!sameValue(next, agentsStore.get())) agentsStore.set(next);
    } catch (e) {
      const store = timelines.get(agentId);
      const message = `Session sync failed: ${(e as Error)?.message ?? e}`;
      if (mounted.has(agentId) && (metadataGenerations.get(agentId) ?? 0) === generation && store && store.get().error !== message)
        setTimeline(store, { ...store.get(), error: message });
    }
  })();
  metadataRefreshes.set(agentId, request);
  try { await request; } finally {
    if (metadataRefreshes.get(agentId) === request) metadataRefreshes.delete(agentId);
  }
}

function reconcileMountedMetadata() {
  if (isDocumentHidden()) return;
  for (const id of mounted.keys()) {
    startMetadataPolling(id);
    void refreshMountedMetadata(id);
  }
}

function resumeVisibleState() {
  if (isDocumentHidden()) {
    for (const timer of timelinePublishTimers.values()) clearTimeout(timer);
    timelinePublishTimers.clear();
    for (const id of metadataTimers.keys()) stopMetadataPolling(id);
    return;
  }
  for (const timer of timelinePublishTimers.values()) clearTimeout(timer);
  timelinePublishTimers.clear();
  publishDeferredStores();
  if (mounted.size && connStore.get().status === "connected") void refreshAgents().catch(() => {});
  reconcileMountedMetadata();
}

function installVisibilityListeners() {
  if (visibilityListenerStarted || typeof document === "undefined") return;
  visibilityListenerStarted = true;
  document.addEventListener("visibilitychange", resumeVisibleState);
  if (typeof window !== "undefined") window.addEventListener("focus", resumeVisibleState);
}

function loadTimeline(agentId: string, store: Store<Timeline>) {
  const generation = (timelineGenerations.get(agentId) ?? 0) + 1;
  timelineGenerations.set(agentId, generation);
  const handle = api.agents.ref(agentId);
  let active = true, fetching = false, dirty = false;
  let pending: PaseoAgentTimelineEvent[] = [];
  setTimeline(store, { ...store.get(), loading: true, loadingEarlier: false, error: undefined });
  const refetch = async () => {
    if (!active) return;
    if (fetching) { dirty = true; return; }
    fetching = true;
    dirty = false;
    pending = [];
    try {
      const t: any = await handle.timeline.refetch({ direction: "tail", limit: 500 });
      if (!active) return;
      const blocks = (t.entries ?? []).reduce((acc: Block[], e: any) => applyItem(acc, e.item), []);
      const agent = t.agent ?? store.get().agent;
      setTimeline(store, { blocks, loading: false, running: agent?.status === "running", agent,
        permissions: agent?.pendingPermissions ?? [], startCursor: t.startCursor,
        hasEarlier: t.hasOlder ?? false });
      const buffered = pending;
      pending = [];
      fetching = false;
      for (const event of buffered) {
        if (active && (!("seq" in event) || event.seq == null || (event.epoch === t.epoch && event.seq > (t.endCursor?.seq ?? -1)))) receive(event);
      }
    } catch (e) {
      if (active) setTimeline(store, { ...store.get(), loading: false, error: String((e as Error)?.message ?? e) });
    } finally { fetching = false; pending = []; }
    if (active && dirty) { dirty = false; void refetch(); }
  };
  timelineRefresh.set(agentId, refetch);
  const receive = (ev: PaseoAgentTimelineEvent) => {
    if (!active) return;
    const e: any = (ev as any).event;
    const cur = store.get();
    if (!e) return;
    if (e.type === "subscription_restored" || e.type === "replacement") return void refetch();
    if (fetching) { pending.push(ev); return; }
    if (e.type === "timeline") return setTimeline(store, { ...cur, blocks: applyItem(cur.blocks, e.item), error: undefined }, !isBatchedTimelineItem(e.item));
    if (e.type === "permission_requested") return setTimeline(store, { ...cur, permissions: [...(cur.permissions ?? []).filter(p => p.id !== e.request.id), e.request] });
    if (e.type === "permission_resolved") return setTimeline(store, { ...cur, permissions: (cur.permissions ?? []).filter(p => p.id !== e.requestId) });
    if (e.type === "turn_started") return setTimeline(store, { ...cur, running: true, error: undefined });
    if (e.type === "turn_completed" || e.type === "turn_canceled") return setTimeline(store, { ...cur, running: false });
    if (e.type === "turn_failed")
      return setTimeline(store, { ...cur, running: false, blocks: applyItem(cur.blocks, { type: "error", message: e.error }) });
    if (e.type === "error") return setTimeline(store, { ...cur, error: e.error });
  };
  const sub = handle.timeline.subscribe(receive);
  const offAgent = handle.subscribe((a: any) => {
    const agent = a?.agent ?? a;
    if (active && agent?.id === agentId) updateTimelineAgent(store, agent);
  });
  sub.ready.then(() => { if (active) void refetch(); }, (e: unknown) => {
    if (active) setTimeline(store, { ...store.get(), loading: false, error: String(e) });
  });
  return () => {
    active = false;
    if (timelineGenerations.get(agentId) === generation) timelineGenerations.set(agentId, generation + 1);
    pending = [];
    const timer = timelinePublishTimers.get(store);
    if (timer) clearTimeout(timer);
    timelinePublishTimers.delete(store);
    deferredStores.delete(store);
    if (timelineRefresh.get(agentId) === refetch) timelineRefresh.delete(agentId);
    sub();
    offAgent();
  };
}

export function timelineStore(agentId: string) {
  let s = timelines.get(agentId);
  if (!s) {
    s = new Store<Timeline>({ blocks: [], loading: true, running: false }, true);
    timelines.set(agentId, s);
    const store = s;
    let release = 0;
    let stop: (() => void) | undefined;
    store.onFirstSubscribe = () => {
      ++release;
      if (!stop) { ensureConnected(); stop = loadTimeline(agentId, store); }
    };
    store.onLastUnsubscribe = () => {
      const generation = ++release;
      queueMicrotask(() => {
        if (release !== generation) return;
        stop?.();
        stop = undefined;
      });
    };
  }
  return s;
}

export const useTimeline = (agentId: string) => {
  useEffect(() => {
    mounted.set(agentId, (mounted.get(agentId) ?? 0) + 1);
    startMetadataPolling(agentId);
    return () => {
      const n = (mounted.get(agentId) ?? 1) - 1;
      if (n) mounted.set(agentId, n);
      else {
        mounted.delete(agentId);
        metadataGenerations.set(agentId, (metadataGenerations.get(agentId) ?? 0) + 1);
        metadataRefreshes.delete(agentId);
        stopMetadataPolling(agentId);
      }
    };
  }, [agentId]);
  return useStore(timelineStore(agentId));
};

export async function loadEarlier(agentId: string) {
  const store = timelineStore(agentId);
  const generation = timelineGenerations.get(agentId);
  const current = store.get();
  if (current.loadingEarlier || !current.startCursor) return;
  setTimeline(store, { ...current, loadingEarlier: true, error: undefined });
  try {
    const page = await api.agents.ref(agentId).timeline.refetch({ direction: "before", cursor: current.startCursor, limit: 500 });
    if (timelineGenerations.get(agentId) !== generation) return;
    if (page.staleCursor || page.reset) throw new Error("Document history changed. Reload the document to continue.");
    const latest = store.get().startCursor;
    if (latest?.epoch !== current.startCursor.epoch || latest?.seq !== current.startCursor.seq) {
      setTimeline(store, { ...store.get(), loadingEarlier: false });
      return; // a refetch replaced the history meanwhile
    }
    const older = page.entries.reduce((blocks: Block[], entry) => applyItem(blocks, entry.item), []);
    setTimeline(store, { ...store.get(), blocks: [...older, ...store.get().blocks], loadingEarlier: false,
      startCursor: page.startCursor, hasEarlier: page.hasOlder });
  } catch (error) {
    if (timelineGenerations.get(agentId) === generation)
      setTimeline(store, { ...store.get(), loadingEarlier: false, error: error instanceof Error ? error.message : "Could not load earlier messages." });
  }
}

export function retryTimeline(agentId: string) {
  const store = timelineStore(agentId);
  setTimeline(store, { ...store.get(), error: undefined, loading: true });
  void timelineRefresh.get(agentId)?.();
}

// ---------- actions ----------

export const sendMessage = (agentId: string, text: string) => api.agents.ref(agentId).send(text);

/** An agent by id: from the live list, else from its loaded timeline (covers archived docs). */
export function useAgent(agentId: string | null | undefined): PaseoAgent | undefined {
  const listed = useAgents().find((a) => a.id === agentId);
  const timeline = useStore(agentId && !listed ? timelineStore(agentId) : emptyTimeline);
  return listed ?? timeline.agent;
}
const emptyTimeline = new Store<Timeline>({ blocks: [], loading: false, running: false });
