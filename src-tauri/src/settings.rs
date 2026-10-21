//! A small JSON settings file in the app's config folder (macOS:
//! ~/Library/Application Support/dev.plica.viewer/settings.json), e.g.
//! {"editor": "com.microsoft.VSCode", "recent": ["..."], "remoteContent": false}.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn read(app: &AppHandle) -> serde_json::Value {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn write(app: &AppHandle, key: &str, value: serde_json::Value) {
    let Some(file) = path(app) else { return };
    let mut json = read(app);
    json[key] = value;
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, serde_json::to_string_pretty(&json).unwrap_or_default());
}

/// Whether remote images load automatically. Off unless the user chose "Always load".
pub fn remote_content(app: &AppHandle) -> bool {
    read(app).get("remoteContent").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Save the remote-content preference and tell every window (and the macOS menu) about it.
pub fn set_remote_content(app: &AppHandle, allowed: bool) {
    write(app, "remoteContent", serde_json::Value::Bool(allowed));
    #[cfg(target_os = "macos")]
    crate::menu::set_remote_checked(app, allowed);
    let _ = app.emit("remote-content", allowed);
}

#[tauri::command]
pub fn get_remote_content(app: AppHandle) -> bool {
    remote_content(&app)
}

#[tauri::command]
pub fn save_remote_content(app: AppHandle, allowed: bool) {
    set_remote_content(&app, allowed);
}
