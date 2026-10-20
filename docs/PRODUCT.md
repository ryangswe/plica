# Product notes

Thinking about turning Plica from a working prototype into something people trust and keep installed,
for developers and for non-technical people who just received a `.md` or `.csv` file.

Nothing here is decided. Each section lists the questions, what's at stake, and a **suggested default**.
Settle a decision, record it in the "Decision log" at the bottom, and move the work into the roadmap in
HANDOFF.md.

---

## 1. The core promise (protect this above everything)

> Double-click a file → it's readable, instantly. One key shows the source.

Every feature should be checked against this promise. The big risk is scope creep into an editor, a
notes app, or an IDE-lite, which plenty of products already do (Typora, Obsidian, VS Code).

- **Viewer, not editor.** People will ask "let me just fix this typo". Suggested answer: an
  **"Open in editor"** button (Cmd/Ctrl+E) that opens the file in their default or configured editor,
  plus live reload, so the change shows up immediately. Revisit in-app editing only if demand is
  overwhelming.
- **Explicit non-goals for 1.0:** editing, syncing, accounts, cloud anything, a plugin marketplace,
  managing a folder of notes.
- Speed is a feature. If a change makes cold start noticeably slower, it needs a strong reason.

## 2. Two audiences, different needs

| | Developers | Non-technical people |
|---|---|---|
| How they get a file | READMEs, docs folders, logs, `git diff`, notebooks, API responses | Email attachments, downloads, a coworker's "notes.md", CSV exports |
| What they want | Speed, keyboard control, fidelity to GitHub, CLI, opening their editor | "Make this look normal", no jargon, no scary warnings |
| Dealbreakers | Slow, wrong rendering, "phones home" | Install warnings, raw text without explanation, anything that looks broken |

Implications:
- **Labels:** "Preview / Raw" is fine for developers. Consider "Formatted / Plain text" for everyone, or
  keep the short labels with tooltips that explain them. Suggested: keep "Preview / Raw" but write the
  tooltips for non-technical readers.
- **Non-technical people need the app to explain itself:** a short line like "This is a Markdown file, a
  plain-text format for formatted documents" on first open of each type, dismissible.
- **Developers need a CLI:** `plica README.md`, `plica .` (see folder mode), and **piping**:
  `git diff | plica`, `curl … | plica --json`, `cat app.log | plica --log`. Piped input is a strong
  developer feature and cheap to add (read stdin, pick a type from a flag or by sniffing the content).

## 3. First run and becoming the default app

This is the single biggest friction point. The app is useless until it's the default for `.md`.

- **The OSes don't let apps silently make themselves the default:** Windows 10/11 forbids it, and macOS
  makes it awkward. We need a guided flow.
- **Suggested:** a first-run screen, "Open these with Plica": ☑ Markdown ☐ JSON ☐ CSV ☐ Notebooks
  ☐ Logs ☐ Diffs, with per-OS steps or deep links (Windows: open the "Default apps" settings page for
  Plica; macOS: try `LSSetDefaultRoleHandlerForContentType`, falling back to the Get Info steps).
- **Don't grab CSV or JSON by default.** Non-technical users often want CSV in Excel/Numbers.
  Markdown only should be pre-checked.
- Settings should show and re-run this ("Default apps…").
- The empty state should teach the three shortcuts and offer the sample file.

## 4. Trust: signing, install, updates

For non-technical users and most corporate developers, **an unsigned app might as well not exist**.
macOS's "damaged, move to Trash" dialog reads like malware.

- **macOS:** Apple Developer Program ($99/year) → Developer ID signing + notarization in the release
  workflow. Required before promoting to non-developers.
- **Windows:** code signing to avoid SmartScreen. Options: Azure Trusted Signing (cheap monthly), or
  SignPath's free tier for open source. Offer an installer that doesn't need admin rights: NSIS per-user
  install (Tauri supports it) for locked-down work laptops.
- **Package managers** (how developers expect to install): Homebrew cask, winget, Scoop, AUR, Flatpak
  (Flathub). Each needs a maintainer; automate in the release workflow where possible.
- **Updates:** `tauri-plugin-updater` with signed update manifests on GitHub Releases. Decide:
  ask-before-update (suggested) vs silent. Must work offline gracefully.
- **Budget:** about $100–200/year for signing. Decide who pays (GitHub Sponsors / Open Collective?).

## 5. Privacy and security as selling points

"Doesn't phone home" is a feature people choose apps for.

- **No telemetry, no network calls by default.** Say so in the README and the About box. If we ever
  want crash reports, make them opt-in and local-first. Without telemetry, measure success through
  downloads, stars, and issues, and make "Report a problem" (link to new GitHub issue with
  OS/version prefilled) easy to find.
- **Remote images in Markdown leak your IP** (tracking pixels, like email). Decision needed:
  - suggested: load remote images by default for local files (people expect READMEs with badges to
    look right), with a setting "Block remote content" (default on in a future "strict mode");
  - alternatively, block by default with a "Load remote images" bar like mail clients do.
- Keep the current rules: sanitize everything, no scripts, sandboxed HTML preview, strict CSP. Write a
  short SECURITY.md (how to report issues, the threat model: "files are untrusted").
- Review the asset protocol scope (`**`) before 1.0; consider limiting it to the open file's folder tree.

## 6. Performance budgets (write them down, test them)

Suggested targets, measured on a mid-range Windows laptop, the slowest likely environment:

| Metric | Target |
|---|---|
| Double-click to content visible (cold start) | < 500 ms |
| Opening another file while running | < 150 ms |
| Memory per open window | < 80 MB |
| Installer size | < 10 MB (except AppImage) |
| 50 MB log / 500k-row CSV | Opens without freezing; scrolls smoothly |

Huge files need virtualized rendering (already on the roadmap). A rough benchmark script in CI that fails
on large regressions would keep this honest.

## 7. Rendering fidelity: "looks like GitHub"

Developers will compare against GitHub's rendering and file bugs on every difference.

- **Pick GitHub-Flavored Markdown as the reference.** Missing today: footnotes, math (`$…$`, ```` ```math ````),
  emoji shortcodes (`:tada:`), GitHub's exact heading-anchor rules, `<picture>` / dark-mode image
  variants (`#gh-dark-mode-only`), and auto-linking of bare URLs (check).
- **Other popular flavors:** Obsidian (`[[wikilinks]]`, `> [!callout]` variants, embeds), MkDocs
  admonitions (`!!! note`), Docusaurus admonitions. Suggested: support Obsidian wikilinks and callouts
  (large non-developer audience), and ignore the rest until someone asks.
- **Visual regression tests:** screenshot each fixture in CI and compare against approved images,
  so a library update can't silently break rendering.
- **The web engine differs by OS:** WebKit on macOS/Linux, Chromium (WebView2) on Windows. The same
  CSS can render differently. Run the e2e suite in WebKit too (Playwright supports it) to catch macOS
  issues on Linux CI.

## 8. Files in the real world (correctness gaps to close)

- **Text encoding.** The Rust side currently decodes everything as UTF-8 (with replacement characters).
  CSVs exported from Excel on Windows are often **UTF-16 or Windows-1252**, so they'll show up garbled.
  Detect BOMs (UTF-16 LE/BE) and fall back to a charset detector (e.g. the `chardetng` crate +
  `encoding_rs`). High priority for non-technical users.
- **Line endings, very long lines, minified JSON on one line** (the tree view handles it; the raw view
  should offer soft wrap).
- **File moved or deleted while open:** show "This file was moved or deleted" instead of failing silently.
- **Permission denied, network drives, OneDrive/iCloud placeholder files** (not downloaded yet): friendly
  messages.
- **Excel-style CSV quirks:** `;` delimiters in European locales (papaparse auto-detects; verify),
  `sep=;` first line, leading zeros (never coerce types).

## 9. Feeling native on each OS

- **Menus:** a proper menu bar (File, Edit, View, Window, Help) with standard shortcuts. On macOS:
  Cmd+W closes the window, Cmd+Q quits, Cmd+, opens settings.
- **Recent files** registered with the OS (macOS Recent Documents / Dock menu, Windows Jump List).
- **"Reveal in Finder/Explorer"**, "Copy file path", and drag-out of the title for developers.
- **Windows vs tabs** (see the next section).
- **Session restore:** reopen the windows from last time? Suggested: no, because a viewer should
  start clean; offer it as a setting.
- **Remember per-file state:** scroll position and mode (Preview/Raw) per file path. Small touch,
  feels polished.
- **Previews in the file browser** (spacebar Quick Look on macOS, Explorer preview pane on Windows) are
  the ultimate in "seamless", but they're separate native components. Post-1.0.

## 10. Windows vs tabs (from our discussion)

- **Default: one window per file**, like Preview or a PDF viewer. This already works.
- **macOS native tabs:** add `.tabbing_identifier("plica")` to the window builder in `create_window`
  (macOS only), so Window → Merge All Windows and the "Prefer tabs" system setting work. Test on a Mac.
- **Later, optional:** in-app tabs as a setting ("Open files in: New window / Tab in current window").
  This is the only way to get tabs on Windows/Linux, and it saves memory when many files are open.
  Requires deciding which window a double-clicked file goes to (suggested: the most recently focused).

## 11. Sharing and export (the original idea)

The tweet that started this was about HTML/DOCX/PDF renderers. For non-technical users, sharing is often
the whole point.

- **Copy as rich text:** copy the rendered view and paste it into Google Docs, Word, Slack or email with
  formatting intact. Likely the single most useful sharing feature, and cheap (copy the rendered HTML to
  the clipboard as `text/html`).
- **Export → HTML** (self-contained file with inlined CSS and images), **PDF** (print with clean print
  styles: no top bar, sensible page breaks), **DOCX** (needs pandoc or a JS docx library; consider
  bundling nothing and using pandoc only if it's installed).
- **CSV → Excel** export? Probably unnecessary: "Open with Excel" is fine.

## 12. Settings (keep the list short)

Every setting is a maintenance cost. Suggested 1.0 list: theme (System / Light / Dark), font size,
reading width (narrow/wide), default mode for each type (Preview/Raw), open in window vs tab, remote
content on/off, default apps. That's it.

## 13. Accessibility and international users

- Keyboard-only use everywhere; visible focus; screen-reader labels (VoiceOver, NVDA) on all controls;
  respect "reduce motion" and Windows high-contrast mode; WCAG AA contrast in both themes.
- Right-to-left text (Arabic/Hebrew Markdown: use `dir="auto"` on blocks), CJK fonts and line breaking.
- The UI has few strings; plan for translation early (keep strings in one place) even if 1.0 is English only.

## 14. Name, identity, website

- **Name decided: Plica** (Latin for "a fold"; the raw text folds into the rendered view). Domain:
  **plica.dev**. Bundle identifier: `dev.plica.viewer`; keep it fixed from the first public release on,
  since macOS/Windows tie file associations and stored settings to it. Still to check before launch:
  trademarks, and Homebrew/winget package-name availability.
- A one-page website (GitHub Pages) with download buttons that detect the visitor's OS, and the web demo
  (the frontend already runs in a browser) so people can try it before installing.

## 15. Open-source project health

- CONTRIBUTING.md (how to add a renderer, how to run tests), issue templates (bug report with OS/version and
  a sample file; feature request), CODE_OF_CONDUCT.md, CHANGELOG.md, semantic versioning.
- A rule for new file types: renderer + fixture + tests + lazy-loading if the dependency is heavy.
- Decide scope publicly (the non-goals in section 1) to set expectations and make saying no easier.
- Funding: GitHub Sponsors to cover signing costs.

## 16. Open questions for the owner

1. Primary audience for 1.0: developers first (CLI, piping, fidelity) or everyone (first-run guide,
   signing, plain-language UI)? Suggested: developers first, but don't make choices that block
   non-developers later. Signing is the gate for the second group.
2. Folder mode (`plica docs/` with a file sidebar for browsing a docs folder): very useful for
   developers, but it's the first step toward being a notes app. In or out for 1.0?
3. Willing to pay ~$100–200/year for code signing?
4. Final name?

---

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-19 | One window per file by default; native macOS tabs; in-app tabs maybe later | Matches "open like a PDF"; tabs are cheap on macOS |
| 2026-10-20 | **Developers first** for 1.0 | Owner's call; don't block non-developers later |
| 2026-10-20 | **Folder mode deferred** to a later iteration, after more product thinking. Ship a cheap stopgap first: next/previous file in the same folder | Browsing several .md files without piling up windows is useful, but a sidebar is the first step toward a notes app |
| 2026-10-20 | **Name: Plica**, domain plica.dev, private repo ryangswe/plica during development | Recto/Gander/Sheaf were taken by similar apps; Plica had no software clashes |
| 2026-10-20 | **Will pay for the Apple Developer Program** ($99/year, recurring) for signing + notarization | Signing is required for anyone beyond tolerant developers; Homebrew is also moving away from unsigned apps |
