import type { DefaultAppsInfo, SetResult } from "./defaults";
import { decodeBytes } from "./lib/decode";
import type { FileDoc } from "./types";

/**
 * Everything platform-specific lives behind this interface. The desktop app
 * uses the Tauri host; running the frontend in a normal browser (dev, tests,
 * a possible web demo) uses the browser host.
 */
export interface Host {
  kind: "tauri" | "browser";
  /** Wire up OS integration (initial file, Finder/Explorer "open", drag & drop). */
  init(handlers: {
    open(doc: FileDoc): void;
    openPath(path: string): void;
    error(msg: string): void;
    dragging(on: boolean): void;
    /** A native menu command (macOS menu bar), e.g. "toggle-raw", "find", "copy-path". */
    command(id: string): void;
    /** A short message from the desktop shell, e.g. "Opening in VS Code…". */
    notice(msg: string): void;
    /** The "load remote images automatically" preference changed (menu, another window). */
    remoteContent(allowed: boolean): void;
    /** macOS window chrome changed: tab bar shown (its inset in px, else 0) or full screen. */
    chrome(state: { tabBarInset: number; fullscreen: boolean }): void;
  }): Promise<void>;
  /** True when a native menu bar owns the standard shortcuts (Cmd+O, Cmd+F, Cmd+/...). */
  nativeMenu: boolean;
  /** Whether remote images load automatically (off by default). */
  getRemoteContent(): Promise<boolean>;
  setRemoteContent(allowed: boolean): void;
  /** Default-app status per file type; null where the host can't tell (browser). */
  defaultApps(): Promise<DefaultAppsInfo | null>;
  setDefaultApps(ids: string[]): Promise<SetResult[]>;
  defaultAppsPromptDismissed(): Promise<boolean>;
  dismissDefaultAppsPrompt(): void;
  /** A command queued for this window before it existed (e.g. Default Apps… with no window open). */
  takePendingCommand(): Promise<string | null>;
  pickFile(): Promise<FileDoc | null>;
  canReadPaths: boolean;
  /** Read a file; `encoding` (a WHATWG label) overrides detection ("Reopen with Encoding"). */
  readPath(path: string, encoding?: string): Promise<FileDoc>;
  /** Call `onChange` when the file at `path` changes on disk. Replaces any previous watch. */
  watch(path: string, onChange: () => void): void;
  assetUrl(path: string): string | null;
  openExternal(url: string): void;
  setTitle(title: string): void;
  openInNewWindow(path: string): void;
  /** Bring the n-th native tab (1–9, 9 = last) of this window forward. macOS desktop only. */
  selectTab(n: number): void;
}

interface RawFile {
  path: string;
  name: string;
  text: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  encoding: string;
}

const REMOTE_KEY = "plica.remoteContent";
let remoteChanged: ((allowed: boolean) => void) | undefined;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function fileToDoc(file: File): Promise<FileDoc> {
  const decoded = decodeBytes(new Uint8Array(await file.arrayBuffer()));
  return {
    path: null,
    name: file.name,
    text: decoded?.text ?? "",
    size: file.size,
    binary: !decoded,
    truncated: false,
    encoding: decoded?.encoding ?? "",
  };
}

export function createBrowserHost(): Host {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.id = "file-picker";
  document.body.append(input);
  return {
    kind: "browser",
    canReadPaths: false,
    nativeMenu: false,
    async getRemoteContent() {
      try {
        return localStorage.getItem(REMOTE_KEY) === "allow";
      } catch {
        return false;
      }
    },
    async defaultApps() {
      return null;
    },
    async setDefaultApps() {
      return [];
    },
    async defaultAppsPromptDismissed() {
      return true;
    },
    dismissDefaultAppsPrompt() {},
    async takePendingCommand() {
      return null;
    },
    setRemoteContent(allowed) {
      try {
        if (allowed) localStorage.setItem(REMOTE_KEY, "allow");
        else localStorage.removeItem(REMOTE_KEY);
      } catch {
        /* private mode: the choice lasts for this page only */
      }
      remoteChanged?.(allowed);
    },
    async init({ open, dragging, remoteContent }) {
      remoteChanged = remoteContent;
      input.addEventListener("change", async () => {
        const f = input.files?.[0];
        if (f) open(await fileToDoc(f));
        input.value = "";
      });
      let depth = 0;
      document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        if (++depth === 1) dragging(true);
      });
      document.addEventListener("dragleave", () => {
        if (--depth === 0) dragging(false);
      });
      document.addEventListener("dragover", (e) => e.preventDefault());
      document.addEventListener("drop", async (e) => {
        e.preventDefault();
        depth = 0;
        dragging(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) open(await fileToDoc(f));
      });
    },
    async pickFile() {
      input.click();
      return null; // result arrives through the change handler
    },
    async readPath() {
      throw new Error("Opening linked files only works in the desktop app.");
    },
    watch() {},
    assetUrl() {
      return null;
    },
    openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    setTitle(title) {
      document.title = title;
    },
    openInNewWindow() {},
    selectTab() {},
  };
}

export async function createTauriHost(): Promise<Host> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { listen } = await import("@tauri-apps/api/event");
  const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  const win = getCurrentWebviewWindow();
  let changeHandler: (() => void) | null = null;

  const toDoc = (r: RawFile): FileDoc => ({ ...r });

  return {
    kind: "tauri",
    canReadPaths: true,
    nativeMenu: /Mac/.test(navigator.platform),
    async init({ openPath, error, dragging, command, notice, remoteContent, chrome }) {
      await win.listen<{ tabBarInset: number; fullscreen: boolean }>("window-chrome", (e) => chrome(e.payload));
      invoke("resend_window_chrome").catch(() => {}); // macOS only; the first report may predate us
      await win.listen<string>("open-path", (e) => openPath(e.payload));
      await listen<boolean>("remote-content", (e) => remoteContent(e.payload)); // app-wide broadcast
      await win.listen<string>("menu", (e) => command(e.payload));
      await win.listen<string>("notice", (e) => notice(e.payload));
      await win.listen<string>("file-changed", () => changeHandler?.());
      await win.onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") dragging(true);
        else if (p.type === "leave") dragging(false);
        else if (p.type === "drop") {
          dragging(false);
          const [first, ...rest] = p.paths;
          if (first) openPath(first);
          for (const extra of rest) invoke("open_window", { path: extra }).catch((err) => error(String(err)));
        }
      });
      const initial = await invoke<string | null>("take_initial_file");
      if (initial) openPath(initial);
    },
    async pickFile() {
      const picked = await openDialog({ multiple: false, directory: false });
      if (typeof picked !== "string") return null;
      return toDoc(await invoke<RawFile>("read_file", { path: picked }));
    },
    async readPath(path, encoding) {
      return toDoc(await invoke<RawFile>("read_file", { path, encoding: encoding ?? null }));
    },
    watch(path, onChange) {
      changeHandler = onChange;
      invoke("watch_file", { path }).catch(() => {
        /* watching is best-effort (network drives etc.) */
      });
    },
    assetUrl(path) {
      return convertFileSrc(path);
    },
    openExternal(url) {
      openUrl(url).catch(() => {});
    },
    setTitle(title) {
      win.setTitle(title).catch(() => {});
    },
    openInNewWindow(path) {
      invoke("open_window", { path }).catch(() => {});
    },
    selectTab(n) {
      invoke("select_tab", { n }).catch(() => {});
    },
    async getRemoteContent() {
      return invoke<boolean>("get_remote_content").catch(() => false);
    },
    setRemoteContent(allowed) {
      invoke("save_remote_content", { allowed }).catch(() => {});
    },
    async defaultApps() {
      return invoke<DefaultAppsInfo>("default_apps").catch(() => null);
    },
    async setDefaultApps(ids) {
      return invoke<SetResult[]>("set_default_apps", { ids }).catch((e) => ids.map((id) => ({ id, ok: false, error: String(e) })));
    },
    async defaultAppsPromptDismissed() {
      return invoke<boolean>("default_apps_prompt_dismissed").catch(() => true);
    },
    dismissDefaultAppsPrompt() {
      invoke("dismiss_default_apps_prompt").catch(() => {});
    },
    async takePendingCommand() {
      return invoke<string | null>("take_pending_command").catch(() => null);
    },
  };
}
