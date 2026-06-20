use std::path::Path;

fn main() {
    // Версия, которую ставит установщик, = версия приложения на момент его
    // сборки. Берём из корневого package.json (единый источник истины) и
    // прокидываем в код через env (см. команду bundled_version в lib.rs).
    // Раньше версия была захардкожена в installer.js ("0.11.6"), поэтому у
    // свежих юзеров (без уже установленной копии) показывалась именно она.
    let version = std::fs::read_to_string("../../package.json")
        .ok()
        .and_then(|s| {
            s.split("\"version\"")
                .nth(1)
                .and_then(|rest| rest.split('"').nth(1))
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rustc-env=VOID_BUNDLED_VERSION={version}");
    println!("cargo:rerun-if-changed=../../package.json");

    // void_setup.exe вшивается в установщик через include_bytes! (см. lib.rs).
    // Перед РЕЛИЗНОЙ сборкой его кладут в payload/ (CI: копия из main-app NSIS;
    // локально — вручную). Если файла нет — создаём пустой placeholder, чтобы
    // компиляция не падала; рантайм тогда вернёт «setup не вшит». rerun — на
    // изменение payload, чтобы пере-встроить свежий setup.
    let setup = Path::new("payload/void_setup.exe");
    if !setup.exists() {
        let _ = std::fs::create_dir_all("payload");
        let _ = std::fs::write(setup, b"");
    }
    println!("cargo:rerun-if-changed=payload/void_setup.exe");

    tauri_build::build();
}
