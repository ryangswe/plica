import "./styles.css";
import type { FileDoc, RenderContext, Renderer } from "./types";
import { createBrowserHost, createTauriHost, isTauri, type Host } from "./host";
import { pickRenderer, rawLanguageFor, renderers } from "./renderers";
import { renderRaw } from "./renderers/raw";
import { el, formatBytes } from "./lib/dom";
import { hasScheme, resolveRelative, splitFragment } from "./lib/paths";
import { readWithRetry, staleMessage } from "./lib/reload";
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
const copyBtn = el("button", { class: "ghost", title: "Copy the whole file as plain text", hidden: "" }, "Copy source");
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
// Shown while the open file can't be read anymore (deleted, moved, permissions); the last content stays.
const staleBar = el("div", { class: "stale-bar", role: "alert", hidden: "" });
const view = el("main", { class: "view-scroll", tabindex: "-1" });
const toast = el("div", { class: "toast", role: "status", "aria-live": "polite" });
const dropOverlay = el("div", { class: "drop-overlay", hidden: "" }, el("div", {}, "Drop to open"));
const find = createFindBar(
  () => view.querySelector<HTMLElement>(".view-content"),
  () =>
    doc && renderer && !doc.binary
      ? { text: doc.text, isRaw: !!renderer.rawOnly || !renderer.render || mode === "raw", showRaw: () => setMode("raw") }
      : null,
);
app.append(bar, staleBar, find.bar, view, toast, dropOverlay);

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

/** Section to scroll to once the next file has rendered (from a link like other.md#setup). */
let pendingAnchor: string | null = null;

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
  if (!opts.keepScroll && pendingAnchor) {
    scrollToAnchor(pendingAnchor);
    pendingAnchor = null;
  }
  find.refresh();
  // Let arrow keys / PageDown / Space scroll right away, unless the user is typing somewhere.
  const active = document.activeElement;
  if (!active || active === document.body || active.tagName === "BUTTON") view.focus({ preventScroll: true });
}

function setDoc(next: FileDoc, opts: { reloaded?: boolean; pushHistory?: boolean } = {}) {
  const samePath = doc?.path != null && doc.path === next.path;
  staleBar.hidden = true; // whatever we're showing now was just read successfully
  if (!samePath) {
    fileState = {};
    mode = "rendered";
  }
  doc = next;
  renderer = pickRenderer(next);
  nameEl.textContent = next.name;
  nameEl.title = next.path ?? next.name;
  // Mention the encoding only when it isn't the expected UTF-8.
  const enc = next.encoding && next.encoding !== "UTF-8" ? ` · ${encodingLabel(next.encoding)}` : "";
  metaEl.textContent = `${renderer.label} · ${formatBytes(next.size)}${enc}`;
  metaEl.title = next.encoding ? `Encoding: ${next.encoding}` : "";
  host.setTitle(next.name);
  if (next.path && opts.pushHistory !== false && !samePath) history.push(next.path);
  backBtn.hidden = history.length < 2;
  if (next.path && !samePath) host.watch(next.path, onFileChanged);
  void render({ reloaded: opts.reloaded, keepScroll: samePath });
}

/** Scroll to the element with this id (or a named anchor). Returns false if there's none. */
function scrollToAnchor(id: string | null): boolean {
  if (!id) return false;
  const target = view.querySelector(`[id="${CSS.escape(id)}"]`) ?? view.querySelector(`[name="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: "start" });
  return !!target;
}

async function openPath(path: string, opts: { pushHistory?: boolean; anchor?: string | null } = {}) {
  try {
    const next = await host.readPath(path);
    pendingAnchor = opts.anchor ?? null;
    setDoc(next, opts);
  } catch (err) {
    showToast(`Couldn't open: ${String((err as Error)?.message ?? err)}`, 3500);
  }
}

let reloadTimer: number | undefined;
function onFileChanged() {
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(async () => {
    if (!doc?.path) return;
    const path = doc.path;
    const r = await readWithRetry(() => host.readPath(path));
    if (doc?.path !== path) return; // switched files meanwhile
    if (!r.ok) {
      staleBar.textContent = staleMessage(r.error);
      staleBar.title = r.error;
      staleBar.hidden = false;
      return;
    }
    staleBar.hidden = true;
    if (r.value.text === doc.text) return;
    setDoc(r.value, { reloaded: true });
    showToast("Reloaded");
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
async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(done);
  } catch {
    showToast("Couldn't access the clipboard");
  }
}
copyBtn.addEventListener("click", () => doc && void copyText(doc.text, "Copied source"));

/** Commands from the native menu bar (macOS). */
function runCommand(id: string) {
  if (id === "toggle-raw") setMode(mode === "raw" ? "rendered" : "raw");
  else if (id === "reload" && doc?.path) void openPath(doc.path, { pushHistory: false });
  else if (id === "back") goBack();
  else if (id === "copy-source" && doc && !doc.binary) void copyText(doc.text, "Copied source");
  else if (id === "copy-path" && doc?.path) void copyText(doc.path, "Copied path");
  else if (id === "find" && doc) find.show();
  else if (id === "find-next" && doc) find.next();
  else if (id === "find-prev" && doc) find.prev();
}
darkQuery.addEventListener("change", () => void render({ keepScroll: true }));

// Links inside rendered content must never navigate the app window itself.
view.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  e.preventDefault();
  if (!href) return;
  if (href.startsWith("#")) {
    scrollToAnchor(splitFragment(href).fragment);
    return;
  }
  if (hasScheme(href)) {
    if (/^(https?|mailto):/i.test(href)) host.openExternal(href);
    return;
  }
  if (doc?.path && host.canReadPaths) {
    const target = resolveRelative(doc.path, href);
    const anchor = splitFragment(href).fragment; // other.md#setup lands on the "setup" heading
    if (e.metaKey || e.ctrlKey) host.openInNewWindow(target);
    else if (target === doc.path) scrollToAnchor(anchor);
    else void openPath(target, { anchor });
  } else {
    showToast("Linked files open in the desktop app");
  }
});

document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  // With a native menu bar, its items own these shortcuts: leave the keys alone so the menu gets them.
  if (host?.nativeMenu && mod && (["/", "o", "f", "g", "r", "["].includes(key) || e.code === "Slash")) return;
  if (mod && key === "g") {
    e.preventDefault();
    if (doc) (e.shiftKey ? find.prev : find.next)();
  } else if (mod && (key === "/" || e.code === "Slash")) {
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

/** "windows-1252" → "Windows-1252"; other names (UTF-16LE, Shift_JIS, GBK) are fine as they are. */
function encodingLabel(name: string): string {
  return name.replace(/^windows-/, "Windows-");
}

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
    command: runCommand,
  });
}

void boot();
