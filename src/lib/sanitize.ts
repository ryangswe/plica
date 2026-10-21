import DOMPurify from "dompurify";

/**
 * What to do with remote content (images, media) referenced by a file. `found` counts the remote
 * references seen, so the UI can offer to load them. Blocking is the default: opening a file must not
 * tell anyone you opened it (tracking pixels).
 */
export interface RemotePolicy {
  allow: boolean;
  found: number;
}

export const blockRemote = (): RemotePolicy => ({ allow: false, found: 0 });

/** http(s):// or protocol-relative //host URLs. Relative paths, data:, blob: and asset: are local. */
export function isRemoteUrl(url: string): boolean {
  return /^\s*(?:https?:)?\/\//i.test(url);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const LOADING_ATTRS = ["src", "poster", "background"];
/** SVG elements whose href loads something (an <a href> only navigates, on click). */
const SVG_LOADING = /^(image|use|feimage)$/i;

/**
 * Neutralize remote URLs on one element: move them to `data-remote-*` and mark the element, unless
 * remote content is allowed (then keep them, without a referrer).
 */
export function guardRemote(el: Element, policy: RemotePolicy): void {
  const attrs = [...LOADING_ATTRS];
  if (el.namespaceURI === SVG_NS && SVG_LOADING.test(el.localName)) attrs.push("href", "xlink:href");
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (!value || !isRemoteUrl(value)) continue;
    policy.found++;
    if (policy.allow) {
      el.setAttribute("referrerpolicy", "no-referrer");
      continue;
    }
    el.removeAttribute(attr);
    el.setAttribute(`data-remote-${attr.replace(":", "-")}`, value);
    el.classList.add("remote-blocked");
  }
}

let currentPolicy: RemotePolicy | null = null;
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (currentPolicy && node.nodeType === 1) guardRemote(node as Element, currentPolicy);
});

/**
 * Everything rendered from a file goes through here. Files are untrusted:
 * no scripts, no event handlers, no <style> that could restyle the app,
 * no forms, no iframes, and no remote images unless `remote.allow`.
 * Blocking happens here, on the inert parsed copy, because an <img> starts downloading as soon as
 * it's created.
 */
export function sanitize(html: string, remote: RemotePolicy = blockRemote()): string {
  currentPolicy = remote;
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "meta", "link"],
      FORBID_ATTR: ["style", "srcset", "ping"],
      ADD_ATTR: ["target"],
    });
  } finally {
    currentPolicy = null;
  }
}

/**
 * The same remote-content guard for trusted-structure HTML that isn't sanitized here (Mermaid's SVG,
 * which Mermaid already sanitizes). Parses into an inert document so nothing loads meanwhile.
 */
export function guardRemoteHtml(html: string, remote: RemotePolicy): string {
  // Fast path: no attribute that could load a remote URL.
  if (!/\b(?:src|href|poster|background)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const el of doc.body.querySelectorAll("*")) guardRemote(el, remote);
  return doc.body.innerHTML;
}
