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

export const htmlRenderer: Renderer = {
  id: "html",
  label: "HTML",
  extensions: ["html", "htm", "xhtml"],
  rawLanguage: "xml",
  render(doc) {
    // An empty sandbox attribute: no scripts, no forms, no navigation, opaque origin.
    const frame = el("iframe", { sandbox: "", class: "html-preview", title: doc.name }) as HTMLIFrameElement;
    frame.srcdoc = doc.text;
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
