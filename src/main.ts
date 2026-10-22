import "./styles.css";
import appIconUrl from "../src-tauri/icons/icon.svg?url"; // the app icon, also on the start screen
import type { FileDoc, RenderContext, Renderer } from "./types";
import { createBrowserHost, createTauriHost, isTauri, type Host } from "./host";
import { pickRenderer, rawLanguageFor } from "./renderers";
import { renderRaw } from "./renderers/raw";
import { el, formatBytes } from "./lib/dom";
import { hasScheme, resolveRelative, splitFragment } from "./lib/paths";
import { readWithRetry, staleMessage } from "./lib/reload";
import type { RemotePolicy } from "./lib/sanitize";
import { createFindBar } from "./find";
import { openDefaultAppsSheet } from "./defaults";
import { createSidebar, type FileList, type ListItem } from "./sidebar";

type Mode = "rendered" | "raw";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

// ---- DOM ------------------------------------------------------------------

const app = document.getElementById("app")!;
const SIDEBAR_KEY = isMac ? "⌃⌘S" : "Ctrl+B";
const sidebarBtn = el(
  "button",
  { class: "icon-btn sidebar-btn", title: `Show or hide the file list (${SIDEBAR_KEY})`, "aria-label": "Sidebar", "aria-pressed": "false", hidden: "" },
);
// Two panes, the left one narrow: the usual "sidebar" glyph.
sidebarBtn.innerHTML =
  '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="0.75" y="0.75" width="14.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 1v12" stroke="currentColor" stroke-width="1.5"/></svg>';
const backBtn = el("button", { class: "icon-btn", id: "back", title: "Back (Alt+←)", "aria-label": "Back", hidden: "" }, "←");
const nameEl = el("span", { class: "file-name" }, "Plica");
const metaEl = el("span", { class: "file-meta" });
const previewBtn = el("button", { "data-mode": "rendered", role: "tab" }, "Preview");
const rawBtn = el("button", { "data-mode": "raw", role: "tab" }, "Raw");
const modeSwitch = el("div", { class: "mode-switch", role: "tablist", title: `Toggle Preview / Raw (${MOD}/)`, hidden: "" }, previewBtn, rawBtn);
const copyBtn = el("button", { class: "ghost", title: "Copy the whole file as plain text", hidden: "" }, "Copy source");
const openBtn = el("button", { class: "ghost", title: `Open a file (${MOD}O)` }, "Open…");
// Toolbar: file name on the left, Preview | Raw centered, actions on the right. On macOS it is also the
// title bar: everything that isn't a control drags the window (and double-click zooms).
const drag = { "data-tauri-drag-region": "" };
nameEl.setAttribute("data-tauri-drag-region", "");
metaEl.setAttribute("data-tauri-drag-region", "");
const bar = el(
  "header",
  { class: "topbar", ...drag },
  el("div", { class: "tb-left", ...drag }, sidebarBtn, backBtn, el("div", { class: "file-title", ...drag }, nameEl, metaEl)),
  el("div", { class: "tb-center", ...drag }, modeSwitch),
  el("div", { class: "tb-right", ...drag }, copyBtn, openBtn),
);
// Shown while the open file can't be read anymore (deleted, moved, permissions); the last content stays.
const staleBar = el("div", { class: "stale-bar", role: "alert", hidden: "" });
// Offers remote images the file references (blocked by default: tracking pixels).
const remoteBar = el("div", { class: "remote-bar", role: "status", hidden: "" });
// Offers to make Plica the default app for Markdown (once; "Not now" is remembered).
const defaultsBar = el("div", { class: "defaults-bar", role: "status", hidden: "" });
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
// Shown only while the macOS tab bar is visible (see .titlebar-drag).
const titlebarDrag = el("div", { class: "titlebar-drag", "data-tauri-drag-region": "", hidden: "" });
// A folder or several files opened together: their list, on the left of the file.
const sidebar = createSidebar(
  (item) => void showItem(item),
  (open) => sidebarBtn.setAttribute("aria-pressed", String(open)),
);
const body = el("div", { class: "body" }, sidebar.el, el("div", { class: "main-col" }, staleBar, defaultsBar, remoteBar, view));
app.append(titlebarDrag, bar, body, find.bar, toast, dropOverlay);

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
  const openLink = el("button", { class: "primary" }, "Open a file");
  openLink.addEventListener("click", () => void pick());
  return el(
    "div",
    { class: "empty" },
    el("img", { class: "empty-mark", src: appIconUrl, alt: "", width: "72", height: "72" }),
    el("h1", {}, "Plica"),
    el("p", {}, "Read Markdown and developer files. Drop files or a folder here, or"),
    openLink,
    el("p", { class: "muted small" }, "Markdown, JSON, CSV, notebooks, logs, diffs, Mermaid and any text or code file."),
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

let defaultOffered = false;
/** First Markdown file in this window: if Plica isn't the Markdown default, offer it (never by itself). */
async function maybeOfferDefault() {
  if (defaultOffered) return;
  defaultOffered = true;
  if (await host.defaultAppsPromptDismissed()) return;
  const info = await host.defaultApps();
  const md = info?.supported ? info.types.find((t) => t.id === "markdown") : undefined;
  if (!md || md.isPlica) return;
  const button = (label: string, onClick: () => void, primary = false) => {
    const b = el("button", primary ? { class: "primary" } : {}, label);
    b.addEventListener("click", onClick);
    return b;
  };
  defaultsBar.replaceChildren(
    el("span", {}, `Markdown files open in ${md.extensions[0]?.app ?? "another app"}. Open them with Plica instead?`),
    button(
      "Make default",
      async () => {
        defaultsBar.hidden = true;
        const [r] = await host.setDefaultApps(["markdown"]);
        showToast(r?.ok ? "Plica now opens Markdown files." : `Couldn't change it: ${r?.error ?? "unknown error"}`, 3500);
      },
      true,
    ),
    button("Choose file types…", () => {
      defaultsBar.hidden = true;
      void showDefaultApps();
    }),
    button("Not now", () => {
      defaultsBar.hidden = true;
      host.dismissDefaultAppsPrompt();
    }),
  );
  defaultsBar.hidden = false;
}

async function showDefaultApps() {
  const info = await host.defaultApps();
  if (!info) return showToast("Default apps can be set in the desktop app.");
  openDefaultAppsSheet(info, (ids) => host.setDefaultApps(ids), (msg) => showToast(msg, 3500));
}

/** Remote images load automatically (the user chose "Always load"). */
let allowRemote = false;
/** Files this window may load remote images for, after "Load once". */
const loadOnce = new Set<string>();
const docKey = (d: FileDoc) => d.path ?? `upload:${d.name}`;

function updateRemoteBar(policy: RemotePolicy | null) {
  const found = policy?.found ?? 0;
  const button = (label: string, onClick: () => void) => {
    const b = el("button", {}, label);
    b.addEventListener("click", onClick);
    return b;
  };
  if (found && policy && !policy.allow) {
    remoteBar.replaceChildren(
      el("span", {}, `This file links to ${found === 1 ? "a remote image" : `${found} remote images`}. Plica blocks them so nobody can tell you opened it.`),
      button("Load once", () => {
        if (doc) loadOnce.add(docKey(doc));
        void render({ keepScroll: true });
      }),
      button("Always load", () => {
        host.setRemoteContent(true);
        showToast(host.nativeMenu ? "Remote images will load. Turn this off in View → Load Remote Images." : "Remote images will load.", 3500);
      }),
    );
    remoteBar.hidden = false;
  } else if (found && allowRemote && !host.nativeMenu) {
    // No menu bar to turn it off again on this platform: offer it here.
    remoteBar.replaceChildren(el("span", {}, "Remote images load automatically."), button("Block them", () => host.setRemoteContent(false)));
    remoteBar.hidden = false;
  } else remoteBar.hidden = true;
}

/** Section to scroll to once the next file has rendered (from a link like other.md#setup). */
let pendingAnchor: string | null = null;

async function render(opts: { reloaded?: boolean; keepScroll?: boolean } = {}) {
  const token = ++renderToken;
  let policy: RemotePolicy | null = null;
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
      remote: { allow: allowRemote || loadOnce.has(docKey(current)), found: 0 },
    };
    policy = ctx.remote;
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
  updateRemoteBar(effective === "raw" || doc.binary ? null : policy);
  if (renderer.id === "markdown") void maybeOfferDefault();
  if (opts.keepScroll) view.scrollTop = scrollRatio * (view.scrollHeight - view.clientHeight);
  else view.scrollTop = 0;
  if (!opts.keepScroll && pendingAnchor) {
    scrollToAnchor(pendingAnchor);
    pendingAnchor = null;
  }
  find.refresh();
  // Let arrow keys / PageDown / Space scroll right away, unless the user is typing somewhere or
  // browsing the file list (arrow keys move through it).
  const active = document.activeElement;
  if (!active || active === document.body || (active.tagName === "BUTTON" && !active.classList.contains("sidebar-item"))) view.focus({ preventScroll: true });
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
  // Mention the encoding only when it isn't the expected UTF-8 (or the user picked one), and let the
  // user correct a wrong guess right there.
  metaEl.replaceChildren(`${renderer.label} · ${formatBytes(next.size)}`);
  metaEl.title = next.encoding ? `Encoding: ${next.encoding}` : "";
  const overridden = next.path != null && encodingOverride.has(next.path);
  if (next.encoding && (next.encoding !== "UTF-8" || overridden)) {
    metaEl.append(" · ", next.path && host.canReadPaths ? encodingPicker(next.encoding) : encodingLabel(next.encoding));
  }
  host.setTitle(next.name);
  sidebar.markCurrent(next.path ?? uploadKey);
  uploadKey = null;
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
    const next = await host.readPath(path, encodingOverride.get(path));
    pendingAnchor = opts.anchor ?? null;
    setDoc(next, opts);
  } catch (err) {
    showToast(`Couldn't open: ${String((err as Error)?.message ?? err)}`, 3500);
  }
}

/** The sidebar item being shown, for files without a path (browser uploads). */
let uploadKey: string | null = null;

async function showItem(item: ListItem) {
  if (item.path) return openPath(item.path);
  if (!item.load) return;
  const next = await item.load();
  uploadKey = item.key;
  setDoc(next);
}

function showList(list: FileList, showFirst = true) {
  sidebar.setList(list);
  sidebarBtn.hidden = false;
  sidebar.setOpen(true);
  if (showFirst && list.items[0]) void showItem(list.items[0]);
}

function toggleSidebar() {
  if (!sidebar.hasList()) return showToast("Open a folder or several files to list them here.", 2500);
  sidebar.setOpen(!sidebar.isOpen());
}

let reloadTimer: number | undefined;
function onFileChanged() {
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(async () => {
    if (!doc?.path) return;
    const path = doc.path;
    const r = await readWithRetry(() => host.readPath(path, encodingOverride.get(path)));
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
sidebarBtn.addEventListener("click", toggleSidebar);
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

/** "Reopen with Encoding" choices per file, for this window (kept across live reloads). */
const encodingOverride = new Map<string, string>();

function reopenWithEncoding(label: string) {
  if (!doc?.path) return showToast("Reopening with another encoding works for files on disk.");
  if (label === "auto") encodingOverride.delete(doc.path);
  else encodingOverride.set(doc.path, label);
  void openPath(doc.path, { pushHistory: false });
}

/** Commands from the native menu bar (macOS). */
function runCommand(id: string) {
  if (id.startsWith("encoding:")) return reopenWithEncoding(id.slice("encoding:".length));
  if (id.startsWith("notice:")) return showToast(id.slice("notice:".length), 5000);
  if (id === "toggle-raw") setMode(mode === "raw" ? "rendered" : "raw");
  else if (id === "toggle-sidebar") toggleSidebar();
  else if (id === "reload" && doc?.path) void openPath(doc.path, { pushHistory: false });
  else if (id === "back") goBack();
  else if (id === "copy-source" && doc && !doc.binary) void copyText(doc.text, "Copied source");
  else if (id === "copy-path" && doc?.path) void copyText(doc.path, "Copied path");
  else if (id === "find" && doc) find.show();
  else if (id === "find-next" && doc) find.next();
  else if (id === "find-prev" && doc) find.prev();
  else if (id === "default-apps") void showDefaultApps();
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
  if (host?.nativeMenu && mod && (["/", "o", "f", "g", "r", "[", "s"].includes(key) || e.code === "Slash")) return;
  const sidebarKey = isMac ? e.metaKey && e.ctrlKey && e.code === "KeyS" : e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyB";
  if (sidebarKey) {
    e.preventDefault();
    return toggleSidebar();
  }
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

/** Encodings to offer in the top bar (same list as the macOS menu). [WHATWG label, name] */
const ENCODINGS: [string, string][] = [
  ["utf-8", "UTF-8"], ["utf-16le", "UTF-16LE"], ["utf-16be", "UTF-16BE"], ["windows-1252", "Windows-1252"],
  ["windows-1250", "Windows-1250"], ["windows-1251", "Windows-1251"], ["koi8-r", "KOI8-R"], ["windows-1253", "Windows-1253"],
  ["windows-1254", "Windows-1254"], ["windows-1255", "Windows-1255"], ["windows-1256", "Windows-1256"],
  ["shift_jis", "Shift_JIS"], ["euc-jp", "EUC-JP"], ["gbk", "GBK"], ["big5", "Big5"], ["euc-kr", "EUC-KR"],
];

/** The encoding name as a small native picker: choosing another one reopens the file with it. */
function encodingPicker(current: string): HTMLElement {
  const select = el("select", { class: "encoding-picker", "aria-label": "Text encoding", title: "Reopen with another encoding" }) as HTMLSelectElement;
  const known = ENCODINGS.some(([, name]) => name.toLowerCase() === current.toLowerCase());
  if (!known) select.append(el("option", { value: "" }, encodingLabel(current)));
  for (const [label, name] of ENCODINGS) {
    const o = el("option", { value: label }, name);
    if (name.toLowerCase() === current.toLowerCase()) o.selected = true;
    select.append(o);
  }
  select.append(el("option", { value: "auto" }, "Detect automatically"));
  select.addEventListener("change", () => select.value && reopenWithEncoding(select.value));
  // Looks like the plain label; the (invisible) native picker on top of it opens the system menu.
  return el("span", { class: "encoding-pick" }, el("span", { class: "encoding-name" }, encodingLabel(current), " ▾"), select);
}

/** "windows-1252" → "Windows-1252"; other names (UTF-16LE, Shift_JIS, GBK) are fine as they are. */
function encodingLabel(name: string): string {
  return name.replace(/^windows-/, "Windows-");
}

// ---- Boot -------------------------------------------------------------------

async function boot() {
  host = isTauri() ? await createTauriHost() : createBrowserHost();
  allowRemote = await host.getRemoteContent();
  document.documentElement.dataset.host = host.kind;
  document.documentElement.dataset.platform = isMac ? "mac" : "other";
  // On macOS the menu bar has File → Open; keep the toolbar for the file itself.
  openBtn.hidden = host.nativeMenu;
  void render();
  await host.init({
    open: (d) => setDoc(d),
    openPath: (p) => void openPath(p),
    list: showList,
    error: (m) => showToast(m, 3500),
    dragging: (on) => (dropOverlay.hidden = !on),
    command: runCommand,
    notice: (m) => showToast(m, 2500),
    chrome: ({ tabBarInset, fullscreen }) => {
      // macOS tab bar shown: move the toolbar below it. Full screen: no traffic lights to make room for.
      const root = document.documentElement;
      root.style.setProperty("--tabbar-inset", `${tabBarInset}px`);
      root.dataset.tabbar = tabBarInset > 0 ? "1" : "";
      titlebarDrag.hidden = tabBarInset === 0;
      root.dataset.fullscreen = fullscreen ? "1" : "";
    },
    remoteContent: (allowed) => {
      allowRemote = allowed;
      void render({ keepScroll: true });
    },
  });
  // E.g. Plica → Default Apps… chosen while no window was open: this window was made for it.
  const pending = await host.takePendingCommand();
  if (pending) runCommand(pending);
}

void boot();
