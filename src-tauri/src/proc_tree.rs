//! Обход дерева процессов через ToolHelp32 — общий помощник для audio_session
//! (ducking opt-out) и screen_indicator (скрытие индикатора захвата экрана).
//! WebView2 (Edge runtime) раскидывает работу по нескольким msedgewebview2.exe
//! процессам-потомкам, поэтому и звук, и окно-индикатор могут принадлежать не
//! нашему PID, а ребёнку. Возвращаем множество PID всех потомков root_pid.

use std::collections::HashSet;

use windows::core::Result;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// Множество PID всех процессов в дереве, начинающемся с root_pid (включая сам
/// root). BFS по ParentProcessId до сходимости. На Win11 (~300 процессов) <1ms.
pub unsafe fn collect_process_tree(root_pid: u32) -> Result<HashSet<u32>> {
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;

    let mut all: Vec<(u32, u32)> = Vec::new(); // (pid, parent_pid)
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if Process32FirstW(snap, &mut entry).is_ok() {
        loop {
            all.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if Process32NextW(snap, &mut entry).is_err() {
                break;
            }
        }
    }
    let _ = CloseHandle(snap);

    let mut tree: HashSet<u32> = HashSet::new();
    tree.insert(root_pid);
    // Фиксируем — BFS до сходимости (parent появился в tree → его дети тоже).
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, parent) in &all {
            if tree.contains(parent) && !tree.contains(pid) {
                tree.insert(*pid);
                changed = true;
            }
        }
    }
    Ok(tree)
}
