import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { api, applyItem, driver, refreshAgents, useAgent, type Block } from "../state/paseo";
import { openDoc } from "../state/layout";
import { PanelLoad, usePanelTask, type PanelProps } from "./RightPanel";
import { scoped } from "../state/native";

function checked<T extends { error?: string | null }>(value: T): T {
  if (value.error) throw new Error("Provider request failed");
  return value;
}

export function AgentPanel({ agentId }: PanelProps) {
  const agent = useAgent(agentId);
  return <div className="panel-body">{agent ? <AgentDetails key={agent.id} agent={agent} /> : <div className="panel-empty"><span className="material-symbols-outlined">description</span><h3>No document selected</h3><p>Open a document to view its agent, model and activity.</p></div>}</div>;
}

function AgentDetails({ agent }: { agent: PaseoAgent }) {
  const [title, setTitle] = useState(agent.title ?? "");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [rewinding, setRewinding] = useState(false);
  const task = usePanelTask();
  const previousTitle = useRef(agent.title ?? "");
  useEffect(() => {
    const old = previousTitle.current, next = agent.title ?? "";
    setTitle(draft => draft === old ? next : draft);
    previousTitle.current = next;
  }, [agent.title]);
  const mutate = (label: string, fn: () => Promise<unknown>) => void task.run(label, async () => {
    setNotice("");
    await fn();
    setNotice("Changes saved.");
    setRevision((n) => n + 1);
    // A refresh failure must not offer to repeat a successful destructive action.
    try { await refreshAgents(); } catch { setNotice("Saved. The document list will update when reconnected."); }
  });
  const forkKey = useRef(crypto.randomUUID());
  return <>
    {task.error}{notice && <p className="panel-muted" role="status">{notice}</p>}
    <section className="panel-section"><form onSubmit={(e) => { e.preventDefault(); if (title.trim()) mutate("rename this document", () => driver.updateAgent(agent.id, { name: title.trim() })); }}>
      <label className="panel-field">Document name<input className="panel-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled document" /></label>
      <button className="panel-btn" disabled={task.busy || !title.trim() || title === agent.title}>Rename</button>
    </form><dl className="panel-facts"><div><dt>Provider</dt><dd>{agent.provider}</dd></div><div><dt>Status</dt><dd><span className="panel-status">{agent.status}</span></dd></div></dl></section>
    <fieldset className="panel-controls" disabled={task.busy}>
      <PanelLoad key={`models:${agent.provider}:${agent.model}:${revision}`} title="Model & reasoning" load={async () => { const r = checked(await driver.listProviderModels(agent.provider, { cwd: agent.cwd })); return { ...r, models: await scoped(agent.provider, r.models ?? []) }; }}>{({ models = [] }) => {
        const model = models.find((m) => m.id === agent.model || m.aliases?.includes(agent.model ?? ""));
        return <><label className="panel-field">Model<select className="panel-input" value={agent.model ?? ""} onChange={(e) => mutate("change model", () => driver.setAgentModel(agent.id, e.target.value || null))}><option value="">Provider default</option>{agent.model && !models.some((m) => m.id === agent.model) && <option value={agent.model}>{agent.model}</option>}{models.filter((m) => m.isSelectable !== false).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
          <label className="panel-field">Thinking<select className="panel-input" disabled={!model?.thinkingOptions?.length} value={agent.thinkingOptionId ?? ""} onChange={(e) => mutate("change thinking level", () => driver.setAgentThinkingOption(agent.id, e.target.value || null))}><option value="">Provider default</option>{model?.thinkingOptions?.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
          {model?.contextWindowMaxTokens != null && <p className="panel-muted">Context window: {model.contextWindowMaxTokens.toLocaleString()} tokens</p>}
        </>;
      }}</PanelLoad>
      <section className="panel-section"><label className="panel-field">Mode<select className="panel-input" disabled={!agent.availableModes?.length} value={agent.currentModeId ?? ""} onChange={(e) => mutate("change mode", () => driver.setAgentMode(agent.id, e.target.value))}><option value="" disabled>Select mode</option>{(agent.availableModes ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label></section>
      <PanelLoad key={`features:${revision}:${agent.model}:${agent.currentModeId}`} title="Features" load={async () => checked(await driver.listProviderFeatures({ provider: agent.provider, cwd: agent.cwd, model: agent.model ?? undefined, modeId: agent.currentModeId ?? undefined, featureValues: Object.fromEntries((agent.features ?? []).map((f) => [f.id, f.value])) }))}>{({ features = [] }) => features.length ? features.map((f) => <label className={f.type === "toggle" ? "panel-row" : "panel-field"} key={f.id} title={f.description}><span>{f.label}</span>{f.type === "toggle" ? <input type="checkbox" checked={f.value} onChange={(e) => mutate(`change ${f.label}`, () => driver.setAgentFeature(agent.id, f.id, e.target.checked))} /> : <select className="panel-input" value={f.value ?? ""} onChange={(e) => mutate(`change ${f.label}`, () => driver.setAgentFeature(agent.id, f.id, e.target.value || null))}><option value="">Default</option>{f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>}</label>) : <p className="panel-muted">No configurable features.</p>}</PanelLoad>
    </fieldset>
    <section className="panel-section"><h3>Usage & context</h3>{agent.lastUsage ? ([["Context used", agent.lastUsage.contextWindowUsedTokens != null && `${agent.lastUsage.contextWindowUsedTokens.toLocaleString()}${agent.lastUsage.contextWindowMaxTokens ? ` of ${agent.lastUsage.contextWindowMaxTokens.toLocaleString()} tokens` : " tokens"}`], ["Input tokens", agent.lastUsage.inputTokens?.toLocaleString()], ["Cached input", agent.lastUsage.cachedInputTokens?.toLocaleString()], ["Output tokens", agent.lastUsage.outputTokens?.toLocaleString()], ["Cost", agent.lastUsage.totalCostUsd != null && `$${agent.lastUsage.totalCostUsd.toFixed(4)}`]] as const).map(([k, v]) => <div className="panel-row" key={k}><span>{k}</span><span>{v || "—"}</span></div>) : <p className="panel-muted">No usage reported yet.</p>}</section>
    <PanelLoad title="Provider usage" load={() => driver.listProviderUsage()}>{(r) => <>{(r.providers ?? []).filter((p) => p.providerId === agent.provider).map((p) => <div key={p.providerId}><p>{p.displayName} · {p.planLabel ?? p.status}</p>{(p.windows ?? []).map((w) => <div className="panel-row" key={w.id}><span>{w.label}</span><span>{w.usedPct != null ? `${Math.round(w.usedPct)}% used` : "Not reported"}</span></div>)}{p.status === "error" && <p className="panel-error">Usage unavailable. Use Refresh to retry.</p>}</div>)}{!(r.providers ?? []).some((p) => p.providerId === agent.provider) && <p className="panel-muted">Usage not reported by this provider.</p>}</>}</PanelLoad>
    <section className="panel-section"><h3>Document information</h3><dl className="panel-facts">{[["Directory", agent.cwd], ["Workspace", agent.workspaceId ?? "Not assigned"], ["Created", date(agent.createdAt)], ["Updated", date(agent.updatedAt)]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl><h3>Labels</h3>{Object.entries(agent.labels ?? {}).length ? <dl className="panel-facts">{Object.entries(agent.labels ?? {}).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : <p className="panel-muted">No labels</p>}</section>
    <PanelLoad title="Commands & skills" load={async () => checked(await api.agents.ref(agent.id).commands())}>{(r) => r.commands?.length ? r.commands.map((c) => <div className="panel-list-item" key={`${c.kind}:${c.name}`}><strong>/{c.name} <small>{c.kind === "skill" ? "Skill" : c.argumentHint}</small></strong><p>{c.description}</p></div>) : <p className="panel-muted">No commands or skills available.</p>}</PanelLoad>
    <PanelLoad title="Sub-agents" load={async () => checked(await driver.listProviderSubagents(agent.id))}>{(r) => r.subagents?.length ? r.subagents.map((s) => <Subagent key={s.id} parentId={agent.id} subagent={s} />) : <p className="panel-muted">No sub-agents.</p>}</PanelLoad>
    <section className="panel-section"><h3>Actions</h3><div className="panel-actions">
      <button className="panel-btn" disabled={task.busy} onClick={() => mutate("fork this document", async () => {
        const context = await driver.buildAgentForkContext(agent.id);
        if (context.error || !context.attachment) throw new Error("Fork context unavailable");
        const fork = await driver.createAgent({ provider: agent.provider, model: agent.model ?? undefined, cwd: agent.cwd, modeId: agent.currentModeId ?? undefined, thinkingOptionId: agent.thinkingOptionId ?? undefined, featureValues: Object.fromEntries((agent.features ?? []).map((f) => [f.id, f.value])), title: `${agent.title ?? "Untitled document"} (fork)`, attachments: [context.attachment], initialPrompt: "Continue from the attached conversation context.", idempotencyKey: forkKey.current });
        forkKey.current = crypto.randomUUID();
        openDoc(fork.id);
      })}>Fork document</button>
      <button className="panel-btn" disabled={task.busy} onClick={() => setRewinding(!rewinding)}>Rewind…</button>
      <button className="panel-btn" disabled={task.busy || !agent.requiresAttention} onClick={() => mutate("clear attention", () => driver.clearAgentAttention(agent.id))}>Clear attention</button>
      <button className="panel-btn panel-danger" disabled={task.busy} onClick={() => { if (window.confirm(`Archive “${agent.title ?? "Untitled document"}”? It will leave the active document list.`)) mutate("archive this document", async () => { await driver.archiveAgent(agent.id); openDoc(null); }); }}>Archive…</button>
    </div>{rewinding && <Rewind agentId={agent.id} />}</section>
  </>;
}

function Rewind({ agentId }: { agentId: string }) {
  const [seq, setSeq] = useState("");
  const [mode, setMode] = useState<"conversation" | "files" | "both">("conversation");
  const [done, setDone] = useState(false);
  const task = usePanelTask();
  return <PanelLoad title="Rewind to a prompt" load={async () => checked(await driver.listAgentTimelinePrompts(agentId))}>{(r) => <>
    <p className="panel-muted">Rewinding removes later conversation or restores file changes. This cannot be undone here.</p>
    {task.error}{done && <p role="status">Rewind complete.</p>}
    <label className="panel-field">Prompt<select className="panel-input" value={seq} onChange={(e) => { setSeq(e.target.value); setDone(false); }}><option value="">Choose a prompt</option>{(r.prompts ?? []).map((p) => <option key={p.seq} value={p.seq}>{p.preview || date(p.timestamp)}</option>)}</select></label>
    <label className="panel-field">Restore<select className="panel-input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="conversation">Conversation only</option><option value="files">Files only</option><option value="both">Conversation and files</option></select></label>
    <button className="panel-btn panel-danger" disabled={task.busy || !seq || done} onClick={() => {
      if (!window.confirm(`Rewind ${mode} to the selected prompt? Later content may be permanently removed.`)) return;
      void task.run("rewind this document", async () => {
        const timeline = await driver.fetchAgentTimeline(agentId, { direction: "after", cursor: { epoch: r.epoch, seq: Number(seq) - 1 }, limit: 1 });
        const row = timeline.entries.find((entry) => entry.seqStart === Number(seq));
        if (timeline.epoch !== r.epoch || row?.item.type !== "user_message" || !row.item.messageId) throw new Error("This prompt cannot be rewound");
        const result = await driver.rewindAgent(agentId, row.item.messageId, mode);
        checked(result);
        setDone(true);
      });
    }}>Confirm rewind</button>
  </>}</PanelLoad>;
}

function date(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "Not available" : d.toLocaleString();
}

/** A sub-agent row that opens to show its own conversation, loaded on first open. */
function Subagent({ parentId, subagent }: { parentId: string; subagent: { id: string; title?: string | null; status: string; description?: string | null; subtitle?: string | null } }) {
  const [blocks, setBlocks] = useState<Block[]>();
  const [error, setError] = useState("");
  const load = () => driver.fetchProviderSubagentTimeline(parentId, subagent.id).then(t => { setError(""); setBlocks((t.rows ?? []).reduce((acc: Block[], row) => applyItem(acc, row.item), [])); }, e => setError(String(e?.message ?? e)));
  return <details className="panel-list-item" onToggle={e => { if (e.currentTarget.open && !blocks) void load(); }}>
    <summary><strong>{subagent.title ?? subagent.id}</strong> <small>{subagent.status}</small></summary>
    <p>{subagent.description}{subagent.subtitle && ` · ${subagent.subtitle}`}</p>
    {error && <p role="alert">Could not load this sub-agent. <button onClick={() => void load()}>Retry</button></p>}
    {blocks?.map((b, i) => <p key={i} className={b.kind === "user" ? "panel-muted" : undefined}>{"text" in b ? b.text : b.kind === "tool" ? `${b.name} · ${b.status}` : ""}</p>)}
  </details>;
}
