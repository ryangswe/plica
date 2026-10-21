//! Desktop shell for Plica.
//!
//! Responsibilities (everything else lives in the web frontend):
//! - figure out which file(s) the OS asked us to open (CLI args, macOS "open" events,
//!   a second launch on Windows/Linux) and give each its own window
//! - read files from disk for the frontend
//! - watch the open file and tell its window when it changes

use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

#[cfg(target_os = "macos")]
mod chrome;
mod defaults;
mod encoding;
#[cfg(target_os = "macos")]
mod menu;
mod settings;

use encoding::decode_text;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Files bigger than this are cut off; nobody wants to scroll a 64 MB log in a viewer.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default)]
struct WindowState {
    /// File waiting to be picked up by the frontend once it has loaded.
    pending: Option<PathBuf>,
    /// File currently shown (or about to be shown) in the window.
    current: Option<PathBuf>,
    /// The frontend has asked for its initial file, so it is listening for events.
    ready: bool,
    /// A menu command to run once the window has loaded (it was opened for that command).
    pending_command: Option<String>,
    watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
struct AppState {
    windows: Mutex<HashMap<String, WindowState>>,
    counter: AtomicUsize,
}

#[derive(Serialize)]
struct FileData {
    path: String,
    name: String,
    text: String,
    size: u64,
    binary: bool,
    truncated: bool,
    /// Encoding the text was decoded from, e.g. "UTF-8", "UTF-16LE", "windows-1252".
    encoding: String,
}

fn read_file_data(path: &Path) -> Result<FileData, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_BYTES) as usize);
    File::open(path)
        .and_then(|f| f.take(MAX_BYTES).read_to_end(&mut bytes))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let decoded = decode_text(&bytes);
    let binary = decoded.is_none();
    let (text, encoding) = decoded.map_or((String::new(), ""), |(t, e)| (t, e.name()));
    Ok(FileData {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        text,
        size: meta.len(),
        binary,
        truncated: meta.len() > MAX_BYTES,
        encoding: encoding.to_string(),
    })
}

#[tauri::command]
fn read_file(path: String, encoding: Option<String>) -> Result<FileData, String> {
    let mut data = read_file_data(Path::new(&path))?;
    // "Reopen with Encoding": decode again as the user asked (detection is a guess).
    if let Some(label) = encoding.filter(|_| !data.binary) {
        let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        let bytes = &bytes[..bytes.len().min(MAX_BYTES as usize)];
        let (text, enc) = encoding::decode_as(bytes, &label).ok_or_else(|| format!("Unknown encoding: {label}"))?;
        data.text = text;
        data.encoding = enc.name().to_string();
    }
    Ok(data)
}

/// Called once by each window's frontend after it has set up its event listeners.
/// The page listens for `window-chrome` now: send it the current state (macOS; nothing elsewhere).
#[tauri::command]
fn resend_window_chrome(window: WebviewWindow) {
    #[cfg(target_os = "macos")]
    chrome::resend(window.app_handle(), window.label());
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Called by each window's frontend after loading: a command it was opened to run, if any.
#[tauri::command]
fn take_pending_command(window: WebviewWindow, state: State<AppState>) -> Option<String> {
    state.windows.lock().unwrap().get_mut(window.label())?.pending_command.take()
}

/// Open an empty window that runs `command` once loaded (menu commands chosen with no window open).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn open_window_for_command(app: &AppHandle, command: &str) {
    match create_window(app, None) {
        Ok(label) => {
            if let Some(w) = app.state::<AppState>().windows.lock().unwrap().get_mut(&label) {
                w.pending_command = Some(command.to_string());
            }
        }
        Err(e) => eprintln!("failed to open window: {e}"),
    }
}

#[tauri::command]
fn take_initial_file(window: WebviewWindow, state: State<AppState>) -> Option<String> {
    let mut windows = state.windows.lock().unwrap();
    let entry = windows.entry(window.label().to_string()).or_default();
    entry.ready = true;
    entry.pending.take().map(|p| p.to_string_lossy().into_owned())
}

/// Start watching `path` for this window (replacing any previous watch).
/// We watch the parent folder rather than the file itself because many editors
/// save by writing a temp file and renaming it over the original.
#[tauri::command]
fn watch_file(window: WebviewWindow, state: State<AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or("no parent folder")?
        .to_path_buf();
    let file_name = target.file_name().ok_or("no file name")?.to_os_string();
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let payload = path.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if concerns_file(&event, &file_name) {
            let _ = app.emit_to(EventTarget::webview_window(label.clone()), "file-changed", payload.clone());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let mut windows = state.windows.lock().unwrap();
    let entry = windows.entry(window.label().to_string()).or_default();
    entry.current = Some(target);
    entry.watcher = Some(watcher); // drops (stops) the previous watcher
    drop(windows);
    #[cfg(target_os = "macos")]
    {
        let recent = PathBuf::from(&path);
        let app = window.app_handle().clone();
        let _ = window.run_on_main_thread(move || menu::note_recent(&app, &recent));
    }
    Ok(())
}

/// Which tab Cmd+`n` selects in a group of `count` tabs: 1–8 by position, 9 is the last one
/// (same as Safari and Terminal).
fn tab_index(n: usize, count: usize) -> Option<usize> {
    match n {
        9 if count > 0 => Some(count - 1),
        1..=8 if n <= count => Some(n - 1),
        _ => None,
    }
}

/// Cmd+1…9: bring the n-th native tab of this window's tab group to the front (macOS only).
#[tauri::command]
fn select_tab(window: WebviewWindow, n: usize) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(ptr) = w.ns_window() else { return };
            // SAFETY: Tauri hands out the live NSWindow of this webview window, and we are on the
            // main thread as AppKit requires.
            let ns_window = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
            let Some(group) = ns_window.tabGroup() else { return };
            let tabs = group.windows();
            if let Some(i) = tab_index(n, tabs.count()) {
                tabs.objectAtIndex(i).makeKeyAndOrderFront(None);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, n);
}

/// Whether a watcher event in the file's folder is about the file. Removals count too, so the
/// frontend re-reads and can tell the user the file is gone instead of silently showing old content.
fn concerns_file(event: &notify::Event, file_name: &std::ffi::OsStr) -> bool {
    matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_))
        && event.paths.iter().any(|p| p.file_name() == Some(file_name))
}

/// Cmd/Ctrl-click on a link: open the file in its own window (or focus the one already showing it).
#[tauri::command]
fn open_window(app: AppHandle, path: String) {
    open_paths(&app, vec![PathBuf::from(path)]);
}

/// The file a window currently shows.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn current_file(app: &AppHandle, label: &str) -> Option<PathBuf> {
    app.state::<AppState>().windows.lock().unwrap().get(label)?.current.clone()
}

/// Create a window (showing `path`, or empty) and return its label.
fn create_window(app: &AppHandle, path: Option<PathBuf>) -> tauri::Result<String> {
    let state = app.state::<AppState>();
    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    let label = format!("w{n}");
    state.windows.lock().unwrap().insert(
        label.clone(),
        WindowState {
            current: path.clone(),
            pending: path,
            ..Default::default()
        },
    );
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Plica")
        .inner_size(1000.0, 780.0)
        .min_inner_size(420.0, 320.0)
        .zoom_hotkeys_enabled(true); // Ctrl/Cmd + / - / 0 to zoom
    // Native macOS tabs: Window → Merge All Windows, and the "Prefer tabs" system setting.
    #[cfg(target_os = "macos")]
    let builder = builder
        .tabbing_identifier("plica")
        // One toolbar instead of a title bar plus our bar: the page draws under a transparent title
        // bar, and the traffic lights sit inside our 44px top bar (vertically centered).
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 22.0));
    // Cascade new windows a little so they don't stack exactly on top of each other.
    let builder = if n > 0 {
        let offset = 40.0 + (n % 8) as f64 * 28.0;
        builder.position(offset + 60.0, offset)
    } else {
        builder.center()
    };
    builder.build()?;
    Ok(label)
}

/// The window already showing `path`, if any (compared after resolving symlinks and `..`).
fn window_showing(windows: &HashMap<String, WindowState>, path: &Path) -> Option<String> {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let target = canon(path);
    windows
        .iter()
        .filter(|(_, w)| w.current.as_deref().is_some_and(|c| canon(c) == target))
        .map(|(label, _)| label.clone())
        .min()
}

/// Open each path: bring its window forward if it is already open (like Preview),
/// otherwise reuse an empty window if there is one (e.g. the window macOS
/// launched us with before telling us which file), otherwise make a new window.
fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    for path in paths {
        let existing = window_showing(&app.state::<AppState>().windows.lock().unwrap(), &path);
        if let Some(w) = existing.and_then(|label| app.get_webview_window(&label)) {
            let _ = w.unminimize();
            let _ = w.set_focus();
            continue;
        }
        let reuse = {
            let state = app.state::<AppState>();
            let mut windows = state.windows.lock().unwrap();
            let empty = windows
                .iter()
                .filter(|(_, w)| w.current.is_none() && w.pending.is_none())
                .map(|(label, _)| label.clone())
                .min();
            empty.map(|label| {
                let w = windows.get_mut(&label).unwrap();
                w.current = Some(path.clone());
                if !w.ready {
                    w.pending = Some(path.clone());
                }
                (label, w.ready)
            })
        };
        match reuse {
            Some((label, true)) => {
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "open-path",
                    path.to_string_lossy().into_owned(),
                );
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_focus();
                }
            }
            Some((_, false)) => {} // frontend will pick it up via take_initial_file
            None => {
                if let Err(e) = create_window(app, Some(path)) {
                    eprintln!("failed to open window: {e}");
                }
            }
        }
    }
}

/// Windows to create at startup: one per file argument, or a single empty window.
/// On macOS a Finder double-click arrives as `RunEvent::Opened` *before* `setup` runs,
/// and that event has already created the file's window (`already_open > 0`); adding
/// an empty one as well would leave the user with two windows.
fn startup_windows(cli_paths: Vec<PathBuf>, already_open: usize) -> Vec<Option<PathBuf>> {
    if !cli_paths.is_empty() {
        cli_paths.into_iter().map(Some).collect()
    } else if already_open == 0 {
        vec![None]
    } else {
        vec![]
    }
}

/// File arguments from a command line (skipping flags), resolved against `cwd`.
fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        })
        .filter(|p| p.is_file())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    menu::register_shortcuts();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle);

    // On Windows/Linux, double-clicking a second file starts a second process;
    // forward its arguments to the running app instead. (macOS keeps one process
    // and sends RunEvent::Opened, so the plugin isn't needed there.)
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let paths = paths_from_args(argv.into_iter().skip(1), Path::new(&cwd));
        if paths.is_empty() {
            let _ = create_window(app, None);
        } else {
            open_paths(app, paths);
        }
    }));

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            take_initial_file,
            take_pending_command,
            watch_file,
            open_window,
            select_tab,
            settings::get_remote_content,
            settings::save_remote_content,
            defaults::default_apps,
            defaults::set_default_apps,
            defaults::default_apps_prompt_dismissed,
            defaults::dismiss_default_apps_prompt,
            resend_window_chrome
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.windows.lock().unwrap().remove(window.label());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            chrome::start(app.handle());
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = paths_from_args(std::env::args().skip(1), &cwd);
            let already_open = app.state::<AppState>().windows.lock().unwrap().len();
            for path in startup_windows(paths, already_open) {
                create_window(app.handle(), path)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Plica");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        match _event {
            // Finder "Open" / double-click arrives as an event, not as arguments.
            tauri::RunEvent::Opened { urls } => {
                let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
                open_paths(_app, paths);
            }
            // Like Preview: closing the last window keeps the app running, so the next file opens
            // warm (~190 ms vs ~510 ms cold). `code: None` only happens when the last window
            // closes; Cmd+Q goes through AppKit's terminate and still quits.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // Clicking the Dock icon with no windows open: give the user an empty window.
            tauri::RunEvent::Reopen { .. } if _app.webview_windows().is_empty() => {
                if let Err(e) = create_window(_app, None) {
                    eprintln!("failed to open window: {e}");
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_text_and_strips_bom() {
        let dir = std::env::temp_dir().join(format!("plica-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.md");
        File::create(&p).unwrap().write_all("\u{feff}# hi".as_bytes()).unwrap();
        let d = read_file_data(&p).unwrap();
        assert_eq!(d.text, "# hi");
        assert_eq!(d.name, "a.md");
        assert!(!d.binary);
    }

    #[test]
    fn detects_binary() {
        let dir = std::env::temp_dir().join(format!("plica-test-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("b.bin");
        File::create(&p).unwrap().write_all(&[1, 2, 0, 3]).unwrap();
        assert!(read_file_data(&p).unwrap().binary);
    }

    #[test]
    fn startup_skips_empty_window_when_a_file_is_already_open() {
        let p = PathBuf::from("/tmp/a.md");
        // Plain launch: one empty window.
        assert_eq!(startup_windows(vec![], 0), vec![None]);
        // macOS double-click: the Opened event already made the file's window.
        assert_eq!(startup_windows(vec![], 1), Vec::<Option<PathBuf>>::new());
        // Command line: one window per file.
        assert_eq!(startup_windows(vec![p.clone()], 0), vec![Some(p)]);
    }

    #[test]
    fn finds_the_window_already_showing_a_file() {
        let dir = std::env::temp_dir().join(format!("plica-test-open-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        File::create(dir.join("a.md")).unwrap();
        File::create(dir.join("b.md")).unwrap();
        let mut windows = HashMap::new();
        windows.insert("w0".to_string(), WindowState::default()); // empty window
        windows.insert(
            "w1".to_string(),
            WindowState { current: Some(dir.join("a.md")), ..Default::default() },
        );
        assert_eq!(window_showing(&windows, &dir.join("a.md")), Some("w1".into()));
        // Same file through a different spelling of the path.
        assert_eq!(window_showing(&windows, &dir.join("sub/../a.md")), Some("w1".into()));
        assert_eq!(window_showing(&windows, &dir.join("b.md")), None);
    }

    #[test]
    fn watcher_reports_changes_and_removals_of_the_file_only() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind};
        let ev = |kind: EventKind, p: &str| notify::Event::new(kind).add_path(PathBuf::from(p));
        let name = std::ffi::OsStr::new("a.md");
        assert!(concerns_file(&ev(EventKind::Modify(ModifyKind::Any), "/d/a.md"), name));
        assert!(concerns_file(&ev(EventKind::Create(CreateKind::File), "/d/a.md"), name));
        assert!(concerns_file(&ev(EventKind::Remove(RemoveKind::File), "/d/a.md"), name));
        assert!(!concerns_file(&ev(EventKind::Remove(RemoveKind::File), "/d/b.md"), name));
        assert!(!concerns_file(&ev(EventKind::Access(notify::event::AccessKind::Any), "/d/a.md"), name));
    }

    #[test]
    fn cmd_number_picks_a_tab() {
        assert_eq!(tab_index(1, 3), Some(0));
        assert_eq!(tab_index(3, 3), Some(2));
        assert_eq!(tab_index(4, 3), None); // no 4th tab: do nothing
        assert_eq!(tab_index(9, 3), Some(2)); // 9 = last tab
        assert_eq!(tab_index(9, 12), Some(11));
        assert_eq!(tab_index(1, 1), Some(0));
        assert_eq!(tab_index(0, 3), None);
    }

    #[test]
    fn args_skip_flags_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("plica-test-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        File::create(dir.join("x.md")).unwrap();
        let got = paths_from_args(vec!["--flag".into(), "x.md".into(), "nope.md".into()], &dir);
        assert_eq!(got, vec![dir.join("x.md")]);
    }
}
