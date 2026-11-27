//! The Wiret desktop app: a window around the same TypeScript editor, compiler and VM that the
//! web page runs. Rust opens the window, gives the page native file dialogs and file access (the
//! dialog and fs plugins), and keeps the student's copies of the lessons; everything else
//! happens in the page.

use std::path::{Component, Path, PathBuf};

use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// The `.wiret` file named on the command line (`wiret lesson.wiret`, or opening a file from the
/// file manager), for the page to open when it starts.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .and_then(|a| std::fs::canonicalize(&a).ok().or(Some(a.into())))
        .map(|p| p.to_string_lossy().trim_start_matches(r"\?\").to_string())
}

/// Where the student's files live, as the desktop prototype's `user_dir`: `WIRET_HOME` if set,
/// else ~/Documents/Wiret, or ~/Wiret if there is no Documents folder. Both apps use the same
/// folder, so a lesson worked on in one continues in the other.
fn user_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    if let Some(env) = std::env::var_os("WIRET_HOME").filter(|v| !v.is_empty()) {
        let s = env.to_string_lossy();
        if s == "~" {
            return Ok(home);
        }
        if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
            return Ok(home.join(rest));
        }
        return Ok(PathBuf::from(env));
    }
    let docs = home.join("Documents");
    Ok(if docs.is_dir() { docs } else { home }.join("Wiret"))
}

/// The working copy of lesson `name` (a relative path such as `01_hello.wiret`) in my_lessons.
fn lesson_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let rel = Path::new(name);
    let plain = rel.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain || rel.extension().and_then(|e| e.to_str()) != Some("wiret") {
        return Err(format!("not a lesson name: {name}"));
    }
    Ok(lessons_root(app)?.join(rel))
}

fn lessons_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(user_dir(app)?.join("my_lessons"))
}

/// The folder the lesson copies are kept in, for telling the student where their work is.
#[tauri::command]
fn lessons_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(lessons_root(&app)?.to_string_lossy().into_owned())
}

/// The student's copy of a lesson, or None if they have not changed it.
#[tauri::command]
fn read_lesson_copy(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(lesson_path(&app, &name)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_lesson_copy(app: tauri::AppHandle, name: String, text: String) -> Result<(), String> {
    let path = lesson_path(&app, &name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Delete the copies of the named lessons; anything else in my_lessons stays. Returns how many.
#[tauri::command]
fn remove_lesson_copies(app: tauri::AppHandle, names: Vec<String>) -> Result<usize, String> {
    let mut removed = 0;
    for name in names {
        match std::fs::remove_file(lesson_path(&app, &name)?) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(removed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // A file given on the command line can be read and watched without a dialog.
            if let Some(path) = startup_file() {
                let _ = app.fs_scope().allow_file(&path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_file,
            lessons_dir,
            read_lesson_copy,
            write_lesson_copy,
            remove_lesson_copies
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Wiret desktop app");
}
