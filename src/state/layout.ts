import { Store, useStore } from "./paseo";

export type PaneArrangement = "columns" | "grid";
export type Layout = {
  panes: (string | null)[];
  paneKeys: string[];
  focused: number;
  arrangement: PaneArrangement;
  paneSizes: Record<string, number[]>;
  sidebarOpen: boolean;
  rightPanel: string | null;
  menusHidden: boolean;
};

const KEY = "docai.layout.v1";
const initial: Layout = {
  panes: [null], paneKeys: [crypto.randomUUID()], focused: 0, arrangement: "columns",
  paneSizes: {}, sidebarOpen: true, rightPanel: null, menusHidden: false,
};
const validIndex = (l: Layout, i: number) => Number.isInteger(i) && i >= 0 && i < l.panes.length;

function load(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || !Array.isArray(v.panes) || v.panes.length < 1 || v.panes.length > 4 ||
      !v.panes.every((id: unknown) => id === null || typeof id === "string")) return initial;
    const paneSizes: Record<string, number[]> = {};
    for (const [key, sizes] of Object.entries(v.paneSizes ?? {})) {
      if (/^(columns:[1-4]|grid:4):(x|y)$/.test(key) && Array.isArray(sizes) && sizes.length >= 1 && sizes.length <= 4 &&
        sizes.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10000)) paneSizes[key] = sizes;
    }
    return {
      panes: v.panes, paneKeys: v.panes.map(() => crypto.randomUUID()),
      focused: Number.isInteger(v.focused) ? Math.max(0, Math.min(v.focused, v.panes.length - 1)) : 0,
      arrangement: v.arrangement === "grid" ? "grid" : "columns", paneSizes,
      sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : true,
      rightPanel: typeof v.rightPanel === "string" ? v.rightPanel : null,
      menusHidden: v.menusHidden === true,
    };
  } catch { return initial; }
}

export const layoutStore = new Store<Layout>(load());
// Storage can be unavailable in private mode or when the disk is full; keep the workspace usable.
layoutStore.subscribe(() => { try { localStorage.setItem(KEY, JSON.stringify(layoutStore.get())); } catch {} });
export const useLayout = () => useStore(layoutStore);
const update = (fn: (l: Layout) => Partial<Layout>) => layoutStore.set({ ...layoutStore.get(), ...fn(layoutStore.get()) });

export const openDoc = (agentId: string | null) => update((l) => {
  const existing = agentId ? l.panes.indexOf(agentId) : -1;
  if (existing !== -1) return { focused: existing };
  const panes = l.panes.slice();
  panes[l.focused] = agentId;
  return { panes };
});
export const insertPane = (i: number, agentId: string | null = null) => update((l) => {
  if (l.panes.length >= 4 || !Number.isInteger(i) || i < 0 || i > l.panes.length) return {};
  const panes = l.panes.slice(), paneKeys = l.paneKeys.slice();
  panes.splice(i, 0, agentId);
  paneKeys.splice(i, 0, crypto.randomUUID());
  return { panes, paneKeys, focused: i };
});
export const splitPane = () => insertPane(layoutStore.get().focused + 1);
export const closePane = (i: number) => update((l) => {
  if (!validIndex(l, i)) return {};
  if (l.panes.length === 1) return { panes: [null], focused: 0 };
  const panes = l.panes.filter((_, j) => j !== i);
  return {
    panes, paneKeys: l.paneKeys.filter((_, j) => j !== i),
    focused: l.focused > i ? l.focused - 1 : Math.min(l.focused, panes.length - 1),
  };
});
export const focusPane = (i: number) => update((l) => validIndex(l, i) ? { focused: i } : {});
export const setPaneAgent = (i: number, agentId: string | null) => update((l) => {
  if (!validIndex(l, i)) return {};
  const panes = l.panes.slice();
  panes[i] = agentId;
  return { panes, focused: i };
});
export const setPaneArrangement = (arrangement: PaneArrangement) => update(() => ({ arrangement }));
export const setPaneSizes = (key: string, sizes: number[]) => update((l) => {
  if (!sizes.length || sizes.some((n) => !Number.isFinite(n) || n <= 0)) return {};
  return { paneSizes: { ...l.paneSizes, [key]: sizes } };
});
export const toggleSidebar = () => update((l) => ({ sidebarOpen: !l.sidebarOpen }));
export const setRightPanel = (id: string | null) => update((l) => ({ rightPanel: l.rightPanel === id ? null : id }));
export const toggleMenus = () => update((l) => ({ menusHidden: !l.menusHidden }));
