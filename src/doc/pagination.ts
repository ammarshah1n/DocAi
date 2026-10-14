export const CONTENT_HEIGHT = 864;
export type Fragment = { html: string; height: number };

// Only called on Streamdown's rendered, sanitised document nodes, never raw model HTML.
export function splitElement(element: HTMLElement, measure: HTMLElement): Fragment[] {
  const height = (node: HTMLElement) => {
    measure.replaceChildren(node);
    const style = getComputedStyle(node);
    return Math.ceil(node.getBoundingClientRect().height + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0"));
  };
  const fragment = (node: HTMLElement): Fragment => ({ height: height(node), html: node.outerHTML });
  const whole = fragment(element.cloneNode(true) as HTMLElement);
  if (whole.height <= CONTENT_HEIGHT) return [whole];

  // Range slicing preserves nested inline marks and list/table structure across sheets.
  const texts: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  if (!texts.length) return [whole];
  const lengths = texts.map(t => t.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  const point = (offset: number): [Text, number] => {
    for (let i = 0; i < texts.length; i++) {
      if (offset <= lengths[i]) return [texts[i], offset];
      offset -= lengths[i];
    }
    return [texts[texts.length - 1], texts[texts.length - 1].length];
  };
  const slice = (start: number, end: number) => {
    const range = document.createRange();
    range.setStart(...point(start)); range.setEnd(...point(end));
    let contents: Node = range.cloneContents();
    let ancestor: Node | null = range.commonAncestorContainer;
    if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
    while (ancestor && ancestor !== element) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.appendChild(contents);
      contents = wrapper;
      ancestor = ancestor.parentNode;
    }
    const node = element.cloneNode(false) as HTMLElement;
    node.append(contents);
    return node;
  };
  const result: Fragment[] = [];
  const text = element.textContent ?? "";
  let start = 0;
  while (start < total) {
    let low = start + 1, high = total, best = start + 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (height(slice(start, mid)) <= CONTENT_HEIGHT) { best = mid; low = mid + 1; }
      else high = mid - 1;
    }
    if (best < total) {
      const boundary = text.lastIndexOf("\n", best);
      const space = text.lastIndexOf(" ", best);
      const cut = Math.max(boundary, space);
      if (cut > start + (best - start) / 2) best = cut + 1;
    }
    result.push(fragment(slice(start, best)));
    start = best;
  }
  measure.replaceChildren();
  return result;
}

export function distribute<T extends { height: number }>(items: T[], reserve = 40): T[][] {
  const pages: T[][] = [[]];
  let used = 0;
  for (const item of items) {
    if (used && used + item.height > CONTENT_HEIGHT) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(item);
    used += item.height;
  }
  if (used + reserve > CONTENT_HEIGHT) pages.push([]);
  return pages;
}
