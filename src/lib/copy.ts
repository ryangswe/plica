import { el } from "./dom";

const SVG = "http://www.w3.org/2000/svg";

/** A 16×16 outline icon from SVG path data (built with DOM calls, no innerHTML). */
function icon(...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
const copyIcon = () => icon("M5.5 4.5V3a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 13.5 3v7a1.5 1.5 0 0 1-1.5 1.5h-1.5", "M2.5 6A1.5 1.5 0 0 1 4 4.5h5A1.5 1.5 0 0 1 10.5 6v7A1.5 1.5 0 0 1 9 14.5H4A1.5 1.5 0 0 1 2.5 13z");
const checkIcon = () => icon("M3 8.5l3 3 7-7");

/**
 * Give every code block matched by `selector` a copy button (shown on hover or keyboard focus), like
 * GitHub. It copies the code exactly as written, without line numbers or the button itself.
 */
export function addCopyButtons(root: HTMLElement, selector: string): void {
  for (const pre of root.querySelectorAll<HTMLElement>(selector)) {
    const btn = el("button", { type: "button", class: "copy-code", title: "Copy", "aria-label": "Copy code" });
    btn.append(copyIcon());
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const text = (pre.textContent ?? "").replace(/\n$/, "");
      try {
        await navigator.clipboard.writeText(text);
        btn.replaceChildren(checkIcon());
        btn.classList.add("copied");
        btn.setAttribute("aria-label", "Copied");
      } catch {
        btn.setAttribute("aria-label", "Couldn't copy");
      }
      window.setTimeout(() => {
        btn.replaceChildren(copyIcon());
        btn.classList.remove("copied");
        btn.setAttribute("aria-label", "Copy code");
      }, 1500);
    });
    const wrap = el("div", { class: "code-block" });
    pre.replaceWith(wrap);
    wrap.append(pre, btn);
  }
}
