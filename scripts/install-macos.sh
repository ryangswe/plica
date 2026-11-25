#!/bin/bash
# Installs the latest Plica release into /Applications (or ~/Applications if that isn't writable).
#
#   curl -fsSL https://raw.githubusercontent.com/ryangswe/plica/main/scripts/install-macos.sh | bash
#
# Plica isn't notarized by Apple, so a .dmg downloaded in a browser opens with a "could not verify ... free
# of malware" warning. Files that curl downloads aren't marked as downloaded, so this install skips that
# warning. The script checks the .dmg against the SHA-256 GitHub recorded for it before installing.
#
# Settings for testing: PLICA_RELEASE_API (the release JSON URL), PLICA_INSTALL_DIR (where Plica.app goes).
set -euo pipefail

api="${PLICA_RELEASE_API:-https://api.github.com/repos/ryangswe/plica/releases/latest}"

fail() { echo "Plica install: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS; see https://github.com/ryangswe/plica#install"
case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x64 ;;
  *) fail "unknown processor $(uname -m)" ;;
esac

tmp="$(mktemp -d)"
mnt="$tmp/mnt"
cleanup() {
  if [ -d "$mnt" ]; then hdiutil detach -quiet "$mnt" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "Finding the latest Plica release..."
curl -fsSL "$api" -o "$tmp/release.json" || fail "couldn't reach GitHub ($api)"

# Pick the .dmg for this Mac: its name, download URL and SHA-256 (JSON parsed with macOS's own JavaScript).
read -r tag name url digest < <(osascript -l JavaScript - "$tmp/release.json" "$arch" <<'JS'
function run(argv) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js;
  const release = JSON.parse(text);
  const asset = (release.assets || []).find((a) => a.name.endsWith(`_${argv[1]}.dmg`));
  if (!asset) return "";
  return [release.tag_name, asset.name, asset.browser_download_url, (asset.digest || "").replace(/^sha256:/, "")].join(" ");
}
JS
) || true
[ -n "${url:-}" ] || fail "the latest release has no .dmg for this Mac ($arch)"
[ -n "${digest:-}" ] || fail "GitHub didn't list a SHA-256 for $name, so it can't be checked"

echo "Downloading $name ($tag)..."
curl -fL --progress-bar "$url" -o "$tmp/$name" || fail "download failed"
actual="$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)"
[ "$actual" = "$digest" ] || fail "$name doesn't match the SHA-256 GitHub lists for it; nothing was installed"

hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$tmp/$name" || fail "couldn't open $name"
[ -d "$mnt/Plica.app" ] || fail "$name has no Plica.app"

dir="${PLICA_INSTALL_DIR:-/Applications}"
if [ -z "${PLICA_INSTALL_DIR:-}" ] && [ ! -w "$dir" ]; then
  dir="$HOME/Applications"
fi
mkdir -p "$dir"

if [ -z "${PLICA_INSTALL_DIR:-}" ] && pgrep -qx plica; then
  echo "Quitting the running Plica..."
  osascript -e 'tell application id "dev.plica.viewer" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -qx plica || break; sleep 0.5; done
fi

rm -rf "$dir/Plica.app"
ditto "$mnt/Plica.app" "$dir/Plica.app"
xattr -dr com.apple.quarantine "$dir/Plica.app" 2>/dev/null || true
codesign --verify --deep --strict "$dir/Plica.app" 2>/dev/null || fail "the installed app's signature doesn't check out"

echo "Installed Plica ${tag#v} in $dir/Plica.app"
