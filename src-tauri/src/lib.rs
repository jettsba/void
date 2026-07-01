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
#[cfg(windows)]
mod proc_tree;
#[cfg(windows)]
mod screen_audio;
#[cfg(windows)]
mod screen_indicator;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, Listener, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// Базовый фон приложения (--bg-0 = #0a0a0b из public/css/base.css). Красим им
/// окно и слой WebView2 ДО загрузки страницы, иначе на cold-start мелькает
/// дефолтный белый фон вебвью размером с окно.
const APP_BG: Color = Color(0x0a, 0x0a, 0x0b, 0xff);
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

/// HWND главного окна (как isize). Нужен screen_indicator'у, чтобы исключить
/// главное окно при скрытии индикатора захвата из таскбара. 0 = окна ещё нет.
#[cfg(windows)]
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

/// Текущие код комнаты и share-ссылка (приходят из JS через void:set-tray-state).
/// `None` когда не в комнате — тогда пункты «Скопировать …» в трее задизейблены.
/// (code, link). Ссылку строит JS на каноничном домене (в desktop origin =
/// tauri://localhost, поэтому строить её в Rust нельзя).
static ROOM_SHARE: Mutex<Option<(String, String)>> = Mutex::new(None);

/// Код комнаты из deep-link (`void://room/КОД`), пойманный ДО готовности
/// главного окна (cold start). JS на init забирает его через
/// take_pending_deep_link и входит. Warm-случай идёт через live-emit.
static PENDING_ROOM: Mutex<Option<String>> = Mutex::new(None);

/// Label кастомного окна-меню трея (см. tray-menu.html / open_tray_menu).
const TRAY_MENU_LABEL: &str = "tray-menu";
/// Ширина окна-меню в логических px. Высота считается tray_menu_height().
const TRAY_MENU_W: f64 = 210.0;

/// Высота окна-меню (логические px). Считается под фиксированные размеры из
/// css/tray-menu.css: border 1px×2, padding 6px×2, item 32px, sep 9px.
/// В комнате видны 2 копи-пункта + лишний разделитель → меню выше.
fn tray_menu_height(in_room: bool) -> f64 {
    const BORDER: f64 = 1.0; // ×2 (верх/низ)
    const PAD: f64 = 6.0; // ×2
    const ITEM: f64 = 32.0;
    const SEP: f64 = 9.0; // 1px линия + 4px margin сверху/снизу
    let (items, seps) = if in_room { (4.0, 2.0) } else { (2.0, 1.0) };
    BORDER * 2.0 + PAD * 2.0 + ITEM * items + SEP * seps
}

/// Mapping Shortcut → action_name (toggleMic / toggleSound / toggleWindow / leaveRoom).
/// Хранится в App state, обновляется при void:register-hotkeys.
#[derive(Default)]
struct HotkeyMap(Mutex<HashMap<Shortcut, String>>);

/// Старт нативного loopback-захвата звука демонстрации (см. screen_audio.rs).
/// JS передаёт Channel — Rust стримит в него PCM-кадры (16-bit/48k/stereo, Raw).
/// Err → JS делает fallback на getDisplayMedia system audio.
#[tauri::command]
fn start_screen_audio(
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> std::result::Result<(), String> {
    #[cfg(windows)]
    {
        screen_audio::start(channel)
    }
    #[cfg(not(windows))]
    {
        let _ = channel;
        Err("screen audio loopback is windows-only".into())
    }
}

/// Останавливает нативный loopback-захват (идемпотентно).
#[tauri::command]
fn stop_screen_audio() {
    #[cfg(windows)]
    {
        screen_audio::stop();
    }
}


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
            // Тёплый перезапуск: приложение уже работало (трей/автозапуск),
            // возможно со старой версией (стартовый silent-чек был давно/пропущен).
            // Перепроверяем апдейт → баннер (режим B). Только release.
            if !cfg!(debug_assertions) {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_update_banner(&h).await;
                });
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        .invoke_handler(tauri::generate_handler![
            take_pending_deep_link,
            tray_menu_action,
            start_screen_audio,
            stop_screen_audio
        ])
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

            // Прячем скрытое IPC-окно single-instance, иначе оно всплывает
            // пунктом «…-siw» в нативном пикере демонстрации экрана.
            #[cfg(windows)]
            screen_indicator::hide_single_instance_window(&app.config().identifier);

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

            // Кастомное окно-меню (вместо нативного Windows-меню) поднимаем
            // скрытым заранее — чтобы по правому клику открывалось мгновенно.
            create_tray_menu_window(app.handle());

            // Без .menu(...) — нативное меню не всплывает. Левый клик → toggle
            // окна; правый клик → наше кастомное меню (open_tray_menu).
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(decode_png_to_image(ICON_IDLE_PNG))
                .tooltip("void")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => toggle_main_window(tray.app_handle()),
                    TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } => open_tray_menu(tray.app_handle(), position),
                    _ => {}
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

            // Инициирующая само-проверка updater.js на старте → обычный
            // check_update_banner (БАННЕР при наличии).
            let app_for_check = app.handle().clone();
            app.listen("void:updater-check", move |_event| {
                let h = app_for_check.clone();
                tauri::async_runtime::spawn(async move {
                    check_update_banner(&h).await;
                });
            });

            // Проверка для КНОПКИ в настройках — отдельный канал
            // void:updater-probe → void:updater-probe-result, БЕЗ баннера (кнопка
            // самодостаточна: инлайн-фидбэк + инлайн-обновление). {status:
            // available|uptodate|error, version?, body?, message?}.
            let app_for_probe = app.handle().clone();
            app.listen("void:updater-probe", move |_event| {
                let h = app_for_probe.clone();
                tauri::async_runtime::spawn(async move {
                    let result = match h.updater() {
                        Err(e) => {
                            serde_json::json!({ "status": "error", "message": format!("{e:?}") })
                        }
                        Ok(updater) => match tokio::time::timeout(
                            std::time::Duration::from_secs(15),
                            updater.check(),
                        )
                        .await
                        {
                            Err(_) => {
                                serde_json::json!({ "status": "error", "message": "timeout" })
                            }
                            Ok(Ok(Some(u))) => serde_json::json!({
                                "status": "available",
                                "version": u.version,
                                "body": u.body.clone().unwrap_or_default(),
                            }),
                            Ok(Ok(None)) => serde_json::json!({ "status": "uptodate" }),
                            Ok(Err(e)) => {
                                serde_json::json!({ "status": "error", "message": format!("{e:?}") })
                            }
                        },
                    };
                    let _ = h.emit("void:updater-probe-result", result);
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

            // Скрытие окна-индикатора захвата экрана (см. screen_indicator.rs).
            // JS шлёт active:true при старте демки, active:false при остановке.
            // На active: ставим WinEvent-хук (мгновенное скрытие при появлении,
            // без мелькания) + разовый проход (вдруг окно уже есть) + короткий
            // поллинг-бэкстоп. На !active: снимаем хук.
            // Скрытие окна-индикатора захвата экрана (см. screen_indicator.rs).
            // JS шлёт: arming (до getDisplayMedia), active:true (старт захвата),
            // active:false (стоп). Хук ставим ЗАРАНЕЕ на arming — чтобы поймать
            // индикатор в момент создания, без мелькания (окно пикера под наш
            // критерий не подходит → держать хук во время пикера безопасно).
            #[cfg(windows)]
            {
                let app_arm = app.handle().clone();
                app.listen("void:screencast-arming", move |_event| {
                    let main_hwnd = MAIN_HWND.load(Ordering::SeqCst);
                    let _ = app_arm.run_on_main_thread(move || {
                        screen_indicator::install_indicator_hook(main_hwnd);
                    });
                });

                let app_sc = app.handle().clone();
                app.listen("void:screencast-active", move |event| {
                    let active = serde_json::from_str::<serde_json::Value>(event.payload())
                        .ok()
                        .and_then(|v| v.get("active").and_then(|b| b.as_bool()))
                        .unwrap_or(false);
                    let main_hwnd = MAIN_HWND.load(Ordering::SeqCst);
                    if active {
                        // Хук уже стоит с arming (ловит индикатор на CREATE, до
                        // отрисовки → без мелькания); переустановим идемпотентно
                        // (страховка, если arming не дошёл) и запустим поллинг-
                        // бэкстоп от старта захвата (40мс×60 ≈ 2.4с).
                        let _ = app_sc.run_on_main_thread(move || {
                            screen_indicator::install_indicator_hook(main_hwnd);
                        });
                        std::thread::spawn(move || {
                            // Первый скан СРАЗУ (без сна), затем плотно 8мс×~120
                            // (≈1с) — чтобы поймать индикатор в момент появления,
                            // даже если хук пропустил CREATE. Снимок дерева <1мс.
                            for _ in 0..120 {
                                if let Ok(true) =
                                    screen_indicator::hide_capture_indicator_for_our_tree(main_hwnd)
                                {
                                    break;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(8));
                            }
                        });
                    } else {
                        // Бэкстоп нативного loopback-захвата звука демки —
                        // на случай, если JS не дёрнул stop_screen_audio
                        // (идемпотентно: no-op если захват не идёт).
                        screen_audio::stop();
                        let _ = app_sc.run_on_main_thread(|| {
                            screen_indicator::uninstall_indicator_hook();
                        });
                    }
                });
            }

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

    // Окно создаём СКРЫТЫМ: сразу после build подгоняем размер/позицию под
    // рабочую область монитора (fit_main_window_to_monitor) и только потом
    // показываем — иначе на FHD@125% и т.п. окно фикс-размера 1280×820
    // вылезало под таскбар и мелькало до репозиционирования.
    let mut builder = WebviewWindowBuilder::new(app, "main", webview_url)
        .title("Void")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .decorations(false)
        .background_color(APP_BG)
        .visible(false)
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

    // Подгоняем под рабочую область монитора (любой размер/любой OS-масштаб),
    // центрируем в ней, затем показываем (окно построено скрытым — без мелькания).
    fit_main_window_to_monitor(&window);
    let _ = window.show();
    let _ = window.set_focus();

    #[cfg(windows)]
    {
        // Авто-грант разрешения на микрофон — чтобы не всплывал нативный виндовый
        // промпт «… хочет использовать микрофон» (см. setup_media_permissions).
        setup_media_permissions(&window);
        // Запоминаем HWND главного окна — screen_indicator исключает его при
        // скрытии индикатора захвата экрана из таскбара.
        if let Ok(h) = window.hwnd() {
            MAIN_HWND.store(h.0 as isize, Ordering::SeqCst);
        }
    }

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

/// Подгоняет главное окно под монитор: комфортный «общепринятый» размер
/// (1280×820 логических), но НЕ больше рабочей области экрана (work_area уже
/// без таскбара), и центрирует ВНУТРИ рабочей области. Работает на любом
/// мониторе и любом OS-масштабе: на FHD@125% окно фикс-размера раньше вылезало
/// под таскбар — теперь высота ужимается под доступную область, низ всегда над
/// таскбаром. Всё считаем в ФИЗИЧЕСКИХ px (work_area физический), target
/// переводим logical→physical через scale_factor.
fn fit_main_window_to_monitor(window: &tauri::WebviewWindow) {
    // Комфортный таргет в логических px и нижний предел (как min_inner_size).
    const TARGET_W: f64 = 1280.0;
    const TARGET_H: f64 = 820.0;
    const MIN_W: f64 = 900.0;
    const MIN_H: f64 = 600.0;
    // Не занимать всю рабочую область — оставить «воздух» по краям.
    const WA_FRAC: f64 = 0.92;

    let Ok(Some(monitor)) = window.current_monitor() else {
        // Монитор не определился — оставляем как есть (центр от билдера-фоллбэка).
        let _ = window.center();
        return;
    };
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    let wa_x = wa.position.x as f64;
    let wa_y = wa.position.y as f64;
    let wa_w = wa.size.width as f64;
    let wa_h = wa.size.height as f64;

    // Таргет (физический) ограничиваем долей рабочей области, но не ниже минимума
    // (а минимум — не больше самой рабочей области, чтобы влезть на мелкий экран).
    let w = (TARGET_W * scale)
        .min(wa_w * WA_FRAC)
        .max((MIN_W * scale).min(wa_w));
    let h = (TARGET_H * scale)
        .min(wa_h * WA_FRAC)
        .max((MIN_H * scale).min(wa_h));

    // Центр ВНУТРИ рабочей области (не полного экрана) → не под таскбар.
    let x = wa_x + (wa_w - w) / 2.0;
    let y = wa_y + (wa_h - h) / 2.0;

    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
}

/// Авто-грант разрешения на микрофон (и камеру) в WebView2.
///
/// ПРОБЛЕМА: на каждый getUserMedia WebView2 поднимает нативный виндовый промпт
/// «<origin> хочет использовать микрофон» (origin = tauri.localhost у bundled
/// сборки). Хуже — WebView2 по умолчанию НЕ запоминает разрешения между
/// запусками (tauri#8979), поэтому промпт всплывал КАЖДУЮ сессию при первом
/// входе в комнату.
///
/// РЕШЕНИЕ: перехватываем PermissionRequested на уровне ICoreWebView2 и сразу
/// отвечаем ALLOW для микрофона/камеры. Origin — наш собственный bundled
/// index.html, приложение установлено пользователем осознанно → авто-грант
/// уместен и убирает диалог насовсем. Token регистрации не храним: хендлер
/// живёт всё время жизни окна.
#[cfg(windows)]
fn setup_media_permissions(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(
                |_sender, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                    if let Some(args) = args {
                        // PermissionKind в этом биндинге — out-param геттер.
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                    }
                    Ok(())
                },
            )),
            &mut token,
        );
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
        .background_color(APP_BG)
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
            let _ = app.emit(
                "void:updater-status",
                serde_json::json!({ "status": "startup-found", "version": update.version }),
            );
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
            let _ = app.emit("void:updater-status", serde_json::json!({ "status": "startup-uptodate" }));
            launch_main_window(&app);
            start_periodic_check(app);
        }
        Ok(Err(e)) => {
            eprintln!("[updater] startup check failed: {:?}", e);
            let _ = app.emit(
                "void:updater-status",
                serde_json::json!({ "status": "startup-error", "message": format!("{e:?}") }),
            );
            launch_main_window(&app);
            start_periodic_check(app);
        }
        Err(_) => {
            // таймаут (2.5с) — окно не вешаем; апдейт подхватит ранний режим B (~40с).
            let _ = app.emit("void:updater-status", serde_json::json!({ "status": "startup-timeout" }));
            launch_main_window(&app);
            start_periodic_check(app);
        }
    }
}

/// Разовая проверка апдейта для режима B (баннер, без принудительного рестарта).
/// Новее → ВСЕГДА эмитит "void:updater-available" (без dedup: иначе при пропуске
/// единственного эмита webview'ом баннер не покажется до перезапуска — JS сам
/// гейтит snooze и idempotent-показ). Результат каждой проверки дублируется в
/// "void:updater-status" (JS пишет в лог + тостит при ручной проверке).
///
/// ТАЙМАУТ 15с: без него зависшее соединение блокировало бы попытку надолго, а
/// следующая — только через интервал. Возвращает true, если проверка ЗАВЕРШИЛАСЬ
/// (есть апдейт или актуально), false при ошибке/таймауте — для ретрая-после-фейла.
async fn check_update_banner(app: &AppHandle) -> bool {
    let Ok(updater) = app.updater() else {
        let _ = app.emit("void:updater-status", serde_json::json!({ "status": "init-error" }));
        return false;
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15), updater.check()).await {
        Err(_) => {
            let _ = app.emit(
                "void:updater-status",
                serde_json::json!({ "status": "error", "message": "timeout" }),
            );
            false
        }
        Ok(Ok(Some(update))) => {
            let _ = app.emit(
                "void:updater-status",
                serde_json::json!({ "status": "available", "version": update.version }),
            );
            let _ = app.emit(
                "void:updater-available",
                serde_json::json!({
                    "version": update.version,
                    "body": update.body.clone().unwrap_or_default(),
                }),
            );
            true
        }
        Ok(Ok(None)) => {
            let _ = app.emit("void:updater-status", serde_json::json!({ "status": "uptodate" }));
            true
        }
        Ok(Err(e)) => {
            let _ = app.emit(
                "void:updater-status",
                serde_json::json!({ "status": "error", "message": format!("{e:?}") }),
            );
            false
        }
    }
}

/// Режим B: фоновая перепроверка обновления → баннер. Принудительного рестарта
/// нет. ПЕРВАЯ проверка — скоро (~40с), а не через 15 мин: стартовый silent-чек
/// имеет таймаут 2.5с и может быть пропущен (троттлинг запуска из Win Search,
/// тёплый single-instance, медленная сеть). Раньше из-за этого старая версия
/// могла висеть без баннера до 15 мин (а то и «никогда» при перезапусках).
fn start_periodic_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(40)).await;
        loop {
            // Ретрай-после-фейла: успех → 15 мин, ошибка/таймаут → 2 мин (чтобы
            // на нестабильном канале не ждать 15 мин до следующей попытки).
            let ok = check_update_banner(&app).await;
            let delay = if ok { 15 * 60 } else { 120 };
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
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

    // Share-данные для пунктов «скопировать …»: валидны только когда есть и код,
    // и ссылка. Иначе вне комнаты эти пункты в меню скрыты.
    let share = match (room_code, room_link) {
        (Some(c), Some(l)) if !c.is_empty() && !l.is_empty() => {
            Some((c.to_string(), l.to_string()))
        }
        _ => None,
    };
    let in_room = share.is_some();
    if let Ok(mut guard) = ROOM_SHARE.lock() {
        *guard = share;
    }
    // Проактивно толкаем состояние в окно-меню — чтобы к моменту открытия
    // копи-пункты уже были показаны/скрыты без мерцания.
    if let Some(menu_win) = app.get_webview_window(TRAY_MENU_LABEL) {
        let _ = menu_win.emit("void:tray-menu-state", serde_json::json!({ "inRoom": in_room }));
    }
}

/// Создаёт скрытое окно кастомного трей-меню (frameless, прозрачное,
/// always-on-top, вне таскбара). Поднимается один раз на старте и
/// переиспользуется (show/hide/reposition) — см. open_tray_menu.
fn create_tray_menu_window(app: &AppHandle) {
    if app.get_webview_window(TRAY_MENU_LABEL).is_some() {
        return;
    }
    let url = if cfg!(debug_assertions) {
        WebviewUrl::External(
            "http://localhost:3000/tray-menu.html"
                .parse()
                .expect("invalid dev URL"),
        )
    } else {
        WebviewUrl::App("tray-menu.html".into())
    };
    let win = match WebviewWindowBuilder::new(app, TRAY_MENU_LABEL, url)
        .title("void menu")
        // +2px — прозрачное кольцо (см. open_tray_menu). Реальный размер
        // выставляется на каждом открытии под состояние комнаты и авто-масштаб.
        .inner_size(TRAY_MENU_W + 2.0, tray_menu_height(false) + 2.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[tray-menu] build failed: {:?}", e);
            return;
        }
    };
    // Клик мимо меню (потеря фокуса) → прячем. Так ведёт себя нативное меню.
    let app_for_blur = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if let Some(w) = app_for_blur.get_webview_window(TRAY_MENU_LABEL) {
                let _ = w.hide();
            }
        }
    });
}

/// Показывает окно-меню у курсора (правый клик по трею). Размер/высота — под
/// текущее состояние комнаты; позиция — якорь правым-нижним углом к курсору
/// (трей в Windows внизу справа), с клампом к рабочей области монитора.
fn open_tray_menu(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    let in_room = ROOM_SHARE.lock().ok().map(|g| g.is_some()).unwrap_or(false);
    let Some(win) = app.get_webview_window(TRAY_MENU_LABEL) else {
        return;
    };

    // Монитор окна: нужен для DPI (scale_factor → физ-позиционирование) и границ
    // рабочей области при клампе позиции.
    let monitor = win.current_monitor().ok().flatten();
    let scale = monitor
        .as_ref()
        .map(|m| m.scale_factor())
        .unwrap_or_else(|| win.scale_factor().unwrap_or(1.0));
    // Нативный масштаб 1.0 на всех мониторах: окно/контент в базовых логических px,
    // физику масштабирует ОС через scale_factor. Раньше домножали на fluid-множитель
    // от ширины монитора — на 2K/4K это раздувало меню (как и весь UI).
    let auto = 1.0_f64;

    // Видимость копи-пунктов + множитель масштаба → странице (rem-сетка).
    // (основной push inRoom — в update_tray_state; scale считаем тут по монитору)
    let _ = win.emit(
        "void:tray-menu-state",
        serde_json::json!({ "inRoom": in_room, "scale": auto }),
    );

    // Контент × авто-масштаб, +2px прозрачного «кольца» (страховка от подреза
    // правого/нижнего бордера у прозрачного frameless-окна — см. tray-menu.css).
    let w_log = TRAY_MENU_W * auto + 2.0;
    let h_log = tray_menu_height(in_room) * auto + 2.0;
    let _ = win.set_size(LogicalSize::new(w_log, h_log));

    // Якорь правым-нижним углом к курсору (трей в Windows внизу справа),
    // с клампом к рабочей области монитора.
    let w_phys = w_log * scale;
    let h_phys = h_log * scale;
    let mut x = cursor.x - w_phys;
    let mut y = cursor.y - h_phys;
    if let Some(mon) = monitor.as_ref() {
        let mp = mon.position();
        let ms = mon.size();
        let gap = 4.0 * scale;
        let min_x = mp.x as f64 + gap;
        let min_y = mp.y as f64 + gap;
        let max_x = (mp.x as f64 + ms.width as f64 - w_phys - gap).max(min_x);
        let max_y = (mp.y as f64 + ms.height as f64 - h_phys - gap).max(min_y);
        x = x.clamp(min_x, max_x);
        y = y.clamp(min_y, max_y);
    }
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.show();
    let _ = win.set_focus();
}

/// Действие из кастомного трей-меню (клик по пункту). Сначала прячем меню,
/// затем выполняем. Копи-действия — no-op вне комнаты (пункты там скрыты).
#[tauri::command]
fn tray_menu_action(app: AppHandle, action: String) {
    if let Some(w) = app.get_webview_window(TRAY_MENU_LABEL) {
        let _ = w.hide();
    }
    match action.as_str() {
        "show" => show_main_window(&app),
        "copy-code" => copy_room_share(&app, true),
        "copy-link" => copy_room_share(&app, false),
        "quit" => app.exit(0),
        _ => {}
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
