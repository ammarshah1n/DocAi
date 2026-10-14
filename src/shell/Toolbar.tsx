import { useState } from "react";
import { toggleMenus, useLayout } from "../state/layout";
import { Dropdown, Icon, Tool, nativeEdit, useAction, useAgentMenus, useFocusedAgent } from "./controls";

export function Toolbar() {
  const agent = useFocusedAgent();
  const { run, error } = useAction();
  const { catalog, modes, models, thinking } = useAgentMenus(agent, run);
  const { menusHidden } = useLayout();
  const [zoom, setZoom] = useState(100);
  const mode = agent?.availableModes?.find(m => m.id === agent.currentModeId)?.label ?? "Editing";
  const model = catalog.models.find(m => m.id === agent?.model)?.label ?? agent?.model ?? "Normal text";
  const tools = (entries: [string, string][]) => entries.map(([icon, label]) => <Tool key={icon} icon={icon} label={`${label} (not available)`} />);
  return <><div className="docs-toolbar" role="toolbar" aria-label="Document toolbar">
    <Tool icon="search" label="Search menus (not available)" />
    <Tool icon="undo" label="Undo (⌘Z)" onClick={() => run("undo", () => nativeEdit("undo"))} />
    <Tool icon="redo" label="Redo (⌘⇧Z)" onClick={() => run("redo", () => nativeEdit("redo"))} />
    <Tool icon="print" label="Print (⌘P)" onClick={() => window.print()} />
    {tools([["spellcheck", "Spelling and grammar"], ["format_paint", "Paint format"]])}<span className="toolbar-divider" />
    <Dropdown label="Zoom" className="zoom-picker" items={[50, 75, 90, 100, 125, 150, 200].map(n => ({ label: `${n}%`, checked: n === zoom, action: () => { setZoom(n); document.documentElement.style.setProperty("--doc-zoom", String(n / 100)); } }))}>{zoom}%<Icon name="arrow_drop_down" /></Dropdown>
    <span className="toolbar-divider" />
    <Dropdown label="Model" className="model-picker" items={catalog.error ? [{ label: "Could not load models · Retry", action: catalog.retry }] : models}><span>{model}</span><Icon name="arrow_drop_down" /></Dropdown>
    <span className="toolbar-divider" />
    <Dropdown label="Thinking" className="mode-picker" items={thinking}><span>{thinking.find(t => t.checked)?.label ?? (agent ? "Default" : "Arial")}</span><Icon name="arrow_drop_down" /></Dropdown>
    <span className="toolbar-divider" />
    <div className="font-size-group"><Tool icon="remove" label="Decrease font size (not available)" /><span className="font-size">11</span><Tool icon="add" label="Increase font size (not available)" /></div>
    {tools([["format_bold", "Bold"], ["format_italic", "Italic"], ["format_underlined", "Underline"], ["format_color_text", "Text colour"], ["ink_highlighter", "Highlight colour"]])}<span className="toolbar-divider" />
    <div className="toolbar-secondary">{tools([["link", "Insert link"], ["add_comment", "Add comment"], ["image", "Insert image"]])}<span className="toolbar-divider" />{tools([["format_align_left", "Align"], ["format_line_spacing", "Line spacing"], ["checklist", "Checklist"], ["format_list_bulleted", "Bulleted list"], ["format_list_numbered", "Numbered list"], ["format_indent_decrease", "Decrease indent"], ["format_indent_increase", "Increase indent"], ["format_clear", "Clear formatting"]])}</div>
    <span className="toolbar-spacer" />
    <Dropdown label="Permission mode" className="permission-picker" items={modes}><Icon name="edit" /><span>{mode}</span><Icon name="arrow_drop_down" /></Dropdown>
    <span className="toolbar-divider" /><Tool icon={menusHidden ? "keyboard_arrow_down" : "keyboard_arrow_up"} label={menusHidden ? "Show menus" : "Hide menus"} onClick={toggleMenus} />
  </div>{error}</>;
}
