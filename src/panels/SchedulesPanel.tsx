import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "./RightPanel";
import { connStore, driver, useStore } from "../state/paseo";
import { openDoc } from "../state/layout";
import { visibleInterval } from "../state/visibleInterval";
import { checked, OpsHeader, useOps } from "./WorkspacePanel";
import "./ops.css";

type Schedule = Awaited<ReturnType<typeof driver.scheduleList>>["schedules"][number];
type Run = Awaited<ReturnType<typeof driver.scheduleLogs>>["runs"][number];
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not scheduled";
// Only editable fields count as an edit conflict, not run/status timestamps.
const editSnapshot = (s: Schedule) => JSON.stringify([s.name ?? "", s.prompt, s.cadence, s.target]);
const presets = [ ["daily", "Every day"], ["weekdays", "Every weekday"], ["weekly", "Every Monday"], ["hourly", "Every hour"], ["custom", "Custom cron"] ];

export function SchedulesPanel({ agentId }: PanelProps) {
  const { busy, error, run } = useOps();
  const connection = useStore(connStore);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [time, setTime] = useState("09:00");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [target, setTarget] = useState("new-agent");
  const [details, setDetails] = useState<Schedule | null>(null);
  const [logs, setLogs] = useState<Run[]>([]);
  const [logsId, setLogsId] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>(["claude", "pi"]);
  const [models, setModels] = useState<string[]>([]);

  const [syncError, setSyncError] = useState("");
  const loadSeq = useRef(0);
  async function load() {
    const seq = ++loadSeq.current; // newest fetch wins, so a slow poll cannot undo a fresher load
    const next = checked(await driver.scheduleList()).schedules ?? [];
    if (seq === loadSeq.current) { setSchedules(next); setSyncError(""); }
  }
  // The SDK has no schedule change event, so poll while mounted (skipping overlaps) to see other clients' changes.
  useEffect(() => {
    if (connection.status !== "connected") return;
    let running = false;
    const stopPolling = visibleInterval(async () => {
      if (running) return;
      running = true;
      try { await load(); } catch { setSyncError("Schedule sync failed. Showing the last known state; retrying automatically."); } finally { running = false; }
    }, 3000);
    return stopPolling;
  }, [connection.status]);
  useEffect(() => { if (connection.status === "connected") void run(() => load()); }, [connection.status]);
  const refresh = () => { void run(() => load()); };
  const mutate = (action: () => Promise<unknown>) => { void run(async () => { checked(await action()); await load(); }); };
  function startEdit(s: Schedule | null) {
    setEditing(s); setFormOpen(true); setName(s?.name ?? ""); setPrompt(s?.prompt ?? ""); setCadence(s?.cadence.type === "every" ? "preserve" : s ? "custom" : "daily");
    setCron(s?.cadence.type === "cron" ? s.cadence.expression : "0 9 * * *");
    setTimezone(s?.cadence.type === "cron" ? s.cadence.timezone ?? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setTarget(s?.target.type ?? "new-agent");
    if (s?.target.type === "new-agent") { setProvider(s.target.config.provider); setModel(s.target.config.model ?? ""); setCwd(s.target.config.cwd); }
    else { setProvider("claude"); setModel(""); setCwd(""); }
    setModels([]);
  }
  async function save() {
    if (!prompt.trim()) throw new Error("Write a prompt for this schedule.");
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    const [hour, minute] = time.split(":").map(Number);
    const expression = cadence === "custom" ? cron.trim() : cadence === "hourly" ? "0 * * * *" : `${minute} ${hour} * * ${cadence === "weekdays" ? "1-5" : cadence === "weekly" ? "1" : "*"}`;
    if (expression.split(/\s+/).length !== 5) throw new Error("Enter a five-field cron expression (minute hour day month weekday).");
    const cadenceValue = { type: "cron" as const, expression, timezone: timezone.trim() };
    if (target === "new-agent" && !cwd.trim().startsWith("/")) throw new Error("Enter an absolute working-folder path.");
    if (editing) {
      const latest = checked(await driver.scheduleInspect({ id: editing.id })).schedule;
      if (!latest || editSnapshot(latest) !== editSnapshot(editing)) {
        await load();
        throw new Error("This schedule changed elsewhere. Your draft is kept. Cancel, then Edit the latest version before saving.");
      }
      const originalConfig = editing.target.type === "new-agent" ? editing.target.config : null;
      // Send only changed fields; never resubmit stale, untouched prompt/config values.
      checked(await driver.scheduleUpdate({ id: editing.id,
        ...((name.trim() || null) !== (editing.name ?? null) ? { name: name.trim() || null } : {}),
        ...(prompt.trim() !== editing.prompt ? { prompt: prompt.trim() } : {}),
        ...(cadence !== "preserve" && JSON.stringify(cadenceValue) !== JSON.stringify(editing.cadence) ? { cadence: cadenceValue } : {}),
        ...(originalConfig ? { newAgentConfig: {
          ...(provider !== originalConfig.provider ? { provider } : {}),
          ...((model.trim() || null) !== (originalConfig.model ?? null) ? { model: model.trim() || null } : {}),
          ...(cwd.trim() !== originalConfig.cwd ? { cwd: cwd.trim() } : {}),
        } } : {}),
      }));
    } else {
      if (target === "agent" && !agentId) throw new Error("Open a document first, or choose a new agent.");
      checked(await driver.scheduleCreate({ name: name.trim() || undefined, prompt: prompt.trim(), cadence: cadenceValue,
        target: target === "agent" && agentId ? { type: "agent", agentId } : { type: "new-agent", config: { provider, model: model.trim() || undefined, cwd: cwd.trim() } } }));
    }
    setFormOpen(false); setEditing(null); await load();
  }

  return <div className="panel-body ops-panel"><OpsHeader title="Schedules" busy={busy} error={error || syncError} refresh={refresh} close="schedules" />
    <fieldset className="ops-controls" disabled={busy || connection.status !== "connected"}>
      {connection.status !== "connected" && <p className="panel-empty">Waiting for Paseo to connect…</p>}
      {!formOpen && <button className="panel-btn primary ops-new" onClick={() => startEdit(null)}><span className="material-symbols-outlined">add</span>New schedule</button>}
      {formOpen && <section className="panel-section"><h3>{editing ? "Edit schedule" : "New schedule"}</h3>{editing && (!schedules.some(s => s.id === editing.id) || schedules.some(s => s.id === editing.id && editSnapshot(s) !== editSnapshot(editing))) && <p className="panel-error" role="alert">This schedule changed or was deleted elsewhere. Your draft is kept. Cancel, then Edit the latest version before saving.</p>}<form onSubmit={e => { e.preventDefault(); void run(save); }}>
        <label>Name<input className="panel-input" value={name} onChange={e => setName(e.target.value)} placeholder="Morning briefing" /></label>
        <label>Prompt<textarea className="panel-input" required rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="What should your agent do?" /></label>
        {editing?.cadence.type === "every" && <p className="ops-note">Interval: {Math.round(editing.cadence.everyMs / 1000)} seconds. Keep it unchanged or select a new cadence.</p>}
        <label>Repeat<select className="panel-input" value={cadence} onChange={e => setCadence(e.target.value)}>{editing?.cadence.type === "every" && <option value="preserve">Keep current interval</option>}{presets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {cadence !== "custom" && cadence !== "hourly" && cadence !== "preserve" && <label>At<input className="panel-input" type="time" required value={time} onChange={e => setTime(e.target.value)} /></label>}
        {cadence === "custom" && <label>Cron expression<input className="panel-input" required value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * 1-5" /><small>Minute · hour · day · month · weekday</small></label>}
        <label>Timezone<input className="panel-input" required value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="Australia/Adelaide" /></label>
        <label>Run in<select className="panel-input" value={target} disabled={!!editing} onChange={e => setTarget(e.target.value)}><option value="new-agent">A new agent each time</option><option value="agent" disabled={!agentId && !editing}>Current document</option></select></label>
        {target === "new-agent" && <><label>Provider<input className="panel-input" required list="ops-providers" value={provider} onChange={e => { setProvider(e.target.value); setModel(""); setModels([]); }} /></label><datalist id="ops-providers">{providers.map(p => <option key={p} value={p} />)}</datalist>
        <label>Model<input className="panel-input" list="ops-models" value={model} onChange={e => setModel(e.target.value)} placeholder="Provider default" /></label><datalist id="ops-models">{models.map(m => <option key={m} value={m} />)}</datalist>
        <button className="panel-btn" type="button" onClick={() => { void run(async () => { const p = checked(await driver.listAvailableProviders()); setProviders(p.providers.map(p => p.provider)); const m = checked(await driver.listProviderModels(provider)); setModels((m.models ?? []).map(m => m.id)); }); }}>Load available models</button>
        <label>Working folder<input className="panel-input" required value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/project" /></label></>}
        {editing?.target.type === "agent" && <p className="ops-note">Target document: {editing.target.agentId}</p>}
        <div className="panel-row"><button className="panel-btn primary">{editing ? "Save changes" : "Create schedule"}</button><button className="panel-btn" type="button" onClick={() => setFormOpen(false)}>Cancel</button></div>
      </form></section>}
      {!schedules.length && !busy && <div className="ops-empty"><span className="material-symbols-outlined">schedule</span><h3>A little help, right on time</h3><p>Schedule a prompt and let your agent take care of the routine.</p></div>}
      {schedules.map(s => <article key={s.id} className="ops-card"><div className="ops-heading"><strong>{s.name || "Untitled schedule"}</strong><span className="ops-status">{s.status}</span></div><p className="ops-prompt">{s.prompt}</p><p className="ops-note">{s.cadence.type === "cron" ? `${s.cadence.expression} · ${s.cadence.timezone || "Daemon timezone"}` : `Every ${Math.round(s.cadence.everyMs / 1000)} seconds`}</p><p className="ops-next">Next: {date(s.nextRunAt)}</p><div className="panel-row"><button className="panel-btn" onClick={() => startEdit(s)}>Edit</button><button className="panel-btn" disabled={s.status === "completed"} onClick={() => mutate(() => s.status === "paused" ? driver.scheduleResume({ id: s.id }) : driver.schedulePause({ id: s.id }))}>{s.status === "paused" ? "Resume" : "Pause"}</button><button className="panel-btn" onClick={() => { if (confirm(`Run “${s.name || "this schedule"}” now? This sends its prompt to an agent.`)) mutate(() => driver.scheduleRunOnce({ id: s.id })); }}>Run once</button></div><details><summary>Details & history</summary><div className="panel-row"><button className="panel-btn" onClick={() => { void run(async () => setDetails(checked(await driver.scheduleInspect({ id: s.id })).schedule)); }}>Inspect</button><button className="panel-btn" onClick={() => { void run(async () => { const result = checked(await driver.scheduleLogs({ id: s.id })); setLogs(result.runs ?? []); setLogsId(s.id); }); }}>Load logs</button><button className="panel-btn danger" onClick={() => { if (confirm(`Delete “${s.name || "this schedule"}”? Future runs will be cancelled. This cannot be undone.`)) mutate(() => driver.scheduleDelete({ id: s.id })); }}>Delete</button></div>
        {details?.id === s.id && <dl className="ops-info"><dt>Created</dt><dd>{date(details.createdAt)}</dd><dt>Last run</dt><dd>{date(details.lastRunAt)}</dd><dt>Target</dt><dd>{details.target.type === "agent" ? details.target.agentId : `${details.target.config.provider} · ${details.target.config.model || "Default model"}\n${details.target.config.cwd}`}</dd><dt>Run limit</dt><dd>{details.maxRuns ?? "Unlimited"}</dd><dt>Expires</dt><dd>{date(details.expiresAt)}</dd></dl>}
        {logsId === s.id && <div aria-live="polite">{!logs.length && <p className="panel-empty">No runs yet.</p>}{logs.map(log => <div className="ops-log" key={log.id}><strong>{log.status}</strong><p>{date(log.startedAt)}</p>{log.error && <p className="panel-error">{log.error}</p>}{log.output && <pre>{log.output}</pre>}{log.agentId && <button className="panel-btn" onClick={() => openDoc(log.agentId)}>Open document</button>}</div>)}</div>}
      </details></article>)}
    </fieldset>
  </div>;
}
