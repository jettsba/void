// Точка входа Tauri-приложения.
//
// Окно создаётся ПРОГРАММНО (не через windows[] в tauri.conf.json), чтобы
// compile-time переключать URL: dev → localhost, release → продакшн-домен.
// debug_assertions выставлен только в debug-профиле, поэтому release-сборка
// никогда не пойдёт на localhost, даже если кто-то запустит её локально.

use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let url = if cfg!(debug_assertions) {
                "http://localhost:3000"
            } else {
                "https://app.void-room.space"
            };

            WebviewWindowBuilder::new(
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Void desktop");
}
