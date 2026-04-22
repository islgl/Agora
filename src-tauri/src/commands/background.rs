use tauri::{AppHandle, State};

use crate::background::BackgroundStatus;
use crate::state::RuntimeHandles;

#[tauri::command]
pub fn load_background_status(
    handles: State<'_, RuntimeHandles>,
) -> Result<BackgroundStatus, String> {
    Ok(handles.background.current_status())
}

#[tauri::command]
pub fn perform_background_action(app: AppHandle, action: String) -> Result<(), String> {
    crate::background::perform_background_action(app, &action)
}

#[tauri::command]
pub fn perform_launcher_submit(app: AppHandle, text: String) -> Result<(), String> {
    crate::background::submit_launcher_text(app, text);
    Ok(())
}

#[tauri::command]
pub fn hide_launcher_window(app: AppHandle) -> Result<(), String> {
    crate::background::hide_launcher(&app)
}
