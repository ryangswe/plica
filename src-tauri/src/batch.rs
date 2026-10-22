//! Opening several files at once (Finder multi-select, Dock drop, command line, drag and drop) and
//! whole folders ("Open Folder as Tabs"). On macOS a batch becomes one window with a tab per file, in
//! the order Finder lists them by name; elsewhere (no native tabs) each file gets its own window.
//! Files Plica can't show (binary) are skipped and named in a notice.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// Ask before opening more files than this at once.
pub const CONFIRM_OVER: usize = 25;

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Files to open, in tab order.
    pub files: Vec<PathBuf>,
    /// Files left out because they aren't text.
    pub skipped: Vec<PathBuf>,
    /// The folder, when the batch is one folder (for messages).
    pub folder: Option<PathBuf>,
}

/// Compare names the way Finder sorts by name: case-insensitive, numbers by value ("2" < "10").
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (na, nb) = (take(&mut a), take(&mut b));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)).then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Top-level, non-hidden files of a folder, sorted like Finder's name order.
pub fn folder_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.is_file() && !name(p).starts_with('.'));
    files.sort_by(|a, b| natural_cmp(&name(a), &name(b)));
    files
}

/// What to open for these paths: folders expand to their files; binary files are set aside.
/// Explicitly chosen files are sorted by name too, since Finder doesn't tell us its order.
pub fn plan(paths: &[PathBuf]) -> Plan {
    let folder = match paths {
        [one] if one.is_dir() => Some(one.clone()),
        _ => None,
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    for p in paths {
        if p.is_dir() {
            candidates.extend(folder_files(p));
        } else if p.is_file() && !candidates.contains(p) {
            candidates.push(p.clone());
        }
    }
    if folder.is_none() {
        candidates.sort_by(|a, b| natural_cmp(&name(a), &name(b)));
    }
    let (files, skipped) = candidates.into_iter().partition(|p| !crate::files::looks_binary(p));
    Plan { files, skipped, folder }
}

/// "Opened 7 files. Skipped 2 that aren't text: logo.png, report.pdf"
pub fn summary(plan: &Plan) -> Option<String> {
    if plan.files.is_empty() {
        let where_ = plan.folder.as_deref().map_or("these files".to_string(), |f| format!("“{}”", name(f)));
        return Some(format!("Nothing to show in {where_}: Plica opens text files only."));
    }
    if plan.skipped.is_empty() {
        return None;
    }
    let names: Vec<String> = plan.skipped.iter().take(4).map(|p| name(p)).collect();
    let more = plan.skipped.len().saturating_sub(4);
    let list = if more > 0 { format!("{}, and {more} more", names.join(", ")) } else { names.join(", ") };
    let n = plan.files.len();
    let s = plan.skipped.len();
    Some(format!(
        "Opened {n} file{}. Skipped {s} that {} text: {list}",
        if n == 1 { "" } else { "s" },
        if s == 1 { "isn't" } else { "aren't" }
    ))
}

/// Open a batch (several files and/or folders). Asks first when it's a lot of files.
pub fn open(app: &AppHandle, paths: Vec<PathBuf>) {
    let plan = plan(&paths);
    if plan.files.len() <= CONFIRM_OVER {
        return open_plan(app, plan);
    }
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let n = plan.files.len();
    let what = plan.folder.as_deref().map_or("these files".to_string(), |f| format!("“{}”", name(f)));
    let handle = app.clone();
    app.dialog()
        .message(format!("{what} has {n} files Plica can show. Open all of them?"))
        .title("Open Many Files")
        .buttons(MessageDialogButtons::OkCancelCustom(format!("Open {n} Files"), "Cancel".into()))
        .show(move |ok| {
            if ok {
                open_plan(&handle, plan);
            }
        });
}

fn open_plan(app: &AppHandle, plan: Plan) {
    let message = summary(&plan);
    let labels = crate::open_files_in_windows(app, plan.files);
    #[cfg(target_os = "macos")]
    if crate::settings::batch_tabs(app) && labels.len() > 1 {
        let handle = app.clone();
        let tabs = labels.clone();
        let _ = app.run_on_main_thread(move || crate::chrome::group_as_tabs(&handle, &tabs));
    }
    if let Some(msg) = message {
        crate::notify(app, labels.first().map(String::as_str), &msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn sorts_names_like_finder() {
        let mut v = vec!["b.md", "a10.md", "A2.md", "a1.md", "README.md", "a02.md"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["a1.md", "A2.md", "a02.md", "a10.md", "b.md", "README.md"]);
    }

    #[test]
    fn folder_expands_to_visible_text_files_in_name_order() {
        let dir = std::env::temp_dir().join(format!("plica-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for (n, body) in [("10-end.md", &b"# end"[..]), ("2-two.md", b"two"), ("1-one.md", b"one"), (".hidden.md", b"h"), ("logo.png", &[0x89, b'P', 0, 0, 1][..])] {
            File::create(dir.join(n)).unwrap().write_all(body).unwrap();
        }
        File::create(dir.join("sub/inner.md")).unwrap();
        let p = plan(std::slice::from_ref(&dir));
        let names: Vec<String> = p.files.iter().map(|f| name(f)).collect();
        assert_eq!(names, ["1-one.md", "2-two.md", "10-end.md"]); // no hidden, no subfolder
        assert_eq!(p.skipped, [dir.join("logo.png")]);
        assert_eq!(summary(&p).unwrap(), "Opened 3 files. Skipped 1 that isn't text: logo.png");
    }

    #[test]
    fn says_when_nothing_can_be_shown() {
        let p = Plan { folder: Some(PathBuf::from("/x/pics")), ..Default::default() };
        assert_eq!(summary(&p).unwrap(), "Nothing to show in “pics”: Plica opens text files only.");
        assert_eq!(summary(&Plan { files: vec![PathBuf::from("/a.md")], ..Default::default() }), None);
    }
}
