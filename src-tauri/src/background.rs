use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Position, Rect, WebviewWindow,
    WebviewWindowBuilder, Wry,
};

use crate::models::GlobalSettings;

pub const BACKGROUND_ACTION_EVENT: &str = "agora-background-action";
pub const BACKGROUND_STATUS_EVENT: &str = "agora-background-status-changed";
pub const PANEL_WINDOW_LABEL: &str = "menubar-panel";
pub const LAUNCHER_WINDOW_LABEL: &str = "launcher";

const QUICK_LAUNCH_OFF_MESSAGE: &str = "Double Option quick launch is turned off.";
const QUICK_LAUNCH_READY_MESSAGE: &str = "Double Option quick launch is active in the background.";
const QUICK_LAUNCH_PERMISSION_MESSAGE: &str =
    "Double Option quick launch could not start. macOS may require Input Monitoring or Accessibility permission.";
#[cfg(not(target_os = "macos"))]
const QUICK_LAUNCH_UNSUPPORTED_MESSAGE: &str =
    "Double Option quick launch is currently available on macOS only.";

const PANEL_WIDTH: f64 = 372.0;
const PANEL_MARGIN_TOP: f64 = 2.0;
const PANEL_MARGIN_RIGHT: f64 = 14.0;
const PANEL_EDGE_OFFSET: f64 = 6.0;
const LAUNCHER_WIDTH: f64 = 620.0;
const LAUNCHER_TOP_RATIO: f64 = 0.30;

pub type SharedBackgroundManager = Arc<BackgroundManager>;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    pub menubar_ready: bool,
    pub quick_launch_enabled: bool,
    pub quick_launch_active: bool,
    pub quick_launch_requires_permission: bool,
    pub quick_launch_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundActionPayload {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

struct TrayState {
    #[allow(dead_code)]
    icon: TrayIcon<Wry>,
}

struct BackgroundStateInner {
    tray: Option<TrayState>,
    tray_rect: Option<Rect>,
    last_panel_shown_at: Option<Instant>,
    last_launcher_shown_at: Option<Instant>,
    #[cfg(target_os = "macos")]
    quick_launch_monitor: Option<macos::OptionDoubleTapMonitor>,
    #[cfg(target_os = "macos")]
    click_outside_monitor: Option<macos::ClickOutsideMonitor>,
    status: BackgroundStatus,
    close_to_tray_enabled: bool,
}

pub struct BackgroundManager {
    inner: Mutex<BackgroundStateInner>,
}

impl BackgroundManager {
    pub fn new() -> SharedBackgroundManager {
        Arc::new(Self {
            inner: Mutex::new(BackgroundStateInner {
                tray: None,
                tray_rect: None,
                last_panel_shown_at: None,
                last_launcher_shown_at: None,
                #[cfg(target_os = "macos")]
                quick_launch_monitor: None,
                #[cfg(target_os = "macos")]
                click_outside_monitor: None,
                status: BackgroundStatus::default(),
                close_to_tray_enabled: true,
            }),
        })
    }

    fn note_panel_shown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_panel_shown_at = Some(Instant::now());
        }
    }

    fn was_panel_recently_shown(&self, threshold: Duration) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.last_panel_shown_at)
            .map(|t| t.elapsed() < threshold)
            .unwrap_or(false)
    }

    fn note_launcher_shown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_launcher_shown_at = Some(Instant::now());
        }
    }

    fn was_launcher_recently_shown(&self, threshold: Duration) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.last_launcher_shown_at)
            .map(|t| t.elapsed() < threshold)
            .unwrap_or(false)
    }

    pub fn set_tray_rect(&self, rect: Rect) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.tray_rect = Some(rect);
        }
    }

    pub fn tray_rect(&self) -> Option<Rect> {
        self.inner.lock().ok().and_then(|inner| inner.tray_rect)
    }

    pub fn initialize(&self, app: &AppHandle, settings: &GlobalSettings) {
        if let Err(err) = self.ensure_tray(app) {
            eprintln!("background tray init failed: {err}");
            let status = {
                let mut inner = self.inner.lock().expect("background state poisoned");
                inner.status.menubar_ready = false;
                inner.status.clone()
            };
            self.emit_status(app, status);
        }
        self.set_quick_launch_enabled(app, settings.quick_launch_enabled);
        self.set_close_to_tray_enabled(settings.close_to_tray_enabled);
        #[cfg(target_os = "macos")]
        self.ensure_click_outside_monitor(app);
    }

    fn set_close_to_tray_enabled(&self, enabled: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.close_to_tray_enabled = enabled;
        }
    }

    pub fn close_to_tray_enabled(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.close_to_tray_enabled)
            .unwrap_or(true)
    }

    #[cfg(target_os = "macos")]
    fn ensure_click_outside_monitor(&self, app: &AppHandle) {
        {
            let inner = self.inner.lock().expect("background state poisoned");
            if inner.click_outside_monitor.is_some() {
                return;
            }
        }
        match macos::ClickOutsideMonitor::start(app.clone()) {
            Ok(monitor) => {
                let mut inner = self.inner.lock().expect("background state poisoned");
                inner.click_outside_monitor = Some(monitor);
            }
            Err(err) => {
                eprintln!("click-outside monitor init failed: {err}");
            }
        }
    }

    pub fn apply_settings(&self, app: &AppHandle, settings: &GlobalSettings) {
        self.initialize(app, settings);
    }

    pub fn current_status(&self) -> BackgroundStatus {
        self.inner
            .lock()
            .expect("background state poisoned")
            .status
            .clone()
    }

    fn ensure_tray(&self, app: &AppHandle) -> Result<(), String> {
        let already_ready = self
            .inner
            .lock()
            .expect("background state poisoned")
            .tray
            .is_some();
        if already_ready {
            return Ok(());
        }

        let icon = tray_icon_image()?;
        let tray_icon = tauri::tray::TrayIconBuilder::with_id("agora-menubar")
            .icon(icon)
            .icon_as_template(true)
            .show_menu_on_left_click(false)
            .tooltip("Agora")
            .on_tray_icon_event(|tray, event| {
                handle_tray_icon_event(tray.app_handle().clone(), event);
            })
            .build(app)
            .map_err(|e| e.to_string())?;

        let status = {
            let mut inner = self.inner.lock().expect("background state poisoned");
            inner.tray = Some(TrayState { icon: tray_icon });
            inner.status.menubar_ready = true;
            inner.status.clone()
        };
        self.emit_status(app, status);
        Ok(())
    }

    fn set_quick_launch_enabled(&self, app: &AppHandle, enabled: bool) {
        #[cfg(target_os = "macos")]
        let previous_monitor = {
            let mut inner = self.inner.lock().expect("background state poisoned");
            inner.quick_launch_monitor.take()
        };
        #[cfg(target_os = "macos")]
        if let Some(monitor) = previous_monitor {
            monitor.stop(app);
        }

        #[cfg(target_os = "macos")]
        let (monitor, active, requires_permission, message) = if enabled {
            match macos::OptionDoubleTapMonitor::start(app.clone()) {
                Ok(monitor) => (
                    Some(monitor),
                    true,
                    false,
                    QUICK_LAUNCH_READY_MESSAGE.to_string(),
                ),
                Err(err) => (None, false, true, err),
            }
        } else {
            (None, false, false, QUICK_LAUNCH_OFF_MESSAGE.to_string())
        };

        #[cfg(not(target_os = "macos"))]
        let (active, requires_permission, message) = if enabled {
            (false, false, QUICK_LAUNCH_UNSUPPORTED_MESSAGE.to_string())
        } else {
            (false, false, QUICK_LAUNCH_OFF_MESSAGE.to_string())
        };

        let status = {
            let mut inner = self.inner.lock().expect("background state poisoned");
            #[cfg(target_os = "macos")]
            {
                inner.quick_launch_monitor = monitor;
            }
            inner.status.quick_launch_enabled = enabled;
            inner.status.quick_launch_active = active;
            inner.status.quick_launch_requires_permission = requires_permission;
            inner.status.quick_launch_message = message;
            inner.status.clone()
        };

        self.emit_status(app, status);
    }

    fn emit_status(&self, app: &AppHandle, status: BackgroundStatus) {
        let _ = app.emit(BACKGROUND_STATUS_EVENT, status);
    }
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    // Handle main-window close based on user preference. Tray keeps the
    // process alive otherwise, so an explicit `app.exit(0)` is required
    // when the user wants a full quit. Other windows (menubar panel,
    // launcher) follow their default hide/close behaviour.
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
            let app = window.app_handle();
            let enabled = app
                .try_state::<crate::state::RuntimeHandles>()
                .map(|handles| handles.background.close_to_tray_enabled())
                .unwrap_or(true);
            if enabled {
                api.prevent_close();
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
            } else {
                api.prevent_close();
                app.exit(0);
            }
        }
        return;
    }

    if !matches!(event, tauri::WindowEvent::Focused(true)) {
        return;
    }
    let label = window.label();
    let app = window.app_handle();
    let handles = app.try_state::<crate::state::RuntimeHandles>();

    // Hide the menubar panel when any other window takes focus, unless we
    // just opened it (macOS activate_app briefly shuffles focus on show).
    if label != PANEL_WINDOW_LABEL {
        let guard = handles
            .as_ref()
            .map(|h| {
                h.background
                    .was_panel_recently_shown(Duration::from_millis(250))
            })
            .unwrap_or(false);
        if !guard {
            if let Some(panel) = app.get_webview_window(PANEL_WINDOW_LABEL) {
                if panel.is_visible().unwrap_or(false) {
                    let _ = panel.hide();
                }
            }
        }
    }

    // Same logic for the launcher floating window.
    if label != LAUNCHER_WINDOW_LABEL {
        let guard = handles
            .as_ref()
            .map(|h| {
                h.background
                    .was_launcher_recently_shown(Duration::from_millis(250))
            })
            .unwrap_or(false);
        if !guard {
            if let Some(launcher) = app.get_webview_window(LAUNCHER_WINDOW_LABEL) {
                if launcher.is_visible().unwrap_or(false) {
                    let _ = launcher.hide();
                }
            }
        }
    }
}

fn handle_tray_icon_event(app: AppHandle, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        rect,
        ..
    } = event
    {
        if let Some(handles) = app.try_state::<crate::state::RuntimeHandles>() {
            handles.background.set_tray_rect(rect);
        }
        if let Err(err) = toggle_menubar_panel(&app) {
            eprintln!("failed to toggle menubar panel: {err}");
        }
    }
}

pub fn perform_background_action(app: AppHandle, action: &str) -> Result<(), String> {
    match action {
        "new-conversation" => {
            let _ = hide_menubar_panel(&app);
            let _ = hide_launcher(&app);
            dispatch_background_action(app, "new-conversation");
            Ok(())
        }
        "open-settings" => {
            let _ = hide_menubar_panel(&app);
            let _ = hide_launcher(&app);
            dispatch_background_action(app, "open-settings");
            Ok(())
        }
        "open-agora" => {
            let _ = hide_menubar_panel(&app);
            let _ = hide_launcher(&app);
            show_main_window(&app).map(|_| ())
        }
        "toggle-menubar-panel" => toggle_menubar_panel(&app),
        "hide-menubar-panel" => hide_menubar_panel(&app),
        "toggle-launcher" => toggle_launcher(&app),
        "hide-launcher" => hide_launcher(&app),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        other => Err(format!("unknown background action: {other}")),
    }
}

pub fn submit_launcher_text(app: AppHandle, text: String) {
    let _ = hide_launcher(&app);
    dispatch_background_action_with_text(app, "new-conversation-with-text", Some(text));
}

fn toggle_menubar_panel(app: &AppHandle) -> Result<(), String> {
    let window = ensure_menubar_panel(app)?;
    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }

    position_menubar_panel(app, &window)?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Some(handles) = app.try_state::<crate::state::RuntimeHandles>() {
        handles.background.note_panel_shown();
    }
    #[cfg(target_os = "macos")]
    macos::activate_app(app);
    Ok(())
}

fn hide_menubar_panel(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PANEL_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn show_launcher(app: &AppHandle) -> Result<(), String> {
    let window = ensure_launcher_window(app)?;
    position_launcher(app, &window)?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Some(handles) = app.try_state::<crate::state::RuntimeHandles>() {
        handles.background.note_launcher_shown();
    }
    #[cfg(target_os = "macos")]
    macos::activate_app(app);
    Ok(())
}

pub fn hide_launcher(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LAUNCHER_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn toggle_launcher(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LAUNCHER_WINDOW_LABEL) {
        if window.is_visible().map_err(|e| e.to_string())? {
            return hide_launcher(app);
        }
    }
    show_launcher(app)
}

fn ensure_launcher_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LAUNCHER_WINDOW_LABEL) {
        return Ok(window);
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == LAUNCHER_WINDOW_LABEL)
        .ok_or_else(|| "missing launcher window config".to_string())?;

    WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

fn position_launcher(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| {
            app.available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
        .ok_or_else(|| "no monitor available".to_string())?;

    let scale = monitor.scale_factor().max(1.0);
    let work_area = monitor.work_area();
    let work_x = f64::from(work_area.position.x) / scale;
    let work_y = f64::from(work_area.position.y) / scale;
    let work_width = f64::from(work_area.size.width) / scale;
    let work_height = f64::from(work_area.size.height) / scale;

    let x = work_x + (work_width - LAUNCHER_WIDTH) / 2.0;
    let y = work_y + (work_height * LAUNCHER_TOP_RATIO).max(12.0);

    window
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())
}

fn ensure_menubar_panel(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PANEL_WINDOW_LABEL) {
        return Ok(window);
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == PANEL_WINDOW_LABEL)
        .ok_or_else(|| "missing menubar panel window config".to_string())?;

    WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

fn position_menubar_panel(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| {
            app.available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
        .ok_or_else(|| "no monitor available".to_string())?;

    let scale = monitor.scale_factor().max(1.0);
    let work_area = monitor.work_area();
    let work_x = f64::from(work_area.position.x) / scale;
    let work_y = f64::from(work_area.position.y) / scale;
    let work_width = f64::from(work_area.size.width) / scale;

    let tray_rect = app
        .try_state::<crate::state::RuntimeHandles>()
        .and_then(|handles| handles.background.tray_rect());

    // Prefer the tray icon's own rect for both axes: it's already below
    // the menubar and horizontally under the icon. Falls back to
    // `work_area` when the tray hasn't reported its position yet.
    let (x, y) = if let Some(rect) = tray_rect {
        let pos = rect.position.to_logical::<f64>(scale);
        let size = rect.size.to_logical::<f64>(scale);
        let min_x = work_x + PANEL_MARGIN_RIGHT;
        let max_x = work_x + work_width - PANEL_WIDTH - PANEL_MARGIN_RIGHT;
        let x = (pos.x - PANEL_EDGE_OFFSET).clamp(min_x, max_x);
        let y = pos.y + size.height + PANEL_MARGIN_TOP;
        (x, y)
    } else {
        (
            work_x + work_width - PANEL_WIDTH - PANEL_MARGIN_RIGHT,
            work_y + PANEL_MARGIN_TOP,
        )
    };

    window
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())
}

fn dispatch_background_action(app: AppHandle, action: &'static str) {
    dispatch_background_action_with_text(app, action, None);
}

pub fn dispatch_background_action_with_text(
    app: AppHandle,
    action: &'static str,
    text: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        let _ = hide_menubar_panel(&app);
        let _ = hide_launcher(&app);

        let created = match show_main_window(&app) {
            Ok(created) => created,
            Err(err) => {
                eprintln!("failed to show main window for background action `{action}`: {err}");
                return;
            }
        };

        if created {
            tokio::time::sleep(Duration::from_millis(300)).await;
        } else {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }

        let payload = BackgroundActionPayload {
            action: action.to_string(),
            text,
        };
        let _ = app.emit(BACKGROUND_ACTION_EVENT, payload);
    });
}

pub fn show_main_window(app: &AppHandle) -> Result<bool, String> {
    let (window, created) = ensure_main_window(app)?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    #[cfg(target_os = "macos")]
    macos::activate_app(app);
    Ok(created)
}

fn ensure_main_window(app: &AppHandle) -> Result<(tauri::WebviewWindow, bool), String> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok((window, false));
    }
    let config = app
        .config()
        .app
        .windows
        .first()
        .ok_or_else(|| "missing main window config".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    Ok((window, true))
}

fn tray_icon_image() -> Result<tauri::image::Image<'static>, String> {
    // macOS renders template tray icons from the alpha channel only — RGB is
    // discarded and the shape is auto-tinted (white on dark menu bars, black
    // on light). The logo's native strokes look spindly at 22pt after the
    // downscale, so we pump the alpha through a layered dilation: a tight
    // solid core adds a few pixels of real weight, then a wider translucent
    // halo adds perceived heft while staying alpha < 255 so it renders as a
    // soft outline. Because template mode maps alpha straight to tint
    // opacity, the halo fades out before it reaches the negative space
    // between strokes — the logo keeps its breathing room.
    let bytes = include_bytes!("../../assets/logo-light.png");
    let decoded = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let rgba = decoded.to_rgba8();
    let processed = thicken_with_halo(&rgba);
    let (width, height) = processed.dimensions();
    Ok(tauri::image::Image::new_owned(
        processed.into_raw(),
        width,
        height,
    ))
}

/// Thicken a logo silhouette without collapsing the gaps between strokes.
/// r=3 solid core = a few pixels of extra stroke weight, still 100% opaque.
/// r=6 outer layer at ~55% alpha = perceived bulk that stays translucent
/// enough for negative space to read as a gap rather than solid fill.
fn thicken_with_halo(src: &image::RgbaImage) -> image::RgbaImage {
    let (w, h) = src.dimensions();
    let core = dilate_alpha(src, 3);
    let halo = dilate_alpha(src, 6);
    let mut out = image::RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let core_a = core.get_pixel(x, y).0[3];
            let halo_a =
                ((halo.get_pixel(x, y).0[3] as u32 * 140) / 255) as u8;
            let new_a = core_a.max(halo_a);
            let [r, g, b, _] = src.get_pixel(x, y).0;
            out.put_pixel(x, y, image::Rgba([r, g, b, new_a]));
        }
    }
    out
}

fn dilate_alpha(src: &image::RgbaImage, radius: u32) -> image::RgbaImage {
    let (w, h) = src.dimensions();
    if radius == 0 {
        return src.clone();
    }

    let mut horizontal = image::RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius).min(w - 1);
            let mut max_a = 0u8;
            for nx in lo..=hi {
                let a = src.get_pixel(nx, y).0[3];
                if a > max_a {
                    max_a = a;
                }
            }
            let [r, g, b, _] = src.get_pixel(x, y).0;
            horizontal.put_pixel(x, y, image::Rgba([r, g, b, max_a]));
        }
    }

    let mut out = image::RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let lo = y.saturating_sub(radius);
            let hi = (y + radius).min(h - 1);
            let mut max_a = 0u8;
            for ny in lo..=hi {
                let a = horizontal.get_pixel(x, ny).0[3];
                if a > max_a {
                    max_a = a;
                }
            }
            let [r, g, b, _] = horizontal.get_pixel(x, y).0;
            out.put_pixel(x, y, image::Rgba([r, g, b, max_a]));
        }
    }

    out
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use tauri::{AppHandle, Manager};

    use super::{
        hide_launcher, show_launcher, LAUNCHER_WINDOW_LABEL, PANEL_WINDOW_LABEL,
        QUICK_LAUNCH_PERMISSION_MESSAGE,
    };

    struct TapState {
        option_is_down: bool,
        used_with_other_input: bool,
        last_tap_at: Option<f64>,
    }

    impl TapState {
        fn new() -> Self {
            Self {
                option_is_down: false,
                used_with_other_input: false,
                last_tap_at: None,
            }
        }
    }

    pub struct OptionDoubleTapMonitor {
        global: MonitorHandle,
        local: Option<LocalMonitorHandle>,
    }

    struct MonitorHandle {
        monitor: Retained<AnyObject>,
        _block: RcBlock<dyn Fn(NonNull<NSEvent>) + 'static>,
    }

    unsafe impl Send for MonitorHandle {}
    unsafe impl Sync for MonitorHandle {}

    struct LocalMonitorHandle {
        monitor: Retained<AnyObject>,
        _block: RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent + 'static>,
    }

    unsafe impl Send for LocalMonitorHandle {}
    unsafe impl Sync for LocalMonitorHandle {}

    fn handle_option_event(
        event: &NSEvent,
        threshold: f64,
        tap_state: &Arc<Mutex<TapState>>,
        app: &AppHandle,
    ) {
        if !should_trigger_launch(event, threshold, tap_state) {
            return;
        }
        let main_focused = app
            .get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        let panel_focused = app
            .get_webview_window(PANEL_WINDOW_LABEL)
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        let launcher_focused = app
            .get_webview_window(LAUNCHER_WINDOW_LABEL)
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        if main_focused || panel_focused || launcher_focused {
            return;
        }
        if let Err(err) = show_launcher(app) {
            eprintln!("failed to show launcher: {err}");
        }
    }

    impl OptionDoubleTapMonitor {
        pub fn start(app: AppHandle) -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::channel();
            let app_for_monitor = app.clone();

            app.run_on_main_thread(move || {
                let tap_state = Arc::new(Mutex::new(TapState::new()));
                let threshold = NSEvent::doubleClickInterval();
                let mask = NSEventMask::from_type(NSEventType::FlagsChanged)
                    | NSEventMask::from_type(NSEventType::KeyDown)
                    | NSEventMask::from_type(NSEventType::KeyUp);

                // Global monitor — fires for events posted to *other* apps.
                // This is the common quick-launch case: user is working in
                // Safari/VS Code/etc. and double-taps Option to summon Agora.
                // A missing handle here means Accessibility permission was
                // denied, which is a hard failure for the feature.
                let state_for_global = Arc::clone(&tap_state);
                let app_for_global = app_for_monitor.clone();
                let global_block = RcBlock::new(move |event_ptr: NonNull<NSEvent>| {
                    let event = unsafe { event_ptr.as_ref() };
                    handle_option_event(event, threshold, &state_for_global, &app_for_global);
                });
                let global = match NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
                    mask,
                    &global_block,
                ) {
                    Some(monitor) => MonitorHandle {
                        monitor,
                        _block: global_block,
                    },
                    None => {
                        let _ = tx.send(Err(QUICK_LAUNCH_PERMISSION_MESSAGE.to_string()));
                        return;
                    }
                };

                // Local monitor — fires for events posted to *this* app.
                // Needed because hiding the main window to tray keeps Agora
                // frontmost, so Option taps are dispatched here and bypass
                // the global monitor entirely. The block must return the
                // event pointer unmodified so normal input still reaches our
                // own windows.
                let state_for_local = Arc::clone(&tap_state);
                let app_for_local = app_for_monitor.clone();
                let local_block =
                    RcBlock::new(move |event_ptr: NonNull<NSEvent>| -> *mut NSEvent {
                        let event = unsafe { event_ptr.as_ref() };
                        handle_option_event(event, threshold, &state_for_local, &app_for_local);
                        event_ptr.as_ptr()
                    });
                // SAFETY: `local_block` returns the input event pointer as-is,
                // satisfying the documented "valid pointer or null" contract
                // and leaving the event free to continue to its target window.
                let local = unsafe {
                    NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local_block)
                }
                .map(|monitor| LocalMonitorHandle {
                    monitor,
                    _block: local_block,
                });
                if local.is_none() {
                    eprintln!(
                        "failed to install local Option-double-tap monitor; \
                         quick-launch will only work while Agora is in the background"
                    );
                }

                let _ = tx.send(Ok(Self { global, local }));
            })
            .map_err(|e| e.to_string())?;

            match rx.recv() {
                Ok(Ok(this)) => Ok(this),
                Ok(Err(msg)) => Err(msg),
                Err(err) => Err(err.to_string()),
            }
        }

        pub fn stop(self, app: &AppHandle) {
            let Self { global, local } = self;
            let _ = app.run_on_main_thread(move || unsafe {
                NSEvent::removeMonitor(&global.monitor);
                if let Some(local) = local.as_ref() {
                    NSEvent::removeMonitor(&local.monitor);
                }
                drop(global);
                drop(local);
            });
        }
    }

    pub struct ClickOutsideMonitor {
        #[allow(dead_code)]
        handle: MonitorHandle,
    }

    impl ClickOutsideMonitor {
        pub fn start(app: AppHandle) -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::channel();
            let app_for_monitor = app.clone();

            app.run_on_main_thread(move || {
                let block = RcBlock::new(move |_event_ptr: NonNull<NSEvent>| {
                    let _ = hide_launcher(&app_for_monitor);
                    if let Some(panel) =
                        app_for_monitor.get_webview_window(PANEL_WINDOW_LABEL)
                    {
                        if panel.is_visible().unwrap_or(false) {
                            let _ = panel.hide();
                        }
                    }
                });

                let mask = NSEventMask::from_type(NSEventType::LeftMouseDown)
                    | NSEventMask::from_type(NSEventType::RightMouseDown)
                    | NSEventMask::from_type(NSEventType::OtherMouseDown);
                let handle = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &block)
                    .map(|monitor| MonitorHandle {
                        monitor,
                        _block: block,
                    });
                let _ = tx.send(handle);
            })
            .map_err(|e| e.to_string())?;

            match rx.recv() {
                Ok(Some(handle)) => Ok(Self { handle }),
                Ok(None) => Err("could not install click-outside monitor".to_string()),
                Err(err) => Err(err.to_string()),
            }
        }
    }

    pub fn activate_app(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| unsafe {
            let mtm = MainThreadMarker::new_unchecked();
            let application = NSApplication::sharedApplication(mtm);
            application.activate();
        });
    }

    fn should_trigger_launch(
        event: &NSEvent,
        threshold: f64,
        tap_state: &Arc<Mutex<TapState>>,
    ) -> bool {
        let mut state = tap_state.lock().expect("option tap state poisoned");
        match event.r#type() {
            ty if ty == NSEventType::KeyDown || ty == NSEventType::KeyUp => {
                if state.option_is_down {
                    state.used_with_other_input = true;
                }
                false
            }
            ty if ty == NSEventType::FlagsChanged => {
                let flags =
                    event.modifierFlags() & NSEventModifierFlags::DeviceIndependentFlagsMask;
                let option_now = flags.contains(NSEventModifierFlags::Option);
                let other_modifiers = flags.intersects(
                    NSEventModifierFlags::Shift
                        | NSEventModifierFlags::Control
                        | NSEventModifierFlags::Command
                        | NSEventModifierFlags::CapsLock
                        | NSEventModifierFlags::Function,
                );

                if option_now && !state.option_is_down {
                    state.option_is_down = true;
                    state.used_with_other_input = other_modifiers;
                    return false;
                }

                if option_now && state.option_is_down {
                    if other_modifiers {
                        state.used_with_other_input = true;
                    }
                    return false;
                }

                if !option_now && state.option_is_down {
                    let eligible_tap = !state.used_with_other_input;
                    state.option_is_down = false;
                    state.used_with_other_input = false;
                    if !eligible_tap {
                        return false;
                    }

                    let timestamp = event.timestamp();
                    if let Some(previous) = state.last_tap_at {
                        if timestamp - previous <= threshold {
                            state.last_tap_at = None;
                            return true;
                        }
                    }
                    state.last_tap_at = Some(timestamp);
                }

                false
            }
            _ => false,
        }
    }
}
