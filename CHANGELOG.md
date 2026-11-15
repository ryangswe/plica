# Changelog

All notable changes to Plica are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-14

The first release.

### Added

- Rendered views for Markdown (GitHub style, with Mermaid, alerts, front matter and a table of contents),
  JSON / JSONC / JSON Lines, CSV / TSV, Jupyter notebooks, logs, diffs, Mermaid, SVG and HTML, and highlighted
  source for any other text file. <kbd>Cmd/Ctrl</kbd> + <kbd>/</kbd> toggles the raw source.
- Find in file, zoom, live reload on save, back after following a link to another file.
- Text encoding detection (UTF-16, Windows-1252, Shift_JIS and more), with Reopen with Encoding.
- Remote images blocked until you allow them, once or always.
- Several files or a folder in one window, with a file list on the left; Cmd/Ctrl-click, drag out or right-click
  to give a file its own window.
- File → Recent Changes: Markdown and text files changed this week, newest first.
- Clicking a web link opens it in the browser; `file.md:42` links open the file.
- macOS: native menu bar and tabs, Open Recent, Open in Editor, Default Apps for choosing which file types
  Plica opens, and staying open after the last window closes.

[Unreleased]: https://github.com/ryangswe/plica/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ryangswe/plica/releases/tag/v0.1.0
