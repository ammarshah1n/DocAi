import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { setRightPanel, useLayout } from "../state/layout";
import { visibleInterval } from "../state/visibleInterval";
import { AgentPanel } from "./AgentPanel";
import { ChangesPanel } from "./ChangesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { FilesPanel } from "./FilesPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { WorkspacePanel } from "./WorkspacePanel";
import { SettingsPanel } from "./SettingsPanel";
import "./panels.css";

export type PanelProps = { agentId: string | null };

export const PANELS: { id: string; icon: string; label: string; Component: ComponentType<PanelProps> }[] = [
  { id: "agent", icon: "smart_toy", label: "Agent details", Component: AgentPanel },
  { id: "changes", icon: "difference", label: "Changes", Component: ChangesPanel },
  { id: "terminal", icon: "terminal", label: "Terminal", Component: TerminalPanel },
  { id: "files", icon: "folder_open", label: "Files", Component: FilesPanel },
  { id: "workspace", icon: "account_tree", label: "Projects & worktrees", Component: WorkspacePanel },
  { id: "schedules", icon: "schedule", label: "Schedules", Component: SchedulesPanel },
  { id: "settings", icon: "settings", label: "Settings", Component: SettingsPanel },
];

export function usePanelTask() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ label: string; retry: () => void } | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (label: string, task: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailure(null);
    try { await task(); }
    catch { if (mounted.current) setFailure({ label, retry: () => void run(label, task) }); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const error = failure && <div className="panel-error" role="alert">Could not {failure.label}. Check the connection and provider availability.<button className="panel-btn" disabled={busy} onClick={failure.retry}>Retry</button></div>;
  return { busy, run, error };
}

export function PanelLoad<T>({ title, load, children, refreshMs }: { title: string; load: () => Promise<T>; children: (value: T) => ReactNode; refreshMs?: number }) {
  const [value, setValue] = useState<T>();
  const task = usePanelTask();
  const currentLoad = useRef(load);
  currentLoad.current = load;
  const refresh = () => void task.run(`load ${title.toLowerCase()}`, async () => { setValue(await currentLoad.current()); });
  useEffect(() => {
    refresh();
    // ponytail: only snapshot-only settings need polling; the task lock prevents overlapping reads.
    if (refreshMs) return visibleInterval(refresh, refreshMs);
  }, [refreshMs]);
  return <section className="panel-section"><div className="panel-section-heading"><h3>{title}</h3><button className="panel-icon-btn" aria-label={`Refresh ${title}`} disabled={task.busy} onClick={refresh}><span className="material-symbols-outlined">refresh</span></button></div>{task.error}{task.busy && <p className="panel-muted" role="status">Loading…</p>}{value !== undefined && children(value)}</section>;
}

export function PanelData({ value }: { value: unknown }) {
  return <pre className="panel-code">{value == null ? "Not available" : typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function RightPanel() {
  const { rightPanel, panes, focused } = useLayout();
  const [hidden, setHidden] = useState(false);
  const open = PANELS.find((p) => p.id === rightPanel);
  return <>
    {open && <aside className="side-panel" aria-label={open.label}>
      <header className="panel-header"><h2>{open.label}</h2><button className="panel-icon-btn" title="Close side panel" aria-label="Close side panel" onClick={() => setRightPanel(null)}><span className="material-symbols-outlined">close</span></button></header>
      {/* Workspace and Settings ignore the focused doc, so they keep their state when focus moves. */}
      <open.Component key={open.id === "workspace" || open.id === "settings" ? open.id : `${open.id}:${panes[focused] ?? "blank"}`} agentId={panes[focused] ?? null} />
    </aside>}
    <nav className={`side-rail${hidden && !open ? " is-hidden" : ""}`} aria-label="Side panel">
      {(!hidden || open) && <div className="side-rail-tools">{PANELS.map((p, i) => <div key={p.id}>{i === PANELS.length - 1 && <div className="side-rail-divider" />}<button title={p.label} aria-label={p.label} aria-pressed={p.id === rightPanel} className={p.id === rightPanel ? "active" : ""} onClick={() => setRightPanel(p.id)}><span className="material-symbols-outlined">{p.icon}</span></button></div>)}</div>}
      <button className="rail-toggle" title={hidden ? "Show side panel" : "Hide side panel"} aria-label={hidden ? "Show side panel" : "Hide side panel"} onClick={() => { if (!hidden) setRightPanel(null); setHidden(!hidden); }}><span className="material-symbols-outlined">{hidden ? "chevron_left" : "chevron_right"}</span></button>
    </nav>
  </>;
}
