# Contributing

Thanks for wanting to help. Plica is a small personal project maintained by one person, so this page is short.

## What is welcome

- **Bug reports**, especially from Windows and Linux, which get less use by hand. A small file that shows the
  problem helps most.
- **Fixes**, with a test that fails without the fix.
- **Rendering fixes** where Plica shows a file differently from GitHub.
- **Small features that fit what Plica is**: a fast, read-only viewer for the text files developers read.
  Open an issue first for anything bigger than a few lines, so neither of us wastes time.

Not taken: editing files, plugins, accounts or sync, and anything that needs a network connection Plica doesn't
already ask for.

## Before you open a pull request

Run the same checks as CI:

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

The e2e tests need the browsers once: `npx playwright install chromium webkit`.

## Rules the code follows

[ARCHITECTURE.md](ARCHITECTURE.md) has the layout. The short version:

- **Keep it small and fast.** Load heavy libraries lazily (see how `src/renderers/mermaid.ts` imports Mermaid)
  and check the sizes `npm run build` prints when you add a dependency.
- **File content is untrusted.** Sanitize HTML with `sanitize()` from `src/lib/sanitize.ts` or use
  `textContent`. Don't loosen the Content Security Policy in `src-tauri/tauri.conf.json` (the test server
  mirrors it in `vite.config.ts`).
- **One renderer per file** in `src/renderers/`, registered in `index.ts`, with a fixture in `tests/fixtures/`
  and a test.
- **Add a line to [CHANGELOG.md](CHANGELOG.md)** under Unreleased for anything a user would notice.

By contributing you agree that your work is released under the [MIT License](LICENSE).
