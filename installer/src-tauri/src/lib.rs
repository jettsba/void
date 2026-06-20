// Точка входа кастомного установщика Void.
//
// Фаза 3: реальный бэкенд — tauri-команды для webview (детект установки,
// дефолтная папка, свободное место, выбор папки, тихий запуск NSIS,
// удаление существующей версии, финиш с ярлыком/запуском).
//
// Архитектура: «UI-скин поверх тихого NSIS». Сам установщик НЕ копирует файлы —
// он молча запускает существующий void_setup.exe (/S /D=<dir>) и uninstall.exe
// (/S). Это сохраняет совместимость с автоапдейтом главного приложения.
// См. tasks/installer-plan.md.
//
// Ground truth (с реальной машины, Tauri NSIS currentUser):
//   reg key:  HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Void
//   значения: DisplayVersion, InstallLocation (в кавычках!), UninstallString
//   дефолт:   %LOCALAPPDATA%\Void
//   exe app:  <InstallLocation>\void-desktop.exe   (cargo-имя бинаря)
//   деинст.:  <InstallLocation>\uninstall.exe
//   ярлыки:   NSIS создаёт Desktop\Void.lnk и Start Menu\Void.lnk сам

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const PRODUCT: &str = "Void";
const APP_EXE: &str = "void-desktop.exe";
/// Вшитый NSIS-установщик (void_setup.exe). Кладётся в payload/ перед сборкой
/// (см. build.rs). Если payload пустой (placeholder) — массив пустой, и
/// resolve_setup вернёт ошибку «setup не вшит».
const NSIS_SETUP: &[u8] = include_bytes!("../payload/void_setup.exe");
#[cfg(windows)]
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Void";
const NEEDED_BYTES: u64 = 18 * 1024 * 1024; // ≈ распакованный размер (для meta-строки)

// ============================ команды ============================

#[derive(Serialize)]
struct ExistingInstall {
    installed: bool,
    version: String,
    location: String,
}

/// Читает HKCU uninstall-ключ главного приложения. Read-only.
#[tauri::command]
fn detect_existing() -> ExistingInstall {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey(UNINSTALL_KEY) {
            let version: String = key.get_value("DisplayVersion").unwrap_or_default();
            let location: String = key
                .get_value::<String, _>("InstallLocation")
                .unwrap_or_default()
                .trim_matches('"') // значение хранится В КАВЫЧКАХ
                .to_string();
            return ExistingInstall { installed: true, version, location };
        }
    }
    ExistingInstall { installed: false, version: String::new(), location: String::new() }
}

/// Версия, которую СТАВИТ установщик (= версия приложения на момент сборки
/// установщика; инжектится build.rs из корневого package.json). Показывается в
/// UI. Раньше version в installer.js была захардкожена ("0.11.6") и
/// перезаписывалась лишь версией уже установленной копии → у свежих юзеров
/// показывался протухший хардкод.
#[tauri::command]
fn bundled_version() -> String {
    env!("VOID_BUNDLED_VERSION").to_string()
}

/// Дефолтная папка установки = %LOCALAPPDATA%\Void (как у Tauri NSIS currentUser).
#[tauri::command]
fn default_install_dir() -> String {
    std::env::var("LOCALAPPDATA")
        .map(|base| format!("{base}\\{PRODUCT}"))
        .unwrap_or_else(|_| format!("C:\\{PRODUCT}"))
}

#[derive(Serialize)]
struct DiskInfo {
    needed: u64,
    free: u64,
}

/// Свободное место на диске целевой папки + требуемый размер.
#[tauri::command]
fn disk_space(dir: String) -> DiskInfo {
    let free = free_bytes(&dir).unwrap_or(0);
    DiskInfo { needed: NEEDED_BYTES, free }
}

/// Нативный диалог выбора папки. None = отмена.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|f| f.to_string())
}

/// Тихая установка: запускает вшиваемый (Фаза 4) void_setup.exe в /S /D=<dir>.
/// В Фазе 3 setup резолвится рядом с exe установщика (см. resolve_setup).
#[tauri::command]
async fn run_install(dir: String) -> Result<(), String> {
    let setup = resolve_setup().ok_or_else(|| {
        "void_setup.exe не найден (положи рядом с установщиком или задай VOID_NSIS_SETUP)".to_string()
    })?;
    run_silent(&setup, Some(&dir)).map_err(|e| format!("установка: {e}"))?;
    // Веха B: если приложение поставило кастомный деинсталлятор — направляем на
    // него «Удалить» в Windows. Если нет (старый build) — оставляем NSIS как есть.
    #[cfg(windows)]
    point_uninstall_to_custom(&dir);
    Ok(())
}

/// Тихое удаление существующей версии через её же uninstall.exe (/S).
#[tauri::command]
async fn uninstall_existing(location: String, purge_data: bool) -> Result<(), String> {
    let unins = Path::new(&location).join("uninstall.exe");
    if !unins.exists() {
        return Err(format!("uninstall.exe не найден в {location}"));
    }
    run_silent(&unins, None).map_err(|e| format!("удаление: {e}"))?;
    if purge_data {
        purge_app_data();
    }
    Ok(())
}

/// Финиш (экран «готово»): применить выбор ярлыка + при желании запустить void.
/// Окно закрывает сам webview после этого. NSIS уже создал Desktop\Void.lnk —
/// поэтому desktop_shorttcut=false означает «удалить», а не «создать».
#[tauri::command]
fn finish_install(
    location: String,
    launch: bool,
    desktop_shortcut: bool,
    lang: String,
) -> Result<(), String> {
    // Язык, выбранный в установщике → one-shot маркер в папке установки.
    // Главное приложение прочитает его на старте, применит и удалит (см. lib.rs
    // главного app: take_installer_lang + initialization_script).
    if lang == "ru" || lang == "en" {
        let _ = std::fs::write(Path::new(&location).join("installer-lang"), &lang);
    }
    if !desktop_shortcut {
        remove_desktop_shortcut();
    }
    if launch {
        let exe = Path::new(&location).join(APP_EXE);
        Command::new(&exe)
            .spawn()
            .map_err(|e| format!("запуск {APP_EXE}: {e}"))?;
    }
    Ok(())
}

// ============================ helpers ============================

/// Запуск процесса в тихом режиме (/S) и ожидание. На Windows используем
/// raw_arg, чтобы /D=<path с пробелами> ушёл БЕЗ кавычек (NSIS не терпит кавычки
/// в /D=, и он должен быть последним аргументом).
fn run_silent(exe: &Path, install_dir: Option<&str>) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg("/S");
        if let Some(dir) = install_dir {
            cmd.raw_arg(format!("/D={dir}")); // ДОЛЖЕН быть последним, без кавычек
        }
    }
    #[cfg(not(windows))]
    {
        let _ = install_dir;
    }
    let status = cmd.status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("процесс вышел с кодом {:?}", status.code()))
    }
}

/// Резолв void_setup.exe: env-override → ВШИТЫЙ (извлечь в temp) → рядом с exe
/// (dev-фоллбэк). Вшитый — основной путь (одиночный void_installer.exe).
fn resolve_setup() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("VOID_NSIS_SETUP") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Some(p) = extract_embedded_setup() {
        return Some(p);
    }
    // dev-фоллбэк: рядом с exe (если собрано без вшитого payload)
    let exe = std::env::current_exe().ok()?;
    let sib = exe.parent()?.join("void_setup.exe");
    if sib.exists() {
        Some(sib)
    } else {
        None
    }
}

/// Извлекает вшитый void_setup.exe во временную папку и возвращает путь.
/// None, если payload пустой (placeholder) — собрано без staged setup.
fn extract_embedded_setup() -> Option<PathBuf> {
    if NSIS_SETUP.is_empty() {
        return None;
    }
    let dir = std::env::temp_dir().join("void-installer");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("void_setup.exe");
    std::fs::write(&path, NSIS_SETUP).ok()?;
    Some(path)
}

#[cfg(windows)]
fn free_bytes(dir: &str) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // целевая папка может ещё не существовать → поднимаемся до существующего предка
    let mut p = PathBuf::from(dir);
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let h = HSTRING::from(p.as_os_str());
    let mut avail: u64 = 0;
    unsafe { GetDiskFreeSpaceExW(&h, Some(&mut avail), None, None).ok()? };
    Some(avail)
}

#[cfg(not(windows))]
fn free_bytes(_dir: &str) -> Option<u64> {
    None
}

/// Переписывает в реестре указатель «Удалить» на наш кастомный деинсталлятор:
///   UninstallString      → "<dir>\void-uninstaller.exe"   (наш webview-UI)
///   QuietUninstallString  → "<dir>\uninstall.exe" /S       (тихий NSIS для winget и т.п.)
/// Только если кастомный деинсталлятор реально стоит в папке установки.
#[cfg(windows)]
fn point_uninstall_to_custom(dir: &str) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let Some(custom) = find_custom_uninstaller(dir) else {
        return;
    };
    let unins = Path::new(dir).join("uninstall.exe");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey_with_flags(UNINSTALL_KEY, KEY_SET_VALUE) {
        let _ = key.set_value("UninstallString", &format!("\"{}\"", custom.display()));
        let _ = key.set_value("QuietUninstallString", &format!("\"{}\" /S", unins.display()));
    }
}

/// Ищет кастомный деинсталлятор в папке установки (корень или resources/).
#[cfg(windows)]
fn find_custom_uninstaller(dir: &str) -> Option<PathBuf> {
    let d = Path::new(dir);
    let root = d.join("void-uninstaller.exe");
    if root.exists() {
        return Some(root);
    }
    let res = d.join("resources").join("void-uninstaller.exe");
    if res.exists() {
        return Some(res);
    }
    None
}

#[cfg(windows)]
fn remove_desktop_shortcut() {
    if let Ok(up) = std::env::var("USERPROFILE") {
        // TODO(Фаза 6): учесть OneDrive-редирект рабочего стола (SHGetKnownFolderPath).
        let lnk = Path::new(&up).join("Desktop").join("Void.lnk");
        let _ = std::fs::remove_file(lnk);
    }
}

#[cfg(not(windows))]
fn remove_desktop_shortcut() {}

#[cfg(windows)]
fn purge_app_data() {
    // TODO(верифицировать): webview-данные Tauri обычно под %LOCALAPPDATA%\{identifier}.
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let _ = std::fs::remove_dir_all(Path::new(&la).join("space.void-room.app"));
    }
}

#[cfg(not(windows))]
fn purge_app_data() {}

// ============================ run ============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            bundled_version,
            detect_existing,
            default_install_dir,
            disk_space,
            pick_folder,
            run_install,
            uninstall_existing,
            finish_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Void installer");
}
