import { el, toolbar } from "../lib/dom";
import type { Renderer } from "../types";

/** A number shown exactly as written because a JS number would change it (big integers, long decimals). */
export class ExactNumber {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

/**
 * 16+ digits or a 3-digit exponent: JSON.parse might round it (9007199254740993 → …992) or overflow it.
 * False positives (e.g. digits inside a string) only cost a slower, still exact, parse.
 */
const MAYBE_INEXACT = /(?:\d\.?){16,}|[eE][+-]?\d{3,}/;

/**
 * A small exact JSON parser, used when JSON.parse would lose information: numbers that don't fit a JS
 * number become `ExactNumber`s, and in `lenient` mode `//` and `/* *\/` comments and trailing commas
 * (outside strings) are allowed, as in tsconfig.json.
 */
export function parseJsonExact(src: string, lenient: boolean): unknown {
  let i = 0;
  const fail = (what: string): never => {
    const before = src.slice(0, i);
    const line = before.split("\n").length;
    const col = i - before.lastIndexOf("\n");
    throw new SyntaxError(`${what} at line ${line}, column ${col}`);
  };
  const skip = () => {
    for (;;) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (lenient && c === "/" && src[i + 1] === "/") while (i < src.length && src[i] !== "\n") i++;
      else if (lenient && c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) fail("Unclosed comment");
        i = end + 2;
      } else return;
    }
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (): unknown => {
    skip();
    const c = src[i];
    if (c === "{" || c === "[") {
      const isArr = c === "[";
      const close = isArr ? "]" : "}";
      const out: unknown[] | Record<string, unknown> = isArr ? [] : {};
      i++;
      skip();
      if (src[i] === close) {
        i++;
        return out;
      }
      for (;;) {
        if (isArr) (out as unknown[]).push(value());
        else {
          skip();
          if (src[i] !== '"') fail("Expected a property name");
          const key = string();
          skip();
          if (src[i] !== ":") fail("Expected ':'");
          i++;
          // defineProperty, so a "__proto__" key is data, as with JSON.parse.
          Object.defineProperty(out, key, { value: value(), enumerable: true, writable: true, configurable: true });
        }
        skip();
        if (src[i] === ",") {
          i++;
          skip();
          if (lenient && src[i] === close) {
            i++;
            return out;
          }
        } else if (src[i] === close) {
          i++;
          return out;
        } else fail(`Expected ',' or '${close}'`);
      }
    }
    if (c === '"') return string();
    if (src.startsWith("true", i)) return (i += 4), true;
    if (src.startsWith("false", i)) return (i += 5), false;
    if (src.startsWith("null", i)) return (i += 4), null;
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(src);
    if (!m) return fail(i >= src.length ? "Unexpected end of input" : `Unexpected '${c}'`);
    i += m[0].length;
    return MAYBE_INEXACT.test(m[0]) ? new ExactNumber(m[0]) : Number(m[0]);
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    if (i >= src.length) fail("Unterminated string");
    i++;
    return JSON.parse(src.slice(start, i)) as string; // handles every escape exactly like JSON.parse
  };
  const result = value();
  skip();
  if (i < src.length) fail(`Unexpected '${src[i]}'`);
  return result;
}

export type JsonParse = { ok: true; value: unknown; lenient: boolean } | { ok: false; error: string };

/** Parse JSON (or JSONC as a fallback) without changing any value. */
export function parseJsonLenient(text: string): JsonParse {
  const src = text.replace(/^\ufeff/, "");
  try {
    const value = JSON.parse(src);
    return { ok: true, value: MAYBE_INEXACT.test(src) ? parseJsonExact(src, false) : value, lenient: false };
  } catch (err) {
    try {
      return { ok: true, value: parseJsonExact(src, true), lenient: true };
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
      rows.push(MAYBE_INEXACT.test(line) ? parseJsonExact(line, false) : JSON.parse(line));
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
  if (value instanceof ExactNumber) return el("span", { class: "j-num", title: "Shown exactly as written" }, value.text);
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

/** A value as JSON text for the clipboard: exact numbers as written; a bare string without quotes. */
export function jsonText(value: unknown, top = true): string {
  if (top && typeof value === "string") return value;
  const walk = (v: unknown, indent: string): string => {
    if (v instanceof ExactNumber) return v.text;
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    const inner = indent + "  ";
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + walk(x, inner)).join(",\n")}\n${indent}]` : "[]";
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${walk(x, inner)}`).join(",\n")}\n${indent}}` : "{}";
  };
  return walk(value, "");
}

/** Small "Copy" button for a row (shown on hover/focus), copying that value. */
function copyButton(value: unknown): HTMLElement {
  const b = el("button", { class: "j-copy", type: "button", title: "Copy this value as JSON" }, "Copy");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(jsonText(value));
      b.textContent = "Copied";
    } catch {
      b.textContent = "Couldn't copy";
    }
    window.setTimeout(() => (b.textContent = "Copy"), 1200);
  };
  b.addEventListener("click", (e) => {
    e.stopPropagation(); // don't toggle the node
    void copy();
  });
  return b;
}

function keyLabel(key: string | number | null, inArray: boolean): HTMLElement | null {
  if (key === null) return null;
  return inArray
    ? el("span", { class: "j-idx" }, `${key}: `)
    : el("span", {}, el("span", { class: "j-key" }, JSON.stringify(key)), ": ");
}

function node(key: string | number | null, value: unknown, depth: number, inArray: boolean): HTMLElement {
  const isObj = value !== null && typeof value === "object" && !(value instanceof ExactNumber);
  if (!isObj) {
    return el("div", { class: "j-row" }, keyLabel(key, inArray), primitive(value), copyButton(value));
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
  const toggle = el("button", { class: "j-toggle", "aria-label": key === null ? "Root" : String(key), "aria-expanded": "false" });
  const head = el(
    "div",
    { class: "j-row j-head" },
    toggle,
    keyLabel(key, inArray),
    el("span", { class: "j-brace" }, openB),
    el("span", { class: "j-summary" }, ` ${summary} `),
    el("span", { class: "j-brace j-close-inline" }, closeB),
    copyButton(value),
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
    toggle.setAttribute("aria-expanded", String(open));
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
