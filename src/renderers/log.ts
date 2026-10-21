import { el, escapeHtml, toolbar } from "../lib/dom";
import { ansiToHtml, hasAnsi, stripAnsi } from "../lib/ansi";
import type { Renderer } from "../types";

export type Level = "error" | "warn" | "info" | "debug" | "none";
const LEVELS: Exclude<Level, "none">[] = ["error", "warn", "info", "debug"];

export function detectLevel(line: string): Level {
  if (/\b(FATAL|CRIT(?:ICAL)?|ERR(?:OR)?|SEVERE|PANIC|EXCEPTION)\b|Traceback \(most recent call last\)/i.test(line)) return "error";
  // Java/Python style exception headers: "java.lang.IllegalStateException: boom", "ValueError: bad"
  if (/^[\w.$]+(?:Exception|Error)(?::|$)/.test(line)) return "error";
  if (/\bWARN(?:ING)?\b/i.test(line)) return "warn";
  if (/\b(INFO|NOTICE)\b/i.test(line)) return "info";
  if (/\b(DEBUG|TRACE|VERBOSE|FINE)\b/i.test(line)) return "debug";
  return "none";
}

const TS_RE = /^(\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\]?|\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?)/;

/** Lines that continue the previous entry (stack traces) inherit its level. */
const CONTINUATION_RE = /^(\s+at\s|\s{2,}|\t|Caused by:|\.\.\. \d+ more)/;

function lineHtml(raw: string): string {
  if (hasAnsi(raw)) return ansiToHtml(raw);
  const m = TS_RE.exec(raw);
  if (m) return `<span class="log-ts">${escapeHtml(m[0])}</span>${escapeHtml(raw.slice(m[0].length))}`;
  return escapeHtml(raw);
}

/**
 * Entries per level, for the chips: a stack trace is one error, not one per line. In logs with
 * timestamps an entry starts at a timestamped line; otherwise every line with its own level counts.
 */
export function countEntries(lines: string[], levels: Level[]): Record<Level, number> {
  const plain = lines.map(stripAnsi);
  const stamped = plain.some((l) => TS_RE.test(l));
  const counts = { error: 0, warn: 0, info: 0, debug: 0, none: 0 };
  plain.forEach((l, i) => {
    const starts = stamped ? TS_RE.test(l) : !CONTINUATION_RE.test(l);
    if (starts) counts[levels[i]]++;
  });
  return counts;
}

export const logRenderer: Renderer = {
  id: "log",
  label: "Log",
  extensions: ["log", "out", "err"],
  rawLanguage: "plaintext",
  render(doc, ctx) {
    const lines = doc.text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const levels: Level[] = [];
    let prev: Level = "none";
    for (const l of lines) {
      let lv = detectLevel(stripAnsi(l));
      if (lv === "none" && CONTINUATION_RE.test(l)) lv = prev;
      levels.push(lv);
      prev = lv;
    }
    const counts = { error: 0, warn: 0, info: 0, debug: 0, none: 0 };
    levels.forEach((l) => counts[l]++);
    const entries = countEntries(lines, levels);

    const state = ctx.state as { filter?: string; hidden?: Level[]; follow?: boolean };
    const hidden = new Set<Level>(state.hidden ?? []);
    const root = el("div", { class: "log-view" });
    const filter = el("input", { type: "search", placeholder: "Filter lines…", "aria-label": "Filter lines" });
    filter.value = state.filter ?? "";
    const chips = LEVELS.filter((l) => counts[l] > 0).map((l) => {
      const n = entries[l] || counts[l];
      const what = `${n.toLocaleString()} ${l} entr${n === 1 ? "y" : "ies"} (${counts[l].toLocaleString()} line${counts[l] === 1 ? "" : "s"})`;
      const b = el("button", { class: `chip chip-${l}`, "aria-pressed": String(!hidden.has(l)), title: `${what}. Click to show or hide.` }, `${l} ${n.toLocaleString()}`);
      b.addEventListener("click", () => {
        hidden.has(l) ? hidden.delete(l) : hidden.add(l);
        b.setAttribute("aria-pressed", String(!hidden.has(l)));
        state.hidden = [...hidden];
        apply();
      });
      return b;
    });
    const nextErr = el("button", { title: "Jump to next error" }, "Next error ↓");
    const follow = el("label", { class: "check" }, el("input", { type: "checkbox" }), " Follow");
    const followBox = follow.querySelector("input")!;
    followBox.checked = state.follow ?? false;
    followBox.addEventListener("change", () => (state.follow = followBox.checked));
    const shown = el("span", { class: "muted" });
    root.append(toolbar(filter, ...chips, counts.error ? nextErr : "", follow, shown));

    const body = el("div", { class: "log-lines" });
    body.style.setProperty("--gutter", `${String(lines.length).length + 1}ch`);
    const parts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i % 500 === 0) parts.push(i ? '</div><div class="raw-chunk">' : '<div class="raw-chunk">');
      parts.push(`<div class="ln lv-${levels[i]}" data-n="${i + 1}"><code>${lineHtml(lines[i]) || " "}</code></div>`);
    }
    if (lines.length) parts.push("</div>");
    body.innerHTML = parts.join("");
    root.append(body);
    const rows = [...body.querySelectorAll<HTMLElement>(".ln")];
    const lower = lines.map((l) => stripAnsi(l).toLowerCase());

    function apply() {
      const q = filter.value.trim().toLowerCase();
      state.filter = filter.value;
      let n = 0;
      for (let i = 0; i < rows.length; i++) {
        const vis = !hidden.has(levels[i]) && (!q || lower[i].includes(q));
        rows[i].hidden = !vis;
        if (vis) n++;
      }
      shown.textContent = n === rows.length ? `${rows.length.toLocaleString()} lines` : `${n.toLocaleString()} of ${rows.length.toLocaleString()} lines`;
    }
    filter.addEventListener("input", apply);

    let errCursor = -1;
    nextErr.addEventListener("click", () => {
      const scroller = root.closest(".view-scroll") ?? document.scrollingElement!;
      const errs = rows.filter((r, i) => levels[i] === "error" && !r.hidden && (i === 0 || levels[i - 1] !== "error"));
      if (!errs.length) return;
      errCursor = (errCursor + 1) % errs.length;
      const target = errs[errCursor];
      rows.forEach((r) => r.classList.remove("flash"));
      target.classList.add("flash");
      target.scrollIntoView({ block: "center" });
      void scroller;
    });
    apply();

    if (ctx.reloaded && followBox.checked) {
      requestAnimationFrame(() => {
        const scroller = root.closest(".view-scroll");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    }
    return root;
  },
};
