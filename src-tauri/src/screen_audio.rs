// Чистый захват звука демонстрации через Windows Application Loopback.
//
// ПРОБЛЕМА:
//   getDisplayMedia({audio}) тащит весь системный микс рендера стримера, включая
//   голоса пиров, которые проигрывает сам void (WebRTC) → зритель слышит себя и
//   других. AEC это маскировал, но давил музыку при разговоре (ducking). Браузерный
//   API не умеет исключить «своё приложение» из системного звука.
//
// РЕШЕНИЕ (desktop-only):
//   WASAPI Application Loopback с PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
//   и target = наш PID. Захватывает ВЕСЬ системный звук, КРОМЕ нашего дерева
//   процессов. Голоса void рендерит WebView2 (потомок void-desktop.exe) → они
//   исключаются. На выходе чистая музыка/игра/видео без голосов и без ducking.
//
// АРХИТЕКТУРА:
//   ActivateAudioInterfaceAsync("VAD\Process_Loopback", IAudioClient, params) →
//   Initialize(SHARED, LOOPBACK, float32/48k/stereo) → поток GetBuffer в цикле →
//   f32→i16 → PCM в JS через tauri::ipc::Channel (Raw). JS-сторона
//   (screen-audio-feeder.js AudioWorklet) собирает из кадров MediaStreamTrack.
//
// ПОЧЕМУ float32 на входе: shared-mode audio engine отдаёт float нативно — это
//   формат, который Initialize гарантированно принимает на любом девайсе. 16-bit
//   PCM движок может не принять напрямую; поэтому берём f32 и сами конвертим в
//   i16 (вдвое экономит IPC, на слух для музыки потерь нет).
//
// ПРОДАКШЕН-СВОЙСТВА:
//   - start() дожидается результата активации и возвращает РЕАЛЬНЫЙ Result →
//     JS сразу знает про провал (старый Windows / ошибка) и не сидит на тишине.
//   - self-heal: при mid-stream ошибке сессия пересобирается (audio не умирает).
//   - CoUninitialize на выходе потока.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use std::collections::HashMap;

use tauri::ipc::{Channel, InvokeResponseBody};
use windows::core::{implement, w, Interface, Ref, Result, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::System::Variant::VT_BLOB;

/// Виртуальное «устройство» для process-loopback активации (MSDN).
const VAD_PROCESS_LOOPBACK: PCWSTR = w!("VAD\\Process_Loopback");

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const IN_BITS: u16 = 32; // float32 на входе (нативный shared-mode формат)
const IN_BLOCK_ALIGN: u16 = CHANNELS * IN_BITS / 8; // 8 байт/кадр (2×f32)
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

/// ДИАГНОСТИКА (временная): перечисляет активные render-аудио-сессии и для каждой
/// показывает имя процесса + лежит ли её PID в дереве процессов void. Цель —
/// понять, почему loopback с EXCLUDE_TARGET_PROCESS_TREE не исключает голоса:
/// если сессия WebView2 (msedgewebview2.exe, играет голоса пиров) помечена OUT —
/// значит она НЕ потомок void → exclude её не ловит, и нужен другой подход.
pub fn diagnostics() -> String {
    // COM-работа (особенно async-активация capture_peak) — на отдельном MTA-потоке,
    // как и реальный захват; на STA-потоке команды completion-handler не доедет.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let s = unsafe { diagnostics_inner() };
        let _ = tx.send(s);
    });
    rx.recv_timeout(Duration::from_secs(12))
        .unwrap_or_else(|_| "diag: timeout".to_string())
}

unsafe fn diagnostics_inner() -> String {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let our_pid = GetCurrentProcessId();
    let tree = crate::proc_tree::collect_process_tree(our_pid).unwrap_or_default();
    let names = process_names();

    // РЕАЛЬНЫЙ ЗАМЕР (вперёд — самое важное, чтобы не обрезалось в тосте):
    // пик |амплитуды| за ~1.2с в каждом режиме.
    //   INCLUDE(void) = ТОЛЬКО звук void (голоса пиров) → >0 если друг говорит.
    //   EXCLUDE(void) = всё КРОМЕ void → если исключение работает и кроме голосов
    //     ничего не играет, должен быть ≈0. Если EXCLUDE тоже ловит голоса (high) —
    //     значит EXCLUDE_TARGET_PROCESS_TREE не срабатывает.
    let fmt = |r: Result<(f32, usize)>| match r {
        Ok((peak, frames)) => format!("{peak:.4}({frames}f)"),
        Err(e) => format!("ERR {e:?}"),
    };
    let inc = capture_peak(our_pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, 1200);
    let exc = capture_peak(our_pid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, 1200);
    let mut out = format!(
        "INCLUDE(void)={} EXCLUDE(void)={} | pid={our_pid} tree={} | ",
        fmt(inc),
        fmt(exc),
        tree.len()
    );

    match enum_render_session_pids() {
        Ok(pids) => {
            for pid in pids {
                let name = names.get(&pid).cloned().unwrap_or_else(|| "?".to_string());
                let loc = if pid == 0 {
                    "SYS"
                } else if tree.contains(&pid) {
                    "IN"
                } else {
                    "OUT"
                };
                out.push_str(&format!("{name}({pid})={loc} "));
            }
        }
        Err(e) => out.push_str(&format!("sessions ERR {e:?}")),
    }
    CoUninitialize();
    out
}

/// Активирует process-loopback IAudioClient в заданном режиме (INCLUDE/EXCLUDE
/// дерева target-процесса). Общий путь для реального захвата и для замера —
/// чтобы диагностика тестировала ровно ту же активацию.
unsafe fn activate_loopback_client(pid: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: mode,
            },
        },
    };
    let blob = BLOB {
        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        pBlobData: &mut params as *mut _ as *mut u8,
    };
    let mut propvar = PROPVARIANT::default();
    {
        let inner = &mut *propvar.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = blob;
    }
    let done = Arc::new(AtomicBool::new(false));
    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivationHandler { done: done.clone() }.into();
    let activate_result = ActivateAudioInterfaceAsync(
        VAD_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&propvar),
        &handler,
    );
    // propvar.blob → стековый params; activation копирует синхронно. forget гасит
    // PROPVARIANT::drop (иначе PropVariantClear фримит стек-указатель → краш).
    std::mem::forget(propvar);
    let op: IActivateAudioInterfaceAsyncOperation = activate_result?;
    for _ in 0..300 {
        if done.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut activate_hr = windows::core::HRESULT(0);
    let mut audio_unknown: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut activate_hr, &mut audio_unknown)?;
    activate_hr.ok()?;
    audio_unknown
        .ok_or_else(windows::core::Error::from_win32)?
        .cast()
}

/// Захватывает ~`ms` мс в заданном loopback-режиме и возвращает (пик|амплитуды|, кадров).
unsafe fn capture_peak(pid: u32, mode: PROCESS_LOOPBACK_MODE, ms: u64) -> Result<(f32, usize)> {
    let client = activate_loopback_client(pid, mode)?;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * IN_BLOCK_ALIGN as u32,
        nBlockAlign: IN_BLOCK_ALIGN,
        wBitsPerSample: IN_BITS,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        2_000_000,
        0,
        &format,
        None,
    )?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    let mut peak = 0f32;
    let mut frames_total = 0usize;
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < ms as u128 {
        loop {
            let packet = capture.GetNextPacketSize()?;
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut num_frames: u32 = 0;
            let mut flags: u32 = 0;
            capture.GetBuffer(&mut data, &mut num_frames, &mut flags, None, None)?;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 && !data.is_null() {
                let n = num_frames as usize * CHANNELS as usize;
                let src = std::slice::from_raw_parts(data as *const f32, n);
                for &s in src {
                    let a = s.abs();
                    if a > peak {
                        peak = a;
                    }
                }
            }
            frames_total += num_frames as usize;
            capture.ReleaseBuffer(num_frames)?;
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    let _ = client.Stop();
    Ok((peak, frames_total))
}

/// PID → имя exe (ToolHelp32 snapshot).
unsafe fn process_names() -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
        return map;
    };
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if Process32FirstW(snap, &mut entry).is_ok() {
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
            map.insert(entry.th32ProcessID, name);
            if Process32NextW(snap, &mut entry).is_err() {
                break;
            }
        }
    }
    let _ = CloseHandle(snap);
    map
}

/// PID'ы всех render-сессий звука на дефолтном устройстве вывода.
unsafe fn enum_render_session_pids() -> Result<Vec<u32>> {
    let device_enum: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = device_enum.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
    let session_mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
    let enumerator = session_mgr.GetSessionEnumerator()?;
    let count = enumerator.GetCount()?;
    let mut pids = Vec::new();
    for i in 0..count {
        let Ok(ctrl) = enumerator.GetSession(i) else {
            continue;
        };
        let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else {
            continue;
        };
        if let Ok(pid) = ctrl2.GetProcessId() {
            pids.push(pid);
        }
    }
    Ok(pids)
}

struct CaptureHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

static CAPTURE: Mutex<Option<CaptureHandle>> = Mutex::new(None);

/// Стартует loopback-захват и стримит PCM в Channel. Идемпотентно (предыдущий
/// захват останавливается). БЛОКИРУЕТСЯ до результата активации (до ~5с): Ok —
/// захват пошёл; Err — активация не удалась (старый Windows / ошибка), JS делает
/// fallback (демка без звука).
pub fn start(channel: Channel<InvokeResponseBody>) -> std::result::Result<(), String> {
    stop();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop_flag.clone();
    let pid = unsafe { GetCurrentProcessId() };
    let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<(), String>>();

    let join = std::thread::spawn(move || {
        capture_thread(pid, stop_for_thread, channel, ready_tx);
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {
            if let Ok(mut guard) = CAPTURE.lock() {
                *guard = Some(CaptureHandle {
                    stop: stop_flag,
                    join: Some(join),
                });
            }
            Ok(())
        }
        Ok(Err(e)) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err(e)
        }
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err("screen audio activation timed out".into())
        }
    }
}

/// Останавливает захват (если идёт) и дожидается завершения потока.
pub fn stop() {
    let handle = CAPTURE.lock().ok().and_then(|mut g| g.take());
    if let Some(mut h) = handle {
        h.stop.store(true, Ordering::SeqCst);
        if let Some(join) = h.join.take() {
            let _ = join.join();
        }
    }
}

/// Completion-handler для ActivateAudioInterfaceAsync — взводит флаг по
/// завершении активации. COM зовёт с RPC-потока → флаг `Arc<AtomicBool>`
/// (Send+Sync, в отличие от сырого Win32 HANDLE).
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    done: Arc<AtomicBool>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> Result<()> {
        self.done.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// COM-поток захвата: первая сессия сигналит готовность через `ready`, дальше —
/// self-heal (пересборка сессии при транзиентной ошибке) до stop.
fn capture_thread(
    pid: u32,
    stop: Arc<AtomicBool>,
    channel: Channel<InvokeResponseBody>,
    ready_tx: mpsc::Sender<std::result::Result<(), String>>,
) {
    unsafe {
        // MTA — completion-handler придёт на отдельном RPC-потоке.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let mut ready: Option<mpsc::Sender<std::result::Result<(), String>>> = Some(ready_tx);
        while !stop.load(Ordering::SeqCst) {
            match run_session(pid, &stop, &channel, &mut ready) {
                Ok(()) => break, // штатное завершение (stop)
                Err(e) => {
                    if let Some(tx) = ready.take() {
                        // Сетап первой сессии упал — на повторе не починится.
                        let _ = tx.send(Err(format!("{e:?}")));
                        break;
                    }
                    // Mid-stream ошибка после успешного старта — пересобираем.
                    eprintln!("[screen_audio] session error, restart in 200ms: {e:?}");
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }

        CoUninitialize();
    }
}

/// Одна сессия захвата: активация → Initialize → Start → polling-цикл до stop.
/// После успешного Start сигналит `ready` (если ещё не сигналили).
unsafe fn run_session(
    pid: u32,
    stop: &AtomicBool,
    channel: &Channel<InvokeResponseBody>,
    ready: &mut Option<mpsc::Sender<std::result::Result<(), String>>>,
) -> Result<()> {
    // Активация process-loopback с исключением нашего дерева процессов (общий
    // путь с диагностикой — activate_loopback_client).
    let audio_client =
        activate_loopback_client(pid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE)?;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }

    // Формат захвата: float32 / 48k / stereo.
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * IN_BLOCK_ALIGN as u32,
        nBlockAlign: IN_BLOCK_ALIGN,
        wBitsPerSample: IN_BITS,
        cbSize: 0,
    };

    // Буфер 200мс. Для process-loopback обязателен LOOPBACK-флаг.
    audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        2_000_000, // 200мс в 100-нс единицах
        0,
        &format,
        None,
    )?;

    let capture: IAudioCaptureClient = audio_client.GetService()?;
    audio_client.Start()?;

    // Старт удался — сигналим готовность (только первая сессия).
    if let Some(tx) = ready.take() {
        let _ = tx.send(Ok(()));
    }

    // Polling-цикл: вычитываем все доступные пакеты, конвертим f32→i16, спим 8мс.
    let mut out: Vec<u8> = Vec::with_capacity(4096);
    while !stop.load(Ordering::SeqCst) {
        loop {
            let packet = capture.GetNextPacketSize()?;
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut num_frames: u32 = 0;
            let mut flags: u32 = 0;
            capture.GetBuffer(&mut data, &mut num_frames, &mut flags, None, None)?;

            let samples = num_frames as usize * CHANNELS as usize; // f32 семплов
            out.clear();
            out.reserve(samples * 2); // i16 = 2 байта/семпл
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
            if silent {
                out.resize(samples * 2, 0);
            } else {
                let src = std::slice::from_raw_parts(data as *const f32, samples);
                for &s in src {
                    let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
            capture.ReleaseBuffer(num_frames)?;

            if !out.is_empty() {
                let _ = channel.send(InvokeResponseBody::Raw(out.clone()));
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }

    let _ = audio_client.Stop();
    Ok(())
}
