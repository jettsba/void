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

use windows::core::{Interface, Result};
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::GetCurrentProcessId;

use crate::proc_tree::collect_process_tree;

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
