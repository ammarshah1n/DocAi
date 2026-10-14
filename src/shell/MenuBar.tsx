import { useState } from "react";
import { closePane, layoutStore, openDoc, setPaneArrangement, setRightPanel, splitPane, toggleMenus, toggleSidebar, useLayout } from "../state/layout";
import { driver, refreshAgents } from "../state/paseo";
import { PANELS } from "../panels/RightPanel";
import { Dropdown, ShellDialog, nativeEdit, useAction, useFocusedAgent, useAgentMenus, type MenuItem } from "./controls";

export function MenuBar() {
  const agent = useFocusedAgent();
  const layout = useLayout();
  const { run, error } = useAction();
  const [dialog, setDialog] = useState<{ title: string; text: string }>();
  const native = (command: string) => () => run(`perform ${command}`, () => nativeEdit(command));
  const panel = (id: string) => () => setRightPanel(id);
  const { catalog, modes, models, thinking } = useAgentMenus(agent, run);
  const menus: Record<string, MenuItem[]> = {
    File: [
      { label: "New document", icon: "add", action: () => openDoc(null) },
      { label: "New from template" },
      { label: "Open", icon: "folder_open", action: () => { if (!layout.sidebarOpen) toggleSidebar(); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('aside input[type="search"], .sidebar input')?.focus()); } },
      { label: "Make a copy" },
      { label: "Rename", separator: true, action: agent ? () => document.querySelector<HTMLInputElement>("#docai-title")?.select() : undefined },
      { label: "Move", icon: "drive_file_move", action: panel("workspace") },
      { label: "Move to trash", icon: "delete", action: agent ? () => { if (window.confirm(`Archive “${agent.title ?? "Untitled document"}”? Its history will remain in Paseo.`)) run("archive this document", async () => { await driver.archiveAgent(agent.id); openDoc(null); await refreshAgents(); }); } : undefined },
      { label: "Version history", icon: "history", separator: true },
      { label: "Print", icon: "print", shortcut: "⌘P", action: () => window.print() },
    ],
    Edit: [
      ...["Undo", "Redo", "Cut", "Copy", "Paste", "Select all"].map((label, i) => ({ label, shortcut: ["⌘Z", "⌘⇧Z", "⌘X", "⌘C", "⌘V", "⌘A"][i], action: native(["undo", "redo", "cut", "copy", "paste", "selectAll"][i]), separator: i === 2 })),
      { label: "Find in document", separator: true },
    ],
    View: [
      { label: "Show tabs & outlines", checked: layout.sidebarOpen, action: toggleSidebar },
      { label: "Split view", children: [1, 2, 3, 4].map(n => ({ label: `${n} ${n === 1 ? "pane" : "panes"}`, checked: layout.panes.length === n, action: () => { while (layoutStore.get().panes.length < n) splitPane(); while (layoutStore.get().panes.length > n) closePane(layoutStore.get().panes.length - 1); } })) },
      { label: "Show menus", checked: !layout.menusHidden, action: toggleMenus },
      { label: "Pane layout", children: [
        { label: "Side by side", checked: layout.arrangement !== "grid", action: () => setPaneArrangement("columns") },
        { label: "2 × 2 grid", checked: layout.arrangement === "grid", action: () => setPaneArrangement("grid") },
      ] },
      { label: "Side panels", separator: true, children: PANELS.map(p => ({ label: p.label, icon: p.icon, checked: p.id === layout.rightPanel, action: panel(p.id) })) },
    ],
    Insert: [{ label: "Image / file attachment", icon: "image", action: panel("files") }, { label: "Mention project" }],
    Format: [
      { label: "Mode", children: modes.length ? modes : undefined },
      { label: "Model", children: catalog.error ? [{ label: "Could not load models · Retry", action: catalog.retry }] : models.length ? models : undefined },
      { label: "Thinking", children: thinking.length ? thinking : undefined },
    ],
    Tools: [
      { label: "Stop generating", icon: "stop", action: agent?.status === "running" ? () => run("stop generating", () => driver.cancelAgent(agent.id)) : undefined },
      { label: "Retry last" },
      { label: "Terminal", separator: true, icon: "terminal", action: panel("terminal") },
      { label: "Changes", icon: "difference", action: panel("changes") },
      { label: "Schedules", icon: "schedule", action: panel("schedules") },
      { label: "Usage", action: panel("agent") },
    ],
    Extensions: [{ label: "Plugins", icon: "extension", action: () => run("load plugins", async () => { const plugins = await driver.listPlugins(); setDialog({ title: "Plugins", text: plugins.length ? JSON.stringify(plugins, null, 2) : "No plugins installed." }); }) }],
    Help: [
      { label: "Keyboard shortcuts", action: () => setDialog({ title: "Keyboard shortcuts", text: "Menus: Enter or Space to open · ↑ ↓ to navigate · → to open a submenu · ← to return · Escape to close.\n\nText editing: ⌘Z Undo · ⌘⇧Z Redo · ⌘X Cut · ⌘C Copy · ⌘V Paste · ⌘A Select all." }) },
      { label: "About DocAi", action: () => setDialog({ title: "DocAi", text: "Your agent harness, dressed as a document.\nHistory and sessions are stored by your local Paseo daemon.\nDocAi is not affiliated with Google." }) },
    ],
  };
  return <><nav className="menubar" aria-label="Document menus">{Object.entries(menus).map(([name, items]) => <Dropdown key={name} label={name} items={items} />)}</nav>{error}{dialog && <ShellDialog title={dialog.title} close={() => setDialog(undefined)}><pre>{dialog.text}</pre></ShellDialog>}</>;
}
