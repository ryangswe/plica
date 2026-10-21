import { el } from "../lib/dom";
import { highlight } from "../lib/highlight";
import { sanitize } from "../lib/sanitize";
import { ansiToHtml } from "../lib/ansi";
import type { RenderContext, Renderer } from "../types";
import { renderMarkdownInto } from "./markdown";
import { parseErrorView } from "./json";
import { addCopyButtons } from "../lib/copy";

type Multiline = string | string[];
interface Output {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  name?: string;
  text?: Multiline;
  data?: Record<string, Multiline>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface Cell {
  cell_type: "code" | "markdown" | "raw";
  source: Multiline;
  execution_count?: number | null;
  outputs?: Output[];
}
interface Notebook {
  cells?: Cell[];
  metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string; display_name?: string } };
  nbformat?: number;
}

const join = (m: Multiline | undefined) => (Array.isArray(m) ? m.join("") : (m ?? ""));

async function renderOutput(out: Output, ctx: RenderContext): Promise<HTMLElement | null> {
  if (out.output_type === "stream") {
    const pre = el("pre", { class: `nb-stream${out.name === "stderr" ? " nb-stderr" : ""}` });
    pre.innerHTML = ansiToHtml(join(out.text));
    return pre;
  }
  if (out.output_type === "error") {
    const pre = el("pre", { class: "nb-error" });
    pre.innerHTML = ansiToHtml((out.traceback ?? [`${out.ename}: ${out.evalue}`]).join("\n"));
    return pre;
  }
  const data = out.data ?? {};
  if (data["image/png"] || data["image/jpeg"] || data["image/gif"]) {
    const mime = data["image/png"] ? "image/png" : data["image/jpeg"] ? "image/jpeg" : "image/gif";
    const b64 = join(data[mime]).replace(/\s/g, "");
    return el("img", { class: "nb-image", src: `data:${mime};base64,${b64}`, alt: "Cell output" });
  }
  if (data["image/svg+xml"]) {
    const blob = new Blob([join(data["image/svg+xml"])], { type: "image/svg+xml" });
    return el("img", { class: "nb-image", src: URL.createObjectURL(blob), alt: "Cell output" });
  }
  if (data["text/html"]) {
    const div = el("div", { class: "nb-html" });
    div.innerHTML = sanitize(join(data["text/html"]));
    return div;
  }
  if (data["text/markdown"]) {
    return renderMarkdownInto(join(data["text/markdown"]), ctx);
  }
  if (data["text/plain"]) {
    const pre = el("pre", { class: "nb-stream" });
    pre.innerHTML = ansiToHtml(join(data["text/plain"]));
    return pre;
  }
  return null;
}

export const notebookRenderer: Renderer = {
  id: "notebook",
  label: "Jupyter Notebook",
  extensions: ["ipynb"],
  rawLanguage: "json",
  async render(doc, ctx) {
    let nb: Notebook;
    try {
      nb = JSON.parse(doc.text);
    } catch (err) {
      return parseErrorView("notebook JSON", (err as Error).message);
    }
    const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? "python";
    const root = el("div", { class: "notebook" });
    const kernel = nb.metadata?.kernelspec?.display_name;
    if (kernel) root.append(el("div", { class: "muted nb-kernel" }, `Kernel: ${kernel}`));
    if (!nb.cells) {
      root.append(el("div", { class: "notice" }, "This notebook uses an old format (nbformat < 4) that isn't supported yet. Use Raw."));
      return root;
    }
    for (const cell of nb.cells) {
      const src = join(cell.source);
      if (cell.cell_type === "markdown") {
        root.append(el("div", { class: "nb-cell nb-md" }, el("div", { class: "nb-prompt" }), await renderMarkdownInto(src, ctx)));
        continue;
      }
      if (cell.cell_type === "raw") {
        root.append(el("div", { class: "nb-cell" }, el("div", { class: "nb-prompt" }), el("pre", { class: "nb-raw" }, src)));
        continue;
      }
      const n = cell.execution_count;
      const code = el("pre", { class: "nb-code hljs" });
      code.innerHTML = highlight(src, lang);
      const cellEl = el(
        "div",
        { class: "nb-cell nb-codecell" },
        el("div", { class: "nb-prompt" }, `[${n ?? " "}]:`),
        el("div", { class: "nb-body" }, code),
      );
      addCopyButtons(cellEl, "pre.nb-code");
      const outputs = el("div", { class: "nb-outputs" });
      for (const out of cell.outputs ?? []) {
        const o = await renderOutput(out, ctx);
        if (o) outputs.append(o);
      }
      if (outputs.childElementCount) cellEl.querySelector(".nb-body")!.append(outputs);
      root.append(cellEl);
    }
    return root;
  },
};
