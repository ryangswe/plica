//! Opening several files at once (Finder multi-select, Dock drop, command line, drag and drop) and
//! whole folders (File → Open Folder…). A batch becomes one window with the files listed in a sidebar,
//! in the order Finder lists them by name. Files Plica can't show (binary) are skipped and named in a
//! notice.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Serialize;
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

/// The files a window lists in its sidebar.
#[derive(Debug, Clone, PartialEq)]
pub struct FileList {
    /// Set when the list is a folder's files (it goes in Open Recent, and opening it again finds it).
    pub folder: Option<PathBuf>,
    pub files: Vec<PathBuf>,
}

/// What the page gets: a heading and the files.
#[derive(Serialize, Clone)]
pub struct ListPayload {
    title: String,
    items: Vec<ListItem>,
}

#[derive(Serialize, Clone)]
struct ListItem {
    name: String,
    path: String,
}

impl FileList {
    /// The folder's name; for files chosen together, their folder's name when they share one.
    pub fn title(&self) -> String {
        if let Some(f) = &self.folder {
            return name(f);
        }
        let parents: Vec<Option<&Path>> = self.files.iter().map(|f| f.parent()).collect();
        match parents.first() {
            Some(Some(p)) if parents.iter().all(|q| q == &Some(*p)) && !name(p).is_empty() => name(p),
            _ => "Files".into(),
        }
    }

    pub fn payload(&self) -> ListPayload {
        let items = self.files.iter().map(|f| ListItem { name: name(f), path: f.to_string_lossy().into_owned() }).collect();
        ListPayload { title: self.title(), items }
    }

    /// The same folder, or the same files.
    pub fn same_as(&self, other: &FileList) -> bool {
        match (&self.folder, &other.folder) {
            (Some(a), Some(b)) => crate::canon(a) == crate::canon(b),
            (None, None) => self.files == other.files,
            _ => false,
        }
    }
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
    // Finder sends folders as ".../docs/": drop the trailing slash so Open Recent sees one folder.
    let paths: Vec<PathBuf> = paths.iter().map(|p| p.components().collect()).collect();
    let folder = match paths.as_slice() {
        [one] if one.is_dir() => Some(one.clone()),
        _ => None,
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    for p in &paths {
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

/// Open a batch (several files and/or folders) in window `target`, or in a window of its own. Asks
/// first when it's a lot of files.
pub fn open(app: &AppHandle, paths: Vec<PathBuf>, target: Option<String>) {
    let plan = plan(&paths);
    if plan.files.len() <= CONFIRM_OVER {
        return open_plan(app, plan, target);
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
                open_plan(&handle, plan, target);
            }
        });
}

fn open_plan(app: &AppHandle, plan: Plan, target: Option<String>) {
    let message = summary(&plan);
    #[cfg(target_os = "macos")]
    if let Some(folder) = plan.folder.clone().filter(|_| !plan.files.is_empty()) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::menu::note_recent(&handle, &folder));
    }
    // Window → Open Groups of Files as Tabs: one native tab per file instead of a file list.
    #[cfg(target_os = "macos")]
    if crate::settings::groups_as_tabs(app) && plan.files.len() > 1 {
        let labels = crate::open::open_for_tabs(app, plan.files, target.is_some());
        let (handle, tabs, anchor) = (app.clone(), labels.clone(), target.clone());
        let _ = app.run_on_main_thread(move || crate::chrome::group_as_tabs(&handle, anchor.as_deref(), &tabs));
        if let Some(msg) = message {
            crate::notify(app, labels.first().or(target.as_ref()).map(String::as_str), &msg);
        }
        return;
    }
    let label = match (&plan.folder, plan.files.as_slice()) {
        (_, []) => target,
        // One file chosen (plus some that aren't text): no list needed.
        (None, [one]) => match target {
            Some(label) => {
                crate::show_in(app, &label, one.clone());
                Some(label)
            }
            None => {
                crate::open_paths(app, vec![one.clone()]);
                None
            }
        },
        _ => crate::open_list(app, FileList { folder: plan.folder, files: plan.files }, target),
    };
    if let Some(msg) = message {
        crate::notify(app, label.as_deref(), &msg);
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
        let slash = PathBuf::from(format!("{}/", dir.display()));
        assert_eq!(plan(&[slash]).folder, Some(dir.clone()));
    }

    #[test]
    fn list_titles_and_identity() {
        let files = |v: &[&str]| v.iter().map(PathBuf::from).collect::<Vec<_>>();
        let folder = FileList { folder: Some("/x/docs".into()), files: files(&["/x/docs/a.md"]) };
        assert_eq!(folder.title(), "docs");
        let together = FileList { folder: None, files: files(&["/x/notes/a.md", "/x/notes/b.md"]) };
        assert_eq!(together.title(), "notes");
        let mixed = FileList { folder: None, files: files(&["/x/a.md", "/y/b.md"]) };
        assert_eq!(mixed.title(), "Files");
        // Opening the same folder again finds the window that has it, even if its files changed.
        assert!(folder.same_as(&FileList { folder: Some("/x/docs".into()), files: vec![] }));
        assert!(!folder.same_as(&together));
        assert!(together.same_as(&together.clone()));
        let p = together.payload();
        assert_eq!((p.title.as_str(), p.items.len(), p.items[1].name.as_str()), ("notes", 2, "b.md"));
    }

    #[test]
    fn says_when_nothing_can_be_shown() {
        let p = Plan { folder: Some(PathBuf::from("/x/pics")), ..Default::default() };
        assert_eq!(summary(&p).unwrap(), "Nothing to show in “pics”: Plica opens text files only.");
        assert_eq!(summary(&Plan { files: vec![PathBuf::from("/a.md")], ..Default::default() }), None);
    }
}
