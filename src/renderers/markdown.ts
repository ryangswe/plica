import { Marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import { highlight } from "../lib/highlight";
import { sanitize } from "../lib/sanitize";
import { el, escapeHtml } from "../lib/dom";
import { hasScheme } from "../lib/paths";
import type { RenderContext, Renderer } from "../types";
import { renderMermaidBlocks } from "./mermaid";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function createMarked(): Marked {
  const slugCounts = new Map<string, number>();
  const marked = new Marked(
    markedHighlight({
      emptyLangClass: "hljs",
      langPrefix: "hljs language-",
      highlight(code, lang) {
        // Mermaid source is kept raw here; the code renderer below escapes it once.
        if (lang.trim().toLowerCase() === "mermaid") return code;
        return highlight(code, lang || undefined);
      },
    }),
  );
  marked.use({
    gfm: true,
    hooks: {
      preprocess(md) {
        slugCounts.clear();
        return md;
      },
    },
    renderer: {
      code(token: Tokens.Code) {
        if ((token.lang ?? "").trim().toLowerCase() === "mermaid") {
          return `<div class="mermaid-block">${escapeHtml(token.text)}</div>\n`;
        }
        return false;
      },
      heading(token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        let slug = slugify(token.text) || "section";
        const n = slugCounts.get(slug) ?? 0;
        slugCounts.set(slug, n + 1);
        if (n > 0) slug = `${slug}-${n}`;
        return `<h${token.depth} id="${slug}"><a class="anchor" href="#${slug}" aria-hidden="true">#</a>${inner}</h${token.depth}>\n`;
      },
    },
  });
  return marked;
}

const FRONTMATTER_RE = /^(?:﻿)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/;

export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return { frontmatter: null, body: md };
  return { frontmatter: m[1], body: md.slice(m[0].length) };
}

/** Markdown string → sanitized HTML string (no DOM post-processing). */
export function markdownToHtml(md: string): string {
  return sanitize(createMarked().parse(md, { async: false }) as string);
}

const ALERTS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/** Turn GitHub-style `> [!NOTE]` blockquotes into callouts. */
function applyAlerts(root: HTMLElement) {
  for (const bq of root.querySelectorAll("blockquote")) {
    const first = bq.firstElementChild;
    if (!first || first.tagName !== "P") continue;
    const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.textContent ?? "");
    if (!m) continue;
    const kind = m[1].toUpperCase();
    // Remove the marker from the first text node.
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode() as Text | null;
    if (t) t.data = t.data.replace(/^\s*\[![A-Za-z]+\]\s*/, "");
    if (first.firstChild?.nodeName === "BR") first.firstChild.remove();
    if (!first.textContent?.trim() && first.children.length === 0) first.remove();
    bq.classList.add("alert", `alert-${kind.toLowerCase()}`);
    bq.prepend(el("p", { class: "alert-title" }, ALERTS[kind]));
  }
}

function fixAssets(root: HTMLElement, ctx: RenderContext) {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || hasScheme(src) || src.startsWith("//")) continue;
    const url = ctx.resolveAsset(src);
    if (url) img.setAttribute("src", url);
  }
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!;
    if (hasScheme(href)) a.setAttribute("title", href);
  }
}

/** Render markdown into a document fragment-like container. Shared with the notebook renderer. */
export async function renderMarkdownInto(md: string, ctx: RenderContext): Promise<HTMLElement> {
  const container = el("div", { class: "markdown-body" });
  container.innerHTML = markdownToHtml(md);
  applyAlerts(container);
  fixAssets(container, ctx);
  await renderMermaidBlocks(container, ctx.dark);
  return container;
}

function buildToc(body: HTMLElement): HTMLElement | null {
  const heads = [...body.querySelectorAll<HTMLHeadingElement>("h1, h2, h3")];
  if (heads.length < 3) return null;
  const list = el("ul");
  for (const h of heads) {
    const text = (h.textContent ?? "").replace(/^#/, "");
    list.append(el("li", { class: `toc-${h.tagName.toLowerCase()}` }, el("a", { href: `#${h.id}` }, text)));
  }
  return el("nav", { class: "toc", "aria-label": "Contents" }, el("div", { class: "toc-title" }, "Contents"), list);
}

export const markdownRenderer: Renderer = {
  id: "markdown",
  label: "Markdown",
  extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdx", "rmd"],
  rawLanguage: "markdown",
  async render(doc, ctx) {
    const { frontmatter, body } = splitFrontmatter(doc.text);
    const content = await renderMarkdownInto(body, ctx);
    if (frontmatter) {
      const fm = el("details", { class: "frontmatter" }, el("summary", {}, "Front matter"));
      const pre = el("pre", { class: "hljs" });
      pre.innerHTML = highlight(frontmatter, "yaml");
      fm.append(pre);
      content.prepend(fm);
    }
    const layout = el("div", { class: "md-layout" });
    const toc = buildToc(content);
    if (toc) layout.append(toc);
    layout.append(content);
    return layout;
  },
};
