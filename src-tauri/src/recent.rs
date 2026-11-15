//! File → Recent Changes: the Markdown and text files changed lately in the user's work folders and
//! Claude Code's plans, newest first, as a file list. It finds what a coding agent just wrote (in a
//! worktree, under `.claude/`) without hunting for its path, and it works the same for any agent.
//!
//! Checkouts, clones and copies write dozens of files in the same second; those bursts are left out so
//! a new worktree doesn't bury the files someone actually wrote.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::batch::{FileList, Recent};
use crate::AppState;

/// How far back to look.
pub const DAYS: u64 = 7;
/// Most files to list.
pub const LIMIT: usize = 200;
/// This many files written within a second of each other are a checkout or copy, not someone writing.
const BURST: usize = 5;
/// Stop walking after this long, whatever has been found (a huge folder shouldn't hang the list).
const BUDGET: Duration = Duration::from_secs(8);

const DOC_EXTS: &[&str] = &["md", "markdown", "mdx", "txt", "rst", "adoc"];

/// Folders that hold dependencies, build output or caches, never someone's notes.
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", ".venv", "venv", "__pycache__", ".next", ".nuxt",
    ".cache", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "Pods", "DerivedData", ".gradle", "vendor",
    "site-packages", ".Trash", "Library",
];

/// Folders people commonly keep code in, relative to home. Used when settings name none.
const WORK_DIRS: &[&str] =
    &["Workspace", "workspace", "Projects", "projects", "Developer", "Code", "code", "src", "dev", "repos", "git", "GitHub", "Documents/GitHub"];

/// The folders to scan: `recentFolders` from settings (a list of paths, `~` allowed), else Claude
/// Code's plans and whichever common code folders exist.
pub fn roots(home: &Path, configured: Option<Vec<String>>) -> Vec<PathBuf> {
    let expand = |s: &str| match s.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if s == "~" => home.to_path_buf(),
        None => PathBuf::from(s),
    };
    let candidates: Vec<PathBuf> = match configured.filter(|c| !c.is_empty()) {
        Some(list) => list.iter().map(|s| expand(s)).collect(),
        None => std::iter::once(home.join(".claude/plans")).chain(WORK_DIRS.iter().map(|d| home.join(d))).collect(),
    };
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for dir in candidates {
        // The same folder twice (a case-insensitive disk: Workspace = workspace) is scanned once.
        let Ok(real) = dir.canonicalize() else { continue };
        if real.is_dir() && !seen.contains(&real) {
            seen.push(real);
            out.push(dir);
        }
    }
    out
}

fn is_doc(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| DOC_EXTS.iter().any(|d| d.eq_ignore_ascii_case(e)))
}

fn skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.ends_with(".egg-info")
}

/// Document files under `roots` changed since `since`, with their change times. Symlinks are not
/// followed (a link to an external drive or a parent folder would be slow or loop).
pub fn walk(roots: &[PathBuf], since: SystemTime) -> Vec<(PathBuf, SystemTime)> {
    let queue = Mutex::new(roots.to_vec());
    let busy = AtomicUsize::new(0);
    let found = Mutex::new(Vec::new());
    let start = Instant::now();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let dir = {
                    let mut q = queue.lock().unwrap();
                    match q.pop() {
                        Some(d) => {
                            busy.fetch_add(1, Ordering::SeqCst);
                            d
                        }
                        None if busy.load(Ordering::SeqCst) == 0 => break,
                        None => {
                            drop(q);
                            std::thread::sleep(Duration::from_millis(1));
                            continue;
                        }
                    }
                };
                let (mut dirs, mut files) = (Vec::new(), Vec::new());
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let Ok(kind) = entry.file_type() else { continue };
                        let path = entry.path();
                        if kind.is_dir() {
                            if !skip_dir(&entry.file_name().to_string_lossy()) {
                                dirs.push(path);
                            }
                        } else if kind.is_file() && is_doc(&path) {
                            if let Some(t) = entry.metadata().ok().and_then(|m| m.modified().ok()).filter(|t| *t >= since) {
                                files.push((path, t));
                            }
                        }
                    }
                }
                if start.elapsed() < BUDGET {
                    queue.lock().unwrap().extend(dirs);
                }
                found.lock().unwrap().extend(files);
                busy.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    found.into_inner().unwrap()
}

/// Leave out files written in bursts (`BURST` or more within a second of each other), then sort the
/// rest newest first.
pub fn drop_bursts(mut files: Vec<(PathBuf, SystemTime)>) -> Vec<(PathBuf, SystemTime)> {
    files.sort_by_key(|(_, t)| *t);
    let secs: Vec<f64> = files.iter().map(|(_, t)| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()).collect();
    let (mut lo, mut hi) = (0, 0);
    let mut keep = vec![true; files.len()];
    for (i, &t) in secs.iter().enumerate() {
        while secs[lo] < t - 1.0 {
            lo += 1;
        }
        while hi + 1 < secs.len() && secs[hi + 1] <= t + 1.0 {
            hi += 1;
        }
        keep[i] = hi + 1 - lo < BURST;
    }
    let mut out: Vec<_> = files.into_iter().zip(keep).filter_map(|(f, k)| k.then_some(f)).collect();
    out.reverse();
    out
}

/// Where a file is, shown under its name: its folder relative to the scanned folder, or the scanned
/// folder itself (with `~` for home) when the file sits at its top.
fn detail(path: &Path, roots: &[PathBuf], home: &Path) -> String {
    let parent = path.parent().unwrap_or(path);
    let tilde = |p: &Path| match p.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    };
    let root = roots.iter().filter(|r| parent.starts_with(r)).max_by_key(|r| r.components().count());
    match root.map(|r| (r, parent.strip_prefix(r))) {
        Some((r, Ok(rel))) if rel.as_os_str().is_empty() => tilde(r),
        Some((_, Ok(rel))) => rel.display().to_string(),
        _ => tilde(parent),
    }
}

/// The recent-changes list for these folders, or None when nothing changed lately.
pub fn list(roots: &[PathBuf], home: &Path, now: SystemTime) -> Option<FileList> {
    let since = now.checked_sub(Duration::from_secs(DAYS * 86_400)).unwrap_or(UNIX_EPOCH);
    let mut files = drop_bursts(walk(roots, since));
    files.truncate(LIMIT);
    if files.is_empty() {
        return None;
    }
    let recent = files
        .iter()
        .map(|(p, t)| Recent { detail: detail(p, roots, home), modified: t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 })
        .collect();
    Some(FileList { folder: None, files: files.into_iter().map(|(p, _)| p).collect(), recent: Some(recent) })
}

/// Scan and show the list: in the window that already shows Recent Changes (refreshing it), else in
/// `from` if that window is empty, else in a new window. Slow folders take a few seconds, so call this
/// off the main thread.
pub fn open(app: &AppHandle, from: Option<String>) {
    let Ok(home) = app.path().home_dir() else { return };
    let roots = roots(&home, crate::settings::recent_folders(app));
    if let Some(label) = &from {
        crate::notify(app, Some(label), "Looking for recent changes…");
    }
    let Some(list) = list(&roots, &home, SystemTime::now()) else {
        let names: Vec<String> = roots.iter().map(|r| detail(&r.join("x"), &[], &home)).collect();
        let msg = if names.is_empty() {
            "No folders to look in. Add some to \"recentFolders\" in Plica's settings.json.".to_string()
        } else {
            format!("No Markdown or text files changed in the last {DAYS} days in {}.", names.join(", "))
        };
        crate::notify(app, from.as_deref(), &msg);
        return;
    };
    let target = from.filter(|label| {
        let state = app.state::<AppState>();
        let windows = state.windows.lock().unwrap();
        let already = windows.values().any(|w| w.list.as_ref().is_some_and(|l| l.recent.is_some()));
        !already && windows.get(label).is_some_and(|w| w.current.is_none() && w.pending.is_none() && w.list.is_none())
    });
    crate::open_list(app, list, target);
}

#[tauri::command]
pub fn recent_changes(app: AppHandle, window: tauri::WebviewWindow) {
    let label = window.label().to_string();
    std::thread::spawn(move || open(&app, Some(label)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn bursts_are_left_out_and_the_rest_is_newest_first() {
        let mut files: Vec<(PathBuf, SystemTime)> = vec![("a.md".into(), at(100)), ("b.md".into(), at(200)), ("c.md".into(), at(150))];
        // A checkout: six files in the same second.
        files.extend((0..6).map(|i| (PathBuf::from(format!("wt/{i}.md")), at(500))));
        let names: Vec<_> = drop_bursts(files).into_iter().map(|(p, _)| p).collect();
        assert_eq!(names, vec![PathBuf::from("b.md"), "c.md".into(), "a.md".into()]);
        // Four files in a second (a small git pull) stay.
        let small: Vec<_> = (0..4).map(|i| (PathBuf::from(format!("{i}.md")), at(10))).collect();
        assert_eq!(drop_bursts(small).len(), 4);
    }

    #[test]
    fn walks_documents_only_skipping_dependencies_old_files_and_links() {
        let dir = std::env::temp_dir().join(format!("plica-test-recent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for d in ["repo/.claude/worktrees/x", "repo/node_modules/pkg", "repo/.git", "repo/docs"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in ["repo/.claude/worktrees/x/plan.md", "repo/docs/notes.TXT", "repo/main.rs", "repo/node_modules/pkg/README.md", "repo/.git/x.md", "repo/old.md"] {
            fs::write(dir.join(f), "x").unwrap();
        }
        File::options().write(true).open(dir.join("repo/old.md")).unwrap().set_modified(at(1000)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("repo"), dir.join("repo/docs/loop")).unwrap();
        let mut found: Vec<_> = walk(std::slice::from_ref(&dir), at(2000)).into_iter().map(|(p, _)| p.strip_prefix(&dir).unwrap().to_path_buf()).collect();
        found.sort();
        assert_eq!(found, vec![PathBuf::from("repo/.claude/worktrees/x/plan.md"), "repo/docs/notes.TXT".into()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn roots_default_to_existing_code_folders_once_each() {
        let home = std::env::temp_dir().join(format!("plica-test-home-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".claude/plans")).unwrap();
        fs::create_dir_all(home.join("Projects")).unwrap();
        let got = roots(&home, None);
        assert!(got.contains(&home.join(".claude/plans")));
        assert_eq!(got.iter().filter(|r| r.to_string_lossy().to_lowercase().ends_with("projects")).count(), 1);
        assert_eq!(roots(&home, Some(vec!["~/Projects".into(), "/nope".into()])), vec![home.join("Projects")]);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn detail_is_the_folder_relative_to_the_scanned_one() {
        let home = Path::new("/u");
        let roots = [PathBuf::from("/u/Workspace"), PathBuf::from("/u/.claude/plans")];
        assert_eq!(detail(Path::new("/u/Workspace/plica/docs/a.md"), &roots, home), "plica/docs");
        assert_eq!(detail(Path::new("/u/.claude/plans/p.md"), &roots, home), "~/.claude/plans");
        assert_eq!(detail(Path::new("/elsewhere/a.md"), &roots, home), "/elsewhere");
    }

    /// Times a scan of this machine's real folders: `cargo test scan_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn scan_real() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let roots = roots(&home, None);
        let t = Instant::now();
        let list = list(&roots, &home, SystemTime::now());
        println!("roots {roots:?}\n{} files in {:?}", list.as_ref().map_or(0, |l| l.files.len()), t.elapsed());
        for (p, r) in list.iter().flat_map(|l| l.files.iter().zip(l.recent.as_ref().unwrap())).take(15) {
            println!("{}  [{}]", p.display(), r.detail);
        }
    }
}
