import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "./RightPanel";
import { api, connStore, driver, useStore } from "../state/paseo";
import { openDoc, setRightPanel } from "../state/layout";
import "./ops.css";

type Result<M extends (...args: never[]) => unknown> = Awaited<ReturnType<M>>;
type Project = Result<typeof driver.listProjects>["projects"][number];
type Workspace = Result<typeof driver.fetchWorkspaces>["entries"][number];
type Worktree = Result<typeof driver.getPaseoWorktreeList>["worktrees"][number];

export function checked<T>(result: T): T {
  if (result && typeof result === "object" && "error" in result && result.error) {
    const error = result.error;
    throw new Error(typeof error === "string" ? error : typeof error === "object" && "message" in error ? String(error.message) : "The daemon could not complete this request.");
  }
  return result;
}

export function useOps() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { checked(await action()); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Request failed. Please try again."); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return { busy, error, run };
}

export function OpsHeader({ title, busy, error, refresh, close }: { title: string; busy: boolean; error: string; refresh: () => void; close: string }) {
  return <><header className="panel-header"><h2>{title}</h2><button className="ops-icon" title="Refresh" aria-label="Refresh" disabled={busy} onClick={refresh}><span className="material-symbols-outlined">refresh</span></button><button className="ops-icon" title="Close panel" aria-label="Close panel" onClick={() => setRightPanel(close)}><span className="material-symbols-outlined">close</span></button></header>{busy && <div className="ops-progress" role="status">Working…</div>}{error && <div className="panel-error" role="alert">{error}<p>Refresh to check the latest state before trying the action again.</p><button className="panel-btn" disabled={busy} onClick={refresh}>Retry refresh</button></div>}</>;
}

function WorkspaceTitle({ workspace, mutate }: { workspace: Workspace; mutate: (action: () => Promise<unknown>) => void }) {
  const [title, setTitle] = useState(workspace.title ?? "");
  const [base, setBase] = useState(workspace.title ?? "");
  useEffect(() => {
    if (title === base) { setTitle(workspace.title ?? ""); setBase(workspace.title ?? ""); }
  }, [workspace.title]);
  return <form onSubmit={e => { e.preventDefault(); mutate(async () => {
    const latest = await api.workspaces.ref(workspace.id).refresh();
    if (!latest || (latest.title ?? "") !== base) throw new Error("This workspace title changed elsewhere. Your draft is kept. Reload the title before saving.");
    const next = title.trim();
    await driver.setWorkspaceTitle(workspace.id, next || null);
    setTitle(next); setBase(next);
  }); }}><label>Title<input className="panel-input" name="title" aria-label="Workspace title" value={title} onChange={e => setTitle(e.target.value)} placeholder={workspace.name} /></label>
    {(workspace.title ?? "") !== base && <p className="panel-error" role="alert">Title changed elsewhere; your draft is kept.</p>}
    <button className="panel-btn">Save title</button><button className="panel-btn" type="button" onClick={() => {
      if (title !== base && !confirm("Discard your unsaved title and reload the latest workspace title?")) return;
      setTitle(workspace.title ?? ""); setBase(workspace.title ?? "");
    }}>Reload title…</button></form>;
}

export function WorkspacePanel(_props: PanelProps) {
  const { busy, error, run } = useOps();
  const connection = useStore(connStore);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [nameBase, setNameBase] = useState("");
  const [branch, setBranch] = useState("");
  const [slug, setSlug] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [target, setTarget] = useState("");
  const [repositories, setRepositories] = useState<Result<typeof driver.searchGithubRepositories>["repositories"]>([]);
  const [recoveryId, setRecoveryId] = useState("");
  const [recovery, setRecovery] = useState<Result<typeof driver.inspectWorkspaceRecovery> | null>(null);
  const [setup, setSetup] = useState<Record<string, string>>({});
  const [icon, setIcon] = useState<string | null>(null);
  const [labels, setLabels] = useState<Result<typeof driver.listWorkspaceLabels>["labels"]>([]);
  const project = projects.find(p => p.projectId === selected);
  useEffect(() => {
    if (project && name === nameBase) { setName(project.projectDisplayName); setNameBase(project.projectDisplayName); }
  }, [selected, project?.projectDisplayName]);

  const [syncError, setSyncError] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loadSeq = useRef(0);
  const reloadTimer = useRef<number | undefined>(undefined);
  async function load(id = selected) {
    // Only the newest load may write state, so a slow remote-triggered reload cannot undo a newer selection.
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current;
    const p = checked(await driver.listProjects());
    if (stale()) return;
    setProjects(p.projects ?? []);
    setSyncError("");
    const active = p.projects?.find(p => p.projectId === id);
    if (!active) { setSelected(""); setWorkspaces([]); setTrees([]); return; }
    const entries: Workspace[] = [];
    let cursor: string | undefined;
    do {
      const page = checked(await driver.fetchWorkspaces({ filter: { projectId: id }, page: { limit: 200, cursor } }));
      entries.push(...(page.entries ?? []));
      const next = page.pageInfo?.hasMore ? page.pageInfo.nextCursor : null;
      if (next === cursor) break;
      cursor = next ?? undefined;
    } while (cursor);
    if (stale()) return;
    setWorkspaces(entries);
    const nextLabels = checked(await driver.listWorkspaceLabels()).labels ?? [];
    if (stale()) return;
    setLabels(nextLabels);
    const nextTrees = active.projectKind === "git" ? checked(await driver.getPaseoWorktreeList({ cwd: active.projectRootPath })).worktrees ?? [] : [];
    if (stale()) return;
    setTrees(nextTrees);
    const image = checked(await driver.getProjectIcon(id));
    if (stale()) return;
    setIcon(image.icon ? `data:${image.icon.mimeType};base64,${image.icon.data}` : null);
  }
  // Remote changes (another Paseo client) reload the lists quietly; forms and drafts are separate state and stay untouched.
  const scheduleReload = () => {
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => { void load(selectedRef.current).catch(() => setSyncError("Workspace sync failed. Refresh to retry.")); }, 200);
  };
  useEffect(() => {
    if (connection.status !== "connected") return;
    // driver.subscribe only registers a local handler; observeEvents makes the daemon send these events.
    const events = driver.observeEvents(["project.update", "workspace_setup_progress"]);
    const offEvents = events.subscribe({ snapshot: scheduleReload, update: () => {}, error: () => setSyncError("Workspace subscription failed. Reopen the panel to retry.") });
    const off = driver.subscribe(event => {
      if (event.type === "project.update") scheduleReload();
      else if (event.type === "workspace_setup_progress") {
        const { workspaceId, status, error } = event.payload;
        setSetup(s => ({ ...s, [workspaceId]: `${status}${error ? `: ${error}` : ""}` }));
      }
    });
    return () => { off(); offEvents(); ++loadSeq.current; window.clearTimeout(reloadTimer.current); void events.release().catch(() => {}); };
  }, [connection.status]);
  useEffect(() => {
    if (connection.status !== "connected" || !selected) return;
    const sub = driver.observeWorkspaces({ filter: { projectId: selected } });
    const off = sub.subscribe({ snapshot: scheduleReload, update: scheduleReload, error: () => setSyncError("Workspace subscription failed. Reopen the panel to retry.") });
    return () => { off(); void sub.release().catch(() => {}); };
  }, [connection.status, selected]);
  useEffect(() => { if (connection.status === "connected") void run(() => load()); }, [connection.status]);
  const refresh = () => { void run(() => load()); };
  const mutate = (action: () => Promise<unknown>) => { void run(async () => { checked(await action()); await load(); }); };
  function newDoc(cwd: string) { void run(async () => { localStorage.setItem("docai.newdoc.cwd", cwd); openDoc(null); window.dispatchEvent(new Event("docai-newdoc")); }); }

  return <div className="panel-body ops-panel"><OpsHeader title="Projects & worktrees" busy={busy} error={error || syncError} refresh={refresh} close="workspace" />
    <fieldset disabled={busy || connection.status !== "connected"} className="ops-controls">
      {connection.status !== "connected" && <p className="panel-empty">Waiting for Paseo to connect…</p>}
      <section className="panel-section"><label>Project<select className="panel-input" value={selected} onChange={e => { const id = e.target.value; setSelected(id); setWorkspaces([]); setTrees([]); setIcon(null); setBranches([]); setName(projects.find(p => p.projectId === id)?.projectDisplayName ?? ""); setNameBase(projects.find(p => p.projectId === id)?.projectDisplayName ?? ""); void run(() => load(id)); }}><option value="">Choose a project</option>{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.projectDisplayName}</option>)}</select></label>
      {!projects.length && !busy && <p className="panel-empty">Bring a project into your workspace to get started.</p>}
      <details><summary>Add a project</summary><form onSubmit={e => { e.preventDefault(); mutate(() => driver.addProject(path.trim())); }}><label>Folder path<input className="panel-input" required value={path} placeholder="/path/to/project" onChange={e => setPath(e.target.value)} /></label><button className="panel-btn primary">Add project</button></form></details></section>
      {project && <>
        <section className="panel-section"><div className="ops-heading">{icon ? <img className="ops-project-icon" src={icon} alt="" /> : <span className="material-symbols-outlined">folder</span>}<h3>{project.projectDisplayName}</h3></div><p className="ops-path">{project.projectRootPath}</p><button className="panel-btn" onClick={() => mutate(() => driver.openProject(project.projectRootPath))}>Open project</button>
        <details><summary>Project settings</summary><form onSubmit={e => { e.preventDefault(); mutate(async () => {
          const latest = checked(await driver.listProjects()).projects.find(p => p.projectId === selected);
          if (!latest || latest.projectDisplayName !== nameBase) throw new Error("This project name changed elsewhere. Your draft is kept. Reload the name before saving.");
          await driver.renameProject(selected, name.trim() || null);
          const saved = checked(await driver.listProjects()).projects.find(p => p.projectId === selected);
          if (saved) { setName(saved.projectDisplayName); setNameBase(saved.projectDisplayName); }
        }); }}><label>Display name<input className="panel-input" aria-label="Project display name" value={name} onChange={e => setName(e.target.value)} /></label>{project.projectDisplayName !== nameBase && <p className="panel-error" role="alert">Name changed elsewhere; your draft is kept.</p>}<button className="panel-btn">Save name</button><button className="panel-btn" type="button" onClick={() => {
          if (name !== nameBase && !confirm("Discard your unsaved name and reload the latest project name?")) return;
          setName(project.projectDisplayName); setNameBase(project.projectDisplayName);
        }}>Reload name…</button></form><label>Project icon<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; if (!file) return; mutate(async () => { if (file.size > 2 * 1024 * 1024) throw new Error("Choose an icon smaller than 2 MB."); const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("Could not read this image.")); reader.readAsDataURL(file); }); await driver.setProjectIcon(selected, { type: "upload", data }); }); e.target.value = ""; }} /></label><div className="panel-row"><button className="panel-btn" onClick={() => mutate(() => driver.setProjectIcon(selected, { type: "automatic" }))}>Reset icon</button><button className="panel-btn danger" onClick={() => { if (confirm(`Remove “${project.projectDisplayName}” from Paseo? Its workspaces will also be removed from the list.`)) mutate(() => driver.removeProject(selected)); }}>Remove project</button></div></details></section>
        <section className="panel-section"><h3>Workspaces</h3>{!workspaces.length && <p className="panel-empty">No active workspaces in this project.</p>}{workspaces.map(w => <article className="ops-card" key={w.id}><div className="ops-heading"><span className="material-symbols-outlined">{w.pinnedAt ? "keep" : "folder_open"}</span><strong>{w.name || "Untitled workspace"}</strong><span className="ops-status">{w.status}</span></div><p className="ops-path">{w.workspaceDirectory || w.projectRootPath}</p><button className="panel-btn primary" onClick={() => newDoc(w.workspaceDirectory || w.projectRootPath)}>New doc here</button><details><summary>Manage workspace</summary>
          <WorkspaceTitle workspace={w} mutate={mutate} />
          <button className="panel-btn" onClick={() => mutate(() => driver.setWorkspacePinned(w.id, !w.pinnedAt))}>{w.pinnedAt ? "Unpin" : "Pin workspace"}</button>
          <div className="panel-row">{(w.labels ?? []).map(label => <button className="ops-chip" key={label} title={`Remove label ${label}`} onClick={() => mutate(() => driver.setWorkspaceLabel({ workspaceId: w.id, label: labels.find(l => l.name === label) ?? { name: label, color: "blue" }, assigned: false }))}>{label} ×</button>)}</div>
          <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const label = String(data.get("label") ?? "").trim(); if (label) mutate(() => driver.setWorkspaceLabel({ workspaceId: w.id, label: labels.find(l => l.name === label) ?? { name: label, color: "blue" }, assigned: true })); }}><label>Add label<input className="panel-input" name="label" required /></label><button className="panel-btn">Add label</button></form>
          <div className="panel-row"><button className="panel-btn" onClick={() => { void run(async () => { const r = checked(await driver.fetchWorkspaceSetupStatus(w.id)); setSetup(s => ({ ...s, [w.id]: r.snapshot ? `${r.snapshot.status}${r.snapshot.error ? `: ${r.snapshot.error}` : ""}` : "No setup has run." })); }); }}>Setup status</button><button className="panel-btn" onClick={() => { void run(async () => { const r = checked(await driver.runWorkspaceSetup(w.id)); setSetup(s => ({ ...s, [w.id]: r.started ? "Setup started. Refresh status to check progress." : "Setup did not start." })); }); }}>Run setup</button></div>{setup[w.id] && <p role="status">{setup[w.id]}</p>}
          <button className="panel-btn danger" onClick={() => { if (confirm(`Archive “${w.name}”? This can stop its agents and remove its worktree. Uncommitted changes may be lost.`)) { setRecoveryId(w.id); mutate(() => driver.archiveWorkspace(w.id)); } }}>Archive workspace</button>
        </details></article>)}
        <details><summary>Create workspace</summary><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); mutate(() => driver.createWorkspace({ idempotencyKey: crypto.randomUUID(), source: { kind: "directory", projectId: selected, path: String(data.get("cwd")).trim() }, title: String(data.get("title") ?? "").trim() || undefined })); }}><label>Folder path<input className="panel-input" name="cwd" required defaultValue={project.projectRootPath} key={selected} /></label><label>Title<input className="panel-input" name="title" /></label><button className="panel-btn primary">Create workspace</button></form></details></section>
        {project.projectKind === "git" && <section className="panel-section"><h3>Worktrees</h3>{trees.map(t => <article className="ops-card" key={t.worktreePath}><strong>{t.branchName || "Detached worktree"}</strong><p className="ops-path">{t.worktreePath}</p><div className="panel-row"><button className="panel-btn" onClick={() => newDoc(t.worktreePath)}>New doc here</button><button className="panel-btn danger" onClick={() => { if (confirm(`Archive worktree at ${t.worktreePath}? Agents may be removed and uncommitted changes may be lost.`)) mutate(() => driver.archivePaseoWorktree({ worktreePath: t.worktreePath })); }}>Archive</button></div></article>)}{!trees.length && <p className="panel-empty">No Paseo worktrees yet.</p>}
        <details><summary>Create worktree</summary><form onSubmit={e => { e.preventDefault(); mutate(async () => { const valid = checked(await driver.validateBranch({ cwd: project.projectRootPath, branchName: branch.trim() })); if (!valid.exists) throw new Error("Choose an existing base branch or ref."); if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) throw new Error("Use letters, numbers, hyphens or underscores for the worktree name."); const created = await driver.createPaseoWorktree({ cwd: project.projectRootPath, projectId: selected, worktreeSlug: slug, refName: valid.resolvedRef ?? branch.trim(), action: "branch-off" }); setTimeout(refresh, 1500); /* ponytail: the daemon lists a new worktree a moment after create returns; poll if 1.5s proves short */ return created; }); }}><label>Worktree name<input className="panel-input" value={slug} required onChange={e => setSlug(e.target.value)} /></label><label>Base branch<input className="panel-input" list="ops-branches" required value={branch} onChange={e => setBranch(e.target.value)} /></label><datalist id="ops-branches">{branches.map(b => <option key={b} value={b} />)}</datalist><div className="panel-row"><button type="button" className="panel-btn" onClick={() => { void run(async () => setBranches(checked(await driver.getBranchSuggestions({ cwd: project.projectRootPath, query: branch, limit: 30 })).branches ?? [])); }}>Suggest branches</button><button className="panel-btn primary">Create worktree</button></div></form></details></section>}
      </>}
      <section className="panel-section"><details><summary>Recover archived workspace</summary><form onSubmit={e => { e.preventDefault(); void run(async () => setRecovery(await driver.inspectWorkspaceRecovery(recoveryId.trim()))); }}><label>Workspace ID<input className="panel-input" required value={recoveryId} onChange={e => { setRecoveryId(e.target.value); setRecovery(null); }} /></label><button className="panel-btn">Check recovery</button></form>{recovery && <><p>{recovery.kind === "recoverable" ? `${recovery.workspaceName}: ${recovery.action}` : recovery.message}</p>{recovery.kind === "recoverable" && <button className="panel-btn" onClick={() => mutate(async () => { await driver.restoreWorkspace(recovery.workspaceId); setRecovery(null); })}>Restore workspace</button>}</>}</details></section>
      <section className="panel-section"><details><summary>Clone from GitHub</summary><form onSubmit={e => { e.preventDefault(); void run(async () => setRepositories(checked(await driver.searchGithubRepositories({ query: repo, limit: 20 })).repositories ?? [])); }}><label>Search repositories<input className="panel-input" required value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/repository" /></label><button className="panel-btn">Search GitHub</button></form>{repositories.map(r => <button className="ops-repo" key={r.id} onClick={() => setRepo(r.nameWithOwner)}>{r.nameWithOwner}<small>{r.description}</small></button>)}<form onSubmit={e => { e.preventDefault(); mutate(() => driver.cloneGithubProject({ repo: repo.trim(), targetDirectory: target.trim() })); }}><label>Repository<input className="panel-input" required value={repo} onChange={e => setRepo(e.target.value)} /></label><label>Destination folder<input className="panel-input" required value={target} onChange={e => setTarget(e.target.value)} /></label><button className="panel-btn primary">Clone project</button></form></details></section>
    </fieldset>
  </div>;
}
