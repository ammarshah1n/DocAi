import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./folder-picker.css";

type FolderPickerProps = {
  folders: string[];
  value: string;
  onChange: (value: string) => void;
  onBrowse?: () => void;
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function FolderPicker({ folders, value, onChange, onBrowse }: FolderPickerProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>();
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return folders.filter(folder => !needle || folder.toLocaleLowerCase().includes(needle) || basename(folder).toLocaleLowerCase().includes(needle));
  }, [folders, query]);

  useLayoutEffect(() => {
    if (!open || !input.current) return;
    const place = () => {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom;
      const showBelow = below >= rect.top;
      const maxHeight = Math.max(80, Math.min(280, (showBelow ? below : rect.top) - 12));
      const top = showBelow ? rect.bottom + 4 : Math.max(8, rect.top - maxHeight - 4);
      setPosition({ left, top, width, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !document.getElementById(`${id}-list`)?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [id, open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id, open]);

  const openPicker = () => {
    setQuery("");
    setActive(-1);
    setOpen(true);
  };
  const choose = (folder: string) => {
    onChange(folder);
    setOpen(false);
    setQuery("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); setOpen(false); setQuery(""); }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openPicker();
      else if (options.length) setActive(index => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActive(index => Math.max(0, index - 1));
    } else if (event.key === "Enter" && open && options[Math.max(0, active)]) {
      event.preventDefault();
      choose(options[Math.max(0, active)]);
    }
  };

  return <div className="folder-picker" ref={root}>
    <input
      ref={input}
      type="text"
      role="combobox"
      aria-label="Working folder"
      placeholder="Search folders…"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={`${id}-list`}
      aria-activedescendant={open && options[active] ? `${id}-option-${active}` : undefined}
      title={value}
      value={open ? query : value}
      onFocus={() => { if (!open) openPicker(); }}
      onClick={() => { if (!open) openPicker(); }}
      onBlur={() => setOpen(false)}
      onChange={event => { setOpen(true); setQuery(event.target.value); setActive(-1); }}
      onKeyDown={onKeyDown}
    />
    {onBrowse && <button type="button" className="folder-picker-browse" onClick={onBrowse}>Browse…</button>}
    {open && createPortal(<div className="folder-picker-popup" style={position}>
      <ul id={`${id}-list`} role="listbox" aria-label="Existing folders">
        {options.length ? options.map((folder, index) => <li
          id={`${id}-option-${index}`}
          key={folder}
          role="option"
          aria-selected={folder === value}
          className={index === active ? "is-active" : undefined}
          title={folder}
          onMouseEnter={() => setActive(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(folder)}
        >{basename(folder)}<small>{folder}</small></li>) : <li className="folder-picker-empty" role="presentation">No matching folders</li>}
      </ul>
    </div>, document.body)}
  </div>;
}
