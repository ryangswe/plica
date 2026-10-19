import { escapeHtml } from "./dom";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC_RE = /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(OTHER_ESC_RE, "");
}

export function hasAnsi(s: string): boolean {
  return s.includes("\x1b[");
}

/** Convert ANSI SGR color codes to <span class="ansi-..."> and escape the rest. */
export function ansiToHtml(s: string): string {
  let out = "";
  let last = 0;
  let classes: string[] = [];
  let open = false;
  const text = s.replace(OTHER_ESC_RE, "");
  for (const m of text.matchAll(ANSI_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) classes = [];
      else if (c === 1) classes.push("ansi-bold");
      else if (c === 2) classes.push("ansi-dim");
      else if (c === 3) classes.push("ansi-italic");
      else if (c === 4) classes.push("ansi-underline");
      else if (c === 22) classes = classes.filter((x) => x !== "ansi-bold" && x !== "ansi-dim");
      else if (c === 39) classes = classes.filter((x) => !x.startsWith("ansi-fg"));
      else if (c === 49) classes = classes.filter((x) => !x.startsWith("ansi-bg"));
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        classes = classes.filter((x) => !x.startsWith("ansi-fg"));
        classes.push(`ansi-fg-${c >= 90 ? c - 90 + 8 : c - 30}`);
      } else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) {
        classes = classes.filter((x) => !x.startsWith("ansi-bg"));
        classes.push(`ansi-bg-${c >= 100 ? c - 100 + 8 : c - 40}`);
      } else if (c === 38 || c === 48) {
        // 256-color / truecolor: skip the extra params, keep default color.
        i += codes[i + 1] === 5 ? 2 : 4;
      }
    }
    if (open) out += "</span>";
    open = classes.length > 0;
    if (open) out += `<span class="${classes.join(" ")}">`;
  }
  out += escapeHtml(text.slice(last));
  if (open) out += "</span>";
  return out;
}
