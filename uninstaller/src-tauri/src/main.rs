// windows_subsystem = "windows" в release → нет консольного окна.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Два режима:
//   без аргументов  → self-relocate: копируем себя в %TEMP% и перезапускаемся
//                     оттуда с «--work <папка установки>», затем выходим. Это
//                     разблокирует exe в папке установки, чтобы NSIS uninstall
//                     смог её удалить.
//   --work <dir>    → реальный UI деинсталлятора (запущен уже из %TEMP%).
fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--work") {
        Some(i) => {
            if let Some(dir) = args.get(i + 1) {
                std::env::set_var("VOID_UNINSTALL_DIR", dir);
            }
            void_uninstaller_lib::run();
        }
        None => void_uninstaller_lib::relocate_and_relaunch(),
    }
}
