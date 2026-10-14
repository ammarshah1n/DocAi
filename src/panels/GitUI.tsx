import { useEffect, useRef, useState } from "react";
import "./git.css";

export function checked<T>(result: T): T {
  if (result && typeof result === "object" && "error" in result && result.error) {
    const error = result.error;
    throw new Error(typeof error === "string" ? error : typeof error === "object" && "message" in error ? String(error.message) : "The operation failed.");
  }
  if (result && typeof result === "object" && "success" in result && result.success === false) throw new Error("The operation did not complete.");
  return result;
}

export function usePanelTask() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const last = useRef<(() => Promise<void>) | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const showError = (e: unknown) => { if (mounted.current) setError(e instanceof Error ? e.message : "Unable to complete this action. Please try again."); };
  const fail = (e: unknown, retry?: () => Promise<void>) => { last.current = retry ?? null; showError(e); };
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    last.current = action;
    running.current = true;
    setBusy(true); setError("");
    try { await action(); } catch (e) { showError(e); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return { busy, run, fail, error, status: <>{busy && <p className="git-muted" role="status">Working…</p>}{error && <div className="panel-error" role="alert">{error}<button className="panel-btn" disabled={busy || !last.current} onClick={() => last.current && void run(last.current)}>Retry</button></div>}</> };
}

export function usePanelConfirm() {
  const [request, setRequest] = useState<{ text: string; resolve: (yes: boolean) => void } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<((yes: boolean) => void) | null>(null);
  useEffect(() => { if (request) dialog.current?.showModal(); }, [request]);
  useEffect(() => () => { pending.current?.(false); }, []);
  const finish = (yes: boolean) => { pending.current?.(yes); pending.current = null; setRequest(null); };
  return {
    confirm: (text: string) => new Promise<boolean>((resolve) => { pending.current = resolve; setRequest({ text, resolve }); }),
    dialog: request && <dialog className="git-confirm" ref={dialog} onCancel={(e) => { e.preventDefault(); finish(false); }}><h3>Confirm action</h3><p>{request.text}</p><div className="panel-row"><button className="panel-btn" autoFocus onClick={() => finish(false)}>Cancel</button><button className="panel-btn primary" onClick={() => finish(true)}>Confirm</button></div></dialog>,
  };
}

export function PanelEmpty({ title }: { title: string }) {
  return <div className="panel-body git-panel"><h2 className="panel-header">{title}</h2><p className="panel-empty">Open a document to view its workspace.</p></div>;
}
