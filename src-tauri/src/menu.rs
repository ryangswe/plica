//! The native macOS menu bar: File / Edit / View / Window, Open Recent (managed by AppKit) and
//! "Open in Editor". Windows and Linux keep the in-page shortcuts; a menu strip inside every window
//! would cost reading space there.
//!
//! Menu items either act in Rust (open, reveal, editor) or are forwarded to the focused window's
//! frontend as a `menu` event (toggle raw, find, copy), which owns those features.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSDocumentController, NSWorkspace};
use objc2_foundation::{NSDictionary, NSString, NSURL, NSUserDefaults};
use tauri::menu::{
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, Submenu, SubmenuBuilder, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use tauri_plugin_dialog::DialogExt;

/// Menu ids forwarded unchanged to the focused window's frontend.
const FRONTEND_COMMANDS: &[&str] =
    &["toggle-raw", "reload", "back", "copy-source", "copy-path", "find", "find-next", "find-prev", "default-apps"];

/// Encodings offered in File → Reopen with Encoding: (WHATWG label, menu text).
const ENCODINGS: &[(&str, &str)] = &[
    ("utf-8", "Unicode (UTF-8)"),
    ("utf-16le", "Unicode (UTF-16 LE)"),
    ("utf-16be", "Unicode (UTF-16 BE)"),
    ("windows-1252", "Western (Windows-1252)"),
    ("windows-1250", "Central European (Windows-1250)"),
    ("windows-1251", "Cyrillic (Windows-1251)"),
    ("koi8-r", "Cyrillic (KOI8-R)"),
    ("windows-1253", "Greek (Windows-1253)"),
    ("windows-1254", "Turkish (Windows-1254)"),
    ("windows-1255", "Hebrew (Windows-1255)"),
    ("windows-1256", "Arabic (Windows-1256)"),
    ("shift_jis", "Japanese (Shift JIS)"),
    ("euc-jp", "Japanese (EUC-JP)"),
    ("gbk", "Chinese, Simplified (GBK)"),
    ("big5", "Chinese, Traditional (Big5)"),
    ("euc-kr", "Korean (EUC-KR)"),
];

/// Editors offered for "Open in Editor", most likely first. (name, bundle id)
const EDITORS: &[(&str, &str)] = &[
    ("VS Code", "com.microsoft.VSCode"),
    ("Cursor", "com.todesktop.230313mzl4w4u92"),
    ("Zed", "dev.zed.Zed"),
    ("Sublime Text", "com.sublimetext.4"),
    ("BBEdit", "com.barebones.bbedit"),
    ("Nova", "com.panic.Nova"),
    ("Xcode", "com.apple.dt.Xcode"),
    ("TextEdit", "com.apple.TextEdit"),
];

/// The saved editor if it's still installed, otherwise the first installed one in `EDITORS` order.
/// Never the file's default app: once Plica owns .md, that would just reopen Plica.
pub fn pick_editor<'a>(saved: Option<&str>, installed: &[&'a str]) -> Option<&'a str> {
    saved
        .and_then(|s| installed.iter().copied().find(|id| *id == s))
        .or_else(|| installed.first().copied())
}

fn editor_name(bundle_id: &str) -> &'static str {
    EDITORS.iter().find(|(_, id)| *id == bundle_id).map_or("Editor", |(name, _)| *name)
}

fn installed_editors() -> Vec<&'static str> {
    let ws = NSWorkspace::sharedWorkspace();
    EDITORS
        .iter()
        .map(|(_, id)| *id)
        .filter(|id| ws.URLForApplicationWithBundleIdentifier(&NSString::from_str(id)).is_some())
        .collect()
}

/// Handles to the items whose text or check state changes at runtime.
struct EditorMenu {
    open_in: MenuItem<Wry>,
    choices: Vec<(&'static str, CheckMenuItem<Wry>)>,
    current: Mutex<Option<&'static str>>,
}

const MAX_RECENT: usize = 10;

/// Move `path` to the front of the recent list (no duplicates, at most `MAX_RECENT`).
pub fn push_recent(list: &mut Vec<PathBuf>, path: PathBuf) {
    list.retain(|p| *p != path);
    list.insert(0, path);
    list.truncate(MAX_RECENT);
}

/// Menu labels: the file name, plus its folder when two recent files share a name.
pub fn recent_labels(list: &[PathBuf]) -> Vec<String> {
    let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    list.iter()
        .map(|p| {
            let n = name(p);
            if list.iter().filter(|q| name(q) == n).count() > 1 {
                let folder = p.parent().and_then(|d| d.file_name()).map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                format!("{n} — {folder}")
            } else {
                n
            }
        })
        .collect()
}

/// Window → Open Multiple Files as Tabs.
struct BatchTabsToggle(CheckMenuItem<Wry>);

/// View → Load Remote Images.
struct RemoteToggle(CheckMenuItem<Wry>);

/// Keep the menu check in sync when the preference changes elsewhere (the in-page "Always load").
pub fn set_remote_checked(app: &AppHandle, on: bool) {
    if let Some(t) = app.try_state::<RemoteToggle>() {
        let _ = t.0.set_checked(on);
    }
}

/// File → Open Recent, kept by Plica (AppKit only fills its own recent menu in nib-based apps).
struct RecentMenu {
    submenu: Submenu<Wry>,
    files: Mutex<Vec<PathBuf>>,
}

fn rebuild_recent(app: &AppHandle, menu: &RecentMenu) {
    let files = menu.files.lock().unwrap().clone();
    while let Ok(Some(_)) = menu.submenu.remove_at(0) {}
    for (i, label) in recent_labels(&files).into_iter().enumerate() {
        if let Ok(item) = MenuItemBuilder::with_id(format!("recent:{i}"), label).build(app) {
            let _ = menu.submenu.append(&item);
        }
    }
    if !files.is_empty() {
        if let Ok(sep) = PredefinedMenuItem::separator(app) {
            let _ = menu.submenu.append(&sep);
        }
    }
    if let Ok(clear) = MenuItemBuilder::with_id("clear-recent", "Clear Menu").enabled(!files.is_empty()).build(app) {
        let _ = menu.submenu.append(&clear);
    }
}

fn save_recent(app: &AppHandle, files: &[PathBuf]) {
    let list = files.iter().map(|p| serde_json::Value::String(p.to_string_lossy().into_owned())).collect();
    crate::settings::write(app, "recent", serde_json::Value::Array(list));
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let version = app.package_info().version.to_string();
    let app_menu = SubmenuBuilder::new(app, "Plica")
        .about(Some(AboutMetadata {
            version: Some(version),
            comments: Some("A fast, read-only viewer for Markdown and other developer files.".into()),
            ..Default::default()
        }))
        .separator()
        .item(&MenuItemBuilder::with_id("default-apps", "Default Apps…").build(app)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let open_recent = SubmenuBuilder::with_id(app, "open-recent", "Open Recent").build()?;

    let settings = crate::settings::read(app);
    let installed = installed_editors();
    let current = pick_editor(settings.get("editor").and_then(|v| v.as_str()), &installed);
    let open_in = MenuItemBuilder::with_id("open-in-editor", format!("Open in {}", current.map_or("Editor", editor_name)))
        .accelerator("CmdOrCtrl+E")
        .enabled(current.is_some())
        .build(app)?;
    let mut choices = Vec::new();
    let mut open_with = SubmenuBuilder::new(app, "Open in Other Editor");
    for id in &installed {
        let item = CheckMenuItemBuilder::with_id(format!("editor:{id}"), editor_name(id))
            .checked(Some(*id) == current)
            .build(app)?;
        open_with = open_with.item(&item);
        choices.push((*id, item));
    }
    let open_with = open_with.build()?;

    // Detection is a guess: let the user pick. Ids are WHATWG labels the frontend passes back to Rust.
    let mut reopen_with = SubmenuBuilder::new(app, "Reopen with Encoding").text("encoding:auto", "Automatic").separator();
    for (label, name) in ENCODINGS {
        reopen_with = reopen_with.text(format!("encoding:{label}"), *name);
    }
    let reopen_with = reopen_with.build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("open-folder", "Open Folder as Tabs…").accelerator("CmdOrCtrl+Shift+O").build(app)?)
        .item(&open_recent)
        .separator()
        .item(&open_in)
        .item(&open_with)
        .text("reveal", "Reveal in Finder")
        .item(&reopen_with)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&MenuItemBuilder::with_id("copy-source", "Copy Source").accelerator("CmdOrCtrl+Shift+C").build(app)?)
        .item(&MenuItemBuilder::with_id("copy-path", "Copy Path").accelerator("CmdOrCtrl+Alt+C").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("find", "Find…").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("find-next", "Find Next").accelerator("CmdOrCtrl+G").build(app)?)
        .item(&MenuItemBuilder::with_id("find-prev", "Find Previous").accelerator("CmdOrCtrl+Shift+G").build(app)?)
        .build()?;

    // Off by default: opening a file shouldn't tell anyone (tracking pixels in READMEs and emails).
    let remote_toggle = CheckMenuItemBuilder::with_id("toggle-remote", "Load Remote Images")
        .checked(crate::settings::remote_content(app))
        .build(app)?;
    app.manage(RemoteToggle(remote_toggle.clone()));
    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("toggle-raw", "Toggle Preview / Raw").accelerator("CmdOrCtrl+/").build(app)?)
        .item(&MenuItemBuilder::with_id("reload", "Reload").accelerator("CmdOrCtrl+R").build(app)?)
        .item(&MenuItemBuilder::with_id("back", "Back").accelerator("CmdOrCtrl+[").build(app)?)
        .separator()
        .item(&remote_toggle)
        .separator()
        .fullscreen()
        .build()?;

    // The Window menu id makes Tauri register it with AppKit, which adds the window list and the tab
    // commands (Show Previous/Next Tab, Move Tab to New Window, Merge All Windows).
    let batch_tabs = CheckMenuItemBuilder::with_id("toggle-batch-tabs", "Open Multiple Files as Tabs")
        .checked(crate::settings::batch_tabs(app))
        .build(app)?;
    app.manage(BatchTabsToggle(batch_tabs.clone()));
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&batch_tabs)
        .separator()
        .bring_all_to_front()
        .build()?;

    app.manage(EditorMenu { open_in, choices, current: Mutex::new(current) });
    let recent_files: Vec<PathBuf> = settings
        .get("recent")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(PathBuf::from).collect())
        .unwrap_or_default();
    let recent = RecentMenu { submenu: open_recent.clone(), files: Mutex::new(recent_files) };
    rebuild_recent(app, &recent);
    app.manage(recent);
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
}

/// The file shown in the focused window, if any.
fn focused_file(app: &AppHandle) -> Option<(String, PathBuf)> {
    let label = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)?;
    let path = crate::current_file(app, &label)?;
    Some((label, path))
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if FRONTEND_COMMANDS.contains(&id) || id.starts_with("encoding:") {
        if let Some(label) = app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false)).map(|(l, _)| l) {
            let _ = app.emit_to(EventTarget::webview_window(label), "menu", id);
        } else if id == "default-apps" {
            // No window open (Plica keeps running on macOS): open one for it.
            crate::open_window_for_command(app, id);
        }
        return;
    }
    match id {
        "open" => {
            let handle = app.clone();
            let mut dialog = app.dialog().file();
            // Start where the user last was: the folder of the current or most recent file.
            let start = focused_file(app)
                .map(|(_, p)| p)
                .or_else(|| app.state::<RecentMenu>().files.lock().unwrap().first().cloned())
                .and_then(|p| p.parent().map(Path::to_path_buf));
            if let Some(dir) = start.filter(|d| d.is_dir()) {
                dialog = dialog.set_directory(dir);
            }
            dialog.pick_files(move |picked| {
                let paths = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
                crate::open_any(&handle, paths); // several files: one window with tabs
            });
        }
        "open-folder" => {
            let handle = app.clone();
            app.dialog().file().set_title("Open Folder as Tabs").pick_folder(move |picked| {
                if let Some(dir) = picked.and_then(|p| p.into_path().ok()) {
                    crate::batch::open(&handle, vec![dir]);
                }
            });
        }
        "toggle-batch-tabs" => {
            let on = app.state::<BatchTabsToggle>().0.is_checked().unwrap_or(true);
            crate::settings::write(app, "batchTabs", serde_json::Value::Bool(on));
        }
        "reveal" => {
            if let Some((_, path)) = focused_file(app) {
                let _ = Command::new("open").arg("-R").arg(path).spawn();
            }
        }
        "open-in-editor" => {
            let menu = app.state::<EditorMenu>();
            let editor = *menu.current.lock().unwrap();
            if let (Some(editor), Some((label, path))) = (editor, focused_file(app)) {
                open_in_editor(app, &label, editor, &path);
            }
        }
        "toggle-remote" => {
            // The check item has already flipped itself; save and broadcast the new state.
            let on = app.state::<RemoteToggle>().0.is_checked().unwrap_or(false);
            crate::settings::set_remote_content(app, on);
        }
        "clear-recent" => {
            let menu = app.state::<RecentMenu>();
            menu.files.lock().unwrap().clear();
            save_recent(app, &[]);
            rebuild_recent(app, &menu);
            if let Some(mtm) = MainThreadMarker::new() {
                // SAFETY: a nil sender is allowed for this action method.
                unsafe { NSDocumentController::sharedDocumentController(mtm).clearRecentDocuments(None) };
            }
        }
        _ if id.starts_with("recent:") => {
            let menu = app.state::<RecentMenu>();
            let Some(path) = id[7..].parse::<usize>().ok().and_then(|i| menu.files.lock().unwrap().get(i).cloned()) else { return };
            if path.is_file() {
                crate::open_paths(app, vec![path]);
            } else {
                // Moved or deleted since: drop it rather than open an error.
                menu.files.lock().unwrap().retain(|p| *p != path);
                save_recent(app, &menu.files.lock().unwrap());
                rebuild_recent(app, &menu);
            }
        }
        _ if id.starts_with("editor:") => {
            let menu = app.state::<EditorMenu>();
            let Some((chosen, _)) = menu.choices.iter().find(|(eid, _)| id == format!("editor:{eid}")) else { return };
            *menu.current.lock().unwrap() = Some(chosen);
            for (eid, item) in &menu.choices {
                let _ = item.set_checked(eid == chosen);
            }
            let _ = menu.open_in.set_text(format!("Open in {}", editor_name(chosen)));
            crate::settings::write(app, "editor", serde_json::Value::String(chosen.to_string()));
            if let Some((label, path)) = focused_file(app) {
                open_in_editor(app, &label, chosen, &path);
            }
        }
        _ => {}
    }
}

/// When the last "Open in Editor" happened, to ignore repeats while a slow editor is still starting.
static LAST_EDITOR_OPEN: Mutex<Option<(PathBuf, std::time::Instant)>> = Mutex::new(None);

/// True if this file was just sent to an editor (within `window`), so a repeated Cmd+E is ignored.
pub fn is_repeat(last: &Option<(PathBuf, std::time::Instant)>, path: &Path, now: std::time::Instant, window: std::time::Duration) -> bool {
    matches!(last, Some((p, t)) if p == path && now.duration_since(*t) < window)
}

fn open_in_editor(app: &AppHandle, label: &str, bundle_id: &str, path: &Path) {
    let now = std::time::Instant::now();
    {
        let mut last = LAST_EDITOR_OPEN.lock().unwrap();
        if is_repeat(&last, path, now, std::time::Duration::from_secs(3)) {
            return;
        }
        *last = Some((path.to_path_buf(), now));
    }
    // Editors can take a few seconds to start: say something right away.
    let _ = app.emit_to(EventTarget::webview_window(label), "notice", format!("Opening in {}…", editor_name(bundle_id)));
    let _ = Command::new("open").arg("-b").arg(bundle_id).arg(path).spawn();
}

/// A file was shown: put it at the top of Open Recent, and tell macOS too (Dock menu, Finder's
/// recent items). Main thread only.
pub fn note_recent(app: &AppHandle, path: &Path) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    if let Some(menu) = app.try_state::<RecentMenu>() {
        let files = {
            let mut files = menu.files.lock().unwrap();
            push_recent(&mut files, path.to_path_buf());
            files.clone()
        };
        save_recent(app, &files);
        rebuild_recent(app, &menu);
    }
    if let Some(p) = path.to_str() {
        let url = NSURL::fileURLWithPath(&NSString::from_str(p));
        NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&url);
    }
}

/// Give AppKit's own "Merge All Windows" item the shortcut ⇧⌘M. Registered (not saved) defaults, so a
/// shortcut the user sets in System Settings → Keyboard → App Shortcuts still wins.
pub fn register_shortcuts() {
    let key = NSString::from_str("Merge All Windows");
    let value: Retained<AnyObject> = Retained::into_super(Retained::into_super(NSString::from_str("@$m")));
    let inner: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[&*key], &[&*value]);
    let outer_key = NSString::from_str("NSUserKeyEquivalents");
    let inner: Retained<AnyObject> = Retained::into_super(Retained::into_super(inner));
    let outer: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[&*outer_key], &[&*inner]);
    // SAFETY: plain property-list values (strings in dictionaries).
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&outer) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_choice_prefers_saved_then_first_installed_never_none_when_one_exists() {
        let installed = ["com.microsoft.VSCode", "com.apple.TextEdit"];
        assert_eq!(pick_editor(Some("com.apple.TextEdit"), &installed), Some("com.apple.TextEdit"));
        assert_eq!(pick_editor(None, &installed), Some("com.microsoft.VSCode"));
        // Saved editor was uninstalled: fall back.
        assert_eq!(pick_editor(Some("dev.zed.Zed"), &installed), Some("com.microsoft.VSCode"));
        assert_eq!(pick_editor(Some("dev.zed.Zed"), &[]), None);
        assert_eq!(editor_name("com.todesktop.230313mzl4w4u92"), "Cursor");
    }

    #[test]
    fn repeated_open_in_editor_is_ignored_briefly() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let last = Some((PathBuf::from("/d/a.md"), t0));
        let w = Duration::from_secs(3);
        assert!(is_repeat(&last, Path::new("/d/a.md"), t0 + Duration::from_secs(1), w));
        assert!(!is_repeat(&last, Path::new("/d/a.md"), t0 + Duration::from_secs(4), w));
        assert!(!is_repeat(&last, Path::new("/d/b.md"), t0 + Duration::from_secs(1), w));
        assert!(!is_repeat(&None, Path::new("/d/a.md"), t0, w));
    }

    #[test]
    fn recent_list_moves_to_front_dedupes_and_caps() {
        let mut list = Vec::new();
        for i in 0..12 {
            push_recent(&mut list, PathBuf::from(format!("/d/{i}.md")));
        }
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], PathBuf::from("/d/11.md"));
        push_recent(&mut list, PathBuf::from("/d/5.md"));
        assert_eq!(list[0], PathBuf::from("/d/5.md"));
        assert_eq!(list.iter().filter(|p| p.as_path() == Path::new("/d/5.md")).count(), 1);
    }

    #[test]
    fn recent_labels_add_the_folder_only_for_duplicate_names() {
        let list = [PathBuf::from("/a/README.md"), PathBuf::from("/b/README.md"), PathBuf::from("/a/notes.md")];
        assert_eq!(recent_labels(&list), ["README.md — a", "README.md — b", "notes.md"]);
    }
}
