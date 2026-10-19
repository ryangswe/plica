import { el } from "../lib/dom";
import type { Renderer } from "../types";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  adds: number;
  dels: number;
  binary: boolean;
}

const strip = (p: string) => p.replace(/^[ab]\//, "").replace(/\t.*$/, "");

/** Parse a unified diff (git diff / diff -u / .patch). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const newFile = (oldPath = "", newPath = ""): DiffFile => {
    const f: DiffFile = { oldPath, newPath, hunks: [], adds: 0, dels: 0, binary: false };
    files.push(f);
    hunk = null;
    return f;
  };
  for (const line of text.split(/\r?\n/)) {
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (git) {
      file = newFile(git[1], git[2]);
      continue;
    }
    if (line.startsWith("--- ") && (!hunk || (hunk as DiffHunk).lines.length === 0 || !file)) {
      if (!file || file.hunks.length > 0) file = newFile();
      file.oldPath = strip(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ") && file && !hunk) {
      file.newPath = strip(line.slice(4));
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      file ??= newFile();
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (file && /^Binary files .* differ$/.test(line)) {
      file.binary = true;
      continue;
    }
    if (!hunk || !file) continue;
    const cur = hunk as DiffHunk;
    if (line.startsWith("+")) {
      cur.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      file.adds++;
    } else if (line.startsWith("-")) {
      cur.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      file.dels++;
    } else if (line.startsWith(" ") || line === "") {
      cur.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith("\\")) {
      cur.lines.push({ kind: "meta", text: line });
    } else {
      hunk = null; // something else (next file's header lines, mail footer...)
    }
  }
  // Drop trailing empty context lines produced by the final newline.
  for (const f of files)
    for (const hk of f.hunks)
      while (hk.lines.length && hk.lines[hk.lines.length - 1].kind === "ctx" && hk.lines[hk.lines.length - 1].text === "")
        hk.lines.pop();
  return files.filter((f) => f.hunks.length || f.binary);
}

export const diffRenderer: Renderer = {
  id: "diff",
  label: "Diff",
  extensions: ["diff", "patch", "rej"],
  rawLanguage: "diff",
  render(doc) {
    const files = parseUnifiedDiff(doc.text);
    if (files.length === 0) {
      return el("div", { class: "notice" }, "No unified diff found in this file. Use Raw to see it.");
    }
    const root = el("div", { class: "diff-view" });
    const totalAdds = files.reduce((n, f) => n + f.adds, 0);
    const totalDels = files.reduce((n, f) => n + f.dels, 0);
    root.append(
      el(
        "div",
        { class: "toolbar" },
        el("span", {}, `${files.length} file${files.length === 1 ? "" : "s"} changed`),
        el("span", { class: "diff-adds" }, `+${totalAdds}`),
        el("span", { class: "diff-dels" }, `−${totalDels}`),
      ),
    );
    for (const f of files) {
      const name = f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath;
      const renamed = f.oldPath && f.newPath && f.oldPath !== f.newPath && f.oldPath !== "/dev/null" && f.newPath !== "/dev/null";
      const head = el(
        "summary",
        { class: "diff-file-head" },
        el("span", { class: "diff-name" }, renamed ? `${f.oldPath} → ${f.newPath}` : name),
        el("span", { class: "diff-adds" }, `+${f.adds}`),
        el("span", { class: "diff-dels" }, `−${f.dels}`),
      );
      const table = el("table", { class: "diff-table" });
      if (f.binary) table.append(el("tr", {}, el("td", { class: "diff-meta", colspan: "3" }, "Binary file changed")));
      for (const hk of f.hunks) {
        table.append(el("tr", { class: "diff-hunk" }, el("td", { colspan: "3" }, hk.header)));
        for (const l of hk.lines) {
          table.append(
            el(
              "tr",
              { class: `diff-${l.kind}` },
              el("td", { class: "diff-no" }, l.oldNo != null ? String(l.oldNo) : ""),
              el("td", { class: "diff-no" }, l.newNo != null ? String(l.newNo) : ""),
              el("td", { class: "diff-code" }, (l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "ctx" ? " " : "") + l.text),
            ),
          );
        }
      }
      root.append(el("details", { class: "diff-file", open: "" }, head, el("div", { class: "diff-scroll" }, table)));
    }
    return root;
  },
};
