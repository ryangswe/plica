# Plica

Cross-platform read-only viewer for Markdown and other dev files (Tauri 2 + TypeScript, no UI framework).
**Read HANDOFF.md first**: status, what's unverified, architecture, roadmap.
Product decisions and open questions: docs/PRODUCT.md.

## Commands

- `npm run tauri dev`: run the desktop app
- `npm run dev`: UI only, in a browser (drag & drop files)
- `npm run typecheck && npm test && npm run test:e2e`: run all of these before committing
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `npm run tauri build`: installers for the current OS

## Conventions

- Keep it small and fast. Heavy libraries must be lazy-loaded (see how `mermaid` is imported in
  `src/renderers/mermaid.ts`). Check `npm run build` output sizes when adding dependencies.
- File content is untrusted: sanitize HTML with `sanitize()` from `src/lib/sanitize.ts` or use
  `textContent`. Never loosen the CSP in `src-tauri/tauri.conf.json` without a strong reason (the
  e2e preview server mirrors it in `vite.config.ts`, so update both).
- One renderer per file in `src/renderers/`, registered in `index.ts`, with a fixture in `tests/fixtures/`
  and tests in `tests/unit/` and/or `tests/e2e/`.
- All Rust lives in `src-tauri/src/lib.rs` unless it grows past ~500 lines.
- Update HANDOFF.md (status + roadmap) when you finish something on it.
