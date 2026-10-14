import { useEffect, useState } from "react";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { driver, useAgent } from "../state/paseo";
import type { PanelProps } from "./RightPanel";
import { checked, PanelEmpty, usePanelConfirm, usePanelTask } from "./GitUI";

type Status = Awaited<ReturnType<typeof driver.getCheckoutStatus>>;
type Commit = Awaited<ReturnType<typeof driver.listCheckoutCommits>>["commits"][number];
type Stash = Awaited<ReturnType<typeof driver.stashList>>["entries"][number];

export function GitDiff({ file }: { file: ParsedDiffFile }) {
  return <div className="git-diff">{file.status && file.status !== "ok" ? <p className="git-muted">{file.status === "binary" ? "Binary file — preview unavailable" : "Diff too large to preview"}</p> : file.hunks.map((hunk, i) => <pre key={i}><span className="git-hunk">@@ −{hunk.oldStart} +{hunk.newStart} @@</span>{hunk.lines.map((line, j) => <span key={j} className={`git-line git-${line.type}`}>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}{line.content}</span>)}</pre>)}</div>;
}

export function ChangesPanel({ agentId }: PanelProps) {
  const agent = useAgent(agentId);
  return agent?.cwd ? <Changes key={agent.cwd} cwd={agent.cwd} /> : <PanelEmpty title="Changes" />;
}

function Changes({ cwd }: { cwd: string }) {
  const task = usePanelTask();
  const { confirm, dialog } = usePanelConfirm();
  const [status, setStatus] = useState<Status>();
  const [files, setFiles] = useState<ParsedDiffFile[]>([]);
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [commits, setCommits] = useState<Commit[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [history, setHistory] = useState<ParsedDiffFile | null>(null);
  const [pr, setPr] = useState<Awaited<ReturnType<typeof driver.checkoutPrStatus>>>();
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = async () => { setStatus(checked(await driver.getCheckoutStatus(cwd))); };
  useEffect(() => { void task.run(refresh); }, [cwd]);
  useEffect(() => {
    let active = true;
    let sub: ReturnType<typeof driver.observeCheckoutDiff> | undefined;
    const fail = (e: unknown) => { if (active) task.fail(e, async () => { await refresh(); setRevision((v) => v + 1); }); };
    try {
      sub = driver.observeCheckoutDiff(cwd, { mode: "uncommitted" });
      const apply = (payload: Omit<Awaited<NonNullable<typeof sub>["ready"]>, "requestId">) => { if (!active) return; try { setFiles(checked(payload).files ?? []); } catch (e) { fail(e); } };
      sub.subscribe({ snapshot: apply, update: (event) => { if (event.type === "checkout_diff_update") { apply(event.payload); void refresh().catch(fail); } }, error: fail });
      void sub.ready.catch(fail);
    } catch (e) { fail(e); }
    return () => { active = false; void sub?.release().catch(() => {}); };
  }, [cwd, revision]);
  const action = (operation: () => Promise<unknown>, warning?: string) => void task.run(async () => {
    if (warning && !await confirm(warning)) return;
    checked(await operation());
    await refresh();
    setRevision((v) => v + 1);
  });
  return <div className="panel-body git-panel">
    <header className="panel-header"><h2>Changes</h2><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => { await refresh(); setRevision((v) => v + 1); })}>Refresh</button></header>
    <p className="git-path" title={cwd}>{cwd}</p>{task.status}{dialog}
    {status && !status.isGit ? <p className="panel-empty">This workspace is not a Git repository.</p> : <>
      <section className="panel-section"><h3>{status?.currentBranch ?? "Loading branch…"}</h3><p className="git-muted">{status?.aheadOfOrigin ?? "—"} ahead · {status?.behindOfOrigin ?? "—"} behind upstream</p>
        <div className="panel-row"><button className="panel-btn" disabled={task.busy || !status?.hasRemote} onClick={() => action(() => driver.checkoutPull(cwd), `Pull remote changes into ${status?.currentBranch} in ${cwd}. This may merge changes into your working tree.`)}>Pull</button><button className="panel-btn" disabled={task.busy || !status?.hasRemote} onClick={() => action(() => driver.checkoutPush(cwd), `Push commits on ${status?.currentBranch} from ${cwd} to its configured remote (${status?.remoteUrl ?? "remote"}). This publishes your commits.`)}>Push…</button></div>
      </section>
      <section className="panel-section"><h3>Suggested changes <span className="git-muted">({files.length})</span></h3>{!files.length && <p className="panel-empty">No uncommitted changes.</p>}{files.map((file) => <details key={file.path} className="git-file"><summary>{file.path}<span className="git-count">+{file.additions} −{file.deletions}</span></summary><GitDiff file={file} /><button className="panel-btn danger" disabled={task.busy} onClick={() => action(() => driver.checkoutDiscardChanges(cwd, { paths: [file.path] }), `Permanently discard all uncommitted changes to ${file.path} in ${cwd}? This cannot be undone.`)}>Discard file…</button></details>)}
        <label className="git-label">Commit message<textarea className="panel-input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Describe your changes" /></label><button className="panel-btn primary" disabled={task.busy || !message.trim() || !files.length} onClick={() => action(async () => { const r = checked(await driver.checkoutCommit(cwd, { message: message.trim(), addAll: true })); setMessage(""); return r; }, `Stage and commit ALL changed files in ${cwd} with message “${message.trim()}”?`)}>Commit all…</button>
      </section>
      <details className="panel-section"><summary>Branches</summary><label className="git-label">Branch name<input className="panel-input" value={branch} onChange={(e) => setBranch(e.target.value)} /></label><div className="panel-row"><button className="panel-btn" disabled={task.busy || !branch.trim()} onClick={() => action(() => driver.checkoutSwitchBranch(cwd, branch.trim()), `Switch ${cwd} to branch ${branch.trim()}? The working tree will change.`)}>Switch…</button><button className="panel-btn" disabled={task.busy || !branch.trim()} onClick={() => action(() => driver.renameBranch({ cwd, branch: branch.trim() }), `Rename current branch ${status?.currentBranch} to ${branch.trim()}?`)}>Rename…</button></div><label className="git-label">Merge from base<input className="panel-input" placeholder={status?.baseRef ?? "main"} value={base} onChange={(e) => setBase(e.target.value)} /></label><button className="panel-btn" disabled={task.busy || !(base.trim() || status?.baseRef)} onClick={() => action(() => driver.checkoutMergeFromBase(cwd, { baseRef: base.trim() || status?.baseRef || undefined, requireCleanTarget: true }), `Merge ${base.trim() || status?.baseRef} into current branch ${status?.currentBranch} in ${cwd}. This changes local files and may create a merge commit. Nothing will be pushed.`)}>Merge from base…</button></details>
      <details className="panel-section"><summary>Stashes</summary><div className="panel-row"><button className="panel-btn" disabled={task.busy} onClick={() => action(async () => { checked(await driver.stashSave(cwd)); setStashes(checked(await driver.stashList(cwd)).entries); }, `Save current changes to a stash in ${cwd}, then remove them from the working tree?`)}>Save stash…</button><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => setStashes(checked(await driver.stashList(cwd)).entries))}>List stashes</button></div>{stashes.map((stash) => <div className="panel-row" key={stash.index}><span>{stash.message}</span><button className="panel-btn" disabled={task.busy} onClick={() => action(async () => { checked(await driver.stashPop(cwd, stash.index)); setStashes(checked(await driver.stashList(cwd)).entries); }, `Apply stash ${stash.index} (${stash.message}) to ${cwd} and remove it from the stash list on success? Conflicts may require resolution.`)}>Pop…</button></div>)}</details>
      <details className="panel-section"><summary>Pull request</summary><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => setPr(checked(await driver.checkoutPrStatus(cwd))))}>Check status</button>{pr && <p className="git-muted">{pr.status ? `${pr.status.title} · ${pr.status.state}` : "No pull request for this branch."}</p>}<label className="git-label">Title<input className="panel-input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} /></label><label className="git-label">Description<textarea className="panel-input" value={prBody} onChange={(e) => setPrBody(e.target.value)} /></label><button className="panel-btn" disabled={task.busy || !prTitle.trim()} onClick={() => action(() => driver.checkoutPrCreate(cwd, { title: prTitle.trim(), body: prBody, baseRef: base.trim() || status?.baseRef || undefined }), `Create a remote pull request titled “${prTitle.trim()}” from ${status?.currentBranch} into ${base.trim() || status?.baseRef || "the default base branch"} on ${status?.remoteUrl ?? "the configured remote"}. The daemon may push this branch to publish the request.`)}>Create PR…</button></details>
      <details className="panel-section"><summary>Commit history</summary><button className="panel-btn" disabled={task.busy} onClick={() => void task.run(async () => setCommits((await driver.listCheckoutCommits(cwd)).commits))}>Load history</button>{commits.map((commit) => <details key={commit.sha} className="git-file"><summary>{commit.subject} <small>{commit.shortSha}</small></summary><p className="git-muted">{commit.authorName} · {commit.authorDate}</p>{commit.files.map((file) => <button className="git-tree-entry" key={file.path} disabled={task.busy} onClick={() => void task.run(async () => setHistory((await driver.getCommitFileDiff(cwd, commit.sha, file.path)).file))}>{file.path}</button>)}</details>)}{history && <><h3>{history.path}</h3><GitDiff file={history} /></>}</details>
    </>}
  </div>;
}
