import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { Streamdown } from "streamdown";
import type { PaseoAgentPermissionResponse, PaseoProviderSnapshotResult } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { api, driver, connStore, useStore, useAgents, useTimeline, loadEarlier, retryTimeline, type Block, useAgent, refreshAgents } from "../state/paseo";
import { native, scoped } from "../state/native";
import { setPaneAgent } from "../state/layout";
import { Ruler } from "../shell/Ruler";
import { FolderPicker } from "./FolderPicker";
import "./doc.css";

type Image = { data: string; mimeType: string };
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please retry.";
const pretty = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
function Banner({ text, retry }: { text: string; retry: () => void }) {
  return <div className="doc-banner" role="alert"><span>{text}</span><button onClick={retry}>Retry</button></div>;
}

export function DocPage({ agentId, pane }: { agentId: string | null; pane: number }) {
  return agentId ? <AgentDoc key={agentId} agentId={agentId} /> : <BlankDoc pane={pane} />;
}

const BlockView = memo(function BlockView({ block, retry }: { block: Block; retry: () => void }) {
  // Expansion belongs to the mounted block, not the immutable streaming snapshot.
  const [open, setOpen] = useState(false);
  switch (block.kind) {
    case "user": {
      // Forks open with the source chat as a tagged summary; show it folded, like Docs' "version history" note.
      const fork = /^<chat-history-summary>([\s\S]*?)<\/chat-history-summary>\s*/.exec(block.text);
      if (!fork) return <p className="doc-user">{block.text}</p>;
      const source = /Source agent: (.*)/.exec(fork[1])?.[1] ?? "another document";
      return <><details className="doc-reasoning"><summary>Forked from {source}</summary><div style={{ whiteSpace: "pre-wrap" }}>{fork[1].trim()}</div></details>{block.text.slice(fork[0].length) && <p className="doc-user">{block.text.slice(fork[0].length)}</p>}</>;
    }
    case "assistant": {
      // Paseo echoes pasted images as file:// markdown, which the markdown sanitizer always blocks; render them directly.
      const local = /!\[[^\]]*\]\((file:\/\/[^)\s]+)\)/g;
      const images = [...block.text.matchAll(local)].map(m => m[1]);
      return <>{images.map(src => <img key={src} className="doc-image" src={src} alt="Attached image" />)}<Streamdown controls={false}>{block.text.replace(local, "")}</Streamdown></>;
    }
    case "reasoning": return <details className="doc-reasoning" open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>Thinking…</summary>{open && <Streamdown controls={false}>{block.text}</Streamdown>}</details>;
    case "tool": return <details className="doc-tool" open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary><span className="material-symbols-outlined">{block.status === "completed" ? "check_circle" : block.status === "failed" ? "error" : "pending"}</span><strong>{block.name}</strong><span>{String(block.item.detail?.description ?? block.item.detail?.command ?? block.status)}</span></summary>{open && <><pre>{pretty(block.item.detail ?? block.item.input ?? block.item)}</pre>{block.item.output != null && <pre>{pretty(block.item.output)}</pre>}</>}</details>;
    case "todo": return <ul className="doc-checklist">{block.items.map((item, i) => <li key={i}><input type="checkbox" checked={item.completed} readOnly aria-label={item.text} /><span>{item.text}</span></li>)}</ul>;
    case "notice": return <Banner text={block.text || "The agent reported a problem."} retry={retry} />;
  }
});

function Sheets({ blocks, children, header, retry, agentId }: { blocks: Block[]; children: ReactNode; header?: ReactNode; retry: () => void; agentId?: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const atBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const follow = () => {
    const el = scroll.current, caret = el?.querySelector(".doc-composer");
    // Keep the writing line visible, not the blank paper underneath a short document.
    if (atBottom.current && el && caret) {
      el.scrollTop = Math.max(0, caret.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + 48 - el.clientHeight);
      lastScrollTop.current = el.scrollTop;
    }
  };
  useLayoutEffect(() => {
    const root = scroll.current!;
    const resize = () => { const zoom = Number(getComputedStyle(root).getPropertyValue("--doc-zoom")) || 1; setScale(Math.min(zoom, Math.max(.15, (root.clientWidth - 32) / 816))); };
    const observer = new ResizeObserver(resize);
    const changes = new MutationObserver(resize);
    observer.observe(root);
    changes.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => { observer.disconnect(); changes.disconnect(); };
  }, []);
  useLayoutEffect(follow, [blocks, children]);
  useEffect(() => {
    const paper = scroll.current?.querySelector(".doc-sheet");
    if (!paper) return;
    const observer = new ResizeObserver(follow);
    observer.observe(paper);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const jump = (event: Event) => {
      const detail = (event as CustomEvent<{ agentId: string; index: number }>).detail;
      if (detail?.agentId !== agentId) return;
      scroll.current?.querySelector(`[data-prompt="${Number(detail.index)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener("docai:scroll-to-prompt", jump);
    return () => window.removeEventListener("docai:scroll-to-prompt", jump);
  }, [agentId]);
  let promptIndex = 0;
  return <div className="doc-frame">
    <div className="doc-ruler" style={{ "--doc-ruler-scale": scale } as CSSProperties}><Ruler /></div>
    <div className="doc-scroll" ref={scroll} onWheel={event => { if (event.deltaY < 0) atBottom.current = false; }} onScroll={() => {
      const el = scroll.current!, caret = el.querySelector(".doc-composer");
      if (el.scrollTop < lastScrollTop.current - 1) atBottom.current = false;
      else if (el.scrollTop > lastScrollTop.current + 1) atBottom.current = caret ? caret.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom < 100 : el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      lastScrollTop.current = el.scrollTop;
    }}>
      <article aria-label="Document" className="doc-sheet doc-text" style={{ zoom: scale } as CSSProperties}>
        {header}
        {blocks.map((block, index) => {
          const prompt = block.kind === "user" ? promptIndex++ : undefined;
          return <div key={index} className="doc-block" data-prompt={prompt}>
            <BlockView block={block} retry={retry} />
          </div>;
        })}
        {children}
      </article>
    </div>
  </div>;
}

function Composer({ running = false, lastPrompt = "", storageKey, onSend, onStop, commands }: { running?: boolean; lastPrompt?: string; storageKey: string; onSend: (text: string, images: Image[]) => Promise<void>; onStop?: () => Promise<void>; commands?: () => Promise<{ name: string; description: string }[]> }) {
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; } });
  const [images, setImages] = useState<Image[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}.images`) ?? "[]");
      return Array.isArray(saved) ? saved.filter(i => typeof i?.mimeType === "string" && i.mimeType.startsWith("image/") && typeof i.data === "string" && i.data.length <= 28 * 1024 * 1024) : [];
    } catch { return []; }
  });
  const [imageSaveError, setImageSaveError] = useState("");
  const saveImages = () => {
    try { localStorage.setItem(`${storageKey}.images`, JSON.stringify(images)); setImageSaveError(""); }
    catch { setImageSaveError("Images could not be saved locally. Keep this document open until you send or remove them."); }
  };
  useEffect(saveImages, [images, storageKey]);
  useEffect(() => {
    if (!imageSaveError || !images.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [imageSaveError, images.length]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [pasting, setPasting] = useState(0);
  const pendingPastes = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const retryAction = useRef<() => void>(() => {});
  const [commandList, setCommandList] = useState<{ name: string; description: string }[]>();
  const slash = /^\/(\S*)$/.exec(draft)?.[1];
  useEffect(() => { if (slash != null && !commandList && commands) commands().then(setCommandList, () => setCommandList([])); }, [slash, commandList, commands]);
  const matches = slash == null ? [] : (commandList ?? []).filter(c => c.name.toLowerCase().startsWith(slash.toLowerCase())).slice(0, 8);
  useEffect(() => {
    const save = () => { try { localStorage.setItem(storageKey, draft); } catch { retryAction.current = save; setError("Draft could not be saved locally. Keep this document open."); } };
    save();
  }, [draft, storageKey]);
  const send = async () => {
    if ((!draft.trim() && !images.length) || sending || pendingPastes.current) return;
    setSending(true); setError("");
    // Clear storage directly too: a blank doc unmounts when its new doc opens, before state updates land.
    try { await onSend(draft, images); try { localStorage.removeItem(storageKey); localStorage.removeItem(`${storageKey}.images`); } catch {} setDraft(""); setImages([]); }
    catch (e) { retryAction.current = () => void send(); setError(message(e)); }
    finally { setSending(false); }
  };
  const stop = async () => { try { await onStop?.(); } catch (e) { retryAction.current = () => void stop(); setError(message(e)); } };
  useLayoutEffect(() => { if (input.current) { input.current.style.height = "0px"; input.current.style.height = `${Math.max(24, input.current.scrollHeight)}px`; } }, [draft]);
  return <div className={`doc-composer ${running ? "is-running" : ""}`}>
    {error && <Banner text={error} retry={() => retryAction.current()} />}
    {imageSaveError && <Banner text={imageSaveError} retry={saveImages} />}
    {images.length > 0 && <div className="doc-attachments">{images.map((image, i) => <button key={i} title="Remove image" disabled={sending} onClick={() => setImages(images.filter((_, j) => i !== j))}><img src={`data:${image.mimeType};base64,${image.data}`} alt={`Attachment ${i + 1}`} />×</button>)}</div>}
    <textarea ref={input} aria-label="Write in document" rows={1} value={draft} readOnly={sending} placeholder={running ? "Write a follow-up…" : "Write a message…"} onChange={e => setDraft(e.target.value)} onKeyDown={e => {
      if ((e.key === "Escape" || (e.metaKey && e.key === ".")) && onStop) { e.preventDefault(); void stop(); }
      if (e.key === "ArrowUp" && !draft) { e.preventDefault(); setDraft(lastPrompt); }
      if (e.key === "Tab" && matches.length) { e.preventDefault(); setDraft(`/${matches[0].name} `); return; }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
    }} onPaste={async e => {
      if (sending) { e.preventDefault(); return; }
      const clipboard = e.clipboardData;
      const imageItems = [...clipboard.items].filter(item => item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => !!file);
      const files = (imageItems.length ? imageItems : [...clipboard.files]).filter(file => file.type.startsWith("image/"));
      const text = clipboard.getData("text/plain");
      const insertText = () => {
        if (!text) return;
        const start = input.current?.selectionStart ?? draft.length, end = input.current?.selectionEnd ?? start;
        const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
        setDraft(next);
        requestAnimationFrame(() => input.current?.setSelectionRange(start + text.length, start + text.length));
      };
      const readFile = (file: File) => new Promise<Image>((resolve, reject) => {
        if (file.size > 20 * 1024 * 1024) return reject(new Error("Images must be smaller than 20 MB."));
        const reader = new FileReader(); reader.onerror = () => reject(new Error("Could not read image."));
        reader.onload = () => { const data = String(reader.result).split(",")[1]; data ? resolve({ mimeType: file.type, data }) : reject(new Error("Could not read image.")); }; reader.readAsDataURL(file);
      });
      const attach = async (read: () => Promise<Image[]>) => {
        ++pendingPastes.current; setPasting(pendingPastes.current);
        try { const pasted = await read(); if (pasted.length) { setImages(current => [...current, ...pasted]); setError(""); } }
        catch (err) { retryAction.current = () => void attach(read); setError(message(err)); }
        finally { --pendingPastes.current; setPasting(pendingPastes.current); }
      };
      if (files.length) {
        e.preventDefault();
        insertText();
        void attach(() => Promise.all(files.map(readFile)));
      } else if (!text && e.nativeEvent.isTrusted) {
        // Native-only images consume the one-shot snapshot from this physical paste shortcut.
        const readClipboardImage = (native as (typeof native & { readClipboardImage?: () => Promise<Image | null> }) | undefined)?.readClipboardImage;
        if (readClipboardImage) void attach(async () => {
          const image = await readClipboardImage.call(native);
          if (!image) return [];
          if (!image.mimeType.startsWith("image/") || !image.data) throw new Error("Could not read image.");
          const bytes = Math.max(0, image.data.length * 3 / 4 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0));
          if (bytes > 20 * 1024 * 1024) throw new Error("Images must be smaller than 20 MB.");
          return [image];
        });
      }
    }} />
    {matches.length > 0 && <ul className="doc-commands" role="listbox" aria-label="Commands">{matches.map(c => <li key={c.name} role="option" aria-selected={false} onMouseDown={e => { e.preventDefault(); setDraft(`/${c.name} `); }}><strong>/{c.name}</strong> <span>{c.description}</span></li>)}</ul>}
    <div className="doc-composer-hint"><span className="doc-compose-status" role="status">{pasting ? "Attaching image…" : running ? "Working" : sending ? "Sending…" : "Ready"}</span><span>{running ? "Enter queues your next paragraph" : "Enter to send · Shift + Enter for a new line"}</span>{running && <button onClick={() => void stop()}>Stop</button>}</div>
  </div>;
}

function Permission({ request, agentId }: { request: AgentPermissionRequest; agentId: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const last = useRef<PaseoAgentPermissionResponse>({ behavior: "deny" });
  const respond = async (response: PaseoAgentPermissionResponse) => {
    last.current = response; setBusy(true); setError("");
    try { await api.agents.ref(agentId).respondToPermission({ requestId: request.id, response }); }
    catch (e) { setError(message(e)); setBusy(false); }
  };
  const questions = Array.isArray(request.input?.questions) ? request.input.questions as { question: string; options?: { label: string; description?: string }[] }[] : [];
  const actions = request.actions?.length ? request.actions : [{ id: "allow", label: questions.length ? "Submit" : "Allow", behavior: "allow" as const }, { id: "deny", label: questions.length ? "Skip" : "Deny", behavior: "deny" as const }];
  return <section className="doc-permission"><div className="doc-permission-heading"><span className="material-symbols-outlined">rate_review</span><strong>{request.title ?? request.name ?? "Permission requested"}</strong></div><p>{request.description}</p>
    {typeof request.input?.plan === "string" && <Streamdown controls={false}>{request.input.plan}</Streamdown>}
    {questions.map((question, i) => <fieldset key={i}><legend>{question.question}</legend>{question.options?.map(option => <label key={option.label}><input type="radio" name={`${request.id}-${i}`} checked={answers[question.question] === option.label} onChange={() => setAnswers({ ...answers, [question.question]: option.label })} />{option.label}{option.description && <small>{option.description}</small>}</label>)}<input aria-label="Other answer" placeholder="Other…" value={answers[question.question] ?? ""} onChange={e => setAnswers({ ...answers, [question.question]: e.target.value })} /></fieldset>)}
    {(request.detail || request.input) && <details><summary>Details</summary><pre>{pretty(request.detail ?? request.input)}</pre></details>}
    {error && <Banner text={error} retry={() => void respond(last.current)} />}
    <div className="doc-permission-actions">{actions.map(action => <button key={action.id} disabled={busy} onClick={() => void respond(action.behavior === "allow" ? { behavior: "allow", selectedActionId: action.id, ...(questions.length ? { updatedInput: { ...request.input, answers } } : {}) } : { behavior: "deny", selectedActionId: action.id })}>{action.label}</button>)}</div>
  </section>;
}

function AgentDoc({ agentId }: { agentId: string }) {
  const timeline = useTimeline(agentId);
  const attention = useAgent(agentId)?.requiresAttention;
  // An open doc has been seen: clear Paseo's unread flag once its turn ends, like Paseo's own app does.
  useEffect(() => { if (attention && !timeline.running) driver.clearAgentAttention(agentId).then(() => refreshAgents()).catch(() => {}); }, [attention, timeline.running, agentId]);
  const [queue, setQueue] = useState<{ text: string; images: Image[] }[]>(() => {
    try { const stored = JSON.parse(localStorage.getItem(`docai.queue.${agentId}`) ?? "[]"); return Array.isArray(stored) ? stored.filter(item => typeof item.text === "string" && Array.isArray(item.images)) : []; } catch { return []; }
  });
  const [queueError, setQueueError] = useState("");
  const [resendError, setResendError] = useState("");
  const draining = useRef(false);
  useEffect(() => { try { localStorage.setItem(`docai.queue.${agentId}`, JSON.stringify(queue)); } catch { setQueueError("Queued paragraphs could not be saved locally. Keep this document open and retry."); } }, [queue, agentId]);
  const lastPrompt = [...timeline.blocks].reverse().find(b => b.kind === "user")?.text ?? "";
  const retry = useCallback(() => { setResendError(""); if (lastPrompt) api.agents.ref(agentId).send(lastPrompt).catch(e => setResendError(message(e))); else retryTimeline(agentId); }, [agentId, lastPrompt]);
  const commands = useCallback(async () => (await api.agents.ref(agentId).commands()).commands ?? [], [agentId]);
  const drain = useCallback(async () => {
    if (draining.current || !queue.length || timeline.running || timeline.loading) return;
    draining.current = true;
    try { await api.agents.ref(agentId).send(queue[0].text, { images: queue[0].images }); setQueue(q => q.slice(1)); setQueueError(""); }
    catch (e) { setQueueError(message(e)); }
    finally { draining.current = false; }
  }, [queue, timeline.running, timeline.loading, agentId]);
  useEffect(() => { if (!queueError) void drain(); }, [drain, queueError]);
  return <Sheets blocks={timeline.blocks} retry={retry} agentId={agentId} header={timeline.hasEarlier && <button className="doc-earlier" disabled={timeline.loadingEarlier} onClick={() => void loadEarlier(agentId)}>{timeline.loadingEarlier ? "Loading…" : "Load earlier paragraphs"}</button>}>
    {timeline.loading && <p className="doc-muted">Loading document…</p>}
    {timeline.error && <Banner text={timeline.error} retry={() => retryTimeline(agentId)} />}
    {(timeline.permissions ?? []).map(request => <Permission key={request.id} request={request} agentId={agentId} />)}
    {queue.length > 0 && <p className="doc-muted">{queue.length} paragraph{queue.length === 1 ? "" : "s"} queued</p>}
    {resendError && <Banner text={resendError} retry={retry} />}
    {queueError && <Banner text={queueError} retry={() => { setQueueError(""); void drain(); }} />}
    <Composer key="composer" commands={commands} storageKey={`docai.draft.${agentId}`} running={timeline.running} lastPrompt={lastPrompt} onStop={() => driver.cancelAgent(agentId)} onSend={async (text, images) => {
      if (timeline.running || queue.length) { setQueue(q => [...q, { text, images }]); return; }
      await api.agents.ref(agentId).send(text, { images });
    }} />
  </Sheets>;
}

const defaults = () => { try { return JSON.parse(localStorage.getItem("docai.new-document") ?? "{}"); } catch { return {}; } };
function BlankDoc({ pane }: { pane: number }) {
  const [settings, setSettings] = useState(() => ({ provider: "claude", model: "", mode: "", thinking: "", cwd: "~", worktree: false, ...defaults() }));
  const [providers, setProviders] = useState<PaseoProviderSnapshotResult["entries"]>([]);
  const agents = useAgents();
  const [error, setError] = useState("");
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    api.providers.snapshot().then(snapshot => Promise.all(snapshot.entries.filter(p => p.enabled).map(async p => ({ ...p, models: p.models && await scoped(p.provider, p.models) })))).then(
      providers => { if (seq === loadSeq.current) { setProviders(providers); setError(""); } },
      e => { if (seq === loadSeq.current) setError(message(e)); },
    );
  }, []);
  useEffect(() => () => { ++loadSeq.current; }, []);
  const online = useStore(connStore).status === "connected";
  useEffect(() => { if (online) { setError(""); load(); } }, [online, load]);
  useEffect(() => api.providers.subscribe(load), [load]);
  // "New doc here" in the workspace panel hands over its folder via localStorage + a docai-newdoc event.
  useEffect(() => {
    const take = () => { const cwd = localStorage.getItem("docai.newdoc.cwd"); if (cwd) { localStorage.removeItem("docai.newdoc.cwd"); setSettings((s: typeof settings) => ({ ...s, cwd })); } };
    take();
    window.addEventListener("docai-newdoc", take);
    return () => window.removeEventListener("docai-newdoc", take);
  }, []);
  // Every folder any doc has worked in, most recent first.
  const folders = [...new Set([settings.cwd, ...agents.map(a => a.cwd).filter(Boolean)])];
  const browse = async () => {
    try { const dir = await native?.pickFolder(settings.cwd === "~" ? undefined : settings.cwd); if (dir) { setSettings((s: typeof settings) => ({ ...s, cwd: dir })); setError(""); } }
    catch (e) { setError(message(e)); }
  };
  const provider = providers.find(p => p.provider === settings.provider);
  const models = provider?.models?.filter(m => m.isSelectable !== false) ?? [];
  const model = models.some(m => m.id === settings.model) ? settings.model : models.find(m => m.isDefault)?.id ?? models[0]?.id ?? "";
  const modes = provider?.modes ?? [];
  const mode = modes.some(m => m.id === settings.mode) ? settings.mode : modes.some(m => m.id === "default") ? "default" : provider?.defaultModeId ?? modes[0]?.id ?? "";
  const thinking = models.find(m => m.id === model)?.thinkingOptions ?? [];
  return <Sheets blocks={[]} retry={load}>
    <div className="doc-setup"><select aria-label="Provider" value={settings.provider} onChange={e => setSettings({ ...settings, provider: e.target.value, model: "" })}>{providers.map(p => <option key={p.provider} value={p.provider}>{p.label ?? p.provider}</option>)}</select><select aria-label="Model" value={model} onChange={e => setSettings({ ...settings, model: e.target.value })}>{models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>{modes.length > 1 && <select aria-label="Mode" value={mode} onChange={e => setSettings({ ...settings, mode: e.target.value })}>{modes.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>}{thinking.length > 0 && <select aria-label="Thinking" value={settings.thinking} onChange={e => setSettings({ ...settings, thinking: e.target.value })}><option value="">Default thinking</option>{thinking.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>}<FolderPicker folders={folders} value={settings.cwd} onChange={cwd => setSettings((s: typeof settings) => ({ ...s, cwd }))} onBrowse={native ? () => void browse() : undefined} /><label><input type="checkbox" checked={settings.worktree} onChange={e => setSettings({ ...settings, worktree: e.target.checked })} />Worktree</label></div>
    <h1 className="doc-title">Untitled document</h1>
    {error && <Banner text={error} retry={() => { setError(""); load(); }} />}
    <Composer key="composer" storageKey={`docai.draft.blank.${pane}`} onSend={async (text, images) => {
      if (!model || !settings.cwd.trim()) throw new Error("Choose a model and working folder first.");
      const create = () => api.agents.create({ config: { provider: `${settings.provider}/${model}`, modeId: mode || undefined, thinkingOptionId: thinking.some(t => t.id === settings.thinking) ? settings.thinking : undefined }, cwd: settings.cwd, prompt: text, images, title: text.trim().slice(0, 80) || "Untitled document", ...(settings.worktree ? { worktree: { mode: "branch-off" as const, newBranch: `docai/${crypto.randomUUID().slice(0, 8)}` } } : {}) });
      // A provider wedged by an earlier timeout recovers after a discovery refresh; retry once.
      const agent = await create().catch(async e => { if (!/refresh/i.test(message(e))) throw e; await driver.refreshProvidersSnapshot(); return create(); });
      try { localStorage.setItem("docai.new-document", JSON.stringify({ ...settings, model })); } catch {}
      setPaneAgent(pane, agent.id);
    }} />
  </Sheets>;
}
