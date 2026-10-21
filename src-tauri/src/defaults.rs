//! "Open these files with Plica": which app opens each supported file type, and making Plica the
//! default for the types the user picks. Only on the user's request (a banner or the Default Apps window),
//! never silently.
//!
//! macOS sets defaults per content type (UTType) through NSWorkspace. Windows doesn't allow apps to set
//! themselves as default, and Linux isn't wired up yet, so there the window shows instructions instead.

use serde::Serialize;

/// The file types Plica registers for (keep in sync with `fileAssociations` in tauri.conf.json; a test
/// checks it). (id, label, extensions)
pub const TYPES: &[(&str, &str, &[&str])] = &[
    ("markdown", "Markdown", &["md", "markdown", "mdown", "mkd", "mkdn"]),
    ("json", "JSON", &["json", "jsonc", "geojson"]),
    ("jsonl", "JSON Lines", &["jsonl", "ndjson"]),
    ("csv", "CSV", &["csv"]),
    ("tsv", "TSV", &["tsv"]),
    ("notebook", "Jupyter notebooks", &["ipynb"]),
    ("log", "Logs", &["log"]),
    ("diff", "Diffs and patches", &["diff", "patch"]),
    ("mermaid", "Mermaid diagrams", &["mmd", "mermaid"]),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionApp {
    ext: &'static str,
    /// Name of the app that opens .ext now, if any.
    app: Option<String>,
    is_plica: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeInfo {
    id: &'static str,
    label: &'static str,
    /// Per extension: who opens it now (empty where the platform can't tell).
    extensions: Vec<ExtensionApp>,
    /// Plica already opens every extension of this type.
    is_plica: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppsInfo {
    /// This platform lets Plica set defaults itself (macOS). Otherwise show instructions.
    supported: bool,
    platform: &'static str,
    types: Vec<TypeInfo>,
}

#[derive(Serialize)]
pub struct SetResult {
    id: String,
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn default_apps() -> DefaultAppsInfo {
    let platform = if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "linux" };
    let types = TYPES
        .iter()
        .map(|(id, label, exts)| {
            let extensions: Vec<ExtensionApp> = exts
                .iter()
                .map(|ext| {
                    #[cfg(target_os = "macos")]
                    let (app, is_plica) = mac::current(ext);
                    #[cfg(not(target_os = "macos"))]
                    let (app, is_plica) = (None, false);
                    ExtensionApp { ext, app, is_plica }
                })
                .collect();
            let is_plica = extensions.iter().all(|e| e.is_plica);
            TypeInfo { id, label, extensions, is_plica }
        })
        .collect();
    DefaultAppsInfo { supported: cfg!(target_os = "macos"), platform, types }
}

/// Make Plica the default for these type ids. Async so waiting for macOS doesn't block the UI.
#[tauri::command]
pub async fn set_default_apps(ids: Vec<String>) -> Vec<SetResult> {
    ids.into_iter()
        .map(|id| {
            let Some((_, _, extensions)) = TYPES.iter().find(|(tid, _, _)| *tid == id) else {
                return SetResult { id, ok: false, error: Some("Unknown file type".into()) };
            };
            #[cfg(target_os = "macos")]
            let result = mac::set(extensions);
            #[cfg(not(target_os = "macos"))]
            let result: Result<(), String> = {
                let _ = extensions;
                Err("Set this in your system settings".into())
            };
            match result {
                Ok(()) => SetResult { id, ok: true, error: None },
                Err(e) => SetResult { id, ok: false, error: Some(e) },
            }
        })
        .collect()
}

#[tauri::command]
pub fn default_apps_prompt_dismissed(app: tauri::AppHandle) -> bool {
    crate::settings::read(&app).get("defaultAppsPromptDismissed").and_then(|v| v.as_bool()).unwrap_or(false)
}

#[tauri::command]
pub fn dismiss_default_apps_prompt(app: tauri::AppHandle) {
    crate::settings::write(&app, "defaultAppsPromptDismissed", serde_json::Value::Bool(true));
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSError, NSObjectProtocol, NSString, NSURL};
    use objc2_uniform_type_identifiers::UTType;

    /// The distinct content types behind these extensions, as macOS resolves them on this Mac
    /// (e.g. .mmd may belong to another app's type; unknown ones get a dynamic type).
    fn types_for(extensions: &[&str]) -> Vec<Retained<UTType>> {
        let mut out: Vec<Retained<UTType>> = Vec::new();
        for ext in extensions {
            if let Some(t) = UTType::typeWithFilenameExtension(&NSString::from_str(ext)) {
                if !out.iter().any(|o| o.identifier().to_string() == t.identifier().to_string()) {
                    out.push(t);
                }
            }
        }
        out
    }

    fn is_this_app(url: &NSURL) -> bool {
        let ours = NSBundle::mainBundle().bundleIdentifier().map(|s| s.to_string());
        let theirs = NSBundle::bundleWithURL(url).and_then(|b| b.bundleIdentifier()).map(|s| s.to_string());
        ours.is_some() && ours == theirs
    }

    fn app_name(url: &NSURL) -> Option<String> {
        let name = url.lastPathComponent()?.to_string();
        Some(name.strip_suffix(".app").unwrap_or(&name).to_string())
    }

    /// (name of the app that opens .ext, whether that's Plica)
    pub fn current(ext: &str) -> (Option<String>, bool) {
        let Some(t) = types_for(&[ext]).into_iter().next() else { return (None, false) };
        let Some(url) = NSWorkspace::sharedWorkspace().URLForApplicationToOpenContentType(&t) else { return (None, false) };
        (app_name(&url), is_this_app(&url))
    }

    pub fn set(extensions: &[&str]) -> Result<(), String> {
        let ws = NSWorkspace::sharedWorkspace();
        if !ws.respondsToSelector(objc2::sel!(setDefaultApplicationAtURL:toOpenContentType:completionHandler:)) {
            return Err("Needs macOS 12 or later".into());
        }
        let app_url = NSBundle::mainBundle().bundleURL();
        for t in types_for(extensions) {
            let (tx, rx) = mpsc::channel::<Option<String>>();
            let block = RcBlock::new(move |err: *mut NSError| {
                // SAFETY: AppKit passes either null or a valid NSError for the duration of the call.
                let msg = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string());
                let _ = tx.send(msg);
            });
            ws.setDefaultApplicationAtURL_toOpenContentType_completionHandler(&app_url, &t, Some(&block));
            match rx.recv_timeout(Duration::from_secs(30)) {
                Ok(None) => {}
                Ok(Some(e)) => return Err(e),
                Err(_) => return Err("macOS didn't answer".into()),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_match_the_file_associations_in_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut declared: Vec<String> = conf["bundle"]["fileAssociations"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|a| a["ext"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_string()))
            .collect();
        let mut ours: Vec<String> = TYPES.iter().flat_map(|(_, _, exts)| exts.iter().map(|e| e.to_string())).collect();
        declared.sort();
        ours.sort();
        assert_eq!(ours, declared);
    }

    #[test]
    fn other_platforms_report_unsupported_instead_of_failing() {
        if cfg!(target_os = "macos") {
            return;
        }
        let info = default_apps();
        assert!(!info.supported);
        assert_eq!(info.types.len(), TYPES.len());
    }
}
