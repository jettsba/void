// windows_subsystem = "windows" в release → у установщика НЕТ консольного окна.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    void_installer_lib::run()
}
