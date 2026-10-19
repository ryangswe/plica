import { el, toolbar } from "../lib/dom";
import type { Renderer } from "../types";

/** Remove line and block comments and trailing commas (outside strings), for tsconfig-style JSONC. */
export function stripJsonComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type JsonParse = { ok: true; value: unknown; lenient: boolean } | { ok: false; error: string };

export function parseJsonLenient(text: string): JsonParse {
  const src = text.replace(/^﻿/, "");
  try {
    return { ok: true, value: JSON.parse(src), lenient: false };
  } catch (err) {
    try {
      return { ok: true, value: JSON.parse(stripJsonComments(src)), lenient: true };
    } catch {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** JSON Lines: one value per non-empty line. */
export function parseJsonLines(text: string): JsonParse {
  const rows: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      return { ok: false, error: `Line ${i + 1}: ${(err as Error).message}` };
    }
  }
  return { ok: true, value: rows, lenient: false };
}

const AUTO_EXPAND_DEPTH = 2;
const MAX_CHILDREN_SHOWN = 1000;

function primitive(value: unknown): HTMLElement {
  if (value === null) return el("span", { class: "j-null" }, "null");
  switch (typeof value) {
    case "string": {
      const s = el("span", { class: "j-str" }, JSON.stringify(value));
      if (/^https?:\/\/\S+$/.test(value)) s.classList.add("j-url");
      return s;
    }
    case "number":
      return el("span", { class: "j-num" }, String(value));
    case "boolean":
      return el("span", { class: "j-bool" }, String(value));
    default:
      return el("span", {}, String(value));
  }
}

function keyLabel(key: string | number | null, inArray: boolean): HTMLElement | null {
  if (key === null) return null;
  return inArray
    ? el("span", { class: "j-idx" }, `${key}: `)
    : el("span", {}, el("span", { class: "j-key" }, JSON.stringify(key)), ": ");
}

function node(key: string | number | null, value: unknown, depth: number, inArray: boolean): HTMLElement {
  const isObj = value !== null && typeof value === "object";
  if (!isObj) {
    return el("div", { class: "j-row" }, keyLabel(key, inArray), primitive(value));
  }
  const isArr = Array.isArray(value);
  const entries: [string | number, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const [openB, closeB] = isArr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return el("div", { class: "j-row" }, keyLabel(key, inArray), el("span", { class: "j-brace" }, openB + closeB));
  }
  const summary = `${entries.length} ${isArr ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}`;
  const toggle = el("button", { class: "j-toggle", "aria-label": "Toggle" });
  const head = el(
    "div",
    { class: "j-row j-head" },
    toggle,
    keyLabel(key, inArray),
    el("span", { class: "j-brace" }, openB),
    el("span", { class: "j-summary" }, ` ${summary} `),
    el("span", { class: "j-brace j-close-inline" }, closeB),
  );
  const children = el("div", { class: "j-children" });
  const wrap = el("div", { class: "j-node" }, head, children, el("div", { class: "j-row j-close" }, el("span", { class: "j-brace" }, closeB)));
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const shown = entries.slice(0, MAX_CHILDREN_SHOWN);
    for (const [k, v] of shown) children.append(node(k, v, depth + 1, isArr));
    if (entries.length > shown.length) {
      children.append(el("div", { class: "j-row j-more" }, `… ${entries.length - shown.length} more not shown (see Raw)`));
    }
  };
  const setOpen = (open: boolean) => {
    if (open) build();
    wrap.classList.toggle("open", open);
  };
  head.addEventListener("click", () => setOpen(!wrap.classList.contains("open")));
  (wrap as unknown as { setOpen: (o: boolean) => void }).setOpen = setOpen;
  if (depth < AUTO_EXPAND_DEPTH) setOpen(true);
  return wrap;
}

function setAll(root: HTMLElement, open: boolean, budget = 20000) {
  // Breadth-first so "expand all" on a huge file opens the top levels first.
  let queue = [...root.querySelectorAll<HTMLElement>(":scope > .j-tree > .j-node")];
  while (queue.length && budget > 0) {
    const next: HTMLElement[] = [];
    for (const n of queue) {
      (n as unknown as { setOpen: (o: boolean) => void }).setOpen(open);
      budget--;
      if (open) next.push(...n.querySelectorAll<HTMLElement>(":scope > .j-children > .j-node"));
    }
    queue = next;
  }
  if (!open) root.querySelectorAll<HTMLElement>(".j-node.open").forEach((n) => n.classList.remove("open"));
}

export function renderJsonTree(value: unknown, note?: string): HTMLElement {
  const root = el("div", { class: "json-view" });
  const expand = el("button", {}, "Expand all");
  const collapse = el("button", {}, "Collapse all");
  expand.addEventListener("click", () => setAll(root, true));
  collapse.addEventListener("click", () => setAll(root, false));
  root.append(toolbar(expand, collapse, note ? el("span", { class: "muted" }, note) : ""));
  root.append(el("div", { class: "j-tree" }, node(null, value, 0, false)));
  return root;
}

export function parseErrorView(kind: string, error: string): HTMLElement {
  return el(
    "div",
    { class: "notice error" },
    el("strong", {}, `This isn't valid ${kind}.`),
    el("div", {}, error),
    el("div", { class: "muted" }, "Switch to Raw to see the file as-is."),
  );
}

export const jsonRenderer: Renderer = {
  id: "json",
  label: "JSON",
  extensions: ["json", "jsonc", "json5", "geojson", "webmanifest", "har"],
  filenames: [".babelrc", ".eslintrc", ".prettierrc", "composer.lock"],
  rawLanguage: "json",
  render(doc) {
    const r = parseJsonLenient(doc.text);
    if (!r.ok) return parseErrorView("JSON", r.error);
    return renderJsonTree(r.value, r.lenient ? "Parsed with comments / trailing commas ignored" : undefined);
  },
};

export const jsonLinesRenderer: Renderer = {
  id: "jsonl",
  label: "JSON Lines",
  extensions: ["jsonl", "ndjson"],
  rawLanguage: "json",
  render(doc) {
    const r = parseJsonLines(doc.text);
    if (!r.ok) return parseErrorView("JSON Lines", r.error);
    return renderJsonTree(r.value, `${(r.value as unknown[]).length} records`);
  },
};
