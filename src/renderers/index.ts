import type { FileDoc, Renderer } from "../types";
import { extOf } from "../lib/dom";
import { languageFor } from "../lib/highlight";
import { markdownRenderer } from "./markdown";
import { jsonRenderer, jsonLinesRenderer } from "./json";
import { csvRenderer, tsvRenderer } from "./csv";
import { notebookRenderer } from "./notebook";
import { diffRenderer } from "./diff";
import { logRenderer } from "./log";
import { mermaidRenderer } from "./mermaid";
import { svgRenderer, htmlRenderer, codeRenderer } from "./simple";

/** Add new file types here. First match wins; `codeRenderer` is the fallback. */
export const renderers: Renderer[] = [
  markdownRenderer,
  jsonRenderer,
  jsonLinesRenderer,
  csvRenderer,
  tsvRenderer,
  notebookRenderer,
  diffRenderer,
  logRenderer,
  mermaidRenderer,
  svgRenderer,
  htmlRenderer,
];

export function pickRenderer(doc: Pick<FileDoc, "name">): Renderer {
  const name = doc.name.toLowerCase();
  const ext = extOf(name);
  return (
    renderers.find((r) => r.filenames?.includes(name)) ??
    renderers.find((r) => r.extensions.includes(ext)) ??
    codeRenderer
  );
}

/** Language for highlighting the raw view of this file. */
export function rawLanguageFor(doc: Pick<FileDoc, "name">, r: Renderer): string | undefined {
  if (r.rawLanguage) return r.rawLanguage;
  return languageFor(doc.name, extOf(doc.name));
}
