// Typed access to the Electron preload bridge (absent when the UI runs in a plain browser).
type Native = {
  pickFolder(defaultPath?: string): Promise<string | null>;
  piEnabledModels(): Promise<string[] | null>;
  readClipboardImage(): Promise<{ mimeType: string; data: string } | null>;
};
export const native: Native | undefined = (window as unknown as { docai?: Native }).docai;

/** pi-style scope match: "*" wildcards; a pattern without a provider matches the bare model id. */
export function matchesScope(id: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    return re.test(id) || (!p.includes("/") && re.test(id.split("/").slice(1).join("/")));
  });
}

let piScope: Promise<string[] | null> | undefined;
/** Drop pi models outside the user's pi scope (settings.json enabledModels); other providers pass through. */
export async function scoped<M extends { id: string }>(provider: string, models: M[]): Promise<M[]> {
  if (provider !== "pi" || !native) return models;
  const patterns = await (piScope ??= native.piEnabledModels().catch(() => null));
  return patterns?.length ? models.filter((m) => matchesScope(m.id, patterns)) : models;
}
