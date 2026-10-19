# Handoff notes

Written at the end of the first build session (a Linux cloud machine with no Mac or Windows available).
Read this before changing anything. Keep it up to date as items get done.

## Goal

A lightweight, open-source, cross-platform viewer that makes opening a `.md` (and other dev text files) as
seamless as opening a PDF: double-click → rendered view, one key to toggle raw source. Read-only.
It must stay small and fast; resist turning it into an editor.

## Current status (v0.1.0)

Working and tested on Linux (in a headless X server):

- Tauri 2 desktop shell: opens files from CLI args, one window per file, second launch forwards files to the
  running instance (single-instance plugin), live reload on file change, drag & drop, Open dialog,
  relative links between files (with Back), local images via the asset protocol, Ctrl/Cmd +/- zoom.
- Renderers: Markdown (GFM, alerts, Mermaid, front matter, TOC, highlighted code), JSON/JSONC/JSONL tree,
  CSV/TSV table (sort, filter), Jupyter notebooks, logs (levels, filter, follow, next error), unified diffs,
  Mermaid files, SVG, sandboxed HTML, and highlighted source for everything else.
- Preview/Raw toggle (Cmd/Ctrl+/), find in page (Cmd/Ctrl+F), copy, light/dark following the OS.
- Strict CSP, DOMPurify sanitizing, HTML preview in an empty-sandbox iframe, links never navigate the window.
- Linux packaging: `npm run tauri build` produces .deb / .rpm (~3.3 MB) and .AppImage (~78 MB, it bundles
  WebKitGTK). The installed .deb was tested end to end: opening a file through its desktop entry (what a
  file manager does on double-click) shows the file rendered. A custom desktop template
  (`src-tauri/linux/unfold.desktop`) adds the `%F` the default template was missing.
- Tests: 23 unit tests (vitest + jsdom), 15 browser e2e tests (Playwright against `vite preview`, which
  sends the same CSP as the app, and the tests fail on any CSP violation), 3 Rust unit tests.
- CI (`.github/workflows/ci.yml`): typecheck, unit, e2e, clippy + cargo test on Linux/macOS/Windows.
- Release (`.github/workflows/release.yml`): push a `v*` tag → draft GitHub Release with .dmg (Apple Silicon
  and Intel), .msi/.exe, .deb/.rpm/.AppImage. "Run workflow" builds the same as downloadable artifacts.

**Not yet verified on a real Mac or Windows machine.** Everything platform-specific below is written
per the Tauri docs but untested.

## Verify first (on the local machine)

1. `npm install && npm test && npm run test:e2e` — should all pass.
2. `npm run tauri dev` — app opens with the empty state; drag a file in; try every fixture in `tests/fixtures/`.
3. `npm run tauri build`, then install/open the built app and check:
   - **macOS double-click flow**: set Unfold as the default for `.md` (Get Info → Open with → Change All),
     quit Unfold, double-click a `.md` in Finder. Expected: exactly one window showing that file (macOS
     sends the file via `RunEvent::Opened` *after* launch; `open_paths` in `src-tauri/src/lib.rs` reuses
     the initial empty window). Double-click a second file while running → second window.
   - Is there a sensible macOS menu bar (Edit → Copy needs to work; Cmd+Q, Cmd+W)? Tauri 2 should add a
     default menu on macOS; if not, add one (see roadmap).
   - Unfold appears in Finder's "Open With" for .md/.json/.csv/.ipynb/.log/.diff/.mmd.
   - Live reload when saving from VS Code / vim (they save via rename; we watch the parent folder).
   - Windows: double-click flow, "Open with" registration from the MSI/NSIS installer, paths with
     backslashes and spaces, relative images.
4. Fix whatever breaks, then cut `v0.1.0` (see Releasing).

## Architecture

```
src/                     web frontend (TypeScript, no framework, Vite)
  main.ts                app shell: top bar, Preview/Raw toggle, shortcuts, live reload, link handling, history
  host.ts                platform layer: Tauri host (desktop) vs browser host (dev/tests/web demo)
  find.ts                find-in-page bar
  types.ts               FileDoc, Renderer, RenderContext
  renderers/             one file per type + index.ts registry (first match wins, codeRenderer is fallback)
    raw.ts               line-numbered highlighted source (used for every Raw view)
  lib/                   highlight (highlight.js), sanitize (DOMPurify), ansi, paths, dom helpers
  styles.css             all styling; CSS variables for light/dark
src-tauri/
  src/lib.rs             windows, file reading, watching, OS open events (all Rust code is here)
  tauri.conf.json        CSP, asset protocol, file associations, bundle settings
  capabilities/          permissions granted to windows (labels w0, w1, ...)
tests/
  fixtures/              sample files for every type (also nice for manual testing)
  unit/                  vitest
  e2e/                   playwright; writes screenshots to test-results/screens/
```

Flow: Rust creates a window per file and stores the path as "pending". The frontend registers listeners,
then calls `take_initial_file`. Files opened later (macOS Opened event, second launch) either reuse an empty
window (`open-path` event) or create a new one. `read_file` returns `{path, name, text, size, binary,
truncated}` (64 MB cap, NUL byte = binary). `watch_file` watches the parent dir and emits `file-changed`
to that window only; the frontend debounces and re-reads.

Adding a renderer: create `src/renderers/foo.ts` exporting a `Renderer` (`id`, `label`, `extensions`,
`rawLanguage`, `render(doc, ctx)` returning an element). Add it to `renderers` in `index.ts`. Add a fixture
and a test. If it should be an OS "Open With" target, add it to `fileAssociations` in `tauri.conf.json`.

Security rules (keep them): everything from a file goes through `sanitize()` or is set via `textContent`;
never `innerHTML` raw file content; no `eval`; keep `script-src 'self'`; links are intercepted in `main.ts`.

## Roadmap (rough priority)

Product questions and suggested defaults (audience, first run, signing, privacy, fidelity, export...)
are in [docs/PRODUCT.md](docs/PRODUCT.md). Read it before planning bigger features.

1. **Verify on macOS + Windows** (above) and ship v0.1.0 via the release workflow.
2. **Export**: "Export as HTML" (rendered content + inlined CSS), "Print / Save as PDF" (check
   `window.print()` support in each webview), optional DOCX via `pandoc` when it's installed. This was part
   of the original idea (HTML/DOCX/PDF renderers for Markdown).
3. **Text encoding**: detect UTF-16 (BOM) and legacy encodings (`encoding_rs` + `chardetng`) in
   `read_file_data`; Excel CSVs on Windows are often UTF-16/Windows-1252 and currently show garbled.
4. **macOS native tabs**: `.tabbing_identifier("unfold")` on the window builder (macOS only) so
   Window → Merge All Windows works. In-app tabs (setting) maybe later; see docs/PRODUCT.md §10.
5. Native menu bar (File: Open, Open Recent, Export; View: Toggle Raw, Zoom; Window) with the same shortcuts.
6. Remember window size/position (`tauri-plugin-window-state`) and recent files.
7. Math in Markdown (KaTeX, lazy-loaded like Mermaid).
8. Side-by-side diff mode; syntax highlighting inside diffs.
9. Virtualized rendering for huge CSV/log files (currently: CSV pages 1000 rows, logs render all lines
   in `content-visibility` chunks; fine to ~100k lines).
10. More types: YAML/TOML as trees, images, SQLite (read-only table browser), `.env` with value masking.
11. macOS Quick Look extension (spacebar preview). Needs a separate Swift app extension target; Tauri can't
   produce it directly. Could reuse the built `dist/` in a WKWebView.
12. Distribution: code signing (Apple Developer ID + notarization, Windows cert), Homebrew cask, winget,
    AUR, auto-update (`tauri-plugin-updater`).
13. Optional web demo: the frontend already runs standalone in a browser (`npm run build`, host `dist/`).

## Known limitations / notes

- App is unsigned → Gatekeeper / SmartScreen warnings (documented in README).
- Name "Unfold" and identifier `io.github.unfold-viewer` are placeholders; check for conflicts before
  publishing (rename = find/replace "Unfold"/"unfold" + `identifier` in tauri.conf.json).
- The Raw view of Markdown with front matter: highlight.js treats the closing `---` as a setext heading,
  so the YAML is colored oddly. Cosmetic.
- Linux: the single-instance plugin uses D-Bus; without a session bus each launch is a separate process.
- `assetProtocol.scope` is `["**"]` so Markdown can show images from anywhere on disk. Scripts can't run,
  so a file can't use this to read other files, but keep that in mind if scripts are ever allowed.
- `package.json` pins `@playwright/test` to 1.56.1 to match the Chromium in the original cloud
  environment; it's safe to bump (CI runs `playwright install`).

## Releasing

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit, then `git tag v0.1.0 && git push --tags`.
3. The Release workflow builds everything and creates a **draft** release; review it and publish.
