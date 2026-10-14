import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { ErrorBoundary } from "../App";
import { DocPage } from "../doc/DocPage";
import { useAgents } from "../state/paseo";
import { closePane, focusPane, insertPane, layoutStore, setPaneAgent, setPaneSizes, splitPane, useLayout } from "../state/layout";
import "./panes.css";

const MIN_WIDTH = 280;
const MIN_HEIGHT = 180;
const DIVIDER = 6;
const DRAG_TYPE = "application/x-docai-agent";
type DropZone = "left" | "right" | "center";

function trackPixels(element: HTMLElement, axis: "x" | "y") {
  const style = getComputedStyle(element);
  return (axis === "x" ? style.gridTemplateColumns : style.gridTemplateRows)
    .split(" ").filter((_, i) => i % 2 === 0).map(Number.parseFloat);
}

export function PaneGrid() {
  const layout = useLayout();
  const agents = useAgents();
  const grid = useRef<HTMLDivElement>(null);
  const paneElements = useRef(new Map<string, HTMLElement>());
  const [drop, setDrop] = useState<{ pane: number; zone: DropZone } | null>(null);
  const { panes, paneKeys, focused } = layout;
  const tiled = panes.length === 4 && layout.arrangement === "grid";
  const columns = tiled ? 2 : panes.length;
  const rows = tiled ? 2 : 1;
  const sizeKey = `${tiled ? "grid" : "columns"}:${panes.length}`;
  const widths = layout.paneSizes[`${sizeKey}:x`]?.length === columns ? layout.paneSizes[`${sizeKey}:x`] : Array(columns).fill(1);
  const heights = layout.paneSizes[`${sizeKey}:y`]?.length === rows ? layout.paneSizes[`${sizeKey}:y`] : Array(rows).fill(1);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing) return;
      const current = layoutStore.get();
      let next: number | undefined;
      if (!event.altKey && (event.key === "\\" || event.code === "Backslash")) splitPane();
      else if (!event.altKey && event.key.toLowerCase() === "w") closePane(current.focused);
      else if (!event.altKey && /^[1-4]$/.test(event.key)) next = Number(event.key) - 1;
      else if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
        next = (current.focused + (event.key === "ArrowLeft" ? -1 : 1) + current.panes.length) % current.panes.length;
      } else return;
      event.preventDefault();
      if (next !== undefined) focusPane(next);
      const updated = layoutStore.get();
      requestAnimationFrame(() => paneElements.current.get(updated.paneKeys[updated.focused])?.focus());
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  function dragZone(event: DragEvent<HTMLElement>, pane: number) {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const zone: DropZone = panes.length < 4 && x < .2 ? "left" : panes.length < 4 && x > .8 ? "right" : "center";
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    return { pane, zone };
  }

  function startResize(event: PointerEvent<HTMLDivElement>, axis: "x" | "y", index: number) {
    if (event.button !== 0 || !grid.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pixels = trackPixels(grid.current, axis);
    const start = axis === "x" ? event.clientX : event.clientY;
    const minimum = axis === "x" ? MIN_WIDTH : MIN_HEIGHT;
    handle.setPointerCapture(event.pointerId);
    const move = (e: globalThis.PointerEvent) => {
      const delta = Math.max(minimum - pixels[index], Math.min(pixels[index + 1] - minimum, (axis === "x" ? e.clientX : e.clientY) - start));
      const next = pixels.slice();
      next[index] += delta;
      next[index + 1] -= delta;
      setPaneSizes(`${sizeKey}:${axis}`, next);
    };
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  }

  function divider(axis: "x" | "y", index: number) {
    const sizes = axis === "x" ? widths : heights;
    return <div key={`${axis}:${index}`} className={`pane-divider pane-divider-${axis}`} role="separator" tabIndex={0}
      aria-label={`Resize ${axis === "x" ? "columns" : "rows"} ${index + 1} and ${index + 2}`}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(sizes[index] / (sizes[index] + sizes[index + 1]) * 100)} aria-valuemin={0} aria-valuemax={100}
      style={axis === "x" ? { gridColumn: index * 2 + 2, gridRow: `1 / ${rows * 2}` } : { gridRow: index * 2 + 2, gridColumn: `1 / ${columns * 2}` }}
      onPointerDown={(e) => startResize(e, axis, index)}
      onDoubleClick={() => setPaneSizes(`${sizeKey}:${axis}`, Array(sizes.length).fill(1))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Home") {
          e.preventDefault();
          setPaneSizes(`${sizeKey}:${axis}`, Array(sizes.length).fill(1));
          return;
        }
        const direction = e.key === (axis === "x" ? "ArrowLeft" : "ArrowUp") ? -1 : e.key === (axis === "x" ? "ArrowRight" : "ArrowDown") ? 1 : 0;
        if (!direction || !grid.current) return;
        e.preventDefault();
        const next = trackPixels(grid.current, axis);
        const minimum = axis === "x" ? MIN_WIDTH : MIN_HEIGHT;
        const delta = Math.max(minimum - next[index], Math.min(next[index + 1] - minimum, direction * 24));
        next[index] += delta;
        next[index + 1] -= delta;
        setPaneSizes(`${sizeKey}:${axis}`, next);
      }} />;
  }

  return <div className="pane-workspace">
    <div ref={grid} className={`pane-grid${panes.length > 1 ? " pane-grid-multiple" : ""}`}
      style={{
        minWidth: columns * MIN_WIDTH + (columns - 1) * DIVIDER,
        minHeight: rows * MIN_HEIGHT + (rows - 1) * DIVIDER,
        gridTemplateColumns: widths.map((n) => `minmax(${MIN_WIDTH}px, ${n}fr)`).join(` ${DIVIDER}px `),
        gridTemplateRows: heights.map((n) => `minmax(${MIN_HEIGHT}px, ${n}fr)`).join(` ${DIVIDER}px `),
      }}>
      {panes.map((id, i) => {
        const agent = agents.find((a) => a.id === id);
        const title = agent?.title || (id ? "Untitled document" : "New document");
        return <section key={paneKeys[i]} ref={(el) => { if (el) paneElements.current.set(paneKeys[i], el); else paneElements.current.delete(paneKeys[i]); }}
          className={`doc-pane${focused === i ? " doc-pane-focused" : ""}`} tabIndex={-1} aria-label={`Pane ${i + 1}: ${title}`}
          style={{ gridColumn: (i % columns) * 2 + 1, gridRow: Math.floor(i / columns) * 2 + 1 }}
          onPointerDownCapture={() => { if (focused !== i) focusPane(i); }}
          onFocusCapture={() => { if (focused !== i) focusPane(i); }}
          onDragOver={(e) => { const target = dragZone(e, i); if (target) setDrop(target); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}
          onDrop={(e) => {
            const target = dragZone(e, i);
            setDrop(null);
            if (!target) return;
            const agentId = e.dataTransfer.getData(DRAG_TYPE).trim();
            if (!agentId || !agents.some((a) => a.id === agentId)) return;
            if (target.zone === "center") setPaneAgent(i, agentId);
            else insertPane(i + (target.zone === "right" ? 1 : 0), agentId);
          }} onDragEnd={() => setDrop(null)}>
          <header className="pane-header">
            <span className="pane-title" title={title}>{title}</span>
            {agent && <><span className="pane-chip" title={`${agent.provider} · ${agent.model || "Default model"}`}>{agent.provider}{agent.model ? ` · ${agent.model}` : ""}</span>
              <span className={`pane-status${agent.status === "running" ? " pane-status-running" : ""}`} title={agent.status} aria-label={`Status: ${agent.status}`} /></>}
            <label className="pane-picker" title="Open in this pane">
              <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
              <select aria-label={`Open in pane ${i + 1}`} value={id ?? ""} onChange={(e) => setPaneAgent(i, e.target.value || null)}>
                <option value="">New document</option>
                {id && !agent && <option value={id}>Untitled document</option>}
                {agents.map((a) => <option key={a.id} value={a.id}>{a.title || "Untitled document"}</option>)}
              </select>
            </label>
            <button className="pane-close" aria-label={`Close pane ${i + 1}`} title="Close pane (⌘W)" onClick={() => closePane(i)}>
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </header>
          <div className="pane-content"><ErrorBoundary key={id ?? "blank"} label={`document ${i + 1}`}><DocPage agentId={id} pane={i} /></ErrorBoundary></div>
          {drop?.pane === i && <div className={`pane-drop pane-drop-${drop.zone}`}><span>{drop.zone === "center" ? "Open in this pane" : "Open in a new pane"}</span></div>}
        </section>;
      })}
      {Array.from({ length: columns - 1 }, (_, i) => divider("x", i))}
      {Array.from({ length: rows - 1 }, (_, i) => divider("y", i))}
    </div>
  </div>;
}
