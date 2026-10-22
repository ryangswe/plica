import { el } from "./lib/dom";
import type { FileDoc } from "./types";

/** One file in the sidebar. Desktop items have a path; browser uploads load from memory. */
export interface ListItem {
  /** Identifies the item: its path, or an upload id. */
  key: string;
  name: string;
  path: string | null;
  load?: () => Promise<FileDoc>;
}

/** A folder, or several files opened together. */
export interface FileList {
  title: string;
  items: ListItem[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Finder's name order: case-insensitive, numbers by value ("2 setup" before "10 faq"). */
export function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => collator.compare(a.name, b.name));
}

export interface Sidebar {
  el: HTMLElement;
  setList(list: FileList): void;
  hasList(): boolean;
  /** Highlight the item with this key (the shown file); null when the file isn't in the list. */
  markCurrent(key: string | null): void;
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

/**
 * The file list on the left. Clicking a file (or moving with the arrow keys) shows it in this window.
 * Only one item is in the Tab order (the current one), so Tab doesn't walk through every file.
 */
export interface SidebarActions {
  /** Show the item in this window. */
  pick(item: ListItem): void;
  /** Open the item in a window of its own (Cmd/Ctrl-click, or dragged out of the window to `at`). */
  openNew(item: ListItem, at?: { x: number; y: number }): void;
  /** Right-click; return true if a menu was shown (else the default one appears). */
  menu(item: ListItem, x: number, y: number): boolean;
  openChange(open: boolean): void;
}

/** True when a drag ended outside this window (screen coordinates). */
export function droppedOutside(e: { screenX: number; screenY: number }, win: { screenX: number; screenY: number; outerWidth: number; outerHeight: number }): boolean {
  return e.screenX < win.screenX || e.screenY < win.screenY || e.screenX > win.screenX + win.outerWidth || e.screenY > win.screenY + win.outerHeight;
}

export function createSidebar(actions: SidebarActions): Sidebar {
  const onPick = actions.pick;
  const onOpenChange = actions.openChange;
  const title = el("div", { class: "sidebar-title" });
  const count = el("span", { class: "sidebar-count" });
  const listEl = el("ul", { class: "sidebar-list" });
  const nav = el("nav", { class: "sidebar", "aria-label": "Files", hidden: "" }, el("div", { class: "sidebar-head" }, title, count), listEl);
  let items: ListItem[] = [];
  let buttons: HTMLButtonElement[] = [];
  let currentKey: string | null = null;

  const focusable = () => {
    const i = Math.max(0, items.findIndex((it) => it.key === currentKey));
    buttons.forEach((b, j) => (b.tabIndex = j === i ? 0 : -1));
  };

  listEl.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
    if (to < 0 || to >= buttons.length || to === i) return;
    e.preventDefault();
    buttons[to].focus();
    onPick(items[to]);
  });

  return {
    el: nav,
    setList(list) {
      items = list.items;
      currentKey = null;
      title.textContent = list.title;
      title.title = list.title;
      count.textContent = String(items.length);
      buttons = items.map((item) => {
        const b = el("button", { class: "sidebar-item", title: item.path ?? item.name, "data-key": item.key }, item.name);
        b.addEventListener("click", (e) => {
          if ((e.metaKey || e.ctrlKey) && item.path) return actions.openNew(item);
          b.focus(); // WebKit doesn't focus buttons on click; keep the arrow keys in the list
          onPick(item);
        });
        b.addEventListener("contextmenu", (e) => {
          if (actions.menu(item, e.clientX, e.clientY)) e.preventDefault();
        });
        if (item.path) {
          // Drag a file out of the window to open it in a window of its own.
          const path = item.path;
          b.draggable = true;
          b.addEventListener("dragstart", (e) => {
            e.dataTransfer?.setData("text/plain", path);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
          });
          b.addEventListener("dragend", (e) => {
            if (droppedOutside(e, window)) actions.openNew(item, { x: e.screenX, y: e.screenY });
          });
        }
        return b;
      });
      listEl.replaceChildren(...buttons.map((b) => el("li", {}, b)));
      focusable();
    },
    hasList: () => items.length > 0,
    markCurrent(key) {
      currentKey = key;
      for (const b of buttons) {
        if (b.dataset.key === key) {
          b.setAttribute("aria-current", "true");
          b.scrollIntoView?.({ block: "nearest" }); // absent in jsdom
        } else b.removeAttribute("aria-current");
      }
      focusable();
    },
    isOpen: () => !nav.hidden,
    setOpen(open) {
      if (open === !nav.hidden) return;
      nav.hidden = !open;
      onOpenChange(open);
    },
  };
}
