// Decides whether a push to main is a new release, for .github/workflows/release.yml.
//
// A release is a version (the same in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json)
// that has no `v<version>` tag yet and a dated section in CHANGELOG.md. The section becomes the
// release notes. A push that leaves the version alone does nothing; a new version with no dated
// changelog section, files that disagree, or a version below the newest tag fail the workflow.
//
// Usage: node scripts/release-plan.ts <tags file, one tag per line> <notes file to write>
// Prints `create=true|false` and `version=X.Y.Z` lines for $GITHUB_OUTPUT.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Plan {
  create: boolean;
  version: string;
  /** Release notes (only when create is true). */
  notes?: string;
  /** Why nothing is released. */
  reason?: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Negative if a < b, 0 if equal, positive if a > b (X.Y.Z only). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)!.slice(1).map(Number);
  const pb = SEMVER.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The body of `## [version] - YYYY-MM-DD` in the changelog, or null if there is no dated section. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const head = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## [") || /^\[[^\]]+\]: /.test(line)) break; // next version, or the link list
    body.push(line);
  }
  return body.join("\n").trim();
}

/** GitHub shows every line break in release notes, so join the changelog's wrapped lines. */
function unwrap(markdown: string): string {
  return markdown.replace(/\n {2}(?=\S)/g, " ").replace(/<kbd>([^<]*)<\/kbd>/g, "$1");
}

function installNotes(version: string): string {
  return `### Install

macOS, with no security warning: \`curl -fsSL https://raw.githubusercontent.com/ryangswe/plica/main/scripts/install-macos.sh | bash\`

Or download:

| System | File |
|---|---|
| macOS, Apple Silicon | \`Plica_${version}_aarch64.dmg\` |
| macOS, Intel | \`Plica_${version}_x64.dmg\` |
| Windows | \`Plica_${version}_x64-setup.exe\` (or the \`.msi\`) |
| Linux | \`.AppImage\`, \`.deb\` or \`.rpm\` |

A downloaded copy isn't notarized or signed, so the first launch shows a warning. On macOS, open Plica once, then go to **System Settings → Privacy & Security** and click **Open Anyway**; on Windows, click **More info → Run anyway** in SmartScreen. Details are in the [README](https://github.com/ryangswe/plica#install).
`;
}

export function plan(input: { versions: Record<string, string>; tags: string[]; changelog: string }): Plan {
  const found = Object.entries(input.versions);
  const version = found[0][1];
  const differ = found.filter(([, v]) => v !== version);
  if (differ.length) {
    throw new Error(`The version differs between files: ${found.map(([f, v]) => `${f} ${v}`).join(", ")}`);
  }
  if (!SEMVER.test(version)) throw new Error(`Version ${version} isn't X.Y.Z`);

  if (input.tags.includes(`v${version}`)) return { create: false, version, reason: `v${version} is already tagged` };

  const released = input.tags.map((t) => t.replace(/^v/, "")).filter((v) => SEMVER.test(v));
  const newest = released.sort(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) < 0) {
    throw new Error(`Version ${version} is lower than the newest tag v${newest}`);
  }

  const section = changelogSection(input.changelog, version);
  if (section === null) {
    throw new Error(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section; add one to release ${version}`);
  }
  return { create: true, version, notes: `${unwrap(section)}\n\n${installNotes(version)}` };
}

function readVersions(): Record<string, string> {
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("src-tauri/Cargo.toml", "utf8"));
  return {
    "package.json": (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version,
    "src-tauri/Cargo.toml": cargo?.[1] ?? "(none)",
    "src-tauri/tauri.conf.json": (JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { version: string }).version,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tagsFile, notesFile] = process.argv.slice(2);
  const tags = readFileSync(tagsFile, "utf8").split("\n").map((t) => t.trim()).filter(Boolean);
  const result = plan({ versions: readVersions(), tags, changelog: readFileSync("CHANGELOG.md", "utf8") });
  if (result.notes) writeFileSync(notesFile, result.notes);
  console.error(result.create ? `Releasing ${result.version}.` : `Nothing to release: ${result.reason}.`);
  console.log(`create=${result.create}`);
  console.log(`version=${result.version}`);
}
