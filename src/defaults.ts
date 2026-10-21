import { el } from "./lib/dom";

/** Who opens one extension now (from the desktop shell). */
export interface ExtensionApp {
  ext: string;
  app: string | null;
  isPlica: boolean;
}

export interface FileTypeInfo {
  id: string;
  label: string;
  extensions: ExtensionApp[];
  /** Plica already opens every extension of this type. */
  isPlica: boolean;
}

export interface DefaultAppsInfo {
  /** Plica can set defaults itself (macOS); otherwise show instructions. */
  supported: boolean;
  platform: "macos" | "windows" | "linux";
  types: FileTypeInfo[];
}

export interface SetResult {
  id: string;
  ok: boolean;
  error: string | null;
}

/** Plain-words state of one file type, e.g. "Opens in Typora" or "Partly: .geojson opens in Xcode". */
export function describeCurrent(t: FileTypeInfo): string {
  if (t.isPlica) return "Plica";
  const others = t.extensions.filter((e) => !e.isPlica);
  const apps = new Set(others.map((e) => e.app));
  if (others.length === t.extensions.length && apps.size === 1) {
    const [app] = apps;
    return app ? `Opens in ${app}` : "No app set";
  }
  const parts = others.map((e) => (e.app ? `.${e.ext} opens in ${e.app}` : `.${e.ext} has no app`));
  return `Partly Plica: ${parts.join(", ")}`;
}

/** "Markdown", "Markdown and CSV", "Markdown, CSV and Logs". */
export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const INSTRUCTIONS: Record<string, string> = {
  windows:
    "Windows doesn't let apps make themselves the default. Open Settings → Apps → Default apps, search for Plica, and pick the file types you want it to open.",
  linux:
    "Right-click a file of that type in your file manager → Open With → Other Application → Plica, and choose to use it as the default.",
};

/**
 * The Default Apps window: one checkbox per file type, what opens it now, Select all, Apply.
 * Markdown is pre-checked; types Plica already opens are checked and locked. Nothing changes until Apply.
 * Returns the backdrop element (already in the document); it removes itself when closed.
 */
export function openDefaultAppsSheet(
  info: DefaultAppsInfo,
  apply: (ids: string[]) => Promise<SetResult[]>,
  done: (message: string) => void,
): HTMLElement {
  const backdrop = el("div", { class: "sheet-backdrop" });
  const title = el("h2", { id: "default-apps-title" }, "Open these files with Plica");
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "default-apps-title" }, title);
  backdrop.append(sheet);
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("click", (e) => e.target === backdrop && close());

  if (!info.supported) {
    sheet.append(el("p", {}, INSTRUCTIONS[info.platform] ?? INSTRUCTIONS.linux));
    const ok = el("button", { class: "primary" }, "Close");
    ok.addEventListener("click", close);
    sheet.append(el("div", { class: "sheet-actions" }, ok));
    document.body.append(backdrop);
    ok.focus();
    return backdrop;
  }

  sheet.append(el("p", { class: "muted" }, "Double-clicking these files will open them in Plica. You can come back here any time from Plica → Default Apps…"));
  const boxes: { type: FileTypeInfo; box: HTMLInputElement; status: HTMLElement }[] = [];
  const list = el("ul", { class: "type-list" });
  for (const type of info.types) {
    const box = el("input", { type: "checkbox", "data-id": type.id }) as HTMLInputElement;
    box.checked = type.isPlica || type.id === "markdown";
    box.disabled = type.isPlica;
    const status = el("span", { class: `type-current${type.isPlica ? " is-plica" : ""}` }, describeCurrent(type));
    const exts = type.extensions.map((e) => `.${e.ext}`).join(" ");
    list.append(el("li", {}, el("label", {}, box, el("span", { class: "type-label" }, type.label), el("span", { class: "muted type-exts" }, exts)), status));
    boxes.push({ type, box, status });
  }
  const pending = () => boxes.filter((b) => b.box.checked && !b.box.disabled);
  const all = el("input", { type: "checkbox" }) as HTMLInputElement;
  const selectAll = el("label", { class: "select-all" }, all, "Select all");
  const cancel = el("button", {}, "Cancel");
  const applyBtn = el("button", { class: "primary" }, "Apply");
  const sync = () => {
    all.checked = boxes.every((b) => b.box.checked);
    applyBtn.disabled = pending().length === 0;
  };
  all.addEventListener("change", () => {
    for (const b of boxes) if (!b.box.disabled) b.box.checked = all.checked;
    sync();
  });
  for (const b of boxes) b.box.addEventListener("change", sync);
  cancel.addEventListener("click", close);
  applyBtn.addEventListener("click", async () => {
    const chosen = pending();
    applyBtn.disabled = cancel.disabled = true;
    applyBtn.textContent = "Applying…";
    const results = await apply(chosen.map((b) => b.type.id));
    const failed = results.filter((r) => !r.ok);
    for (const r of results) {
      const row = boxes.find((b) => b.type.id === r.id);
      if (!row) continue;
      row.status.textContent = r.ok ? "Plica" : `Couldn't change: ${r.error ?? "unknown error"}`;
      row.status.classList.toggle("is-plica", r.ok);
      row.status.classList.toggle("failed", !r.ok);
      if (r.ok) row.box.disabled = true;
    }
    const okLabels = chosen.filter((b) => results.find((r) => r.id === b.type.id)?.ok).map((b) => b.type.label);
    if (!failed.length) {
      close();
      done(`Plica now opens ${joinLabels(okLabels)} files.`);
    } else {
      applyBtn.textContent = "Apply";
      cancel.disabled = false;
      cancel.textContent = "Close";
      sync();
    }
  });
  sync();
  sheet.append(selectAll, list, el("div", { class: "sheet-actions" }, cancel, applyBtn));
  document.body.append(backdrop);
  (boxes.find((b) => !b.box.disabled)?.box ?? applyBtn).focus();
  return backdrop;
}
