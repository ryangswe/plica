/** A file loaded into the viewer. */
export interface FileDoc {
  /** Absolute path on disk, or null when the file came from a browser upload/drop. */
  path: string | null;
  name: string;
  text: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  /** Encoding the text was decoded from ("UTF-8", "UTF-16LE", "windows-1252"...); empty for binary files. */
  encoding: string;
}

/** What a renderer gets besides the file itself. */
export interface RenderContext {
  /** Turn a path relative to the file into a URL the webview can load (images). Null if unsupported. */
  resolveAsset(rel: string): string | null;
  /** Per-file scratch state that survives live reloads (filters, toggles...). */
  state: Record<string, unknown>;
  /** True if the file just reloaded because it changed on disk. */
  reloaded: boolean;
  dark: boolean;
}

export interface Renderer {
  id: string;
  label: string;
  /** Lowercase extensions without the dot. */
  extensions: string[];
  /** Exact file names (lowercase), e.g. "dockerfile". */
  filenames?: string[];
  /** If true there is no separate rendered view; the raw (highlighted) view is the only view. */
  rawOnly?: boolean;
  /** highlight.js language for the raw view. */
  rawLanguage?: string;
  render?(doc: FileDoc, ctx: RenderContext): HTMLElement | Promise<HTMLElement>;
}
