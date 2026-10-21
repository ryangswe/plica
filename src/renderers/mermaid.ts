import { el } from "../lib/dom";
import { guardRemoteHtml, type RemotePolicy } from "../lib/sanitize";
import type { Renderer } from "../types";

type MermaidApi = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidApi> | null = null;
let lastTheme: string | null = null;
let counter = 0;

/** Mermaid is big, so it is only loaded when a diagram actually shows up. */
async function getMermaid(dark: boolean): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  const theme = dark ? "dark" : "default";
  if (theme !== lastTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    lastTheme = theme;
  }
  return mermaid;
}

async function renderDiagram(source: string, dark: boolean, remote: RemotePolicy): Promise<HTMLElement> {
  const box = el("div", { class: "mermaid-diagram" });
  try {
    const mermaid = await getMermaid(dark);
    const { svg } = await mermaid.render(`plica-mermaid-${++counter}`, source);
    box.innerHTML = guardRemoteHtml(svg, remote); // diagrams can reference images by URL
  } catch (err) {
    box.classList.add("render-error");
    box.append(
      el("div", { class: "error-title" }, "Couldn't render this diagram"),
      el("div", { class: "error-detail" }, String((err as Error)?.message ?? err)),
      el("pre", {}, source),
    );
    // Mermaid sometimes leaves an orphaned error element in <body>.
    document.getElementById(`dplica-mermaid-${counter}`)?.remove();
  }
  return box;
}

/** Replace every `.mermaid-block` (from ```mermaid fences) with the rendered diagram. */
export async function renderMermaidBlocks(root: HTMLElement, dark: boolean, remote: RemotePolicy): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-block")];
  for (const block of blocks) {
    block.replaceWith(await renderDiagram(block.textContent ?? "", dark, remote));
  }
}

export const mermaidRenderer: Renderer = {
  id: "mermaid",
  label: "Mermaid",
  extensions: ["mmd", "mermaid"],
  rawLanguage: "plaintext",
  async render(doc, ctx) {
    const wrap = el("div", { class: "center-stage" });
    wrap.append(await renderDiagram(doc.text, ctx.dark, ctx.remote));
    return wrap;
  },
};
