// Кастомный деинсталлятор Void (Веха B). См. tasks/installer-plan.md, Фаза 6.
//
// Поток: Windows на «Удалить» запускает <installdir>\void-uninstaller.exe
// (UninstallString переписан установщиком). main.rs без --work → relocate в
// %TEMP% → перезапуск с --work <installdir> → этот lib поднимает webview-UI →
// по кнопке «удалить» команда run_uninstall молча гонит <installdir>\uninstall.exe
// /S → «удалено» → закрытие.

use std::path::Path;
use std::process::Command;

const ENV_DIR: &str = "VOID_UNINSTALL_DIR";

/// Копирует себя в %TEMP% и перезапускается оттуда с «--work <installdir>».
/// Нужно, чтобы exe в папке установки не был залочен, когда NSIS будет её удалять.
pub fn relocate_and_relaunch() {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return,
    };
    let origdir = match exe.parent() {
        Some(d) => d.to_path_buf(),
        None => return,
    };
    let tmp = std::env::temp_dir().join("void-uninstaller-run.exe");
    if std::fs::copy(&exe, &tmp).is_err() {
        return;
    }
    let _ = Command::new(&tmp).arg("--work").arg(origdir).spawn();
    // немедленный выход — оригинальный exe в папке установки разблокирован
}

/// Тихое удаление: <installdir>\uninstall.exe /S + опционально снос данных.
#[tauri::command]
async fn run_uninstall(purge_data: bool) -> Result<(), String> {
    let dir = std::env::var(ENV_DIR).map_err(|_| "не задана папка установки".to_string())?;
    let unins = find_uninstaller(&dir)
        .ok_or_else(|| format!("uninstall.exe не найден (от {dir})"))?;
    let mut cmd = Command::new(&unins);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg("/S");
    }
    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("uninstall вышел с кодом {:?}", status.code()));
    }
    if purge_data {
        purge_app_data();
    }
    Ok(())
}

/// Ищет NSIS uninstall.exe: рядом с деинсталлятором, либо этажом выше (если
/// Tauri положил наш exe в подпапку resources/).
fn find_uninstaller(dir: &str) -> Option<std::path::PathBuf> {
    let d = Path::new(dir);
    let here = d.join("uninstall.exe");
    if here.exists() {
        return Some(here);
    }
    let up = d.parent()?.join("uninstall.exe");
    if up.exists() {
        return Some(up);
    }
    None
}

#[cfg(windows)]
fn purge_app_data() {
    // TODO(верифицировать): webview-данные Tauri под %LOCALAPPDATA%\{identifier}.
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let _ = std::fs::remove_dir_all(Path::new(&la).join("space.void-room.app"));
    }
}

#[cfg(not(windows))]
fn purge_app_data() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_uninstall])
        .run(tauri::generate_context!())
        .expect("error while running Void uninstaller");
}
