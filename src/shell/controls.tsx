import { useEffect, useRef, useState, type ReactNode } from "react";
import { driver, refreshAgents, useAgent, useAgents } from "../state/paseo";
import { useLayout } from "../state/layout";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import "./shell.css";
import { scoped } from "../state/native";

let lastEditor: HTMLElement | null = null;
function rememberEditor() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea"))) lastEditor = active;
}
export function nativeEdit(command: string) {
  if (lastEditor?.isConnected) lastEditor.focus();
  if (!document.execCommand(command)) throw new Error("This editing command is unavailable here.");
}
export const Icon = ({ name }: { name: string }) => <span aria-hidden="true" className="material-symbols-outlined">{name}</span>;
export function useFocusedAgent() {
  const layout = useLayout();
  return useAgent(layout.panes[layout.focused]);
}
export function useAction() {
  const [failure, setFailure] = useState<{ label: string; retry: () => void }>();
  const [busy, setBusy] = useState(false);
  function run(label: string, action: () => unknown | Promise<unknown>) {
    setBusy(true); setFailure(undefined);
    // The daemon does not push every agent field change (e.g. model), so re-list after each action.
    Promise.resolve().then(action).then(() => refreshAgents().catch(() => {})).catch(() => setFailure({ label, retry: () => run(label, action) })).finally(() => setBusy(false));
  }
  return { run, busy, error: failure && <div className="chrome-error" role="alert">Could not {failure.label}. The action may be unavailable or Paseo disconnected. <button onClick={failure.retry}>Retry</button><button aria-label="Dismiss error" onClick={() => setFailure(undefined)}>×</button></div> };
}
export function useModelOptions(agent: ReturnType<typeof useFocusedAgent>) {
  const [models, setModels] = useState<AgentModelDefinition[]>([]);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setModels([]); setError(false);
    if (agent) driver.listProviderModels(agent.provider, { cwd: agent.cwd }).then(r => scoped(agent.provider, r.models ?? [])).then(m => { if (active) setModels(m); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [agent?.id, agent?.provider, agent?.cwd, attempt]);
  return { models, error, retry: () => setAttempt(n => n + 1) };
}
// Mode / model / thinking menu items for the focused agent, shared by the menu bar and toolbar.
export function useAgentMenus(agent: ReturnType<typeof useFocusedAgent>, run: (what: string, fn: () => Promise<unknown>) => unknown) {
  const catalog = useModelOptions(agent);
  const modes = (agent?.availableModes ?? []).map(m => ({ label: m.label, checked: m.id === agent?.currentModeId, action: () => run("change mode", () => driver.setAgentMode(agent!.id, m.id)) }));
  const models = catalog.models.filter(m => m.isSelectable !== false).map(m => ({ label: m.label, checked: m.id === agent?.model, action: () => run("change model", () => driver.setAgentModel(agent!.id, m.id)) }));
  const thinking = catalog.models.find(m => m.id === agent?.model)?.thinkingOptions?.map(t => ({ label: t.label, checked: t.id === agent?.thinkingOptionId, action: () => run("change thinking", () => driver.setAgentThinkingOption(agent!.id, t.id)) })) ?? [];
  return { catalog, modes, models, thinking };
}
export function Tool({ icon, label, onClick, children, className = "" }: { icon?: string; label: string; onClick?: () => void; children?: ReactNode; className?: string }) {
  return <button className={`chrome-tool ${className}`} aria-label={label} data-tooltip={label} disabled={!onClick} onPointerDown={e => { rememberEditor(); e.preventDefault(); }} onClick={onClick}>{icon && <Icon name={icon} />}{children}</button>;
}
export type MenuItem = { label: string; icon?: string; shortcut?: string; action?: () => void; children?: MenuItem[]; separator?: boolean; checked?: boolean };
export function Dropdown({ label, children, items, className = "" }: { label: string; children?: ReactNode; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    root.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div ref={root} className={`chrome-dropdown ${className}`} onPointerDown={rememberEditor} onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (e.key === "Tab") setOpen(false);
    if (!open && ["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); setOpen(true); }
  }}><button ref={trigger} className="chrome-menu-trigger" aria-label={label} aria-haspopup="menu" disabled={!items.length} aria-expanded={open} onClick={() => setOpen(!open)}>{children ?? label}</button>{open && <MenuList items={items} close={() => { setOpen(false); trigger.current?.focus(); }} />}</div>;
}
function MenuList({ items, close, back = close }: { items: MenuItem[]; close: () => void; back?: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus(); }, []);
  return <div className="chrome-menu" role="menu" ref={root} onKeyDown={e => {
    if ((e.target as HTMLElement).closest('[role="menu"]') !== root.current) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(':scope > .chrome-menu-row > button:not(:disabled)') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (i + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
    if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); const active = document.activeElement as HTMLButtonElement; if (active?.getAttribute("aria-haspopup") === "menu") active.click(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); const parent = root.current?.parentElement?.querySelector<HTMLButtonElement>(":scope > button"); parent?.focus(); back(); }
  }}>{items.map((item, i) => <div className="chrome-menu-row" key={`${item.label}-${i}`}>
    {item.separator && <div className="chrome-menu-separator" role="separator" />}
    <button role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={item.checked} disabled={!item.action && !item.children} aria-haspopup={item.children ? "menu" : undefined} aria-expanded={item.children ? sub === i : undefined} onClick={() => {
      if (item.children) { setSub(sub === i ? null : i); }
      else { close(); item.action?.(); }
    }}><span className="chrome-menu-glyph">{(item.checked || item.icon) && <Icon name={item.checked ? "check" : item.icon!} />}</span><span>{item.label}</span><span className="chrome-shortcut">{item.shortcut}</span>{item.children && <Icon name="chevron_right" />}</button>
    {sub === i && item.children && <MenuList items={item.children} close={close} back={() => setSub(null)} />}
  </div>)}</div>;
}
export function ShellDialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="chrome-dialog" onCancel={close}><h2>{title}</h2>{children}<div className="chrome-dialog-actions"><button autoFocus onClick={close}>Close</button></div></dialog>;
}
