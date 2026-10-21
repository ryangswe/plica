/** Directory part of a path (works with / and \ separators). */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : "";
}

export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

/** True for things like https:, mailto:, data: — anything that is not a local relative path. */
export function hasScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href);
}

/**
 * Resolve `rel` against the directory of `fromFile`. Strips ?query and #hash.
 * Keeps the separator style of the base path.
 */
export function resolveRelative(fromFile: string, rel: string): string {
  let clean = rel.split("#")[0].split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* keep as-is */
  }
  if (isAbsolute(clean)) return clean;
  const base = dirname(fromFile);
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const parts = base.split(/[\\/]/);
  for (const seg of clean.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join(sep);
}

/** Split "other.md#Set%20up" into the path part and the decoded fragment ("Set up"), if any. */
export function splitFragment(href: string): { path: string; fragment: string | null } {
  const i = href.indexOf("#");
  if (i < 0) return { path: href, fragment: null };
  let fragment = href.slice(i + 1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    /* keep as-is */
  }
  return { path: href.slice(0, i), fragment: fragment || null };
}
