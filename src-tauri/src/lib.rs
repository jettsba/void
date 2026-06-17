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
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{
    Builder as GlobalShortcutBuilder, GlobalShortcutExt, Shortcut, ShortcutState,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const TRAY_ID: &str = "main";
const ICON_IDLE_PNG: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_IN_ROOM_PNG: &[u8] = include_bytes!("../icons/tray/in_room.png");

static SHOWN_HIDE_TOAST: AtomicBool = AtomicBool::new(false);
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Текущие код комнаты и share-ссылка (приходят из JS через void:set-tray-state).
/// `None` когда не в комнате — тогда пункты «Скопировать …» в трее задизейблены.
/// (code, link). Ссылку строит JS на каноничном домене (в desktop origin =
/// tauri://localhost, поэтому строить её в Rust нельзя).
static ROOM_SHARE: Mutex<Option<(String, String)>> = Mutex::new(None);

/// Код комнаты из deep-link (`void://room/КОД`), пойманный ДО готовности
/// главного окна (cold start). JS на init забирает его через
/// take_pending_deep_link и входит. Warm-случай идёт через live-emit.
static PENDING_ROOM: Mutex<Option<String>> = Mutex::new(None);

/// Handles пунктов меню «Скопировать код / ссылку» — чтобы дёргать set_enabled
/// при смене состояния комнаты. Кладём в managed state.
struct TrayMenuItems {
    copy_code: MenuItem<tauri::Wry>,
    copy_link: MenuItem<tauri::Wry>,
}

/// Mapping Shortcut → action_name (toggleMic / toggleSound / toggleWindow / leaveRoom).
/// Хранится в App state, обновляется при void:register-hotkeys.
#[derive(Default)]
struct HotkeyMap(Mutex<HashMap<Shortcut, String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance ДОЛЖЕН идти первым плагином (требование плагина).
        // Если app уже запущен и прилетел новый запуск (вкл. void:// deep-link) —
        // не плодим 2-й процесс, а передаём ссылку текущему и фокусим окно.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in &argv {
                if arg.starts_with("void://") {
                    route_deep_link(app, arg);
                }
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .invoke_handler(tauri::generate_handler![take_pending_deep_link])
        .setup(|app| {
            // Bundled-web архитектура (Phase 6 фикс, v0.10.48):
            //   dev:     WebviewUrl::External("http://localhost:3000") — node-сервер
            //            с hot-reload, как раньше.
            //   release: WebviewUrl::App("index.html") — окно грузит bundled
            //            public/ snapshot ВНУТРИ exe через tauri:// protocol.
            //            Это нужно потому что withGlobalTauri inline-script
            //            блокируется CSP внешнего origin'а (app.void-room.space).
            //            При bundled-loading CSP под контролем Tauri, drag-region
            //            и весь Tauri API работают. Web в браузере на сайте
            //            продолжает обновляться независимо при деплое.
            //            Desktop-обновления — через Updater (Фаза 10).
            // Главное окно создаётся ОТЛОЖЕННО (updater v2, режим A) — не здесь,
            // а из launch_main_window() после проверки апдейтов. На старте окна
            // может не быть пару секунд (чек) либо вместо него поднимется окно
            // обновления. Логика URL (dev localhost / release bundled App) и
            // close-to-tray переехали в launch_main_window() ниже.

            // Веха B: вернуть указатель «Удалить» на наш деинсталлятор, если NSIS-
            // апдейт его сбил. No-op если кастомного деинсталлятора рядом нет.
            #[cfg(windows)]
            reassert_custom_uninstaller();

            // ============ Deep links (void://room/КОД) ============
            // on_open_url ловит cold-start (Windows читает launch-argv) + macOS.
            // Warm-случай (app уже открыт) обрабатывает single-instance callback.
            let dl_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    route_deep_link(&dl_handle, url.as_str());
                }
            });
            // В dev схема не прописана инсталлятором — регистрируем на dev-exe,
            // чтобы можно было гонять handoff локально. В release регистрирует NSIS.
            #[cfg(debug_assertions)]
            {
                let _ = app.deep_link().register("void");
            }

            // Cold-start: приложение не было запущено и ссылка пришла в launch-argv
            // ПЕРВОГО процесса. on_open_url на Windows для первого запуска
            // срабатывает не всегда → читаем argv явно и маршрутизируем
            // (route_deep_link кладёт код в PENDING_ROOM; JS заберёт его через
            // take_pending_deep_link на init и войдёт в комнату). Warm-случай
            // (app уже открыт) по-прежнему идёт через single-instance callback.
            {
                let h = app.handle().clone();
                for arg in std::env::args().skip(1) {
                    if arg.starts_with("void://") {
                        route_deep_link(&h, &arg);
                        break;
                    }
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Открыть Void", true, None::<&str>)?;
            // Стартуют задизейбленными (idle) — включаются в update_tray_state при входе в комнату.
            let copy_code_item =
                MenuItem::with_id(app, "copy-code", "Скопировать код", false, None::<&str>)?;
            let copy_link_item =
                MenuItem::with_id(app, "copy-link", "Скопировать ссылку", false, None::<&str>)?;
            let sep_top = PredefinedMenuItem::separator(app)?;
            let sep_bottom = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &sep_top,
                    &copy_code_item,
                    &copy_link_item,
                    &sep_bottom,
                    &quit_item,
                ],
            )?;
            app.manage(TrayMenuItems {
                copy_code: copy_code_item,
                copy_link: copy_link_item,
            });

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(decode_png_to_image(ICON_IDLE_PNG))
                .tooltip("void")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "copy-code" => copy_room_share(app, true),
                    "copy-link" => copy_room_share(app, false),
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

            // ============ Updater v2 — см. tasks/updater-v2-plan.md ============
            // Режим A (release): главное окно НЕ создаётся сразу. Сначала чек —
            //   есть апдейт (до таймаута 2.5с) → окно обновления + тихая установка
            //   + relaunch; нет/ошибка/таймаут → создаём главное окно и запускаем
            //   периодический чек (режим B, баннер раз в 15 мин).
            // Dev: silent выключен (грузим localhost), сразу главное окно.
            if cfg!(debug_assertions) {
                launch_main_window(app.handle());
            } else {
                tauri::async_runtime::spawn(startup_update_flow(app.handle().clone()));
            }

            // Install trigger из UI — повторно делаем check, потом
            // download_and_install (плагин сам перезапустит app после).
            let app_for_install = app.handle().clone();
            app.listen("void:updater-install", move |_event| {
                let h = app_for_install.clone();
                tauri::async_runtime::spawn(async move {
                    let updater = match h.updater() {
                        Ok(u) => u,
                        Err(e) => {
                            let _ = h.emit(
                                "void:updater-error",
                                serde_json::json!({ "message": format!("{:?}", e) }),
                            );
                            return;
                        }
                    };
                    let update = match updater.check().await {
                        Ok(Some(u)) => u,
                        Ok(None) => return,
                        Err(e) => {
                            let _ = h.emit(
                                "void:updater-error",
                                serde_json::json!({ "message": format!("{:?}", e) }),
                            );
                            return;
                        }
                    };
                    let h_progress = h.clone();
                    let mut downloaded: u64 = 0;
                    let result = update
                        .download_and_install(
                            move |chunk_length, content_length| {
                                downloaded += chunk_length as u64;
                                let _ = h_progress.emit(
                                    "void:updater-progress",
                                    serde_json::json!({
                                        "downloaded": downloaded,
                                        "total": content_length,
                                    }),
                                );
                            },
                            || {},
                        )
                        .await;
                    match result {
                        // Установка прошла — перезапускаемся в новую версию.
                        Ok(_) => h.restart(),
                        Err(e) => {
                            let _ = h.emit(
                                "void:updater-error",
                                serde_json::json!({ "message": format!("{:?}", e) }),
                            );
                        }
                    }
                });
            });

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
                let room_link = parsed
                    .get("roomLink")
                    .and_then(|s| s.as_str())
                    .map(String::from);
                let app_clone = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    update_tray_state(
                        &app_clone,
                        &state,
                        room_code.as_deref(),
                        room_link.as_deref(),
                    );
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

// ---- Updater v2 (режимы A/B) — см. tasks/updater-v2-plan.md ----

/// Создаёт (или показывает, если уже есть) главное окно. Вынесено из setup,
/// чтобы создавать его ОТЛОЖЕННО — после проверки апдейтов (режим A).
fn launch_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let webview_url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://localhost:3000".parse().expect("invalid dev URL"))
    } else {
        WebviewUrl::App("index.html".into())
    };

    let mut builder = WebviewWindowBuilder::new(app, "main", webview_url)
        .title("Void")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .resizable(true)
        .decorations(false)
        .visible(true)
        .focused(true);

    // Язык, выбранный в кастомном установщике, приходит один раз через файл-маркер
    // installer-lang рядом с exe. Инжектим в окно ДО загрузки страницы — settings.js
    // подхватит window.__VOID_INSTALLER_LANG__ в init(). Маркер удаляется при чтении.
    if let Some(lang) = take_installer_lang() {
        builder = builder
            .initialization_script(&format!("window.__VOID_INSTALLER_LANG__={lang:?};"));
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[main-window] build failed: {:?}", e);
            return;
        }
    };

    let window_for_close = window.clone();
    let app_for_close = app.clone();
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
                        .body("Кликните по значку в системном лотке, чтобы вернуться")
                        .show();
                }
            }
        }
    });
}

/// Читает one-shot маркер языка, оставленный кастомным установщиком в папке
/// установки (рядом с exe). Возвращает "ru"/"en" и УДАЛЯЕТ файл, чтобы язык
/// применился только на первом запуске после установки. В dev (exe в target/)
/// маркера нет → None.
fn take_installer_lang() -> Option<String> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let marker = dir.join("installer-lang");
    let raw = std::fs::read_to_string(&marker).ok()?;
    let _ = std::fs::remove_file(&marker);
    let lang = raw.trim();
    if lang == "ru" || lang == "en" {
        Some(lang.to_string())
    } else {
        None
    }
}

/// Веха B: возвращает в реестре указатель «Удалить» на наш кастомный
/// деинсталлятор, если он установлен рядом (NSIS-апдейт сбивает UninstallString
/// обратно на свой uninstall.exe). No-op в dev (exe в target/, деинсталлятора нет).
#[cfg(windows)]
fn reassert_custom_uninstaller() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;

    // Из dev-сборки реестр НЕ трогаем: dev-exe живёт в target/debug, и reassert
    // переписал бы UninstallString установленного приложения на dev-путь
    // (баг «uninstall.exe не найден» при удалении). Только установленный release.
    if cfg!(debug_assertions) {
        return;
    }

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    let custom = [
        dir.join("void-uninstaller.exe"),
        dir.join("resources").join("void-uninstaller.exe"),
    ]
    .into_iter()
    .find(|p| p.exists());
    let Some(custom) = custom else {
        return;
    };
    let unins = dir.join("uninstall.exe");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Void",
        KEY_QUERY_VALUE | KEY_SET_VALUE,
    ) else {
        return;
    };

    // Трогаем реестр только если запущены ИЗ папки установки (current_exe рядом
    // с InstallLocation). Защита от перезаписи указателя «Удалить» чужим или
    // перемещённым exe (тот же класс бага, что dev-запуск выше).
    if let Ok(loc) = key.get_value::<String, _>("InstallLocation") {
        if !dir
            .to_string_lossy()
            .eq_ignore_ascii_case(loc.trim_matches('"'))
        {
            return;
        }
    }

    let want = format!("\"{}\"", custom.display());
    let cur: Result<String, _> = key.get_value("UninstallString");
    if cur.map(|c| c != want).unwrap_or(true) {
        let _ = key.set_value("UninstallString", &want);
        let _ = key.set_value(
            "QuietUninstallString",
            &format!("\"{}\" /S", unins.display()),
        );
    }
}

/// Окно обновления (режим A) — frameless 640×468 в стиле инсталлера.
/// Закрытие (✕) = выход из приложения (отмена; relaunch повторит чек).
fn launch_updater_window(app: &AppHandle) {
    if app.get_webview_window("updater").is_some() {
        return;
    }

    let url = if cfg!(debug_assertions) {
        WebviewUrl::External(
            "http://localhost:3000/updater.html"
                .parse()
                .expect("invalid dev URL"),
        )
    } else {
        WebviewUrl::App("updater.html".into())
    };

    let win = match WebviewWindowBuilder::new(app, "updater", url)
        .title("void")
        .inner_size(640.0, 468.0)
        .resizable(false)
        .decorations(false)
        .center()
        .visible(true)
        .focused(true)
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[updater-window] build failed: {:?}", e);
            return;
        }
    };

    let app_for_close = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            app_for_close.exit(0);
        }
    });
}

/// Режим A: на старте чек с таймаутом-страховкой. Есть апдейт → окно обновления
/// + тихая установка + relaunch. Нет/ошибка/таймаут → главное окно + режим B.
async fn startup_update_flow(app: AppHandle) {
    use std::time::Duration;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] init failed: {:?}", e);
            launch_main_window(&app);
            start_periodic_check(app);
            return;
        }
    };

    // Главное окно ОБЯЗАНО появиться даже если сеть висит → timeout 2.5с.
    // timeout роняет in-flight чек — ок, режим B перепроверит через 15 мин.
    let checked = tokio::time::timeout(Duration::from_millis(2500), updater.check()).await;

    match checked {
        Ok(Ok(Some(update))) => {
            // Апдейт есть, юзер ещё не в приложении (окна нет) → тихий режим A.
            launch_updater_window(&app);
            // Даём странице окна обновления подняться и навесить листенеры.
            tokio::time::sleep(Duration::from_millis(450)).await;
            let _ = app.emit(
                "void:upd-begin",
                serde_json::json!({ "version": update.version }),
            );

            let app_progress = app.clone();
            let app_phase = app.clone();
            let mut downloaded: u64 = 0;
            let result = update
                .download_and_install(
                    move |chunk, total| {
                        downloaded += chunk as u64;
                        let _ = app_progress.emit(
                            "void:upd-progress",
                            serde_json::json!({ "downloaded": downloaded, "total": total }),
                        );
                    },
                    move || {
                        let _ = app_phase
                            .emit("void:upd-phase", serde_json::json!({ "phase": "install" }));
                    },
                )
                .await;

            match result {
                Ok(_) => {
                    let _ = app.emit("void:upd-phase", serde_json::json!({ "phase": "done" }));
                    // NSIS поставлен — перезапускаемся в новую версию.
                    app.restart();
                }
                Err(e) => {
                    eprintln!("[updater] silent install failed: {:?}", e);
                    if let Some(w) = app.get_webview_window("updater") {
                        let _ = w.close();
                    }
                    launch_main_window(&app);
                    start_periodic_check(app);
                }
            }
        }
        Ok(Ok(None)) => {
            launch_main_window(&app);
            start_periodic_check(app);
        }
        Ok(Err(e)) => {
            eprintln!("[updater] startup check failed: {:?}", e);
            launch_main_window(&app);
            start_periodic_check(app);
        }
        Err(_) => {
            // таймаут — не вешаем запуск, апдейт подхватит режим B
            launch_main_window(&app);
            start_periodic_check(app);
        }
    }
}

/// Режим B: после показа главного окна — фоновая перепроверка раз в 15 мин.
/// Новая версия → "void:updater-available" (баннер). Принудительного рестарта нет.
fn start_periodic_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_notified: Option<String> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15 * 60)).await;
            let Ok(updater) = app.updater() else { continue };
            if let Ok(Some(update)) = updater.check().await {
                if last_notified.as_deref() != Some(update.version.as_str()) {
                    last_notified = Some(update.version.clone());
                    let _ = app.emit(
                        "void:updater-available",
                        serde_json::json!({
                            "version": update.version,
                            "body": update.body.clone().unwrap_or_default(),
                        }),
                    );
                }
            }
        }
    });
}

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

fn update_tray_state(
    app: &AppHandle,
    state: &str,
    room_code: Option<&str>,
    room_link: Option<&str>,
) {
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

    // Share-данные для пунктов «Скопировать …»: валидны только когда есть и код,
    // и ссылка. Иначе пункты гасим (нечего копировать вне комнаты).
    let share = match (room_code, room_link) {
        (Some(c), Some(l)) if !c.is_empty() && !l.is_empty() => {
            Some((c.to_string(), l.to_string()))
        }
        _ => None,
    };
    let enabled = share.is_some();
    if let Ok(mut guard) = ROOM_SHARE.lock() {
        *guard = share;
    }
    if let Some(items) = app.try_state::<TrayMenuItems>() {
        let _ = items.copy_code.set_enabled(enabled);
        let _ = items.copy_link.set_enabled(enabled);
    }
}

// ============ Deep links ============

/// Парсит код комнаты из `void://room/КОД` (терпит и `void://КОД`).
/// Берёт ведущие alphanumeric-символы, в верхний регистр. JS валидирует ещё раз.
fn parse_room_code(url: &str) -> Option<String> {
    let rest = url.strip_prefix("void://")?;
    let rest = rest.trim_start_matches('/');
    let after = rest.strip_prefix("room/").unwrap_or(rest);
    let code: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    if code.is_empty() {
        None
    } else {
        Some(code.to_uppercase())
    }
}

/// Маршрутизация пойманного deep-link'а: сохранить код (cold-start pull),
/// показать/сфокусировать окно и live-эмитнуть в webview (warm-случай).
fn route_deep_link(app: &AppHandle, url: &str) {
    let Some(code) = parse_room_code(url) else {
        return;
    };
    if let Ok(mut guard) = PENDING_ROOM.lock() {
        *guard = Some(code.clone());
    }
    show_main_window(app);
    let _ = app.emit("void:deep-link-room", serde_json::json!({ "code": code }));
}

/// Забирает (и очищает) код из deep-link, пойманного до готовности окна.
/// JS дёргает на init — для cold-start входа в комнату по ссылке.
#[tauri::command]
fn take_pending_deep_link() -> Option<String> {
    PENDING_ROOM.lock().ok().and_then(|mut g| g.take())
}

/// Копирует в буфер код комнаты (`code=true`) или share-ссылку (`code=false`).
/// No-op если не в комнате (пункты в этом случае и так задизейблены).
fn copy_room_share(app: &AppHandle, code: bool) {
    let value = ROOM_SHARE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(c, l)| if code { c.clone() } else { l.clone() }));
    if let Some(v) = value {
        if let Err(e) = app.clipboard().write_text(v) {
            eprintln!("[tray] clipboard write failed: {:?}", e);
        }
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
