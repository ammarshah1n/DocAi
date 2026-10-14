import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { driver, connStore, useStore, useAgent } from "../state/paseo";
import { visibleInterval } from "../state/visibleInterval";
import type { PanelProps } from "./RightPanel";
import { checked, PanelEmpty, usePanelConfirm, usePanelTask } from "./GitUI";

type TerminalInfo = Awaited<ReturnType<typeof driver.listTerminals>>["terminals"][number];
type Scripts = NonNullable<Awaited<ReturnType<typeof driver.listWorkspaceScripts>>["scripts"]>;

export function TerminalPanel({ agentId }: PanelProps) {
  const agent = useAgent(agentId);
  return agent?.cwd ? <Terminals key={`${agent.id}:${agent.cwd}`} cwd={agent.cwd} workspaceId={agent.workspaceId ?? undefined} /> : <PanelEmpty title="Terminal" />;
}

function TerminalView({ terminalId }: { terminalId: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Connecting…");
  const connection = useStore(connStore);
  useEffect(() => {
    if (!element.current || connection.status !== "connected") return;
    let alive = true;
    let attached = false;
    const fail = (e: unknown) => { if (alive) { attached = false; setError(e instanceof Error ? e.message : "Terminal disconnected. Please retry."); } };
    const term = new Terminal({ cursorBlink: false, fontFamily: "Menlo, Consolas, monospace", fontSize: 12, scrollback: 3000, theme: { background: "#ffffff", foreground: "#1f1f1f", cursor: "#0b57d0", selectionBackground: "#d3e3fd" } });
    const fit = new FitAddon();
    term.loadAddon(fit); term.open(element.current); fit.fit();
    setError(""); setStatus("Connecting…");
    const send = (message: Parameters<typeof driver.sendTerminalInput>[1]) => { try { driver.sendTerminalInput(terminalId, message); } catch (e) { fail(e); } };
    const input = term.onData((data) => { if (attached) send({ type: "input", data }); });
    const resize = new ResizeObserver(() => { try { fit.fit(); if (attached) send({ type: "resize", rows: term.rows, cols: term.cols, intent: "claim" }); } catch (e) { fail(e); } });
    resize.observe(element.current);
    let sub: ReturnType<typeof driver.observeTerminal> | undefined;
    try {
      sub = driver.observeTerminal(terminalId, (event) => {
        if (!alive) return;
        if (event.type === "restore") { term.reset(); term.write(event.data); }
        else if (event.type === "output") term.write(event.data);
        else {
          // Older daemons return cell snapshots instead of an ANSI restore stream.
          term.reset();
          term.resize(event.state.cols, event.state.rows);
          term.write(event.state.grid.map((row) => row.map((cell) => cell.char || " ").join("")).join("\r\n") + `\x1b[${event.state.cursor.row + 1};${event.state.cursor.col + 1}H`);
        }
      }, { restore: { mode: "visible-snapshot", scrollbackLines: 200, size: { rows: term.rows, cols: term.cols } } });
      sub.subscribe({ snapshot: () => {}, error: fail, update: (event) => { if (event.type === "terminal_stream_exit") { attached = false; if (event.payload.error) fail(new Error(event.payload.error)); else setStatus("Terminal exited."); } } });
      void sub.ready.then((result) => { checked(result); if (alive) { attached = true; setStatus("Connected"); send({ type: "resize", rows: term.rows, cols: term.cols, intent: "claim" }); } }).catch(fail);
    } catch (e) { fail(e); }
    return () => { alive = false; input.dispose(); resize.disconnect(); term.dispose(); void sub?.release().catch(() => {}); };
  }, [terminalId, attempt, connection.status]);
  return <><p className="git-muted" role="status">{connection.status === "connected" ? status : "Waiting for daemon connection…"}</p>{error && <div className="panel-error" role="alert">{error}<button className="panel-btn" onClick={() => setAttempt((v) => v + 1)}>Retry</button></div>}<div className="term-screen" ref={element} aria-label="Workspace terminal" /></>;
}

function Terminals({ cwd, workspaceId }: { cwd: string; workspaceId?: string }) {
  const task = usePanelTask();
  const { confirm, dialog } = usePanelConfirm();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [scripts, setScripts] = useState<Scripts>([]);
  const connection = useStore(connStore);
  const [syncError, setSyncError] = useState("");
  const loadSeq = useRef(0);
  const refresh = async () => {
    const seq = ++loadSeq.current;
    const result = await driver.listTerminals(cwd, undefined, { workspaceId });
    if (seq !== loadSeq.current) return;
    setSyncError("");
    setTerminals(result.terminals);
    setSelected((id) => result.terminals.some((t) => t.id === id) ? id : result.terminals[0]?.id ?? "");
  };
  useEffect(() => { void task.run(refresh); }, [cwd, workspaceId]);
  // Other Paseo clients can create/kill terminals or start scripts; mirror them quietly (no busy state, selection kept).
  useEffect(() => {
    if (connection.status !== "connected") return;
    let alive = true;
    let timer: number | undefined;
    let loading = false;
    let again = false;
    const sync = async () => {
      if (loading) { again = true; return; }
      loading = true;
      try {
        do {
          again = false;
          await refresh();
          if (!alive) return;
          if (workspaceId) {
            const next = await driver.listWorkspaceScripts(workspaceId);
            if (alive && !("error" in next && next.error)) setScripts(next.scripts ?? []);
          }
        } while (again && alive);
      } catch { if (alive) setSyncError("Terminal sync failed. Refresh to retry."); }
      finally { loading = false; }
    };
    const schedule = () => { window.clearTimeout(timer); if (!document.hidden) timer = window.setTimeout(() => void sync(), 150); };
    // ponytail: Paseo 0.10.3 does not broadcast terminal renames; reconcile this mounted panel only.
    const stopPolling = visibleInterval(() => void sync(), 3000);
    const sub = driver.observeTerminals({ cwd, workspaceId });
    const offTerminals = sub.subscribe({ snapshot: schedule, update: schedule, error: () => setSyncError("Terminal subscription failed. Reopen the panel to retry.") });
    // driver.subscribe has no script events; the raw handler works once observeEvents opts this connection in.
    const events = workspaceId ? driver.observeEvents(["script_status_update"]) : undefined;
    const offScripts = workspaceId ? driver.on("script_status_update", (message) => { if (message.payload.workspaceId === workspaceId) schedule(); }) : undefined;
    return () => { alive = false; ++loadSeq.current; stopPolling(); window.clearTimeout(timer); offTerminals(); offScripts?.(); void sub.release().catch(() => {}); void events?.release().catch(() => {}); };
  }, [cwd, workspaceId, connection.status]);
  return <div className="panel-body git-panel"><header className="panel-header"><h2>Terminal</h2><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(refresh)}>Refresh</button></header><p className="git-path" title={cwd}>{cwd}</p>{task.status}{dialog}{syncError && <p className="panel-error" role="alert">{syncError}</p>}
    <section className="panel-section"><label className="git-label">Terminal<select className="panel-input" value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Choose a terminal</option>{terminals.map((t) => <option key={t.id} value={t.id}>{t.title || t.name}</option>)}</select></label><label className="git-label">Terminal name<input className="panel-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Terminal" /></label><div className="panel-row"><button className="panel-btn primary" disabled={task.busy} onClick={() => void task.run(async () => { const result = checked(await driver.createTerminal(cwd, name.trim() || undefined, undefined, { workspaceId })); if (!result.terminal) throw new Error("No terminal was created. Please retry."); await refresh(); setSelected(result.terminal.id); })}>New terminal</button><button className="panel-btn" disabled={task.busy || !selected || !name.trim()} onClick={() => void task.run(async () => { checked(await driver.renameTerminal({ terminalId: selected, title: name.trim() })); await refresh(); })}>Rename</button><button className="panel-btn danger" disabled={task.busy || !selected} onClick={() => void task.run(async () => { if (!await confirm(`Kill terminal “${terminals.find((t) => t.id === selected)?.title || terminals.find((t) => t.id === selected)?.name || selected}” in ${cwd}? Its running processes will be stopped.`)) return; checked(await driver.killTerminal(selected)); await refresh(); })}>Kill…</button></div></section>
    {selected ? <TerminalView key={selected} terminalId={selected} /> : <p className="panel-empty">Create a terminal to run commands in this workspace.</p>}
    <section className="panel-section"><h3>Workspace scripts</h3>{workspaceId ? <><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => setScripts(checked(await driver.listWorkspaceScripts(workspaceId)).scripts ?? []))}>Refresh scripts</button>{!scripts.length && <p className="git-muted">No scripts loaded.</p>}{scripts.map((script) => <div className="term-script" key={script.scriptName}><span>{script.scriptName}<small className="git-muted">{script.lifecycle}{script.health ? ` · ${script.health}` : ""}</small></span><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => { if (script.lifecycle === "running") { if (!await confirm(`Stop workspace script ${script.scriptName} in ${cwd}?`)) return; checked(await driver.stopWorkspaceScript(workspaceId, script.scriptName)); } else { const result = checked(await driver.startWorkspaceScriptWithStatus(workspaceId, script.scriptName)); if (result.script?.terminalId) setSelected(result.script.terminalId); } setScripts(checked(await driver.listWorkspaceScripts(workspaceId)).scripts ?? []); await refresh(); })}>{script.lifecycle === "running" ? "Stop…" : "Start"}</button></div>)}</> : <p className="panel-empty">This document has no workspace ID. Scripts require a Paseo workspace.</p>}</section>
  </div>;
}
