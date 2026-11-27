//! The Wiret desktop app: a window around the same TypeScript editor, compiler and VM that the
//! web page runs. Rust only opens the window and gives the page native file dialogs and file
//! access (the dialog and fs plugins); everything else happens in the page.

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
        .invoke_handler(tauri::generate_handler![startup_file])
        .run(tauri::generate_context!())
        .expect("error while running the Wiret desktop app");
}
