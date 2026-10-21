import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { markdownToHtml, splitFrontmatter, markdownRenderer } from "../../src/renderers/markdown";
import { parseJsonLenient, parseJsonLines, jsonRenderer } from "../../src/renderers/json";
import { parseDelimited, csvRenderer } from "../../src/renderers/csv";
import { parseUnifiedDiff } from "../../src/renderers/diff";
import { detectLevel, logRenderer } from "../../src/renderers/log";
import { notebookRenderer } from "../../src/renderers/notebook";
import { ansiToHtml, stripAnsi } from "../../src/lib/ansi";
import { splitHighlightedLines, highlight, languageFor } from "../../src/lib/highlight";
import { resolveRelative, hasScheme, splitFragment } from "../../src/lib/paths";
import { readWithRetry, staleMessage } from "../../src/lib/reload";
import { pickRenderer } from "../../src/renderers";
import { renderRaw } from "../../src/renderers/raw";
import type { FileDoc, RenderContext } from "../../src/types";

const fixture = (name: string) => readFileSync(`${process.cwd()}/tests/fixtures/${name}`, "utf8");
const doc = (name: string, text = fixture(name)): FileDoc => ({ path: `/tmp/fx/${name}`, name, text, size: text.length, binary: false, truncated: false, encoding: "UTF-8" });
const ctx = (): RenderContext => ({ resolveAsset: (r) => `asset://${r}`, state: {}, reloaded: false, dark: false });

describe("markdown", () => {
  it("renders GFM features with heading ids", () => {
    const html = markdownToHtml("# Hello World\n\n## Hello World\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('id="hello-world-1"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
  });

  it("highlights fenced code and keeps mermaid fences for later rendering", () => {
    const html = markdownToHtml("```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain("A--&gt;B");
  });

  it("strips scripts, event handlers, javascript: urls, iframes and styles", () => {
    const html = markdownToHtml(fixture("xss.md"));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/style=/i);
    expect(html).toContain("Safe text after.");
  });

  it("splits YAML front matter", () => {
    const { frontmatter, body } = splitFrontmatter("---\ntitle: x\n---\n# Body\n");
    expect(frontmatter).toBe("title: x");
    expect(body).toBe("# Body\n");
    expect(splitFrontmatter("# No fm").frontmatter).toBeNull();
  });

  it("renders the sample: alerts, toc, front matter, resolved images", async () => {
    const out = await markdownRenderer.render!(doc("sample.md"), ctx());
    expect(out.querySelector(".alert-note .alert-title")?.textContent).toBe("Note");
    expect(out.querySelector(".alert-warning")).not.toBeNull();
    expect(out.querySelector(".toc")).not.toBeNull();
    expect(out.querySelector("details.frontmatter")).not.toBeNull();
    expect(out.querySelector("img")?.getAttribute("src")).toBe("asset://icon.svg");
    expect(out.querySelector("blockquote.alert")?.textContent).not.toContain("[!NOTE]");
  });
});

describe("json", () => {
  it("parses strict JSON", () => {
    const r = parseJsonLenient('{"a":1}');
    expect(r.ok && r.value).toEqual({ a: 1 });
  });
  it("falls back to JSONC (comments + trailing commas) without touching strings", () => {
    const r = parseJsonLenient('{ // c\n "url": "http://x//y", /* b */ "a": [1,2,], }');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lenient).toBe(true);
      expect(r.value).toEqual({ url: "http://x//y", a: [1, 2] });
    }
  });
  it("never edits commas or comment markers inside strings (JSONC)", () => {
    const r = parseJsonLenient('{"label":",}", "list":"a,]", "path":"/*not a comment*/",}');
    expect(r.ok && r.value).toEqual({ label: ",}", list: "a,]", path: "/*not a comment*/" });
  });
  it("shows numbers JavaScript can't hold exactly as written", () => {
    const r = parseJsonLenient('{"id":9007199254740993,"small":42,"pi":3.14159265358979323846,"huge":1e400,"s":"9007199254740993"}');
    expect(r.ok).toBe(true);
    const v = (r.ok ? r.value : {}) as Record<string, unknown>;
    expect(String(v.id)).toBe("9007199254740993");
    expect(v.small).toBe(42);
    expect(String(v.pi)).toBe("3.14159265358979323846");
    expect(String(v.huge)).toBe("1e400");
    expect(v.s).toBe("9007199254740993");
    const lines = parseJsonLines('{"id":9007199254740993}\n{"id":1}');
    expect(lines.ok && String((lines.value as { id: unknown }[])[0].id)).toBe("9007199254740993");
    // Also in JSONC files.
    const jsonc = parseJsonLenient('{"id":9007199254740993, // c\n}');
    expect(jsonc.ok && String((jsonc.value as { id: unknown }).id)).toBe("9007199254740993");
  });
  it("renders exact numbers in the tree", () => {
    const out = jsonRenderer.render!(doc("big.json", '{"id":9007199254740993}'), ctx()) as HTMLElement;
    expect(out.querySelector(".j-num")?.textContent).toBe("9007199254740993");
  });
  it("keeps a __proto__ key as data", () => {
    const r = parseJsonLenient('{"__proto__":{"x":1},"n":12345678901234567}');
    const v = (r.ok ? r.value : {}) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__", "n"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("reports errors", () => {
    expect(parseJsonLenient("{nope").ok).toBe(false);
    expect(parseJsonLenient('{"a":1 "b":2}').ok).toBe(false);
    expect(parseJsonLenient('{"a":12345678901234567,}x').ok).toBe(false);
  });
  it("parses JSON lines, skipping blanks and reporting the bad line", () => {
    const r = parseJsonLines(fixture("events.jsonl"));
    expect(r.ok && (r.value as unknown[]).length).toBe(3);
    const bad = parseJsonLines('{"a":1}\n{oops');
    expect(!bad.ok && bad.error).toMatch(/^Line 2/);
  });
  it("renders a tree that auto-expands the top levels", () => {
    const out = jsonRenderer.render!(doc("package.json"), ctx()) as HTMLElement;
    expect(out.querySelector(".j-key")?.textContent).toBe('"name"');
    expect(out.querySelectorAll(".j-node.open").length).toBeGreaterThan(1);
    expect(out.textContent).not.toContain("deep"); // depth-5 value not built yet (lazy)
  });
});

describe("csv", () => {
  it("handles quoted fields", () => {
    const { rows, problems } = parseDelimited(fixture("data.csv"), "");
    expect(rows[3][1]).toBe("pandas, the library");
    expect(rows.length).toBe(7);
    expect(problems).toEqual([]);
  });
  it("never drops fields that appear late in the file, and says so", () => {
    const lines = ["a,b,c", ...Array.from({ length: 600 }, (_, i) => (i === 549 ? "1,2,3,EXTRA" : "1,2,3"))];
    const out = csvRenderer.render!(doc("wide.csv", lines.join("\n")), ctx()) as HTMLElement;
    expect(out.querySelectorAll("th[data-col]").length).toBe(4);
    expect(out.querySelector("th.extra-col")?.textContent).toBe("Column 4");
    expect(out.querySelector(".notice")?.textContent).toMatch(/1 row has a different number of fields than the header \(row 550\)/);
  });
  it("reports malformed quoting", () => {
    const { problems } = parseDelimited('a,b\n"unclosed,2\n3,4\n', "");
    expect(problems.join(" ")).toMatch(/quote/i);
  });
  it("treats a one-column file as fine", () => {
    expect(parseDelimited("name\nada\ngrace\n", "").problems).toEqual([]);
  });
  it("renders a sortable table with numeric sort", () => {
    const c = ctx();
    const out = csvRenderer.render!(doc("data.csv"), c) as HTMLElement;
    expect(out.querySelectorAll("tbody tr").length).toBe(6);
    (out.querySelectorAll("th[data-col]")[0] as HTMLElement).click();
    const firstIds = [...out.querySelectorAll("tbody tr")].map((tr) => tr.children[1].textContent);
    expect(firstIds).toEqual(["1", "2", "3", "4", "5", "10"]); // numeric, not "1, 10, 2"
  });
});

describe("diff", () => {
  it("parses multi-file git diffs with line numbers", () => {
    const files = parseUnifiedDiff(fixture("change.diff"));
    expect(files.map((f) => f.newPath)).toEqual(["src/greet.py", "README.md"]);
    expect(files[0].adds).toBe(2);
    expect(files[0].dels).toBe(1);
    const firstAdd = files[0].hunks[0].lines.find((l) => l.kind === "add")!;
    expect(firstAdd.newNo).toBe(2);
    expect(files[1].hunks[0].lines[0].oldNo).toBe(10);
  });
  it("parses plain diff -u output", () => {
    const files = parseUnifiedDiff("--- a.txt\t2026-01-01\n+++ b.txt\t2026-01-02\n@@ -1 +1 @@\n-x\n+y\n");
    expect(files.length).toBe(1);
    expect(files[0].oldPath).toBe("a.txt");
    expect(files[0].newPath).toBe("b.txt");
  });
});

describe("logs", () => {
  it("detects levels", () => {
    expect(detectLevel("2026 ERROR boom")).toBe("error");
    expect(detectLevel("[warn] slow")).toBe("warn");
    expect(detectLevel("INFO ok")).toBe("info");
    expect(detectLevel("debug: x")).toBe("debug");
    expect(detectLevel("plain")).toBe("none");
    expect(detectLevel("terrorist")).toBe("none");
  });
  it("gives stack trace lines the level of their entry and colors ANSI", () => {
    const out = logRenderer.render!(doc("app.log"), ctx()) as HTMLElement;
    const rows = out.querySelectorAll(".ln");
    expect(rows[5].className).toContain("lv-error"); // "    at com.example..."
    expect(out.querySelector(".ansi-fg-2")).not.toBeNull();
    expect(out.querySelector(".chip-error")?.textContent).toMatch(/error 4/);
  });
});

describe("notebook", () => {
  it("renders markdown, code, html tables, images and errors", async () => {
    const out = await notebookRenderer.render!(doc("notebook.ipynb"), ctx());
    expect(out.querySelector(".nb-md h1")?.textContent).toContain("Notebook demo");
    expect(out.querySelectorAll(".nb-codecell").length).toBe(3);
    expect(out.querySelector(".nb-html table")).not.toBeNull();
    expect(out.querySelector("img.nb-image")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(out.querySelector(".nb-error")?.textContent).toContain("ZeroDivisionError");
    expect(out.querySelector(".nb-prompt")?.textContent).toBe("");
  });
});

describe("helpers", () => {
  it("ansi", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(ansiToHtml("\x1b[1;31m<b>\x1b[0m")).toBe('<span class="ansi-bold ansi-fg-1">&lt;b&gt;</span>');
  });
  it("splits highlighted html into balanced lines", () => {
    const html = highlight('/* a\nb */\nconst x = "y";', "javascript");
    const lines = splitHighlightedLines(html);
    expect(lines.length).toBe(3);
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
  });
  it("raw view has one row per line", () => {
    const out = renderRaw("a\nb\nc\n", "plaintext");
    expect(out.querySelectorAll(".ln").length).toBe(3);
    expect(out.querySelector(".ln:last-child")?.getAttribute("data-n")).toBe("3");
  });
  it("resolves relative paths (posix and windows)", () => {
    expect(resolveRelative("/a/b/c.md", "../img/x.png")).toBe("/a/img/x.png");
    expect(resolveRelative("/a/b/c.md", "./d%20e.md#top")).toBe("/a/b/d e.md");
    expect(resolveRelative("C:\\docs\\notes\\a.md", "img\\x.png")).toBe("C:\\docs\\notes\\img\\x.png");
    expect(resolveRelative("C:\\docs\\a.md", "../b.md")).toBe("C:\\b.md");
  });
  it("scheme detection does not mistake windows drive letters", () => {
    expect(hasScheme("https://x")).toBe(true);
    expect(hasScheme("C:\\x")).toBe(false);
    expect(hasScheme("docs/a.md")).toBe(false);
  });
  it("picks renderers by extension and file name", () => {
    expect(pickRenderer({ name: "README.MD" }).id).toBe("markdown");
    expect(pickRenderer({ name: "x.ipynb" }).id).toBe("notebook");
    expect(pickRenderer({ name: "Dockerfile" }).id).toBe("code");
    expect(pickRenderer({ name: "weird.xyz" }).id).toBe("code");
    expect(languageFor("Dockerfile", "")).toBe("dockerfile");
    expect(languageFor(".env.local", "local")).toBe("bash");
  });
});

describe("link fragments", () => {
  it("keeps the section of a link to another file", () => {
    expect(splitFragment("other.md#section")).toEqual({ path: "other.md", fragment: "section" });
    expect(splitFragment("docs/a%20b.md#Set%20up")).toEqual({ path: "docs/a%20b.md", fragment: "Set up" });
    expect(splitFragment("other.md")).toEqual({ path: "other.md", fragment: null });
    expect(splitFragment("other.md#")).toEqual({ path: "other.md", fragment: null });
    expect(resolveRelative("/docs/a.md", "other.md#section")).toBe("/docs/other.md");
  });
});

describe("reload", () => {
  const noSleep = async () => {};
  it("retries while an editor is mid-save, then succeeds", async () => {
    let calls = 0;
    const r = await readWithRetry(async () => {
      if (++calls < 3) throw new Error("No such file or directory (os error 2)");
      return "fresh";
    }, [0, 300, 1000], noSleep);
    expect(r).toEqual({ ok: true, value: "fresh" });
  });
  it("reports a file that stays gone, in plain words", async () => {
    const r = await readWithRetry(async () => { throw new Error("/x/a.md: No such file or directory (os error 2)"); }, [0, 1], noSleep);
    expect(r.ok).toBe(false);
    expect(staleMessage(r.ok ? "" : r.error)).toMatch(/^This file was moved or deleted\. You're seeing the last version/);
    expect(staleMessage("Permission denied (os error 13)")).toMatch(/isn't allowed/);
    expect(staleMessage("weird")).toMatch(/can't read this file right now/);
  });
});
