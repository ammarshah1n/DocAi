import { useEffect, useRef, useState } from "react";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { driver, useAgent } from "../state/paseo";
import { visibleInterval } from "../state/visibleInterval";
import type { PanelProps } from "./RightPanel";
import { checked, PanelEmpty, usePanelConfirm, usePanelTask } from "./GitUI";

type Directory = Awaited<ReturnType<typeof driver.listDirectory>>;

function fileText(file: FileReadResult) {
  if (file.kind !== "text") return "";
  if (file.bytes.byteLength < file.size) throw new Error("This file is too large to edit safely in the panel. No changes were made.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
}

// <classify>
type RemoteVersion = { status: "ready" | "missing" | "error"; modifiedAt?: string; revision?: string; error?: string };
export function classifyRemote(version: RemoteVersion, known: { modifiedAt: string; revision?: string }, dirty: boolean) {
  if (version.status === "error") return "error";
  if (version.status === "missing") return "missing";
  if (version.modifiedAt === known.modifiedAt && version.revision === known.revision) return "same";
  return dirty ? "conflict" : "reload";
}
// </classify>

const DIR_POLL_MS = 5000;

export function FilesPanel({ agentId }: PanelProps) {
  const agent = useAgent(agentId);
  return agent?.cwd ? <Files key={`${agent.id}:${agent.cwd}`} cwd={agent.cwd} agentId={agent.id} /> : <PanelEmpty title="Files" />;
}

function Files({ cwd, agentId }: { cwd: string; agentId: string }) {
  const task = usePanelTask();
  const { confirm, dialog } = usePanelConfirm();
  const [dirs, setDirs] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [parent, setParent] = useState("");
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<FileReadResult>();
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [uploaded, setUploaded] = useState<NonNullable<Awaited<ReturnType<typeof driver.uploadFile>>["file"]>>();
  const [attachmentText, setAttachmentText] = useState("");
  const live = useRef({ selected, file, text, original, expanded, busy: task.busy });
  live.current = { ...live.current, selected, file, text, original, expanded, busy: task.busy };
  const watchPath = file?.kind === "text" ? selected : "";
  const draftKey = (path: string) => `docai.file-draft:${cwd}:${path}`;
  const loadDir = async (path: string) => { const result = await driver.listDirectory(cwd, path); setDirs((d) => ({ ...d, [path]: result })); };
  const refresh = async () => { for (const path of expanded) await loadDir(path); };
  useEffect(() => { void task.run(() => loadDir("")); }, [cwd]);
  // ponytail: no SDK directory events; refresh only expanded folders while this panel is mounted.
  useEffect(() => {
    let stopped = false, inflight = false;
    const stopPolling = visibleInterval(async () => {
      if (inflight || live.current.busy) return;
      inflight = true;
      try {
        for (const path of live.current.expanded) {
          const result = await driver.listDirectory(cwd, path);
          if (stopped) return;
          if (live.current.expanded.has(path)) setDirs((d) => ({ ...d, [path]: result }));
        }
      } catch (e) { if (!stopped) setNotice(`Could not refresh the file list: ${e instanceof Error ? e.message : "unknown error"}`); }
      finally { inflight = false; }
    }, DIR_POLL_MS);
    return () => { stopped = true; stopPolling(); };
  }, [cwd]);
  // Selected text file: follow external edits. Never touch a dirty draft or its original revision.
  useEffect(() => {
    if (!watchPath) return;
    let cancelled = false, seq = 0;
    const onVersion = async (version: Parameters<typeof classifyRemote>[0]) => {
      const cur = live.current;
      if (cancelled || !cur.file || cur.selected !== watchPath) return;
      const mine = ++seq;
      const verdict = classifyRemote(version, cur.file, cur.text !== cur.original);
      if (verdict === "same") return;
      if (verdict === "error") return setNotice(`Cannot watch ${watchPath}: ${version.error}`);
      if (verdict === "missing") return setNotice(cur.text !== cur.original ? "This file was deleted on disk. Your draft is kept; saving is blocked until you reload or copy it." : "This file was deleted on disk.");
      if (verdict === "conflict") return setNotice("This file changed on disk while you have unsaved edits. Your draft is kept; copy it, then use Reload disk… to merge.");
      try {
        const next = await driver.readFile(cwd, watchPath, undefined, 1024 * 1024);
        const content = fileText(next);
        const now = live.current;
        if (cancelled || mine !== seq || now.selected !== watchPath || now.text !== now.original) return;
        setFile(next); setText(content); setOriginal(content); setNotice("Updated from disk.");
      } catch (e) { if (!cancelled) setNotice(`Could not refresh ${watchPath}: ${e instanceof Error ? e.message : "unknown error"}`); }
    };
    let unsubscribe: (() => Promise<void>) | undefined;
    driver.subscribeFile({ cwd, path: watchPath }, (v) => void onVersion(v)).then((sub) => {
      if (cancelled) void sub.unsubscribe().catch(() => {}); else { unsubscribe = sub.unsubscribe; void onVersion(sub.initial); }
    }).catch((e) => { if (!cancelled) setNotice(`Cannot watch ${watchPath}: ${e instanceof Error ? e.message : "unknown error"}`); });
    return () => { cancelled = true; void unsubscribe?.().catch(() => {}); };
  // A saved/reloaded revision rechecks the subscription snapshot, including changes during the save.
  }, [cwd, watchPath, file?.revision, file?.modifiedAt]);
  const open = async (path: string) => {
    const next = await driver.readFile(cwd, path, undefined, 1024 * 1024);
    const content = fileText(next);
    let draft: { text: string; original: string; modifiedAt: string; revision?: string } | null = null;
    try { const stored = JSON.parse(localStorage.getItem(draftKey(path)) ?? "null"); if (stored && typeof stored.text === "string" && typeof stored.original === "string" && typeof stored.modifiedAt === "string") draft = stored; } catch { /* Storage may be disabled. */ }
    setFile(draft ? { ...next, modifiedAt: draft.modifiedAt, revision: draft.revision } : next); setSelected(path); setOriginal(draft?.original ?? content); setText(draft?.text ?? content);
    setNotice(draft !== null ? "Restored your unsaved draft. Review before saving; external changes will block overwrite." : "");
  };
  const changeText = (value: string) => {
    live.current.text = value;
    setText(value);
    try { if (value === original) localStorage.removeItem(draftKey(selected)); else localStorage.setItem(draftKey(selected), JSON.stringify({ text: value, original, modifiedAt: file?.modifiedAt, revision: file?.revision })); }
    catch { setNotice("Draft could not be stored locally. Keep this panel open until saved."); }
  };
  const mutate = (operation: () => Promise<unknown>, warning?: string) => void task.run(async () => {
    if (warning && !await confirm(warning)) return;
    checked(await operation()); setExpanded(new Set([""])); setDirs({}); setParent(""); await loadDir("");
  });
  const tree = (path: string, depth = 0): React.ReactNode => depth > 30 ? <p className="git-muted">Maximum preview depth reached.</p> : dirs[path]?.entries.map((entry) => <div key={entry.path}>
    <button className={`git-tree-entry ${selected === entry.path ? "selected" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} disabled={task.busy} onClick={() => void task.run(async () => {
      if (entry.kind === "directory") {
        setSelected(entry.path); setParent(entry.path); setFile(undefined);
        if (expanded.has(entry.path)) setExpanded((old) => { const next = new Set(old); next.delete(entry.path); return next; });
        else { await loadDir(entry.path); setExpanded((old) => new Set([...old, entry.path])); }
      } else { setParent(path); await open(entry.path); }
    })}><span className="material-symbols-outlined">{entry.kind === "directory" ? expanded.has(entry.path) ? "folder_open" : "folder" : "description"}</span><span>{entry.name}</span></button>
    {entry.kind === "directory" && expanded.has(entry.path) && tree(entry.path, depth + 1)}
  </div>);
  return <div className="panel-body git-panel"><header className="panel-header"><h2>Files</h2><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(refresh)}>Refresh</button></header><p className="git-path" title={cwd}>{cwd}</p>{task.status}{dialog}{notice && <p role="status" className="git-muted">{notice}</p>}
    <section className="panel-section"><button className="git-tree-entry" disabled={task.busy} onClick={() => { setParent(""); setSelected(""); setFile(undefined); }}>Workspace root</button>{tree("")}{dirs[""]?.entries.length === 0 && <p className="panel-empty">This folder is empty.</p>}</section>
    <details className="panel-section"><summary>Manage files</summary><p className="git-muted">Create in: {parent || "Workspace root"}</p><label className="git-label">Name<input className="panel-input" value={name} onChange={(e) => setName(e.target.value)} /></label><div className="panel-row">{(["file", "directory"] as const).map((kind) => <button className="panel-btn" key={kind} disabled={task.busy || !name.trim() || /[\\/]/.test(name) || name === "." || name === ".."} onClick={() => mutate(() => driver.createFileEntry({ cwd, parentPath: parent, name: name.trim(), kind }))}>New {kind === "directory" ? "folder" : "file"}</button>)}</div>{selected && <><p className="git-path">Selected: {selected}</p><div className="panel-row"><button className="panel-btn" disabled={task.busy || !name.trim() || /[\\/]/.test(name) || name === "." || name === ".." || text !== original && !!file} onClick={() => mutate(async () => { const r = checked(await driver.renameFileEntry({ cwd, path: selected, name: name.trim() })); setFile(undefined); setSelected(""); setDirs({}); setExpanded(new Set([""])); setParent(""); await loadDir(""); return r; }, `Rename ${selected} to ${name.trim()}?`)}>Rename…</button><button className="panel-btn" disabled={task.busy} onClick={() => mutate(() => driver.duplicateFileEntry({ cwd, path: selected }))}>Duplicate</button><button className="panel-btn danger" disabled={task.busy} onClick={() => mutate(async () => { const r = checked(await driver.deleteFileEntry({ cwd, path: selected })); setFile(undefined); setSelected(""); setDirs({}); setExpanded(new Set([""])); setParent(""); await loadDir(""); return r; }, `Permanently delete ${selected} from ${cwd}, including any contents? This cannot be undone. Unsaved drafts will not restore the original file.`)}>Delete…</button></div></>}</details>
    {file && <section className="panel-section"><h3 className="git-path">{selected}</h3>{file.kind === "text" ? <><label className="git-label">File contents{text !== original && " · Unsaved"}<textarea className="files-editor" spellCheck={false} disabled={task.busy} value={text} onChange={(e) => changeText(e.target.value)} /></label><div className="panel-row"><button className="panel-btn primary" disabled={task.busy || text === original} onClick={() => void task.run(async () => {
      if (!await confirm(`Overwrite ${selected} in ${cwd} with your edited contents? If the file changed externally, saving will be blocked.`)) return;
      const result = await driver.writeFile({ cwd, path: selected, content: text, expectedModifiedAt: file.modifiedAt, expectedRevision: file.revision });
      if (result.status === "conflict") throw new Error("This file changed on disk. Your draft is kept. Copy it, then reload the disk version before merging and saving.");
      if (result.status === "error") throw new Error(result.error);
      setOriginal(text); setFile({ ...file, modifiedAt: result.modifiedAt, revision: result.revision });
      try { localStorage.removeItem(draftKey(selected)); } catch { /* Saved on the daemon. */ }
      setNotice("Saved."); await refresh();
    })}>Save changes…</button><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => {
      if (text !== original && !await confirm(`Discard your unsaved draft for ${selected} and reload the disk version?`)) return;
      const next = await driver.readFile(cwd, selected, undefined, 1024 * 1024);
      const content = fileText(next);
      try { localStorage.removeItem(draftKey(selected)); } catch { /* Continue with the fetched version. */ }
      setFile(next); setText(content); setOriginal(content); setNotice("");
    })}>Reload disk…</button></div></> : <p className="panel-empty">{file.mime} · {file.size.toLocaleString()} bytes. Binary preview is not available.</p>}</section>}
    <section className="panel-section"><h3>Attach to document</h3><label className="git-label">Choose attachment<input type="file" disabled={task.busy} onChange={(e) => { const upload = e.target.files?.[0]; e.target.value = ""; if (upload) void task.run(async () => { const result = checked(await driver.uploadFile({ fileName: upload.name, mimeType: upload.type || "application/octet-stream", bytes: await upload.arrayBuffer(), modifiedAt: new Date(upload.lastModified).toISOString() })); if (!result.file) throw new Error("Upload returned no file. Please retry."); setUploaded(result.file); }); }} /></label>{uploaded && <><p className="git-muted">Ready: {uploaded.fileName}</p><label className="git-label">Message<input className="panel-input" value={attachmentText} onChange={(e) => setAttachmentText(e.target.value)} /></label><button className="panel-btn primary" disabled={task.busy} onClick={() => void task.run(async () => { if (!await confirm(`Send ${uploaded.fileName} to this document's agent? This starts an agent turn.`)) return; await driver.sendMessage(agentId, attachmentText.trim() || `Attached: ${uploaded.fileName}`, { attachments: [uploaded] }); setUploaded(undefined); setAttachmentText(""); setNotice("Attachment sent to agent."); })}>Send attachment…</button></>}</section>
  </div>;
}
