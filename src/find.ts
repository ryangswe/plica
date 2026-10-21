import { el } from "./lib/dom";

const MAX_MATCHES = 5000;

/** Elements that start a new block of text: a match never spans two of them. */
const BLOCK = "p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dt,dd,summary,figcaption,.ln,.j-row,tr,div";

/** Viewer UI inside the content (contents list, row numbers, "3 keys" summaries): not part of the file. */
const NOT_CONTENT = "[hidden], .find-bar, script, style, svg, .toc, .rownum, .j-idx, .j-summary, .j-more";

/** Count case-insensitive occurrences of `needle` (already lowercased) in `text`, up to `max`. */
function countIn(text: string, needle: string, max: number): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < max; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export interface FindSource {
  /** The whole file, to tell the user about matches that aren't on screen. */
  text: string;
  /** True when the view already shows the whole source (Raw), so there's nothing to compare. */
  isRaw: boolean;
  /** Switch to Raw, where every match is on screen. */
  showRaw(): void;
}

/**
 * Find in page (webviews don't all ship one). Highlights matches with <mark>, also when a match spans
 * several text nodes (e.g. syntax-highlighted tokens). Matches that exist in the file but not on screen
 * (collapsed JSON, CSV rows beyond the first page, Markdown link URLs) are counted and offered in Raw.
 */
export function createFindBar(getRoot: () => HTMLElement | null, getSource: () => FindSource | null = () => null) {
  const input = el("input", { type: "search", placeholder: "Find…", "aria-label": "Find in file" });
  const count = el("span", { class: "muted find-count" });
  const prev = el("button", { title: "Previous (Shift+Enter)", "aria-label": "Previous match" }, "↑");
  const next = el("button", { title: "Next (Enter)", "aria-label": "Next match" }, "↓");
  const close = el("button", { title: "Close (Esc)", "aria-label": "Close find" }, "✕");
  const elsewhere = el("span", { class: "muted find-elsewhere" });
  const showRaw = el("button", { class: "find-raw", hidden: "" }, "Show in Raw");
  const bar = el("div", { class: "find-bar", hidden: "" }, input, count, prev, next, elsewhere, showRaw, close);
  showRaw.addEventListener("click", () => getSource()?.showRaw());

  /** One entry per match; a match split across text nodes has several <mark> pieces. */
  let matches: HTMLElement[][] = [];
  let marks: HTMLElement[] = [];
  let index = -1;

  function clear() {
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
      parent.normalize();
    }
    marks = [];
    matches = [];
    index = -1;
  }

  function search() {
    clear();
    const q = input.value;
    const root = getRoot();
    if (!q || !root) {
      count.textContent = elsewhere.textContent = "";
      showRaw.hidden = true;
      return;
    }
    const needle = q.toLowerCase();
    // Lay the visible text out as one string, with a break between blocks, remembering where each
    // text node starts, so matches can cross formatting (e.g. "def main" across highlight spans).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || !n.nodeValue || p.closest(NOT_CONTENT)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const segs: { node: Text; start: number }[] = [];
    let full = "";
    let lastBlock: Element | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const block = node.parentElement!.closest(BLOCK);
      if (segs.length && block !== lastBlock) full += "\n";
      lastBlock = block;
      segs.push({ node, start: full.length });
      full += node.data;
    }
    const hay = full.toLowerCase();
    if (hay.length !== full.length) return searchSimple(root, q); // rare: lowercasing changed lengths
    const found: number[] = [];
    for (let i = hay.indexOf(needle); i >= 0 && found.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) found.push(i);
    // Wrap from the end so earlier offsets stay valid while text nodes get split.
    let seg = segs.length - 1;
    for (let k = found.length - 1; k >= 0; k--) {
      const s = found[k];
      const e = s + needle.length;
      while (seg > 0 && segs[seg].start >= e) seg--;
      const pieces: HTMLElement[] = [];
      for (let j = seg; j >= 0 && segs[j].start + segs[j].node.data.length > s; j--) {
        const { node, start } = segs[j];
        const from = Math.max(s, start) - start;
        const to = Math.min(e, start + node.data.length) - start;
        if (to <= from) continue;
        const match = node.splitText(from);
        match.splitText(to - from);
        const mark = el("mark", { class: "find-hit" }, match.data);
        match.replaceWith(mark);
        pieces.unshift(mark);
      }
      if (pieces.length) matches.unshift(pieces);
    }
    marks = matches.flat();
    reportElsewhere(needle);
    // Open collapsed <details> that contain hits.
    for (const m of marks) {
      let d = m.closest("details");
      while (d) {
        d.open = true;
        d = d.parentElement?.closest("details") ?? null;
      }
    }
    go(1);
  }

  function go(delta: number) {
    if (!matches.length) {
      count.textContent = input.value ? "No matches here" : "";
      return;
    }
    matches[index]?.forEach((m) => m.classList.remove("current"));
    index = (index + delta + matches.length) % matches.length;
    matches[index].forEach((m) => m.classList.add("current"));
    matches[index][0].scrollIntoView({ block: "center" });
    count.textContent = `${index + 1} / ${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""}`;
  }

  /** Tell the user about matches in the file that this view doesn't show. */
  function reportElsewhere(needle: string) {
    const src = getSource();
    const extra = src && !src.isRaw ? countIn(src.text, needle, MAX_MATCHES) - matches.length : 0;
    elsewhere.textContent = extra > 0 ? `${extra.toLocaleString()} more only in the source` : "";
    showRaw.hidden = extra <= 0;
  }

  /** Fallback when lowercasing changes string lengths: match within single text nodes only. */
  function searchSimple(root: HTMLElement, q: string) {
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (n.parentElement && !n.parentElement.closest(NOT_CONTENT) && n.data.toLowerCase().includes(needle)) nodes.push(n);
    }
    for (const node of nodes) {
      let t: Text = node;
      while (matches.length < MAX_MATCHES) {
        const i = t.data.toLowerCase().indexOf(needle);
        if (i < 0) break;
        const match = t.splitText(i);
        t = match.splitText(q.length);
        const mark = el("mark", { class: "find-hit" }, match.data);
        match.replaceWith(mark);
        matches.push([mark]);
      }
    }
    marks = matches.flat();
    reportElsewhere(needle);
    go(1);
  }

  let timer: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(search, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") hide();
  });
  next.addEventListener("click", () => go(1));
  prev.addEventListener("click", () => go(-1));
  close.addEventListener("click", () => hide());

  function show() {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value) search();
  }
  function hide() {
    clear();
    count.textContent = elsewhere.textContent = "";
    showRaw.hidden = true;
    bar.hidden = true;
  }
  return {
    bar,
    show,
    hide,
    isOpen: () => !bar.hidden,
    /** Find Next / Previous (Cmd+G / Shift+Cmd+G): opens the bar first if it's closed. */
    next: () => (bar.hidden ? show() : go(1)),
    prev: () => (bar.hidden ? show() : go(-1)),
    /** Call after the view re-renders. */
    refresh: () => {
      marks = [];
      matches = [];
      index = -1;
      if (!bar.hidden && input.value) search();
    },
  };
}
