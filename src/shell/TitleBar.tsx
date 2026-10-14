import { useEffect, useState } from "react";
import docaiMark from "../assets/docai.svg";
import { connStore, driver, refreshAgents, useStore } from "../state/paseo";
import { openDoc, setRightPanel } from "../state/layout";
import { Icon, Tool, useAction, useFocusedAgent } from "./controls";

export function TitleBar() {
  const agent = useFocusedAgent();
  const conn = useStore(connStore);
  const [title, setTitle] = useState("");
  const { run, busy, error } = useAction();
  useEffect(() => setTitle(agent?.title ?? "Untitled document"), [agent?.id, agent?.title]);
  const rename = () => {
    const name = title.trim();
    if (!name) return setTitle(agent?.title ?? "Untitled document");
    if (agent && name !== agent.title) run("rename this document", async () => { await driver.updateAgent(agent.id, { name }); await refreshAgents(); });
  };
  return <><div className="titlebar">
    <button className="docs-logo" aria-label="New blank document" title="DocAi · New blank document" onClick={() => openDoc(null)}><img src={docaiMark} alt="" aria-hidden="true" /></button>
    <input id="docai-title" className="document-title" aria-label="Document title" value={title} disabled={!agent || busy} style={{ width: `${Math.max(16, Math.min(title.length + 2, 40))}ch` }} onChange={e => setTitle(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setTitle(agent?.title ?? "Untitled document"); } }} />
    <Tool icon={agent?.labels?.starred === "true" ? "star" : "star_outline"} label="Star document" onClick={agent ? () => run("star this document", async () => { await driver.updateAgent(agent.id, { labels: { ...agent.labels, starred: agent.labels?.starred === "true" ? "false" : "true" } }); await refreshAgents(); }) : undefined} />
    <Tool icon="drive_file_move" label="Projects & worktrees" onClick={() => setRightPanel("workspace")} />
    <span className="cloud-status" role="status" aria-label={conn.status} data-tooltip={conn.status === "connected" ? "Connected to Paseo · history saved by daemon" : conn.status === "connecting" ? "Connecting to Paseo…" : "Offline · waiting to reconnect"}><Icon name={conn.status === "connected" ? "cloud_done" : conn.status === "connecting" ? "sync" : "cloud_off"} /></span>
    <div className="titlebar-spacer" />
    <div className="titlebar-actions"><Tool icon="history" label="Version history (not available)" /><Tool icon="comment" label="Agent details" onClick={() => setRightPanel("agent")} />
    <button className="run-pill" title={agent?.status === "running" ? "Stop generating" : "Send your message from the document to run"} disabled={!agent || busy || agent.status !== "running"} onClick={() => agent && run("stop generating", () => driver.cancelAgent(agent.id))}><Icon name={agent?.status === "running" ? "stop" : "play_arrow"} />{agent?.status === "running" ? "Stop" : "Run"}</button>
    <button className="account-avatar" aria-label="DocAi settings" onClick={() => setRightPanel("settings")}>D</button></div>
  </div>{error}</>;
}
