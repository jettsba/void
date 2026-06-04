use std::path::Path;

fn main() {
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
