import "./styles.css";
import type { FileDoc, RenderContext, Renderer } from "./types";
import { createBrowserHost, createTauriHost, isTauri, type Host } from "./host";
import { pickRenderer, rawLanguageFor, renderers } from "./renderers";
import { renderRaw } from "./renderers/raw";
import { el, formatBytes } from "./lib/dom";
import { hasScheme, resolveRelative } from "./lib/paths";
import { createFindBar } from "./find";

type Mode = "rendered" | "raw";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

// ---- DOM ------------------------------------------------------------------

const app = document.getElementById("app")!;
const backBtn = el("button", { class: "icon-btn", id: "back", title: "Back (Alt+←)", "aria-label": "Back", hidden: "" }, "←");
const nameEl = el("span", { class: "file-name" }, "Plica");
const metaEl = el("span", { class: "file-meta" });
const previewBtn = el("button", { "data-mode": "rendered", role: "tab" }, "Preview");
const rawBtn = el("button", { "data-mode": "raw", role: "tab" }, "Raw");
const modeSwitch = el("div", { class: "mode-switch", role: "tablist", title: `Toggle Preview / Raw (${MOD}/)`, hidden: "" }, previewBtn, rawBtn);
const copyBtn = el("button", { class: "ghost", title: "Copy the file's text", hidden: "" }, "Copy");
const openBtn = el("button", { class: "ghost", title: `Open a file (${MOD}O)` }, "Open…");
const bar = el(
  "header",
  { class: "topbar" },
  backBtn,
  el("div", { class: "file-title" }, nameEl, metaEl),
  el("div", { class: "spacer" }),
  modeSwitch,
  copyBtn,
  openBtn,
);
const view = el("main", { class: "view-scroll", tabindex: "-1" });
const toast = el("div", { class: "toast", role: "status", "aria-live": "polite" });
const dropOverlay = el("div", { class: "drop-overlay", hidden: "" }, el("div", {}, "Drop to open"));
const find = createFindBar(() => view.querySelector<HTMLElement>(".view-content"));
app.append(bar, find.bar, view, toast, dropOverlay);

// ---- State ----------------------------------------------------------------

let host: Host;
let doc: FileDoc | null = null;
let renderer: Renderer | null = null;
let mode: Mode = "rendered";
let fileState: Record<string, unknown> = {};
const history: string[] = [];
let renderToken = 0;
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function showToast(msg: string, ms = 1600) {
  toast.textContent = msg;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), ms);
}

function emptyState(): HTMLElement {
  const types = renderers.map((r) => r.label).join(" · ");
  const openLink = el("button", { class: "primary" }, "Open a file");
  openLink.addEventListener("click", () => void pick());
  return el(
    "div",
    { class: "empty" },
    el("div", { class: "empty-mark", "aria-hidden": "true" }, "❯_"),
    el("h1", {}, "Plica"),
    el("p", {}, "Drop a file here, or"),
    openLink,
    el("p", { class: "muted small" }, types, " · and any text or code file"),
    el(
      "div",
      { class: "shortcuts muted small" },
      el("span", {}, el("kbd", {}, `${MOD}/`), " Preview ↔ Raw"),
      el("span", {}, el("kbd", {}, `${MOD}F`), " Find"),
      el("span", {}, el("kbd", {}, `${MOD}O`), " Open"),
    ),
  );
}

// ---- Rendering --------------------------------------------------------------

async function render(opts: { reloaded?: boolean; keepScroll?: boolean } = {}) {
  const token = ++renderToken;
  if (!doc || !renderer) {
    view.replaceChildren(emptyState());
    modeSwitch.hidden = copyBtn.hidden = true;
    return;
  }
  const scrollRatio = opts.keepScroll && view.scrollHeight > view.clientHeight ? view.scrollTop / (view.scrollHeight - view.clientHeight) : 0;
  const effective: Mode = renderer.rawOnly || !renderer.render ? "raw" : mode;
  modeSwitch.hidden = !!renderer.rawOnly || doc.binary;
  copyBtn.hidden = doc.binary;
  previewBtn.setAttribute("aria-selected", String(effective === "rendered"));
  rawBtn.setAttribute("aria-selected", String(effective === "raw"));

  const content = el("div", { class: `view-content type-${renderer.id} mode-${effective}` });
  if (doc.truncated) content.append(el("div", { class: "notice" }, "This file is very large; only the first part is shown."));

  if (doc.binary) {
    content.append(el("div", { class: "notice" }, el("strong", {}, "This looks like a binary file."), el("div", {}, "Plica shows text files only.")));
  } else if (effective === "raw") {
    content.append(renderRaw(doc.text, rawLanguageFor(doc, renderer), { wrap: renderer.id === "markdown" || renderer.id === "code" && /\.(txt|text)$/i.test(doc.name) }));
  } else {
    const current = doc;
    const ctx: RenderContext = {
      resolveAsset: (rel) => (current.path ? host.assetUrl(resolveRelative(current.path, rel)) : null),
      state: fileState,
      reloaded: !!opts.reloaded,
      dark: darkQuery.matches,
    };
    try {
      content.append(await renderer.render!(current, ctx));
    } catch (err) {
      console.error(err);
      content.append(
        el("div", { class: "notice error" }, el("strong", {}, "Couldn't render this file."), el("div", {}, String((err as Error)?.message ?? err)), el("div", { class: "muted" }, "Switch to Raw to see it as-is.")),
      );
    }
  }
  if (token !== renderToken) return; // a newer render started meanwhile
  view.replaceChildren(content);
  if (opts.keepScroll) view.scrollTop = scrollRatio * (view.scrollHeight - view.clientHeight);
  else view.scrollTop = 0;
  find.refresh();
  // Let arrow keys / PageDown / Space scroll right away, unless the user is typing somewhere.
  const active = document.activeElement;
  if (!active || active === document.body || active.tagName === "BUTTON") view.focus({ preventScroll: true });
}

function setDoc(next: FileDoc, opts: { reloaded?: boolean; pushHistory?: boolean } = {}) {
  const samePath = doc?.path != null && doc.path === next.path;
  if (!samePath) {
    fileState = {};
    mode = "rendered";
  }
  doc = next;
  renderer = pickRenderer(next);
  nameEl.textContent = next.name;
  nameEl.title = next.path ?? next.name;
  metaEl.textContent = `${renderer.label} · ${formatBytes(next.size)}`;
  host.setTitle(next.name);
  if (next.path && opts.pushHistory !== false && !samePath) history.push(next.path);
  backBtn.hidden = history.length < 2;
  if (next.path && !samePath) host.watch(next.path, onFileChanged);
  void render({ reloaded: opts.reloaded, keepScroll: samePath });
}

async function openPath(path: string, opts: { pushHistory?: boolean } = {}) {
  try {
    setDoc(await host.readPath(path), opts);
  } catch (err) {
    showToast(`Couldn't open: ${String((err as Error)?.message ?? err)}`, 3500);
  }
}

let reloadTimer: number | undefined;
function onFileChanged() {
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(async () => {
    if (!doc?.path) return;
    try {
      const fresh = await host.readPath(doc.path);
      if (fresh.text === doc.text) return;
      setDoc(fresh, { reloaded: true });
      showToast("Reloaded");
    } catch {
      /* file may be mid-save or deleted; ignore */
    }
  }, 150);
}

function setMode(next: Mode) {
  if (!renderer || renderer.rawOnly || mode === next) return;
  mode = next;
  void render({ keepScroll: true });
}

async function pick() {
  try {
    const picked = await host.pickFile();
    if (picked) setDoc(picked);
  } catch (err) {
    showToast(String((err as Error)?.message ?? err), 3500);
  }
}

function goBack() {
  if (history.length < 2) return;
  history.pop();
  void openPath(history[history.length - 1], { pushHistory: false });
}

// ---- Events -----------------------------------------------------------------

previewBtn.addEventListener("click", () => setMode("rendered"));
rawBtn.addEventListener("click", () => setMode("raw"));
openBtn.addEventListener("click", () => void pick());
backBtn.addEventListener("click", goBack);
copyBtn.addEventListener("click", async () => {
  if (!doc) return;
  try {
    await navigator.clipboard.writeText(doc.text);
    showToast("Copied to clipboard");
  } catch {
    showToast("Couldn't access the clipboard");
  }
});
darkQuery.addEventListener("change", () => void render({ keepScroll: true }));

// Links inside rendered content must never navigate the app window itself.
view.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  e.preventDefault();
  if (!href) return;
  if (href.startsWith("#")) {
    const id = decodeURIComponent(href.slice(1));
    const target = view.querySelector(`[id="${CSS.escape(id)}"]`) ?? view.querySelector(`[name="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: "start" });
    return;
  }
  if (hasScheme(href)) {
    if (/^(https?|mailto):/i.test(href)) host.openExternal(href);
    return;
  }
  if (doc?.path && host.canReadPaths) {
    const target = resolveRelative(doc.path, href);
    if (e.metaKey || e.ctrlKey) host.openInNewWindow(target);
    else void openPath(target);
  } else {
    showToast("Linked files open in the desktop app");
  }
});

document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && (key === "/" || e.code === "Slash")) {
    e.preventDefault();
    setMode(mode === "raw" ? "rendered" : "raw");
  } else if (mod && key === "o") {
    e.preventDefault();
    void pick();
  } else if (mod && key === "f") {
    e.preventDefault();
    if (doc) find.show();
  } else if (mod && key === "r" && doc?.path) {
    e.preventDefault();
    void openPath(doc.path, { pushHistory: false });
  } else if ((e.altKey && e.key === "ArrowLeft") || (mod && e.key === "[")) {
    e.preventDefault();
    goBack();
  } else if (isMac && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
    // Cmd+1…9 jumps to a native tab. e.code, so it works on layouts where digits need Shift.
    e.preventDefault();
    host.selectTab(Number(e.code.slice(5)));
  } else if (e.key === "Escape" && find.isOpen()) {
    find.hide();
  }
});

// ---- Boot -------------------------------------------------------------------

async function boot() {
  host = isTauri() ? await createTauriHost() : createBrowserHost();
  document.documentElement.dataset.host = host.kind;
  document.documentElement.dataset.platform = isMac ? "mac" : "other";
  void render();
  await host.init({
    open: (d) => setDoc(d),
    openPath: (p) => void openPath(p),
    error: (m) => showToast(m, 3500),
    dragging: (on) => (dropOverlay.hidden = !on),
  });
}

void boot();
