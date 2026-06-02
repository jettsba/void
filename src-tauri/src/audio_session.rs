// Отключение Windows communications-ducking для нашего процесс-дерева.
//
// ПРОБЛЕМА:
//   По дефолту в Windows стоит "Reduce volume of other sounds by 80%" во вкладке
//   Sound → Communications. Когда любая audio session становится "communications"
//   (типично — активный mic в voice call), Windows автоматически приглушает ВСЕ
//   другие audio sources на 80%.
//
//   В нашем случае при WebRTC voice + screen-share: Pete говорит в свой mic →
//   его Chrome activates communications session → Windows ducks ВСЁ остальное
//   включая воспроизведение того же WebRTC stream'а (моя музыка/демо). Это
//   та самая жалоба "звук собеседника приглушается когда я говорю", известная
//   всем юзерам Discord/Zoom/Teams.
//
//   В web-сборке это не починить (OS-level), в desktop Tauri — можем.
//
// РЕШЕНИЕ:
//   IAudioSessionControl2::SetDuckingPreference(true) — для конкретной audio
//   session говорит Windows "не дакать других когда я communications". Применяем
//   ко всем аудио-сессиям нашего процесс-дерева (void-desktop.exe + WebView2
//   child processes, особенно audio service).
//
// ПОЧЕМУ process tree:
//   WebView2 (Edge runtime) запускает audio в отдельном утилитарном msedgewebview2.exe
//   процессе (audio service). ProcessId этого ребёнка != our PID. Поэтому
//   обходим всё дерево по ParentProcessId и идентифицируем все сессии,
//   принадлежащие потомкам void-desktop.exe.
//
// ПОЧЕМУ периодически:
//   WebView2 audio service может запускаться позже основного окна; при reconnect
//   (отвалился mic / поменяли устройство) сессия может пересоздаваться. Периодический
//   rescan (30s) гарантирует что новые сессии тоже получат opt-out.

use std::collections::HashSet;

use windows::core::{Interface, Result};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::GetCurrentProcessId;

pub fn disable_communications_ducking_for_our_tree() -> Result<()> {
    unsafe {
        // CoInitializeEx может вернуть RPC_E_CHANGED_MODE / S_FALSE если уже
        // инициализирован — это нормально, игнорируем.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let our_pid = GetCurrentProcessId();
        let tree = collect_process_tree(our_pid)?;

        let device_enum: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = device_enum.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        let session_mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let enumerator = session_mgr.GetSessionEnumerator()?;
        let count = enumerator.GetCount()?;

        for i in 0..count {
            let Ok(ctrl) = enumerator.GetSession(i) else {
                continue;
            };
            let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = ctrl2.GetProcessId() else {
                continue;
            };
            if tree.contains(&pid) {
                // SetDuckingPreference(true) — opt out of triggering ducking
                // когда наша сессия становится communications.
                let _ = ctrl2.SetDuckingPreference(true);
            }
        }
        Ok(())
    }
}

/// Возвращает множество PID всех процессов в дереве, начинающемся с root_pid.
/// BFS по ParentProcessId. На современных Win11 машинах ~300 процессов в snapshot,
/// итерация занимает <1ms.
unsafe fn collect_process_tree(root_pid: u32) -> Result<HashSet<u32>> {
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
