// Точка входа Tauri-приложения.
// В dev окно грузит http://localhost:3000 (Node-сервер из package.json `npm start`).
// В prod — переключим на https://app.void-room.space (фаза 1).
// Frontend-бандл (frontendDist в tauri.conf.json) — placeholder, пока окно
// всегда грузит remote URL. Реальный offline-fallback появится позже.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running Void desktop");
}
