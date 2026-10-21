//! Reading files for the frontend (size cap, binary detection, encodings) and deciding which watcher
//! events concern an open file.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use notify::EventKind;
use serde::Serialize;

use crate::encoding::{self, decode_text};

/// Files bigger than this are cut off; nobody wants to scroll a 64 MB log in a viewer.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileData {
    path: String,
    name: String,
    text: String,
    size: u64,
    binary: bool,
    truncated: bool,
    /// Encoding the text was decoded from, e.g. "UTF-8", "UTF-16LE", "windows-1252".
    encoding: String,
}

pub fn read_file_data(path: &Path) -> Result<FileData, String> {
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
pub fn read_file(path: String, encoding: Option<String>) -> Result<FileData, String> {
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

/// Whether a watcher event in the file's folder is about the file. Removals count too, so the
/// frontend re-reads and can tell the user the file is gone instead of silently showing old content.
pub fn concerns_file(event: &notify::Event, file_name: &std::ffi::OsStr) -> bool {
    matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_))
        && event.paths.iter().any(|p| p.file_name() == Some(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

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
}
