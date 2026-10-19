import { el } from "./lib/dom";

const MAX_MATCHES = 5000;

/** Simple find-in-page (webviews don't all ship one). Highlights matches with <mark>. */
export function createFindBar(getRoot: () => HTMLElement | null) {
  const input = el("input", { type: "search", placeholder: "Find…", "aria-label": "Find in file" });
  const count = el("span", { class: "muted find-count" });
  const prev = el("button", { title: "Previous (Shift+Enter)", "aria-label": "Previous match" }, "↑");
  const next = el("button", { title: "Next (Enter)", "aria-label": "Next match" }, "↓");
  const close = el("button", { title: "Close (Esc)", "aria-label": "Close find" }, "✕");
  const bar = el("div", { class: "find-bar", hidden: "" }, input, count, prev, next, close);

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
    index = -1;
  }

  function search() {
    clear();
    const q = input.value;
    const root = getRoot();
    if (!q || !root) {
      count.textContent = "";
      return;
    }
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest("[hidden], .find-bar, script, style, svg")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue && n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes: Text[] = [];
    while (walker.nextNode() && nodes.length < MAX_MATCHES) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      let t: Text = node;
      while (marks.length < MAX_MATCHES) {
        const i = t.data.toLowerCase().indexOf(needle);
        if (i < 0) break;
        const match = t.splitText(i);
        t = match.splitText(q.length);
        const mark = el("mark", { class: "find-hit" }, match.data);
        match.replaceWith(mark);
        marks.push(mark);
      }
    }
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
    if (!marks.length) {
      count.textContent = input.value ? "No matches" : "";
      return;
    }
    marks[index]?.classList.remove("current");
    index = (index + delta + marks.length) % marks.length;
    const m = marks[index];
    m.classList.add("current");
    m.scrollIntoView({ block: "center" });
    count.textContent = `${index + 1} / ${marks.length}${marks.length >= MAX_MATCHES ? "+" : ""}`;
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
    count.textContent = "";
    bar.hidden = true;
  }
  return {
    bar,
    show,
    hide,
    isOpen: () => !bar.hidden,
    /** Call after the view re-renders. */
    refresh: () => {
      marks = [];
      index = -1;
      if (!bar.hidden && input.value) search();
    },
  };
}
