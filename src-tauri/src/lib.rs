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
    let binary = bytes[..bytes.len().min(8000)].contains(&0);
    let text = if binary {
        String::new()
    } else {
        let s = String::from_utf8_lossy(&bytes);
        s.strip_prefix('\u{feff}').unwrap_or(&s).to_string()
    };
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
    })
}

#[tauri::command]
fn read_file(path: String) -> Result<FileData, String> {
    read_file_data(Path::new(&path))
}

/// Called once by each window's frontend after it has set up its event listeners.
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
        let relevant = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_))
            && event.paths.iter().any(|p| p.file_name() == Some(file_name.as_os_str()));
        if relevant {
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
    Ok(())
}

#[tauri::command]
fn open_window(app: AppHandle, path: String) -> Result<(), String> {
    create_window(&app, Some(PathBuf::from(path))).map_err(|e| e.to_string())
}

fn create_window(app: &AppHandle, path: Option<PathBuf>) -> tauri::Result<()> {
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
    // Cascade new windows a little so they don't stack exactly on top of each other.
    let builder = if n > 0 {
        let offset = 40.0 + (n % 8) as f64 * 28.0;
        builder.position(offset + 60.0, offset)
    } else {
        builder.center()
    };
    builder.build()?;
    Ok(())
}

/// Open each path: reuse an empty window if there is one (e.g. the window macOS
/// launched us with before telling us which file), otherwise make a new window.
fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    for path in paths {
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
    let builder = tauri::Builder::default();

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
        .invoke_handler(tauri::generate_handler![read_file, take_initial_file, watch_file, open_window])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.windows.lock().unwrap().remove(window.label());
            }
        })
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = paths_from_args(std::env::args().skip(1), &cwd);
            if paths.is_empty() {
                create_window(app.handle(), None)?;
            } else {
                for p in paths {
                    create_window(app.handle(), Some(p))?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Plica");

    app.run(|_app, _event| {
        // macOS delivers Finder "Open" / double-click as an event, not as arguments.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            open_paths(_app, paths);
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
    fn args_skip_flags_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("plica-test-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        File::create(dir.join("x.md")).unwrap();
        let got = paths_from_args(vec!["--flag".into(), "x.md".into(), "nope.md".into()], &dir);
        assert_eq!(got, vec![dir.join("x.md")]);
    }
}
