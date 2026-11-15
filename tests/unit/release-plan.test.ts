import { describe, expect, it } from "vitest";
import { changelogSection, compareVersions, plan } from "../../scripts/release-plan";

const changelog = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-12-01

### Added

- A feature with a long line that wraps
  onto a second line. Press <kbd>Cmd</kbd> + <kbd>/</kbd>.

## [0.1.1] - 2026-11-15

### Fixed

- A fix.

[Unreleased]: https://github.com/ryangswe/plica/compare/v0.2.0...HEAD
`;

const same = (v: string) => ({ "package.json": v, "src-tauri/Cargo.toml": v, "src-tauri/tauri.conf.json": v });

describe("release plan", () => {
  it("releases a new version with its changelog section as notes", () => {
    const p = plan({ versions: same("0.2.0"), tags: ["v0.1.0", "v0.1.1"], changelog });
    expect(p.create).toBe(true);
    expect(p.notes).toContain("- A feature with a long line that wraps onto a second line. Press Cmd + /.");
    expect(p.notes).not.toContain("A fix.");
    expect(p.notes).toContain("`Plica_0.2.0_aarch64.dmg`");
  });
  it("does nothing when the version is already tagged", () => {
    expect(plan({ versions: same("0.1.1"), tags: ["v0.1.0", "v0.1.1"], changelog })).toMatchObject({ create: false });
  });
  it("refuses files that disagree, a missing dated section, or a version below the newest tag", () => {
    expect(() => plan({ versions: { ...same("0.2.0"), "package.json": "0.1.9" }, tags: [], changelog })).toThrow(/differs/);
    expect(() => plan({ versions: same("0.3.0"), tags: ["v0.2.0"], changelog })).toThrow(/no "## \[0.3.0\]/);
    expect(() => plan({ versions: same("0.1.5"), tags: ["v0.2.0"], changelog: "## [0.1.5] - 2026-12-02\n" })).toThrow(/lower/);
  });
  it("finds only dated sections and compares versions by number", () => {
    expect(changelogSection(changelog, "0.1.1")).toBe("### Fixed\n\n- A fix.");
    expect(changelogSection("## [0.3.0]\n- undated\n", "0.3.0")).toBeNull();
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  });
});
