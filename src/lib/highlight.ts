import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { escapeHtml } from "./dom";

hljs.registerLanguage("dockerfile", dockerfile);

/** Don't try to highlight anything bigger than this; it gets slow and isn't worth it. */
export const MAX_HIGHLIGHT_CHARS = 1_500_000;

const EXT_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", pyi: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp",
  cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", m: "objectivec", mm: "objectivec",
  php: "php", pl: "perl", lua: "lua", r: "r", sql: "sql", graphql: "graphql", gql: "graphql",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "plaintext",
  css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  plist: "xml", vue: "xml", json: "json", jsonc: "json", json5: "json", ipynb: "json",
  geojson: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  conf: "ini", env: "bash", md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff", mk: "makefile", dockerfile: "dockerfile", wasm: "wasm",
};

const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  ".env": "bash", ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash",
  ".gitignore": "bash", ".gitattributes": "bash", ".editorconfig": "ini",
  "cargo.lock": "ini", gemfile: "ruby", rakefile: "ruby", podfile: "ruby",
};

export function languageFor(name: string, ext: string): string | undefined {
  const lower = name.toLowerCase();
  if (NAME_LANG[lower]) return NAME_LANG[lower];
  if (lower.startsWith(".env")) return "bash";
  if (lower.startsWith("dockerfile")) return "dockerfile";
  return EXT_LANG[ext];
}

/** Highlight to an HTML string. Falls back to escaped text. */
export function highlight(code: string, lang?: string): string {
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(lang)) {
    return escapeHtml(code);
  }
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Split highlighted HTML into one string per source line, closing and
 * re-opening any <span>s that cross a line break, so each line is valid HTML.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1]);
      current += m[1];
    } else if (m[2]) {
      open.pop();
      current += m[2];
    } else if (m[3]) {
      current += "</span>".repeat(open.length);
      lines.push(current);
      current = open.join("");
    } else {
      current += m[4];
    }
  }
  lines.push(current);
  return lines;
}
