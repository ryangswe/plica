//! Which window a file or a file list goes into: the window already showing it, the one listing it,
//! an empty one, or a new one.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

use crate::{batch, create_window, create_window_with, AppState, WindowOpts, WindowState};

pub fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The window already showing `path`, if any (compared after resolving symlinks and `..`).
pub fn window_showing(windows: &HashMap<String, WindowState>, path: &Path) -> Option<String> {
    window_showing_except(windows, path, None)
}

fn window_showing_except(windows: &HashMap<String, WindowState>, path: &Path, except: Option<&str>) -> Option<String> {
    let target = canon(path);
    windows
        .iter()
        .filter(|(label, _)| Some(label.as_str()) != except)
        .filter(|(_, w)| w.current.as_deref().is_some_and(|c| canon(c) == target))
        .map(|(label, _)| label.clone())
        .min()
}

/// Open one file: bring its window forward if it's already open (like Preview), otherwise reuse an
/// empty window if there is one (e.g. the window macOS launched us with before saying which file),
/// otherwise make a new window. Returns the window it went into, unless it was already open.
pub fn open_one(app: &AppHandle, path: PathBuf) -> Option<String> {
    let existing = window_showing(&app.state::<AppState>().windows.lock().unwrap(), &path);
    if let Some(w) = existing.and_then(|label| app.get_webview_window(&label)) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return None;
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
            let _ = app.emit_to(EventTarget::webview_window(label.clone()), "open-path", path.to_string_lossy().into_owned());
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.set_focus();
            }
            Some(label)
        }
        Some((label, false)) => Some(label), // the frontend picks it up via take_initial_file
        None => create_window(app, Some(path)).map_err(|e| eprintln!("failed to open window: {e}")).ok(),
    }
}

/// A batch as native tabs (macOS setting): the first file opens like any other (reusing an empty window),
/// the rest in hidden windows that `chrome::group_as_tabs` shows once they're tabs, so no windows flash
/// by. Files already open are left where they are. Returns the new windows in order.
#[cfg(target_os = "macos")]
pub fn open_for_tabs(app: &AppHandle, files: Vec<PathBuf>, into_existing: bool) -> Vec<String> {
    let mut labels = Vec::new();
    for (i, path) in files.into_iter().enumerate() {
        if window_showing(&app.state::<AppState>().windows.lock().unwrap(), &path).is_some() {
            continue;
        }
        let label = if i == 0 && !into_existing {
            open_one(app, path)
        } else {
            create_window_with(app, Some(path), None, WindowOpts { hidden: true, ..Default::default() })
                .map_err(|e| eprintln!("failed to open window: {e}"))
                .ok()
        };
        labels.extend(label);
    }
    labels
}

/// Open `path` in a window other than `from`: another one already showing it, else a new one (at `at`).
pub fn open_elsewhere(app: &AppHandle, from: &str, path: PathBuf, at: Option<(f64, f64)>) {
    let other = window_showing_except(&app.state::<AppState>().windows.lock().unwrap(), &path, Some(from));
    if let Some(w) = other.and_then(|label| app.get_webview_window(&label)) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if let Err(e) = create_window_with(app, Some(path), None, WindowOpts { at, ..Default::default() }) {
        eprintln!("failed to open window: {e}");
    }
}

/// Open each path in its own window (or the one already showing it).
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    for path in paths {
        open_one(app, path);
    }
}

/// The window whose file list has `path` (a file) or is the same list (same folder or files).
fn window_listing(windows: &HashMap<String, WindowState>, path: Option<&Path>, same_as: Option<&batch::FileList>) -> Option<String> {
    windows
        .iter()
        .filter(|(_, w)| {
            let Some(list) = &w.list else { return false };
            path.is_some_and(|p| list.files.iter().any(|f| canon(f) == canon(p))) || same_as.is_some_and(|other| list.same_as(other))
        })
        .map(|(label, _)| label.clone())
        .min()
}

/// Show `path` in window `label` (now if it has loaded, else once it does) and bring it forward.
pub fn show_in(app: &AppHandle, label: &str, path: PathBuf) {
    let ready = {
        let state = app.state::<AppState>();
        let mut windows = state.windows.lock().unwrap();
        let Some(w) = windows.get_mut(label) else { return };
        w.current = Some(path.clone());
        if !w.ready {
            w.pending = Some(path.clone());
        }
        w.ready
    };
    if ready {
        let _ = app.emit_to(EventTarget::webview_window(label), "open-path", path.to_string_lossy().into_owned());
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Give a window this file list (or a new window, when `target` is None and no window has it yet) and
/// show its first file. Returns the window.
pub fn open_list(app: &AppHandle, list: batch::FileList, target: Option<String>) -> Option<String> {
    let first = list.files.first()?.clone();
    // This window, else one that already lists the same folder, else an empty one.
    let existing = target.or_else(|| {
        let state = app.state::<AppState>();
        let windows = state.windows.lock().unwrap();
        window_listing(&windows, None, Some(&list)).or_else(|| {
            windows.iter().filter(|(_, w)| w.current.is_none() && w.pending.is_none() && w.list.is_none()).map(|(l, _)| l.clone()).min()
        })
    });
    let Some(label) = existing else {
        return create_window_with(app, Some(first), Some(list), WindowOpts::default()).map_err(|e| eprintln!("failed to open window: {e}")).ok();
    };
    let payload = list.payload();
    let ready = {
        let state = app.state::<AppState>();
        let mut windows = state.windows.lock().unwrap();
        let w = windows.get_mut(&label)?;
        w.list = Some(list);
        w.ready
    };
    if ready {
        let _ = app.emit_to(EventTarget::webview_window(label.clone()), "file-list", payload);
    }
    show_in(app, &label, first);
    Some(label)
}

/// Files the OS asked us to open. Several paths or a folder go through `batch` (one window with a
/// file list, skipping binaries). One file opens in its own window, or in the window that lists it.
pub fn open_any(app: &AppHandle, paths: Vec<PathBuf>) {
    match paths.as_slice() {
        [one] if one.is_file() => {
            let windows = app.state::<AppState>();
            let windows = windows.windows.lock().unwrap();
            let listed = window_showing(&windows, one).is_none().then(|| window_listing(&windows, Some(one), None)).flatten();
            drop(windows);
            match listed {
                Some(label) => show_in(app, &label, one.clone()),
                None => open_paths(app, paths),
            }
        }
        [] => {}
        _ => batch::open(app, paths, None),
    }
}

/// Files dropped on a window: one file opens right there (returned to the page); several files or a
/// folder become this window's file list.
#[tauri::command]
pub fn open_dropped(window: WebviewWindow, paths: Vec<String>) -> Option<String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    match paths.as_slice() {
        [one] if one.is_file() => Some(one.to_string_lossy().into_owned()),
        _ => {
            batch::open(window.app_handle(), paths, Some(window.label().to_string()));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

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
        // Pulling a file out of the window showing it: that window doesn't count.
        assert_eq!(window_showing_except(&windows, &dir.join("a.md"), Some("w1")), None);
    }
}
