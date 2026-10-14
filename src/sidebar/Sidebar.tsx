import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { agentsStore, api, connStore, driver, ensureConnected, useStore } from "../state/paseo";
import { layoutStore, openDoc, setPaneAgent, splitPane, toggleSidebar, useLayout } from "../state/layout";
import { Icon } from "../shell/controls";
import "./sidebar.css";

const titleOf = (agent: PaseoAgent) => agent.title?.trim() || "Untitled document";
const projectOf = (agent: PaseoAgent) => (agent.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Other documents";
type Prompts = Awaited<ReturnType<typeof driver.listAgentTimelinePrompts>>["prompts"];

function Outline({ agent }: { agent: PaseoAgent }) {
  const [prompts, setPrompts] = useState<Prompts>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const { status } = useStore(connStore);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setLoading(true);
    driver.listAgentTimelinePrompts(agent.id).then((result) => {
      if (!active) return;
      if (result.error) { setFailed(true); return; }
      setPrompts(result.prompts ?? []);
    }).catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [agent.id, agent.lastUserMessageAt, agent.status, status, retry]);
  return <div className="sidebar-outline" aria-label="Document outline">
    {failed ? <div className="sidebar-error" role="alert">Couldn’t load the outline. <button onClick={() => setRetry((n) => n + 1)}>Retry</button></div>
      : loading && !prompts.length ? <p className="sidebar-hint" role="status">Loading outline…</p>
      : !prompts.length ? <p className="sidebar-hint">Prompts appear here as you write.</p>
      : prompts.map((prompt, index) => <button key={prompt.seq} className="sidebar-prompt" title={prompt.preview || "Untitled prompt"}
        onClick={() => window.dispatchEvent(new CustomEvent("docai:scroll-to-prompt", { detail: { agentId: agent.id, index } }))}>
        {prompt.preview?.replace(/\s+/g, " ").trim() || "Untitled prompt"}
      </button>)}
  </div>;
}

function DocumentRow({ agent, onChange, pinned, onTogglePin }: { agent: PaseoAgent; onChange: (agent: PaseoAgent) => void; pinned: boolean; onTogglePin: (id: string) => void }) {
  const layout = useLayout();
  const selected = layout.panes[layout.focused] === agent.id;
  const pane = layout.panes.indexOf(agent.id);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(titleOf(agent));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const permission = Boolean(agent.pendingPermissions?.length);
  const state = permission ? "permission" : agent.requiresAttention ? "attention" : agent.status === "running" ? "running" : null;
  const stateLabel = state === "permission" ? "Permission needed" : state === "attention" ? "Needs attention" : "Running";

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  async function act(action: () => Promise<void>, message: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try { await action(); }
    catch { setFailure({ message, retry: () => { void act(action, message); } }); }
    finally { pending.current = false; setBusy(false); }
  }
  const rename = () => {
    const title = name.trim();
    if (!title) return;
    void act(async () => {
      await driver.updateAgent(agent.id, { name: title });
      onChange({ ...agent, title });
      setEditing(false);
    }, "Couldn’t rename this document.");
  };
  const archive = () => void act(async () => {
    const result = await driver.archiveAgent(agent.id);
    onChange({ ...agent, archivedAt: result.archivedAt });
    setConfirm(false);
  }, "Couldn’t move this document to trash.");
  const restore = () => void act(async () => {
    if (!agent.persistence) throw new Error("Missing session history");
    onChange(await driver.resumeAgent(agent.persistence));
    // Resume starts a new agent and unarchives this one; re-read it so it leaves Trash.
    const original = await driver.fetchAgent(agent.id);
    if (original?.agent) onChange(original.agent);
  }, "Couldn’t restore this document.");

  return <div ref={root} className="sidebar-document" onKeyDown={(event) => {
    if (event.key === "Escape") { setMenu(false); setConfirm(false); setEditing(false); menuButton.current?.focus(); }
  }}>
    <div className={`sidebar-row${selected ? " is-selected" : ""}`} draggable={!editing && !busy}
      onDragStart={(event) => { event.dataTransfer.setData("application/x-docai-agent", agent.id); event.dataTransfer.effectAllowed = "copy"; }}>
      {editing ? <form className="sidebar-rename" onSubmit={(event) => { event.preventDefault(); rename(); }}>
        <input aria-label="Document name" value={name} autoFocus maxLength={500} disabled={busy}
          onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} />
        <button className="sidebar-icon" aria-label="Save document name" disabled={busy || !name.trim()}><Icon name="check" /></button>
      </form> : <button className="sidebar-open" onClick={() => openDoc(agent.id)} aria-current={selected ? "page" : undefined} title={`${titleOf(agent)}\n${agent.cwd || ""}`}>
        <Icon name="article" />{pinned && <span className="sidebar-pin-icon" role="img" aria-label="Pinned" title="Pinned"><Icon name="push_pin" /></span>}<span className="sidebar-title">{titleOf(agent)}</span>
        {state && <span className={`sidebar-status ${state}`} role="img" aria-label={stateLabel} title={stateLabel} />}
        {pane >= 0 && !selected && <span className="sidebar-pane" title={`Open in pane ${pane + 1}`}>{pane + 1}</span>}
      </button>}
      {!editing && <button ref={menuButton} className={`sidebar-icon sidebar-more${menu ? " is-open" : ""}`} aria-label={`Options for ${titleOf(agent)}`}
        aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu(!menu)}><Icon name="more_vert" /></button>}
    </div>
    {menu && <div ref={menuRef} className="sidebar-menu" role="menu" aria-label="Document options" onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }} onBlur={(event) => { if (!root.current?.contains(event.relatedTarget as Node)) setMenu(false); }}>
      <button role="menuitem" disabled={layout.panes.length >= 4} onClick={() => {
        if (layoutStore.get().panes.length >= 4) return;
        splitPane(); setPaneAgent(layoutStore.get().focused, agent.id); setMenu(false);
      }}><Icon name="vertical_split" />Open in new pane</button>
      <button role="menuitem" onClick={() => { onTogglePin(agent.id); setMenu(false); }}><Icon name="push_pin" />{pinned ? "Unpin" : "Pin"}</button>
      <button role="menuitem" onClick={() => { setName(titleOf(agent)); setEditing(true); setMenu(false); }}><Icon name="edit" />Rename</button>
      {agent.archivedAt ? <>
        <button role="menuitem" disabled={!agent.persistence} onClick={() => { setMenu(false); restore(); }}><Icon name="restore_from_trash" />Restore</button>
        {!agent.persistence && <p className="sidebar-hint">No saved session is available to restore.</p>}
      </> : <button role="menuitem" onClick={() => { setMenu(false); setConfirm(true); }}><Icon name="delete" />Move to trash</button>}
    </div>}
    {confirm && <div className="sidebar-confirm" role="alertdialog" aria-label={`Move ${titleOf(agent)} to trash?`}>
      <p>Move this document to trash?{agent.status === "running" ? " Its running agent will be stopped." : ""}</p>
      <div><button autoFocus disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button disabled={busy} onClick={archive}>Move to trash</button></div>
    </div>}
    {busy && <p className="sidebar-hint" role="status">Saving…</p>}
    {failure && <div className="sidebar-error" role="alert">{failure.message} <button disabled={busy} onClick={failure.retry}>Retry</button></div>}
    {selected && !agent.archivedAt && <Outline key={agent.id} agent={agent} />}
  </div>;
}

export function Sidebar() {
  const { sidebarOpen } = useLayout();
  const connection = useStore(connStore);
  const [agents, setAgents] = useState<PaseoAgent[]>(() => agentsStore.get());
  const [query, setQuery] = useState("");
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [pinsReady, setPinsReady] = useState(false);
  const [pinStorageError, setPinStorageError] = useState(false);
  const [pinFetchError, setPinFetchError] = useState(false);
  const [pinFetchRetry, setPinFetchRetry] = useState(0);
  const pendingPinWrite = useRef<string[] | null>(null);
  const pendingPinReads = useRef(new Set<string>());
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["trash"]));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const liveChanges = useRef(new Map<string, PaseoAgent | null>());
  const scroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem("docai.sidebar.pins") ?? "[]");
      if (!Array.isArray(value)) throw new Error("Invalid pin list");
      setPinnedIds([...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 256))]);
    } catch { setPinStorageError(true); }
    finally { setPinsReady(true); }
  }, []);

  const retryPinStorage = useCallback(() => {
    try {
      if (pendingPinWrite.current) {
        localStorage.setItem("docai.sidebar.pins", JSON.stringify(pendingPinWrite.current));
        setPinnedIds(pendingPinWrite.current);
        pendingPinWrite.current = null;
      } else {
        const value = JSON.parse(localStorage.getItem("docai.sidebar.pins") ?? "[]");
        if (!Array.isArray(value)) throw new Error("Invalid pin list");
        setPinnedIds([...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 256))]);
      }
      setPinStorageError(false);
    } catch { setPinStorageError(true); }
  }, []);

  const resetPins = useCallback(() => {
    try {
      localStorage.setItem("docai.sidebar.pins", "[]");
      pendingPinWrite.current = null;
      setPinnedIds([]);
      setPinStorageError(false);
    } catch { setPinStorageError(true); }
  }, []);

  const togglePin = useCallback((id: string) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((item) => item !== id) : [...pinnedIds, id];
    try {
      localStorage.setItem("docai.sidebar.pins", JSON.stringify(next));
      pendingPinWrite.current = null;
      setPinnedIds(next);
      setPinStorageError(false);
    } catch {
      pendingPinWrite.current = next;
      setPinStorageError(true);
    }
  }, [pinnedIds]);

  const onChange = useCallback((agent: PaseoAgent) => {
    pendingPinReads.current.delete(agent.id);
    liveChanges.current.set(agent.id, agent);
    setAgents((previous) => [agent, ...previous.filter((item) => item.id !== agent.id)]);
    agentsStore.set([agent, ...agentsStore.get().filter((item) => item.id !== agent.id)]);
  }, []);

  // Fields the daemon doesn't push (attention, model) arrive via refreshAgents(); fold them into this list.
  useEffect(() => {
    const off = agentsStore.subscribe(() => {
      const live = new Map(agentsStore.get().map((agent) => [agent.id, agent]));
      setAgents((previous) => previous.map((agent) => live.get(agent.id) ?? agent));
    });
    return () => { off(); };
  }, []);

  const loadPage = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Only updates arriving during this request outrank its snapshot.
    liveChanges.current.clear();
    setLoading(true); setFailed(false);
    try {
      const result = await api.agents.list({ filter: { includeArchived: true }, sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 100, cursor: cursor.current } });
      const page = result.entries.map((entry) => entry.agent);
      setAgents((previous) => {
        const merged = new Map(previous.map((agent) => [agent.id, agent]));
        for (const agent of page) if (agent?.id) merged.set(agent.id, agent);
        for (const [id, agent] of liveChanges.current) agent ? merged.set(id, agent) : merged.delete(id);
        return [...merged.values()];
      });
      const next = result.pageInfo?.nextCursor ?? undefined;
      if (result.pageInfo?.hasMore && (!next || next === cursor.current)) throw new Error("Invalid pagination cursor");
      cursor.current = next;
      setHasMore(Boolean(result.pageInfo?.hasMore));
    } catch { setFailed(true); }
    finally { inFlight.current = false; setLoading(false); }
  }, []);

  useEffect(() => {
    ensureConnected();
    return api.agents.subscribe((update) => {
      if (update.kind === "remove") {
        pendingPinReads.current.delete(update.agentId);
        liveChanges.current.set(update.agentId, null);
        setAgents((previous) => previous.filter((agent) => agent.id !== update.agentId));
      } else if (update.agent) onChange(update.agent);
    });
  }, [onChange]);
  useEffect(() => {
    if (connection.status === "connected") { cursor.current = undefined; void loadPage(); }
  }, [connection.status, loadPage]);
  useEffect(() => {
    if (!pinsReady || connection.status !== "connected") return;
    let active = true;
    const missing = pinnedIds.filter((id) => !agents.some((agent) => agent.id === id));
    setPinFetchError(false);
    pendingPinReads.current = new Set(missing);
    void Promise.all(missing.map((id) => driver.fetchAgent(id).then((result) => {
      // A newer live update/removal invalidates this snapshot, even if it removed the row.
      if (!active || !pendingPinReads.current.delete(id)) return;
      if (result?.agent) setAgents((previous) => previous.some((agent) => agent.id === id) ? previous : [...previous, result.agent!]);
      else throw new Error("Pinned document not found");
    }))).catch(() => { if (active) setPinFetchError(true); });
    return () => { active = false; pendingPinReads.current.clear(); };
  }, [pinsReady, pinnedIds, connection.status, pinFetchRetry]);
  useEffect(() => {
    if (!sidebarOpen || !hasMore || failed || loading || connection.status !== "connected" || !sentinel.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      const container = scroll.current;
      if (entry.isIntersecting && container && container.scrollHeight - container.scrollTop - container.clientHeight <= 120) void loadPage();
    }, { root: scroll.current, rootMargin: "120px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [sidebarOpen, hasMore, failed, loading, connection.status, loadPage, query, closed]);

  const groups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const grouped = new Map<string, { name: string; agents: PaseoAgent[] }>();
    const sorted = [...agents].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const pinned = new Set(pinnedIds);
    for (const agent of sorted) {
      if (search && !`${titleOf(agent)} ${agent.cwd || ""}`.toLocaleLowerCase().includes(search)) continue;
      if (!agent.archivedAt && pinned.has(agent.id)) {
        if (!grouped.has("pinned")) grouped.set("pinned", { name: "Pinned", agents: [] });
        grouped.get("pinned")!.agents.push(agent);
        continue;
      }
      const key = agent.archivedAt ? "trash" : `project:${agent.cwd || ""}`;
      if (!grouped.has(key)) grouped.set(key, { name: agent.archivedAt ? "Trash" : projectOf(agent), agents: [] });
      grouped.get(key)!.agents.push(agent);
    }
    if (!grouped.has("trash")) grouped.set("trash", { name: "Trash", agents: [] });
    return [...grouped].sort(([a], [b]) => a === "pinned" ? -1 : b === "pinned" ? 1 : a === "trash" ? 1 : b === "trash" ? -1 : 0);
  }, [agents, query, pinnedIds]);

  if (!sidebarOpen) return <button className="sidebar-show sidebar-icon" aria-label="Show tabs & outlines" title="Show tabs & outlines" onClick={toggleSidebar}><Icon name="left_panel_open" /></button>;
  return <nav className="sidebar" aria-label="Documents">
    <div className="sidebar-header"><h2>Documents</h2><button className="sidebar-icon" aria-label="New blank document" title="New blank document" onClick={() => openDoc(null)}><Icon name="add" /></button>
      <button className="sidebar-icon" aria-label="Hide tabs & outlines" title="Hide tabs & outlines" onClick={toggleSidebar}><Icon name="left_panel_close" /></button></div>
    <div className="sidebar-search"><Icon name="search" /><input type="search" aria-label="Search documents" placeholder="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div ref={scroll} className="sidebar-scroll" aria-busy={loading}>
      {connection.status !== "connected" && <p className="sidebar-hint" role="status">{connection.status === "connecting" ? "Connecting…" : "Offline. Reconnecting…"}</p>}
      {pinStorageError && <div className="sidebar-error" role="alert">Pinned preferences could not be read or saved. <button onClick={retryPinStorage}>Retry</button><button onClick={resetPins}>Reset pins</button></div>}
      {pinFetchError && <div className="sidebar-error" role="alert">Couldn’t load pinned documents. <button onClick={() => setPinFetchRetry((value) => value + 1)}>Retry</button></div>}
      {groups.map(([key, group]) => <section key={key} className="sidebar-group">
        <button className="sidebar-group-toggle" aria-expanded={!closed.has(key)} title={key === "trash" ? "Trash" : key === "pinned" ? "Pinned" : key.slice(8)} onClick={() => setClosed((previous) => {
          const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
        })}><Icon name={closed.has(key) ? "chevron_right" : "expand_more"} />{key === "trash" ? <Icon name="delete" /> : key === "pinned" ? <Icon name="push_pin" /> : null}<span>{group.name}</span><span className="sidebar-count">{group.agents.length}</span></button>
        {!closed.has(key) && (group.agents.length ? group.agents.map((agent) => <DocumentRow key={agent.id} agent={agent} onChange={onChange} pinned={pinnedIds.includes(agent.id)} onTogglePin={togglePin} />) : <p className="sidebar-hint">{key === "trash" ? "Trash is empty." : "No pinned documents."}</p>)}
      </section>)}
      {!loading && !failed && groups.every(([, group]) => !group.agents.length) && <p className="sidebar-hint">{query ? "No matching documents." : "Create a document to get started."}</p>}
      {failed && <div className="sidebar-error" role="alert">Couldn’t load documents. <button onClick={() => void loadPage()}>Retry</button></div>}
      {loading && <p className="sidebar-hint" role="status">Loading documents…</p>}
      <div ref={sentinel} className="sidebar-sentinel" />
      {hasMore && !loading && !failed && <button className="sidebar-load" disabled={connection.status !== "connected"} onClick={() => void loadPage()}>Load more documents</button>}
    </div>
  </nav>;
}
