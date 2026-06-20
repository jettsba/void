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

use tauri::ipc::{Channel, InvokeResponseBody};
use windows::core::{implement, w, Interface, Ref, Result, PCWSTR};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    BLOB, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
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
    // Параметры process-loopback: исключаем наше дерево процессов.
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    // Упаковываем params в PROPVARIANT(VT_BLOB) для ActivateAudioInterfaceAsync.
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

    let op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
        VAD_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&propvar),
        &handler,
    )?;

    // Ждём активацию (поллинг до ~3с), уважая stop.
    for _ in 0..300 {
        if done.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }

    let mut activate_hr = windows::core::HRESULT(0);
    let mut audio_unknown: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut activate_hr, &mut audio_unknown)?;
    activate_hr.ok()?;
    let audio_client: IAudioClient = audio_unknown
        .ok_or_else(windows::core::Error::from_win32)?
        .cast()?;

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
