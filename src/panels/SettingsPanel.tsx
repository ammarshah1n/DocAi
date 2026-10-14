import { useEffect, useState } from "react";
import { api, connStore, driver, useStore } from "../state/paseo";
import { PanelData, PanelLoad, usePanelTask, type PanelProps } from "./RightPanel";

export const APP_PREFS_KEY = "docai.preferences.v1";
export type AppPreferences = { zoom: number; defaultProvider: string; defaultModel: string };
export function readAppPreferences(): AppPreferences {
  const defaults = { zoom: 100, defaultProvider: "", defaultModel: "" };
  try {
    const raw = JSON.parse(localStorage.getItem(APP_PREFS_KEY) ?? "null");
    return { zoom: Number.isFinite(raw?.zoom) && raw.zoom >= 50 && raw.zoom <= 200 ? raw.zoom : 100, defaultProvider: typeof raw?.defaultProvider === "string" ? raw.defaultProvider : "", defaultModel: typeof raw?.defaultModel === "string" ? raw.defaultModel : "" };
  } catch { return defaults; }
}

export function SettingsPanel(_: PanelProps) {
  const connection = useStore(connStore);
  const [prefs, setPrefs] = useState(readAppPreferences);
  const [saved, setSaved] = useState(false);
  const task = usePanelTask();
  const [diagnostic, setDiagnostic] = useState<{ provider: string; text: string }>();
  const [pluginRevision, setPluginRevision] = useState(0);
  const [providerRevision, setProviderRevision] = useState(0);
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof driver.getDaemonPairingOffer>>>();
  const [copied, setCopied] = useState(false);
  useEffect(() => api.providers.subscribe(() => setProviderRevision((n) => n + 1)), []);
  return <div className="panel-body">
    {task.error}
    <section className="panel-section"><h3>App preferences</h3><form onSubmit={(e) => {
      e.preventDefault();
      void task.run("save preferences", async () => { localStorage.setItem(APP_PREFS_KEY, JSON.stringify(prefs)); window.dispatchEvent(new Event("docai:preferences")); setSaved(true); });
    }} onChange={() => setSaved(false)}>
      <label className="panel-field">Default zoom<select className="panel-input" value={prefs.zoom} onChange={(e) => setPrefs({ ...prefs, zoom: Number(e.target.value) })}>{[50, 75, 90, 100, 125, 150, 200].map((n) => <option key={n} value={n}>{n}%</option>)}</select></label>
      <label className="panel-field">Default provider<input className="panel-input" placeholder="Provider default" value={prefs.defaultProvider} onChange={(e) => setPrefs({ ...prefs, defaultProvider: e.target.value.trim(), defaultModel: "" })} /></label>
      <label className="panel-field">Default model<input className="panel-input" placeholder="Provider default" value={prefs.defaultModel} onChange={(e) => setPrefs({ ...prefs, defaultModel: e.target.value.trim() })} /></label>
      <button className="panel-btn" disabled={task.busy}>Save preferences</button>{saved && <span className="panel-saved" role="status">Saved</span>}
    </form></section>
    <PanelLoad key={`providers:${connection.status}:${providerRevision}`} title="Providers" load={() => driver.getProvidersSnapshot()}>{(r) => <>
      <button className="panel-btn" disabled={task.busy} onClick={() => void task.run("refresh providers", async () => { await driver.refreshProvidersSnapshot(); setProviderRevision((n) => n + 1); })}>Refresh provider discovery</button>
      {r.entries?.length ? r.entries.map((p) => <div className="panel-list-item" key={p.provider}><div className="panel-row"><strong>{p.label ?? p.provider}</strong><span className="panel-status">{p.status}</span></div><p>{p.enabled ? "Enabled" : "Disabled"} · {p.models?.length ?? 0} models</p><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(`load ${p.label ?? p.provider} diagnostics`, async () => { const result = await driver.getProviderDiagnostic(p.provider); setDiagnostic({ provider: p.label ?? p.provider, text: result.diagnostic }); })}>Diagnostics</button></div>) : <p className="panel-muted">No providers reported.</p>}
      {diagnostic && <details open className="panel-diagnostic"><summary>{diagnostic.provider} diagnostics</summary><PanelData value={diagnostic.text} /></details>}
    </>}</PanelLoad>
    <PanelLoad title="Daemon" refreshMs={3000} load={() => driver.getDaemonStatus()}>{(r) => <><div className="panel-row"><span>Connection</span><span className="panel-status">{connection.status}</span></div>{([["Version", r.version], ["Listening on", r.listen], ["Started", r.startedAt && new Date(r.startedAt).toLocaleString()], ["Remote relay", r.relay?.enabled ? "On" : "Off"]] as const).map(([k, v]) => <div className="panel-row" key={k}><span>{k}</span><span>{v ?? "—"}</span></div>)}</>}</PanelLoad>
    <PanelLoad key={`plugins:${pluginRevision}`} title="Plugins" refreshMs={3000} load={() => driver.listPlugins()}>{(plugins) => plugins?.length ? plugins.map((p) => <div className="panel-list-item" key={p.id}><label className="panel-row"><strong>{p.id}</strong><input type="checkbox" aria-label={`Enable ${p.id}`} checked={p.enabled} disabled={task.busy} onChange={() => {
      if (!window.confirm(`${p.enabled ? "Disable" : "Enable"} plugin “${p.id}”? This affects all daemon clients.`)) return;
      void task.run(`${p.enabled ? "disable" : "enable"} plugin`, async () => { await (p.enabled ? driver.disablePlugin(p.id) : driver.enablePlugin(p.id)); setPluginRevision((n) => n + 1); });
    }} /></label><p>{p.status}{p.description ? ` · ${p.description}` : ""}</p></div>) : <p className="panel-muted">No plugins installed.</p>}</PanelLoad>
    <section className="panel-section"><h3>Mobile pairing</h3><p className="panel-muted">Create a private pairing link for your phone. Anyone with the link may connect to this daemon.</p><button className="panel-btn" disabled={task.busy} onClick={() => void task.run("create a pairing offer", async () => { setPairing(await driver.getDaemonPairingOffer()); setCopied(false); })}>{pairing ? "Refresh pairing link" : "Create pairing link"}</button>
      {pairing && <div className="panel-pairing">{pairing.qr?.startsWith("data:image/png;base64,") && <img src={pairing.qr} alt="Mobile pairing QR code" width="220" height="220" />}<label className="panel-field">Private pairing link<textarea className="panel-input" readOnly rows={4} value={pairing.url} /></label><button className="panel-btn" disabled={task.busy} onClick={() => void task.run("copy the pairing link", async () => { await navigator.clipboard.writeText(pairing.url); setCopied(true); })}>{copied ? "Copied" : "Copy link"}</button><button className="panel-btn" onClick={() => setPairing(undefined)}>Hide link</button></div>}
    </section>
  </div>;
}
