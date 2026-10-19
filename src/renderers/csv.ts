import Papa from "papaparse";
import { el, toolbar } from "../lib/dom";
import type { Renderer } from "../types";

const PAGE = 1000;

export function parseDelimited(text: string, delimiter: string): string[][] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
    delimiter,
    skipEmptyLines: "greedy",
  });
  return res.data;
}

function compare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function makeTableRenderer(id: string, label: string, extensions: string[], delimiter: string): Renderer {
  return {
    id,
    label,
    extensions,
    rawLanguage: "plaintext",
    render(doc, ctx) {
      const rows = parseDelimited(doc.text, delimiter);
      if (rows.length === 0) return el("div", { class: "notice" }, "This file is empty.");
      const header = rows[0];
      const body = rows.slice(1);
      const width = Math.max(...rows.slice(0, 500).map((r) => r.length));

      const state = ctx.state as { filter?: string; sortCol?: number; sortDir?: 1 | -1 };
      const root = el("div", { class: "table-view" });
      const filter = el("input", { type: "search", placeholder: "Filter rows…", "aria-label": "Filter rows" });
      filter.value = state.filter ?? "";
      const count = el("span", { class: "muted" });
      root.append(toolbar(filter, count));

      const table = el("table", { class: "data-table" });
      const thead = el("thead");
      const tbody = el("tbody");
      table.append(thead, tbody);
      root.append(el("div", { class: "table-scroll" }, table));

      const headRow = el("tr", {}, el("th", { class: "rownum" }, "#"));
      for (let c = 0; c < width; c++) {
        const th = el("th", { "data-col": String(c), title: "Click to sort" }, header[c] ?? "");
        th.addEventListener("click", () => {
          if (state.sortCol === c) state.sortDir = state.sortDir === 1 ? -1 : 1;
          else {
            state.sortCol = c;
            state.sortDir = 1;
          }
          update();
        });
        headRow.append(th);
      }
      thead.append(headRow);

      let limit = PAGE;
      const more = el("button", { class: "more" }, "");
      more.addEventListener("click", () => {
        limit += PAGE * 5;
        update();
      });
      root.append(more);

      function update() {
        const q = filter.value.trim().toLowerCase();
        state.filter = filter.value;
        let view = body.map((r, i) => ({ r, i }));
        if (q) view = view.filter(({ r }) => r.some((cell) => cell.toLowerCase().includes(q)));
        if (state.sortCol != null) {
          const c = state.sortCol;
          const d = state.sortDir ?? 1;
          view.sort((a, b) => compare(a.r[c] ?? "", b.r[c] ?? "") * d);
        }
        for (const th of thead.querySelectorAll<HTMLElement>("th[data-col]")) {
          th.classList.toggle("sorted-asc", Number(th.dataset.col) === state.sortCol && state.sortDir === 1);
          th.classList.toggle("sorted-desc", Number(th.dataset.col) === state.sortCol && state.sortDir === -1);
        }
        const frag = document.createDocumentFragment();
        for (const { r, i } of view.slice(0, limit)) {
          const tr = el("tr", {}, el("td", { class: "rownum" }, String(i + 1)));
          for (let c = 0; c < width; c++) tr.append(el("td", {}, r[c] ?? ""));
          frag.append(tr);
        }
        tbody.replaceChildren(frag);
        count.textContent = q
          ? `${view.length.toLocaleString()} of ${body.length.toLocaleString()} rows`
          : `${body.length.toLocaleString()} rows × ${width} columns`;
        more.hidden = view.length <= limit;
        more.textContent = `Show more (${(view.length - limit).toLocaleString()} hidden)`;
      }
      filter.addEventListener("input", () => {
        limit = PAGE;
        update();
      });
      update();
      return root;
    },
  };
}

export const csvRenderer = makeTableRenderer("csv", "CSV", ["csv"], "");
export const tsvRenderer = makeTableRenderer("tsv", "TSV", ["tsv", "tab"], "\t");
