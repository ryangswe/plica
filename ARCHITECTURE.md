# Architecture

How Plica is put together, for contributors. Plica is a read-only viewer: Tauri 2 (Rust shell + the OS's
web engine) with a TypeScript frontend and no UI framework.

## Layout

```
src/                     web frontend (TypeScript, no framework, Vite)
  main.ts                app shell: top bar, Preview/Raw toggle, shortcuts, live reload, link handling, history
  host.ts                platform layer: Tauri host (desktop) vs browser host (dev/tests/web demo)
  defaults.ts            the Default Apps window
  find.ts                find-in-page bar (matches across formatting; points to Raw for off-screen matches)
  types.ts               FileDoc, Renderer, RenderContext
  renderers/             one file per type + index.ts registry (first match wins, codeRenderer is fallback)
    raw.ts               line-numbered highlighted source (used for every Raw view)
  lib/                   highlight (highlight.js), sanitize (DOMPurify), ansi, paths, decode, reload, dom helpers
  styles.css             all styling; CSS variables for light/dark
src-tauri/
  src/lib.rs             windows, OS open events, watching, macOS tabs, startup
  src/files.rs           reading files for the frontend (size cap, binary, encodings); which watch events matter
  src/encoding.rs        bytes → text (BOM, UTF-16, UTF-8, legacy-encoding guess)
  src/defaults.rs        which app opens each file type; make Plica the default (macOS: NSWorkspace + UTType)
  src/chrome.rs          macOS: tells each window when the tab bar shows or it goes full screen (the toolbar
                         is drawn in the transparent title bar)
  src/settings.rs        settings.json (editor, recent files, remote images, prompts)
  src/menu.rs            macOS menu bar, Open Recent (AppKit-managed), Open in Editor; commands the
                         frontend owns are sent to the focused window as `menu` events
  tauri.conf.json        CSP, asset protocol, file associations, bundle settings
  capabilities/          permissions granted to windows (labels w0, w1, ...)
tests/
  fixtures/              sample files for every type (also nice for manual testing)
  unit/                  vitest
  e2e/                   playwright (Chromium + WebKit); screenshots in test-results/screens/<browser>/
  macos/smoke.sh         opens files in the installed .app via `open -a` and checks the windows/tabs (local only)
```

Flow: Rust creates a window per file and stores the path as "pending". The frontend registers listeners,
then calls `take_initial_file`. Files opened later (macOS Opened event, second launch) either reuse an empty
window (`open-path` event) or create a new one. `read_file` returns `{path, name, text, size, binary,
truncated, encoding}` (64 MB cap; zero bytes that aren't UTF-16 = binary). `watch_file` watches the parent dir and emits `file-changed`
to that window only (changes and removals); the frontend debounces and re-reads, retrying briefly, and shows a
"moved or deleted" bar if the file stays unreadable.

Adding a renderer: create `src/renderers/foo.ts` exporting a `Renderer` (`id`, `label`, `extensions`,
`rawLanguage`, `render(doc, ctx)` returning an element). Add it to `renderers` in `index.ts`. Add a fixture
and a test. If it should be an OS "Open With" target, add it to `fileAssociations` in `tauri.conf.json`.

Remote content: `sanitize()` (and `guardRemoteHtml()` for Mermaid's SVG) moves remote URLs on images, media
and SVG `<image>` to `data-remote-*` unless `ctx.remote.allow`; this has to happen on the inert parsed copy,
because an `<img>` starts downloading as soon as it's created. The HTML preview gets its own CSP inside the
frame. The asset protocol may read any local file (hidden folders included, so `.github/` images work) except
common secret folders (`.ssh`, `.aws`, ...); pages can't run scripts, so they can only display what they reference.

Security rules (keep them): everything from a file goes through `sanitize()` or is set via `textContent`;
never `innerHTML` raw file content; no `eval`; keep `script-src 'self'`; links are intercepted in `main.ts`.


## Tests

- `npm run typecheck && npm test && npm run test:e2e`, plus `cargo clippy` and `cargo test` (see CLAUDE.md).
- The e2e tests run against `vite preview`, which sends the same CSP as the app; any CSP violation fails a
  test. Locally, Playwright reuses whatever is already on port 1420, so stop `tauri dev` first.
- `tests/macos/smoke.sh` (macOS only, needs a real screen): after installing the built app, checks how files
  open (cold start, second file, reopen, native tabs, quit). Run it when touching window or file-opening code.

## Releasing

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit, then `git tag v0.1.0 && git push --tags`.
3. The Release workflow builds everything and creates a **draft** release; review it and publish.
