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
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSDocumentController, NSWorkspace};
use objc2_foundation::{NSDictionary, NSString, NSURL, NSUserDefaults};
use tauri::menu::{
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    SubmenuBuilder, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use tauri_plugin_dialog::DialogExt;

/// Menu ids forwarded unchanged to the focused window's frontend.
const FRONTEND_COMMANDS: &[&str] = &["toggle-raw", "reload", "back", "copy-source", "copy-path", "find", "find-next", "find-prev"];

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

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn saved_editor(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(settings_path(app)?).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("editor")?.as_str().map(str::to_string)
}

fn save_editor(app: &AppHandle, bundle_id: &str) {
    let Some(path) = settings_path(app) else { return };
    let mut json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    json["editor"] = serde_json::Value::String(bundle_id.to_string());
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(&json).unwrap_or_default());
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
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // AppKit fills this submenu itself once its "Clear Menu" item has the right action (see
    // `after_launch`), and keeps the Dock menu's recent files in sync.
    let open_recent = SubmenuBuilder::with_id(app, "open-recent", "Open Recent").text("clear-recent", "Clear Menu").build()?;

    let installed = installed_editors();
    let saved = saved_editor(app);
    let current = pick_editor(saved.as_deref(), &installed);
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

    let file = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&open_recent)
        .separator()
        .item(&open_in)
        .item(&open_with)
        .text("reveal", "Reveal in Finder")
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

    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("toggle-raw", "Toggle Preview / Raw").accelerator("CmdOrCtrl+/").build(app)?)
        .item(&MenuItemBuilder::with_id("reload", "Reload").accelerator("CmdOrCtrl+R").build(app)?)
        .item(&MenuItemBuilder::with_id("back", "Back").accelerator("CmdOrCtrl+[").build(app)?)
        .separator()
        .fullscreen()
        .build()?;

    // The Window menu id makes Tauri register it with AppKit, which adds the window list and the tab
    // commands (Show Previous/Next Tab, Move Tab to New Window, Merge All Windows).
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window").minimize().maximize().separator().bring_all_to_front().build()?;

    app.manage(EditorMenu { open_in, choices, current: Mutex::new(current) });
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
    if FRONTEND_COMMANDS.contains(&id) {
        if let Some(label) = app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false)).map(|(l, _)| l) {
            let _ = app.emit_to(EventTarget::webview_window(label), "menu", id);
        }
        return;
    }
    match id {
        "open" => {
            let handle = app.clone();
            app.dialog().file().pick_files(move |picked| {
                let paths = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
                crate::open_paths(&handle, paths);
            });
        }
        "reveal" => {
            if let Some((_, path)) = focused_file(app) {
                let _ = Command::new("open").arg("-R").arg(path).spawn();
            }
        }
        "open-in-editor" => {
            let menu = app.state::<EditorMenu>();
            let editor = *menu.current.lock().unwrap();
            if let (Some(editor), Some((_, path))) = (editor, focused_file(app)) {
                open_in_editor(editor, &path);
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
            save_editor(app, chosen);
            if let Some((_, path)) = focused_file(app) {
                open_in_editor(chosen, &path);
            }
        }
        _ => {}
    }
}

fn open_in_editor(bundle_id: &str, path: &Path) {
    let _ = Command::new("open").arg("-b").arg(bundle_id).arg(path).spawn();
}

/// Called once the menu is installed (main thread): hand the Open Recent submenu to AppKit.
pub fn after_launch() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let Some(main) = app.mainMenu() else { return };
    let find = |menu: &objc2_app_kit::NSMenu, title: &str| menu.itemWithTitle(&NSString::from_str(title));
    let clear = find(&main, "File")
        .and_then(|f| f.submenu())
        .and_then(|f| find(&f, "Open Recent"))
        .and_then(|r| r.submenu())
        .and_then(|r| find(&r, "Clear Menu"));
    if let Some(clear) = clear {
        // SAFETY: standard AppKit action; a nil target sends it up the responder chain, which ends at
        // the shared NSDocumentController that implements it.
        unsafe {
            clear.setTarget(None);
            clear.setAction(Some(sel!(clearRecentDocuments:)));
        }
        let _ = NSDocumentController::sharedDocumentController(mtm);
    }
}

/// Add a file to Open Recent (and the Dock menu). Main thread only; silently ignored elsewhere.
pub fn note_recent(path: &Path) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(path) = path.to_str() else { return };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&url);
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
}
