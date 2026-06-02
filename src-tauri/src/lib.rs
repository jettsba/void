// Точка входа Tauri-приложения.
//
// Окно создаётся ПРОГРАММНО (не через windows[] в tauri.conf.json), чтобы
// compile-time переключать URL: dev → localhost, release → продакшн-домен.
//
// Фаза 2:
//   2A — tray + close-to-hide-tray.
//   2B — state-aware tray (idle vs in_room) с tooltip "void :: #CODE".
//   2C — auto-launch через native-плагин. Тоггл в UI «настройки приложения».
//   2D — toast-уведомление при первом hide-to-tray (per session).
//   2E — global hotkeys (toggleMic / toggleSound / toggleWindow / leaveRoom).
//        Push-to-talk вынесен в конец roadmap как optional (см. desktop-plan.md).
//
// Веб ↔ Rust:
//   listen  void:set-tray-state       { state, roomCode }
//   listen  void:set-close-behavior   { behavior }
//   listen  void:set-autostart        { enabled }
//   listen  void:register-hotkeys     { bindings: {action: accelerator, ...} }
//   emit    void:autostart-state      { enabled }   на startup
//   emit    void:hotkey-pressed       { action }     при срабатывании хоткея

#[cfg(windows)]
mod audio_session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{ManagerExt as _, MacosLauncher};
use tauri_plugin_global_shortcut::{
    Builder as GlobalShortcutBuilder, GlobalShortcutExt, Shortcut, ShortcutState,
};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "main";
const ICON_IDLE_PNG: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_IN_ROOM_PNG: &[u8] = include_bytes!("../icons/tray/in_room.png");

static SHOWN_HIDE_TOAST: AtomicBool = AtomicBool::new(false);
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Mapping Shortcut → action_name (toggleMic / toggleSound / toggleWindow / leaveRoom).
/// Хранится в App state, обновляется при void:register-hotkeys.
#[derive(Default)]
struct HotkeyMap(Mutex<HashMap<Shortcut, String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            GlobalShortcutBuilder::new()
                .with_handler(on_global_shortcut)
                .build(),
        )
        .manage(HotkeyMap::default())
        .setup(|app| {
            let url = if cfg!(debug_assertions) {
                "http://localhost:3000"
            } else {
                "https://app.void-room.space"
            };

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("invalid app URL")),
            )
            .title("Void")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .resizable(true)
            .decorations(false)
            .visible(true)
            .focused(true)
            .build()?;

            let window_for_close = window.clone();
            let app_for_close = app.handle().clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if CLOSE_TO_TRAY.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                        if !SHOWN_HIDE_TOAST.swap(true, Ordering::SeqCst) {
                            let _ = app_for_close
                                .notification()
                                .builder()
                                .title("Void свернулся в трей")
                                .body(
                                    "Кликните по значку в системном лотке, чтобы вернуться",
                                )
                                .show();
                        }
                    }
                }
            });

            let show_item = MenuItem::with_id(app, "show", "Открыть Void", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(decode_png_to_image(ICON_IDLE_PNG))
                .tooltip("void")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            let initial_autostart = app.autolaunch().is_enabled().unwrap_or(false);
            let _ = app.emit("void:autostart-state", initial_autostart);

            // Фоновый thread: периодически опт-аут наших audio-сессий из
            // communications-ducking. Первая попытка через 3с — даём WebView2
            // успеть spawn'нуть audio service child process. Дальше rescan
            // каждые 30с — для случаев когда сессия пересоздаётся (смена mic,
            // reconnect, восстановление после suspend). См. audio_session.rs
            // и его doc-комментарий для полного описания проблемы.
            #[cfg(windows)]
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(3));
                loop {
                    if let Err(e) =
                        audio_session::disable_communications_ducking_for_our_tree()
                    {
                        eprintln!("[audio] ducking opt-out failed: {:?}", e);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(30));
                }
            });

            // ============ Event listeners ============

            let app_handle = app.handle().clone();
            app.listen("void:set-tray-state", move |event| {
                let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                let state = parsed
                    .get("state")
                    .and_then(|s| s.as_str())
                    .unwrap_or("idle")
                    .to_string();
                let room_code = parsed
                    .get("roomCode")
                    .and_then(|s| s.as_str())
                    .map(String::from);
                let app_clone = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    update_tray_state(&app_clone, &state, room_code.as_deref());
                });
            });

            app.listen("void:set-close-behavior", move |event| {
                let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                let behavior = parsed
                    .get("behavior")
                    .and_then(|s| s.as_str())
                    .unwrap_or("minimize");
                CLOSE_TO_TRAY.store(behavior == "minimize", Ordering::SeqCst);
            });

            let app_handle_as = app.handle().clone();
            app.listen("void:set-autostart", move |event| {
                let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                let enabled = parsed
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let app_clone = app_handle_as.clone();
                let _ = app_handle_as.run_on_main_thread(move || {
                    let mgr = app_clone.autolaunch();
                    let _ = if enabled { mgr.enable() } else { mgr.disable() };
                });
            });

            let app_handle_hk = app.handle().clone();
            app.listen("void:register-hotkeys", move |event| {
                let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                let Some(obj) = parsed.get("bindings").and_then(|v| v.as_object()) else {
                    return;
                };
                let bindings: HashMap<String, String> = obj
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect();
                let app_clone = app_handle_hk.clone();
                let _ = app_handle_hk.run_on_main_thread(move || {
                    register_hotkeys(&app_clone, &bindings);
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Void desktop");
}

// ============ Helpers ============

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        if visible {
            let _ = w.hide();
        } else {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn update_tray_state(app: &AppHandle, state: &str, room_code: Option<&str>) {
    let (png, tooltip): (&[u8], String) = match state {
        "idle" => (ICON_IDLE_PNG, "void".to_string()),
        _ => {
            let tip = match room_code {
                Some(c) if !c.is_empty() => format!("void :: #{}", c),
                _ => "void".to_string(),
            };
            (ICON_IN_ROOM_PNG, tip)
        }
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(decode_png_to_image(png)));
        let _ = tray.set_tooltip(Some(tooltip.as_str()));
    }
}

fn decode_png_to_image(bytes: &[u8]) -> Image<'static> {
    let img = image::load_from_memory(bytes).expect("invalid tray PNG");
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Image::new_owned(rgba.into_raw(), w, h)
}

// ============ Global hotkeys ============

/// Сначала unregister всех ранее зарегистрированных, потом register по списку.
/// Невалидные/занятые комбинации тихо пропускаем (UI покажет «—» если хоткей не сохранился).
fn register_hotkeys(app: &AppHandle, bindings: &HashMap<String, String>) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let mut map: HashMap<Shortcut, String> = HashMap::new();
    for (action, accel) in bindings {
        if accel.is_empty() {
            continue;
        }
        let Ok(shortcut) = accel.parse::<Shortcut>() else {
            continue;
        };
        if gs.register(shortcut).is_ok() {
            map.insert(shortcut, action.clone());
        }
    }
    if let Some(state) = app.try_state::<HotkeyMap>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = map;
        }
    }
}

/// Срабатывает при нажатии любого зарегистрированного хоткея.
/// Look up action by shortcut, маршрутизация:
///   - toggleWindow → обрабатываем здесь же (Rust), без round-trip в JS;
///   - остальные → emit "void:hotkey-pressed" → JS вызовет нужную функцию.
fn on_global_shortcut(app: &AppHandle, shortcut: &Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let action = match app.try_state::<HotkeyMap>() {
        Some(state) => state.0.lock().ok().and_then(|m| m.get(shortcut).cloned()),
        None => None,
    };
    let Some(action) = action else {
        return;
    };

    if action == "toggleWindow" {
        let app_clone = app.clone();
        let _ = app.run_on_main_thread(move || {
            toggle_main_window(&app_clone);
        });
    } else {
        let _ = app.emit("void:hotkey-pressed", serde_json::json!({ "action": action }));
    }
}
