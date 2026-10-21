import { el } from "../lib/dom";
import type { Renderer } from "../types";

export const svgRenderer: Renderer = {
  id: "svg",
  label: "SVG",
  extensions: ["svg"],
  rawLanguage: "xml",
  render(doc) {
    // Rendering via <img> means scripts inside the SVG never run.
    const url = URL.createObjectURL(new Blob([doc.text], { type: "image/svg+xml" }));
    return el("div", { class: "center-stage checker" }, el("img", { src: url, alt: doc.name, class: "svg-preview" }));
  },
};

/** Rough count of remote resources an HTML page would load (attributes and CSS url()). */
export function countRemoteRefs(html: string): number {
  const re = /\b(?:src|srcset|poster|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//gi;
  return html.match(re)?.length ?? 0;
}

export const htmlRenderer: Renderer = {
  id: "html",
  label: "HTML",
  extensions: ["html", "htm", "xhtml"],
  rawLanguage: "xml",
  render(doc, ctx) {
    // An empty sandbox attribute: no scripts, no forms, no navigation, opaque origin. A CSP at the top of
    // the page decides whether remote images and media may load (the page itself isn't sanitized).
    const frame = el("iframe", { sandbox: "", class: "html-preview", title: doc.name }) as HTMLIFrameElement;
    ctx.remote.found += countRemoteRefs(doc.text);
    const remote = ctx.remote.allow ? " https: http:" : "";
    const csp = `default-src 'none'; img-src data: blob:${remote}; media-src data: blob:${remote}; style-src 'unsafe-inline'; font-src data:`;
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${doc.text}`;
    return el("div", { class: "html-stage" }, frame);
  },
};

/** Fallback for any other text file: highlighted source only. */
export const codeRenderer: Renderer = {
  id: "code",
  label: "Text",
  extensions: [],
  rawOnly: true,
};
