#!/usr/bin/env bash
# macOS smoke test for how the installed app opens files (things CI can't check).
# `open -a` sends the same "open documents" Apple Event as a Finder double-click.
#
#   npm run tauri build -- --bundles app && cp -R src-tauri/target/release/bundle/macos/Plica.app /Applications/
#   tests/macos/smoke.sh [/Applications/Plica.app]
#
# Needs Screen Recording permission for your terminal (to read window titles).
# Quits Plica when done. Uses a Plica-only "prefer tabs" setting and removes it again, and restores
# Plica's settings.json (Open Recent, editor choice) afterwards.
set -euo pipefail
APP="${1:-/Applications/Plica.app}"
FIX="$(cd "$(dirname "$0")/../fixtures" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0

# Quit like Cmd+Q does (AppKit terminate). Plica stays alive when its last window closes, so make sure
# quitting still ends the process.
quit() {
  osascript -e 'quit app "Plica"' >/dev/null 2>&1 || true
  for _ in $(seq 20); do pgrep -xq plica || return 0; sleep 0.25; done
  echo "FAIL quit: Plica is still running"; fails=$((fails + 1)); pkill -x plica || true
}
# Right after a quit, LaunchServices can briefly refuse to relaunch (error -600/-609), so retry.
launch() {
  for _ in 1 2 3 4 5; do open -a "$APP" "$@" 2>/dev/null && return 0; sleep 1; done
  echo "FAIL could not launch $APP $*"; exit 1
}
open_file() { launch "$@"; sleep "${WAIT:-2.5}"; }
# All windows, or only the visible ones (background tabs are off screen).
windows() { osascript -l JavaScript "$HERE/windows.js" | awk -F'\t' -v m="${1:-all}" 'm=="all" || $2=="on" {print $1}' | tr '\n' ' ' | sed 's/ $//'; }
expect() { # description, expected, actual
  if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: expected [$2], got [$3]"; fails=$((fails + 1)); fi
}
# The test opens fixtures, which would land in the user's Open Recent list: put their settings back after.
SETTINGS="$HOME/Library/Application Support/dev.plica.viewer/settings.json"
BACKUP="$(mktemp)"; had_settings=0; [[ -f "$SETTINGS" ]] && cp "$SETTINGS" "$BACKUP" && had_settings=1
cleanup() {
  quit
  defaults delete dev.plica.viewer AppleWindowTabbingMode >/dev/null 2>&1 || true
  if ((had_settings)); then cp "$BACKUP" "$SETTINGS"; else rm -f "$SETTINGS"; fi
  rm -f "$BACKUP"
}
trap cleanup EXIT

quit
open_file "$FIX/sample.md";              expect "cold start with a file: one window" "sample.md" "$(windows)"
open_file "$FIX/data.csv";               expect "second file while running: new window" "data.csv sample.md" "$(windows)"
open_file "$FIX/sample.md";              expect "reopening a file: no duplicate" "data.csv sample.md" "$(windows)"
launch; sleep 1.5;                       expect "Dock click with windows open: no new window" "data.csv sample.md" "$(windows)"
quit
open_file "$FIX/sample.md" "$FIX/app.log"; expect "cold start with two files: one window" "app.log" "$(windows)"
quit
launch; sleep 2.5;                       expect "plain launch: one empty window" "Plica" "$(windows)"
open_file "$FIX/app.log";                expect "file goes into the empty window" "app.log" "$(windows)"
quit

# Batches: several files at once, or a folder, become one window with the files listed in a sidebar
# (name order, binaries skipped), showing the first one. The window title is the file shown.
recent_first() { python3 -c 'import json,sys,os; r=json.load(open(sys.argv[1])).get("recent",[]); print(os.path.basename(r[0]) if r else "")' "$SETTINGS"; }
open_file "$FIX/sample.md" "$FIX/app.log" "$FIX/data.csv"
expect "three files at once: one window, first by name" "app.log" "$(windows)"
open_file "$FIX/data.csv";               expect "a listed file opens in that window" "data.csv" "$(windows)"
quit
BATCH="$(mktemp -d)"; mkdir "$BATCH/sub"
for n in a1 a2 a10; do printf '# %s\n' "$n" > "$BATCH/$n.md"; done
printf '\x89PNG\x00\x00\x01' > "$BATCH/logo.png"; printf 'x' > "$BATCH/.hidden.md"; printf 'x' > "$BATCH/sub/inner.md"
open_file "$BATCH";                      expect "folder: one window, first by name" "a1.md" "$(windows)"
expect "folder: in Open Recent as the folder" "$(basename "$BATCH")" "$(recent_first)"
open_file "$BATCH/a10.md";               expect "a file of that folder opens in its window" "a10.md" "$(windows)"
open_file "$BATCH";                      expect "the same folder again: no second window" "a1.md" "$(windows)"
open_file "$FIX/other.md";               expect "a file outside the folder: its own window" "a1.md other.md" "$(windows)"
rm -rf "$BATCH"
quit

defaults write dev.plica.viewer AppleWindowTabbingMode always
open_file "$FIX/sample.md"; open_file "$FIX/data.csv"
expect "prefer tabs: both files in one window" "data.csv" "$(windows on)"
expect "prefer tabs: other file in a background tab" "data.csv sample.md" "$(windows)"
open_file "$FIX/sample.md";              expect "reopening selects its tab" "sample.md" "$(windows on)"

echo; if ((fails)); then echo "$fails check(s) failed"; exit 1; else echo "all checks passed"; fi
