import { highlight, splitHighlightedLines, MAX_HIGHLIGHT_CHARS } from "../lib/highlight";
import { escapeHtml } from "../lib/dom";

const CHUNK = 400;

/**
 * Source view with line numbers. Lines are grouped into chunks with
 * `content-visibility: auto` so very large files stay scrollable.
 */
export function renderRaw(text: string, lang?: string, opts: { wrap?: boolean } = {}): HTMLElement {
  const html = text.length > MAX_HIGHLIGHT_CHARS ? escapeHtml(text) : highlight(text, lang);
  const lines = splitHighlightedLines(html);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const root = document.createElement("div");
  root.className = "raw" + (opts.wrap ? " wrap" : "");
  root.style.setProperty("--gutter", `${String(lines.length).length + 1}ch`);
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    parts.push('<div class="raw-chunk">');
    const end = Math.min(i + CHUNK, lines.length);
    for (let j = i; j < end; j++) {
      parts.push(`<div class="ln" data-n="${j + 1}"><code>${lines[j] || " "}</code></div>`);
    }
    parts.push("</div>");
  }
  root.innerHTML = `<div class="hljs raw-lines">${parts.join("")}</div>`;
  return root;
}
