import type { FileDoc } from "./types";

/**
 * Everything platform-specific lives behind this interface. The desktop app
 * uses the Tauri host; running the frontend in a normal browser (dev, tests,
 * a possible web demo) uses the browser host.
 */
export interface Host {
  kind: "tauri" | "browser";
  /** Wire up OS integration (initial file, Finder/Explorer "open", drag & drop). */
  init(handlers: { open(doc: FileDoc): void; openPath(path: string): void; error(msg: string): void; dragging(on: boolean): void }): Promise<void>;
  pickFile(): Promise<FileDoc | null>;
  canReadPaths: boolean;
  readPath(path: string): Promise<FileDoc>;
  /** Call `onChange` when the file at `path` changes on disk. Replaces any previous watch. */
  watch(path: string, onChange: () => void): void;
  assetUrl(path: string): string | null;
  openExternal(url: string): void;
  setTitle(title: string): void;
  openInNewWindow(path: string): void;
}

interface RawFile {
  path: string;
  name: string;
  text: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function fileToDoc(file: File): Promise<FileDoc> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const binary = buf.subarray(0, 8000).includes(0);
  const text = binary ? "" : new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
  return { path: null, name: file.name, text, size: file.size, binary, truncated: false };
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
    async init({ open, dragging }) {
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
  };
}

export async function createTauriHost(): Promise<Host> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  const win = getCurrentWebviewWindow();
  let changeHandler: (() => void) | null = null;

  const toDoc = (r: RawFile): FileDoc => ({ ...r });

  return {
    kind: "tauri",
    canReadPaths: true,
    async init({ openPath, error, dragging }) {
      await win.listen<string>("open-path", (e) => openPath(e.payload));
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
    async readPath(path) {
      return toDoc(await invoke<RawFile>("read_file", { path }));
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
  };
}
