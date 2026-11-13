// Чистый захват звука демонстрации на macOS через Core Audio process tap.
//
// ПРОБЛЕМА (та же, что на Windows, см. screen_audio.rs):
//   звук демки надо отдать зрителю БЕЗ голосов пиров, которые проигрывает сам
//   void. На маке хуже: WKWebView вообще не отдаёт звук в getDisplayMedia, то
//   есть без нативного пути демка молчит.
//
// РЕШЕНИЕ:
//   CATapDescription(initStereoGlobalTapButExcludeProcesses) — «весь системный
//   звук, КРОМЕ вот этих процессов» (аналог WASAPI
//   PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE). Исключаем свои процессы
//   → в тапе остаётся музыка/видео/игра стримера без голосов и без ducking.
//   От выбранного в пикере экрана/окна тап не зависит, поэтому звук есть и при
//   демке всего экрана, и при демке окна.
//
// КАК ОПОЗНАЁМ «СВОИ» ПРОЦЕССЫ:
//   голоса пиров играет не void-desktop, а XPC-процесс com.apple.WebKit.GPU,
//   чей ppid = launchd. Фильтр по bundle id com.apple.WebKit.* убил бы заодно
//   звук Safari у стримера. Поэтому берём responsible-процесс:
//   responsibility_get_pid_responsible_for_pid(pid) == getpid() — для WebKit-
//   процессов void даёт void, для таких же процессов Safari даёт Safari
//   (проверено замером: void-desktop 30868 ← GPU/WebContent/Networking,
//   Safari 80419 ← свой GPU 80432).
//
// АРХИТЕКТУРА:
//   tap → приватный aggregate device (clock device = дефолтный выход, список
//   sub-device пустой, чтобы единственным входным стримом был сам тап) →
//   IOProc-блок кладёт float32-кадры в ring → поток-насос ресемплит до 48k,
//   конвертит f32→i16 и отдаёт в тот же tauri::ipc::Channel, что и Windows
//   (JS-сторона — public/audio/screen-audio-feeder.js, менять не нужно).
//
// ПРОДАКШЕН-СВОЙСТВА:
//   - start() возвращает РЕАЛЬНЫЙ Result: нет API (macOS < 14.2) или TCC-отказ
//     → Err, JS уводит демку в режим «без звука» и показывает подсказку.
//   - kAudioTapPropertyDescription у живого тапа НЕ переписывается (замер:
//     !hog / kAudioDevicePermissionsError), поэтому при изменении набора «своих»
//     процессов или смене устройства вывода сессия пересобирается целиком.
//   - слушатели kAudioHardwarePropertyProcessObjectList и
//     kAudioHardwarePropertyDefaultOutputDevice взводят флаг пересборки.
//   - CATapMuteBehavior::Unmuted — стример продолжает слышать свой звук.

use std::collections::BTreeSet;
use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceClockDeviceKey, kAudioAggregateDeviceIsPrivateKey,
    kAudioAggregateDeviceIsStackedKey, kAudioAggregateDeviceMainSubDeviceKey,
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceSubDeviceListKey,
    kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
    kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioProcessPropertyPID, kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey,
    kAudioSubTapUIDKey, kAudioTapPropertyFormat, kAudioTapPropertyUID,
    AudioDeviceCreateIOProcIDWithBlock, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
    AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
    AudioHardwareDestroyAggregateDevice, AudioObjectAddPropertyListenerBlock,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress, AudioObjectPropertySelector, AudioObjectRemovePropertyListenerBlock,
    CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use tauri::ipc::{Channel, InvokeResponseBody};

const TARGET_RATE: f64 = 48_000.0;
const TARGET_CHANNELS: usize = 2;
/// Потолок ring-буфера — 1 с при 48k/stereo. Насос вычитывает его каждые 8 мс;
/// переполнение возможно только если JS-сторона встала, и тогда лучше ронять
/// старое, чем пухнуть в памяти.
const RING_CAP: usize = 48_000 * TARGET_CHANNELS;

type ProcessTapCreate =
    unsafe extern "C" fn(*const AnyObject, *mut AudioObjectID) -> i32;
type ProcessTapDestroy = unsafe extern "C" fn(AudioObjectID) -> i32;

/// Символы тапов есть только с macOS 14.2. Берём их через dlsym, а не обычным
/// extern — иначе на 13.x приложение не слиняется вовсе (chained fixups
/// биндят символы на запуске) и упадёт до первого окна.
struct TapApi {
    create: ProcessTapCreate,
    destroy: ProcessTapDestroy,
}

fn tap_api() -> Option<&'static TapApi> {
    use std::sync::OnceLock;
    static API: OnceLock<Option<TapApi>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let create = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"AudioHardwareCreateProcessTap".as_ptr(),
        );
        let destroy = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"AudioHardwareDestroyProcessTap".as_ptr(),
        );
        if create.is_null() || destroy.is_null() {
            return None;
        }
        // Класс описания тапа ищется по имени в рантайме (objc2 кэширует
        // objc_getClass), но если его нет — обращение паникует. Проверяем здесь.
        AnyClass::get(c"CATapDescription")?;
        Some(TapApi {
            create: std::mem::transmute::<*mut c_void, ProcessTapCreate>(create),
            destroy: std::mem::transmute::<*mut c_void, ProcessTapDestroy>(destroy),
        })
    })
    .as_ref()
}

/// Приватный, но стабильный символ libsystem: кто «отвечает» за процесс. Для
/// XPC-сервисов WebKit это приложение, которое их породило. Им же пользуется
/// сама система, когда решает, у кого спрашивать TCC-разрешения.
fn responsible_pid(pid: i32) -> i32 {
    use std::sync::OnceLock;
    type Fun = unsafe extern "C" fn(i32) -> i32;
    static F: OnceLock<Option<Fun>> = OnceLock::new();
    let f = F.get_or_init(|| unsafe {
        let p = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_get_pid_responsible_for_pid".as_ptr(),
        );
        if p.is_null() {
            None
        } else {
            Some(std::mem::transmute::<*mut c_void, Fun>(p))
        }
    });
    match f {
        Some(f) => unsafe { f(pid) },
        None => -1,
    }
}

fn addr(sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: sel,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

unsafe fn get_u32(obj: AudioObjectID, sel: AudioObjectPropertySelector) -> Result<u32, i32> {
    let a = addr(sel);
    let mut v: u32 = 0;
    let mut size = 4u32;
    let st = AudioObjectGetPropertyData(
        obj,
        NonNull::from(&a),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::new(&mut v as *mut u32 as *mut c_void).unwrap(),
    );
    if st != 0 {
        return Err(st);
    }
    Ok(v)
}

unsafe fn get_string(obj: AudioObjectID, sel: AudioObjectPropertySelector) -> Result<String, i32> {
    let a = addr(sel);
    let mut ptr: *const NSString = std::ptr::null();
    let mut size = std::mem::size_of::<*const NSString>() as u32;
    let st = AudioObjectGetPropertyData(
        obj,
        NonNull::from(&a),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::new(&mut ptr as *mut _ as *mut c_void).unwrap(),
    );
    if st != 0 || ptr.is_null() {
        return Err(st);
    }
    // CFString приходит с +1 (Get...Data на CFTypeRef отдаёт владение).
    Ok(Retained::from_raw(ptr as *mut NSString)
        .map(|s| s.to_string())
        .unwrap_or_default())
}

/// Все процессы, которые зарегистрированы в аудио-HAL (включая те, что сейчас
/// молчат — объект живёт, пока жив процесс).
unsafe fn process_objects() -> Vec<AudioObjectID> {
    let a = addr(kAudioHardwarePropertyProcessObjectList);
    let mut size = 0u32;
    if AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject as u32,
        NonNull::from(&a),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
    ) != 0
    {
        return vec![];
    }
    let mut v: Vec<AudioObjectID> = vec![0; size as usize / 4];
    if v.is_empty() {
        return v;
    }
    let mut got = size;
    if AudioObjectGetPropertyData(
        kAudioObjectSystemObject as u32,
        NonNull::from(&a),
        0,
        std::ptr::null(),
        NonNull::from(&mut got),
        NonNull::new(v.as_mut_ptr() as *mut c_void).unwrap(),
    ) != 0
    {
        return vec![];
    }
    v.truncate(got as usize / 4);
    v
}

/// Объекты процессов, за которые отвечаем мы: сам void и все его XPC-дети
/// (WebKit GPU/WebContent/Networking — именно они играют голоса пиров).
///
/// Сравниваем не с собственным pid, а с КОРНЕМ ответственности: приложение,
/// запущенное через Launch Services (из Dock, Finder, по void://-ссылке),
/// отвечает за себя само — тогда корень это мы, и условие читается как «наш
/// responsible-процесс = мы». Но если void запустили из терминала или из-под
/// другого процесса, ответственность НАСЛЕДУЕТСЯ: у наших же WebKit-детей
/// responsible будет не void, а тот запускающий процесс, и фильтр «== getpid()»
/// их не увидит — голоса утекут в демку (ровно это и показал замер на
/// dev-сборке, запущенной из шелла: в исключениях оказался один void-desktop,
/// а 440 Гц из вебвью остался в тапе на −10 дБ).
unsafe fn own_process_objects() -> BTreeSet<AudioObjectID> {
    let me = std::process::id() as i32;
    let root = match responsible_pid(me) {
        r if r > 0 => r,
        _ => me,
    };
    process_objects()
        .into_iter()
        .filter(|&obj| {
            let Ok(pid) = get_u32(obj, kAudioProcessPropertyPID) else {
                return false;
            };
            let pid = pid as i32;
            pid == me || pid == root || responsible_pid(pid) == root
        })
        .collect()
}

fn ns(key: &CStr) -> Retained<NSString> {
    NSString::from_str(key.to_str().unwrap_or_default())
}

/// Кубическая интерполяция (Catmull-Rom) — ресемплинг частоты устройства к 48k.
/// Линейная на 44.1→48 даёт слышимые артефакты на музыке, полный sinc здесь
/// неоправдан: это не мастеринг, а поток, который дальше жмётся в Opus.
#[derive(Clone)]
struct Resampler {
    ratio: f64,
    pos: f64,
    h: [f32; 4],
}

impl Resampler {
    fn new(in_rate: f64) -> Self {
        Self {
            ratio: in_rate / TARGET_RATE,
            pos: 0.0,
            h: [0.0; 4],
        }
    }

    fn push(&mut self, s: f32, out: &mut Vec<i16>) {
        self.h = [self.h[1], self.h[2], self.h[3], s];
        while self.pos < 1.0 {
            let t = self.pos as f32;
            let (y0, y1, y2, y3) = (self.h[0], self.h[1], self.h[2], self.h[3]);
            let c0 = y1;
            let c1 = 0.5 * (y2 - y0);
            let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
            let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
            let v = ((c3 * t + c2) * t + c1) * t + c0;
            out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
            self.pos += self.ratio;
        }
        self.pos -= 1.0;
    }
}

/// Живая сессия захвата. Создаётся и рушится ЦЕЛИКОМ на потоке-контроллере:
/// id-шники объектов — просто u32, но блоки (RcBlock) не Send.
struct Session {
    tap: AudioObjectID,
    agg: AudioObjectID,
    io_proc: AudioDeviceIOProcID,
    _io_block: IoBlock,
    in_rate: f64,
    in_channels: usize,
    excluded: BTreeSet<AudioObjectID>,
    /// Устройство вывода, под которое собраны тап и aggregate. Сменился
    /// дефолтный выход (наушники вставили) — сессию надо пересобрать: у нового
    /// устройства своя частота, а clock device старого больше не тот.
    out_device: AudioObjectID,
}

impl Session {
    unsafe fn teardown(&self) {
        let _ = AudioDeviceStop(self.agg, self.io_proc);
        let _ = AudioDeviceDestroyIOProcID(self.agg, self.io_proc);
        let _ = AudioHardwareDestroyAggregateDevice(self.agg);
        if let Some(api) = tap_api() {
            let _ = (api.destroy)(self.tap);
        }
    }
}

type Ring = Arc<Mutex<Vec<f32>>>;

/// Блок IOProc: (now, input, input_time, output, output_time).
type IoBlock = RcBlock<
    dyn Fn(
        NonNull<AudioTimeStamp>,
        NonNull<AudioBufferList>,
        NonNull<AudioTimeStamp>,
        NonNull<AudioBufferList>,
        NonNull<AudioTimeStamp>,
    ),
>;

/// Собирает тап + aggregate device и запускает IOProc. `ring` наполняется
/// интерливленными float-кадрами в формате устройства.
unsafe fn build_session(ring: &Ring) -> Result<Session, String> {
    let api = tap_api().ok_or_else(|| "needs-macos-14-2".to_string())?;

    let excluded = own_process_objects();
    if std::env::var_os("VOID_SCREEN_AUDIO_LOG").is_some() {
        let pids: Vec<i32> = excluded
            .iter()
            .map(|&o| get_u32(o, kAudioProcessPropertyPID).map(|v| v as i32).unwrap_or(-1))
            .collect();
        eprintln!(
            "[screen_audio_mac] excluding objects {:?} pids {:?}",
            excluded, pids
        );
    }
    let nums: Vec<Retained<NSNumber>> = excluded.iter().map(|&o| NSNumber::new_u32(o)).collect();
    let exclude_list = NSArray::from_retained_slice(&nums);

    let desc = CATapDescription::initStereoGlobalTapButExcludeProcesses(
        CATapDescription::alloc(),
        &exclude_list,
    );
    desc.setName(&NSString::from_str("void screen audio"));
    desc.setPrivate(true);
    desc.setMuteBehavior(CATapMuteBehavior::Unmuted);

    let mut tap: AudioObjectID = 0;
    let st = (api.create)(Retained::as_ptr(&desc) as *const AnyObject, &mut tap);
    if st != 0 || tap == 0 {
        // На 14.2+ единственная реальная причина — отказ в «записи звука
        // системы» (TCC). Пробрасываем как отдельный код: JS покажет подсказку.
        return Err(format!("tap-denied:{st}"));
    }

    let guard = TapGuard(tap);

    let tap_uid = get_string(tap, kAudioTapPropertyUID).map_err(|e| format!("tap-uid:{e}"))?;
    let a = addr(kAudioTapPropertyFormat);
    let mut asbd: AudioStreamBasicDescription = std::mem::zeroed();
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    let st = AudioObjectGetPropertyData(
        tap,
        NonNull::from(&a),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::new(&mut asbd as *mut _ as *mut c_void).unwrap(),
    );
    if st != 0 {
        return Err(format!("tap-format:{st}"));
    }
    let in_rate = if asbd.mSampleRate > 0.0 {
        asbd.mSampleRate
    } else {
        TARGET_RATE
    };
    let in_channels = (asbd.mChannelsPerFrame as usize).clamp(1, 8);

    let out_dev = get_u32(
        kAudioObjectSystemObject as u32,
        kAudioHardwarePropertyDefaultOutputDevice,
    )
    .map_err(|e| format!("default-output:{e}"))?;
    let out_uid = get_string(out_dev, kAudioDevicePropertyDeviceUID)
        .map_err(|e| format!("output-uid:{e}"))?;

    let agg = create_aggregate(&tap_uid, &out_uid)?;
    let agg_guard = AggGuard(agg);

    let sink = ring.clone();
    let in_ch = in_channels;
    let io_block = RcBlock::new(
        move |_now: NonNull<AudioTimeStamp>,
              input: NonNull<AudioBufferList>,
              _input_time: NonNull<AudioTimeStamp>,
              _out: NonNull<AudioBufferList>,
              _out_time: NonNull<AudioTimeStamp>| {
            let bl = unsafe { input.as_ref() };
            if bl.mNumberBuffers == 0 {
                return;
            }
            // Список sub-device у aggregate пустой, поэтому единственный
            // входной буфер — это сам тап (интерливленный float32).
            let buf = &bl.mBuffers[0];
            if buf.mData.is_null() || buf.mDataByteSize == 0 {
                return;
            }
            let n = buf.mDataByteSize as usize / std::mem::size_of::<f32>();
            let src = unsafe { std::slice::from_raw_parts(buf.mData as *const f32, n) };
            if let Ok(mut g) = sink.lock() {
                if g.len() + n > RING_CAP {
                    // Насос встал — роняем старое, держим хвост.
                    let over = (g.len() + n).saturating_sub(RING_CAP);
                    let have = g.len();
                    let drop_to = ((over / in_ch) * in_ch).min(have); // не рвать кадр
                    g.drain(..drop_to);
                }
                g.extend_from_slice(src);
            }
        },
    );

    let mut io_proc: AudioDeviceIOProcID = None;
    let st = AudioDeviceCreateIOProcIDWithBlock(
        NonNull::from(&mut io_proc),
        agg,
        None,
        RcBlock::as_ptr(&io_block) as *mut _,
    );
    if st != 0 {
        return Err(format!("ioproc:{st}"));
    }
    let st = AudioDeviceStart(agg, io_proc);
    if st != 0 {
        let _ = AudioDeviceDestroyIOProcID(agg, io_proc);
        return Err(format!("device-start:{st}"));
    }

    std::mem::forget(guard);
    std::mem::forget(agg_guard);
    Ok(Session {
        tap,
        agg,
        io_proc,
        _io_block: io_block,
        in_rate,
        in_channels,
        excluded,
        out_device: out_dev,
    })
}

/// Приватный aggregate device, в котором ЕДИНСТВЕННЫЙ входной стрим — наш тап.
/// Поэтому clock device = дефолтный выход, а список sub-device пустой: если
/// положить выход в sub-device (рецепт Apple из AudioCap), то на интерфейсах с
/// входами (USB-карты) первым буфером в IOProc придут их входы, а не тап.
/// Фолбэк на рецепт с sub-device оставлен на случай, если HAL не примет
/// аудио-устройство в роли clock device.
unsafe fn create_aggregate(tap_uid: &str, out_uid: &str) -> Result<AudioObjectID, String> {
    let mut last = 0;
    for use_clock in [true, false] {
        let sub = NSDictionary::from_slices(
            &[&*ns(kAudioSubDeviceUIDKey)],
            &[&*NSString::from_str(out_uid) as &AnyObject],
        );
        let subtap = NSDictionary::from_slices(
            &[&*ns(kAudioSubTapUIDKey), &*ns(kAudioSubTapDriftCompensationKey)],
            &[
                &*NSString::from_str(tap_uid) as &AnyObject,
                &*NSNumber::new_bool(true) as &AnyObject,
            ],
        );
        let empty: Retained<NSArray<NSDictionary>> = NSArray::new();
        let one = NSArray::from_slice(&[&*sub]);
        let anchor_key = if use_clock {
            ns(kAudioAggregateDeviceClockDeviceKey)
        } else {
            ns(kAudioAggregateDeviceMainSubDeviceKey)
        };
        let uid = format!(
            "space.void-room.screen-audio.{}.{}",
            std::process::id(),
            if use_clock { "clk" } else { "sub" }
        );
        let composition = NSDictionary::from_slices(
            &[
                &*ns(kAudioAggregateDeviceNameKey),
                &*ns(kAudioAggregateDeviceUIDKey),
                &*anchor_key,
                &*ns(kAudioAggregateDeviceIsPrivateKey),
                &*ns(kAudioAggregateDeviceIsStackedKey),
                &*ns(kAudioAggregateDeviceTapAutoStartKey),
                &*ns(kAudioAggregateDeviceSubDeviceListKey),
                &*ns(kAudioAggregateDeviceTapListKey),
            ],
            &[
                &*NSString::from_str("void screen audio") as &AnyObject,
                &*NSString::from_str(&uid) as &AnyObject,
                &*NSString::from_str(out_uid) as &AnyObject,
                &*NSNumber::new_bool(true) as &AnyObject,
                &*NSNumber::new_bool(false) as &AnyObject,
                &*NSNumber::new_bool(true) as &AnyObject,
                if use_clock {
                    &*empty as &AnyObject
                } else {
                    &*one as &AnyObject
                },
                &*NSArray::from_slice(&[&*subtap]) as &AnyObject,
            ],
        );
        let cf = &*(Retained::as_ptr(&composition) as *const CFDictionary);
        let mut agg: AudioObjectID = 0;
        let st = AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut agg));
        if st == 0 && agg != 0 {
            return Ok(agg);
        }
        last = st;
    }
    Err(format!("aggregate:{last}"))
}

struct TapGuard(AudioObjectID);
impl Drop for TapGuard {
    fn drop(&mut self) {
        if let Some(api) = tap_api() {
            unsafe {
                let _ = (api.destroy)(self.0);
            }
        }
    }
}

struct AggGuard(AudioObjectID);
impl Drop for AggGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = AudioHardwareDestroyAggregateDevice(self.0);
        }
    }
}

struct CaptureHandle {
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

static CAPTURE: Mutex<Option<CaptureHandle>> = Mutex::new(None);

/// Сколько ждём результата сборки сессии. Долго не из-за самого Core Audio, а
/// из-за TCC: при ПЕРВОЙ демке система показывает запрос «запись звука
/// системы», и создание тапа висит, пока человек не ответит. Короткий таймаут
/// (как 5 с на Windows, где запроса нет) соврал бы «звука не будет» ровно в тот
/// момент, когда человек тянется к кнопке «разрешить».
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// Стартует захват и стримит PCM (16-bit/48k/stereo) в Channel. Идемпотентно.
/// Блокируется до результата сборки сессии (до START_TIMEOUT).
pub fn start(channel: Channel<InvokeResponseBody>) -> Result<(), String> {
    stop();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let done_flag = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop_flag.clone();
    let done_for_thread = done_flag.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    // Поток НЕ джойним: вызовы Core Audio (AudioDeviceStop в частности) умеют
    // висеть в mach_msg, пока HAL ждёт ответа на системный запрос доступа, а
    // join здесь — это зависший навсегда IPC-поток Tauri (поймано на замере).
    // Поэтому общаемся только флагами, а поток досматривает себя сам.
    std::thread::spawn(move || {
        controller(stop_for_thread, channel, ready_tx);
        done_for_thread.store(true, Ordering::SeqCst);
    });

    match ready_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(())) => {
            if let Ok(mut guard) = CAPTURE.lock() {
                *guard = Some(CaptureHandle {
                    stop: stop_flag,
                    done: done_flag,
                });
            }
            Ok(())
        }
        Ok(Err(e)) => {
            stop_flag.store(true, Ordering::SeqCst);
            Err(e)
        }
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            Err("screen audio start timed out".into())
        }
    }
}

/// Останавливает захват (если идёт). Ждём завершения потока, но не дольше
/// секунды: дальше поток догорает сам (см. комментарий в start про mach_msg).
pub fn stop() {
    let handle = CAPTURE.lock().ok().and_then(|mut g| g.take());
    if let Some(h) = handle {
        h.stop.store(true, Ordering::SeqCst);
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while !h.done.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Поток-контроллер: собирает сессию, качает кадры в JS, пересобирается на
/// смену набора «своих» процессов или устройства вывода.
fn controller(
    stop: Arc<AtomicBool>,
    channel: Channel<InvokeResponseBody>,
    ready_tx: mpsc::Sender<Result<(), String>>,
) {
    let ring: Ring = Arc::new(Mutex::new(Vec::with_capacity(RING_CAP / 4)));
    // Взведён СРАЗУ: объект процесса появляется в HAL не мгновенно, и наш же
    // WebKit-процесс может зарегистрироваться на пару сотен миллисекунд позже
    // старта тапа (а слушатель ставится уже после сборки сессии). Первая же
    // проверка через 300 мс пересчитает набор исключений и, если он изменился,
    // пересоберёт сессию — до этого в демку успеет попасть лишь мгновение
    // чужого звука.
    let dirty = Arc::new(AtomicBool::new(true));

    let mut session = match unsafe { build_session(&ring) } {
        Ok(s) => {
            let _ = ready_tx.send(Ok(()));
            s
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    let listeners = unsafe { install_listeners(dirty.clone()) };

    let mut resamplers = vec![Resampler::new(session.in_rate); TARGET_CHANNELS];
    let mut per_channel: Vec<Vec<i16>> =
        (0..TARGET_CHANNELS).map(|_| Vec::with_capacity(2048)).collect();
    let mut frames: Vec<f32> = Vec::with_capacity(RING_CAP / 4);
    let mut last_check = std::time::Instant::now();

    while !stop.load(Ordering::SeqCst) {
        // Забираем всё, что накопил IOProc, одним swap — критическая секция
        // короткая, аудио-поток не ждёт на нашем конвертере.
        frames.clear();
        if let Ok(mut g) = ring.lock() {
            std::mem::swap(&mut frames, &mut *g);
        }
        if !frames.is_empty() {
            let in_ch = session.in_channels;
            for buf in per_channel.iter_mut() {
                buf.clear();
            }
            for frame in frames.chunks_exact(in_ch) {
                for ch in 0..TARGET_CHANNELS {
                    // Моно-источник дублируем в оба канала.
                    let s = frame[ch.min(in_ch - 1)];
                    resamplers[ch].push(s, &mut per_channel[ch]);
                }
            }
            // Ресемплим каналы по отдельности, потом интерливим: при
            // ratio != 1 один входной кадр даёт то один, то два выходных, и
            // складывать их в общий буфер «по кругу» означало бы разъехавшиеся
            // L/R. Каналы идут с одинаковым ratio, так что длины совпадают;
            // min — страховка.
            let n = per_channel.iter().map(|b| b.len()).min().unwrap_or(0);
            if n > 0 {
                let mut bytes: Vec<u8> = Vec::with_capacity(n * TARGET_CHANNELS * 2);
                for i in 0..n {
                    for buf in per_channel.iter() {
                        bytes.extend_from_slice(&buf[i].to_le_bytes());
                    }
                }
                let _ = channel.send(InvokeResponseBody::Raw(bytes));
            }
        }

        // Пересборка — не чаще раза в 300 мс, чтобы пачка событий HAL
        // (процесс стартовал/умер) не дёргала тап много раз подряд.
        if dirty.load(Ordering::SeqCst) && last_check.elapsed() >= Duration::from_millis(300) {
            dirty.store(false, Ordering::SeqCst);
            last_check = std::time::Instant::now();
            let fresh = unsafe { own_process_objects() };
            let out_dev = unsafe {
                get_u32(
                    kAudioObjectSystemObject as u32,
                    kAudioHardwarePropertyDefaultOutputDevice,
                )
            }
            .unwrap_or(0);
            let device_changed = out_dev != 0 && out_dev != session.out_device;
            if fresh != session.excluded || device_changed {
                if std::env::var_os("VOID_SCREEN_AUDIO_LOG").is_some() {
                    eprintln!(
                        "[screen_audio_mac] rebuild: device_changed={device_changed} old={:?} new={fresh:?}",
                        session.excluded
                    );
                }
                unsafe { session.teardown() };
                if let Ok(mut g) = ring.lock() {
                    g.clear();
                }
                match unsafe { build_session(&ring) } {
                    Ok(s) => {
                        resamplers = vec![Resampler::new(s.in_rate); TARGET_CHANNELS];
                        session = s;
                    }
                    Err(e) => {
                        eprintln!("[screen_audio_mac] rebuild failed: {e}");
                        break;
                    }
                }
            }
        }

        std::thread::sleep(Duration::from_millis(8));
    }

    unsafe {
        remove_listeners(listeners);
        session.teardown();
        drop(session);
    }
}

type ListenerBlock = RcBlock<dyn Fn(u32, NonNull<AudioObjectPropertyAddress>)>;

unsafe fn install_listeners(dirty: Arc<AtomicBool>) -> Vec<(AudioObjectPropertySelector, ListenerBlock)> {
    let mut out = vec![];
    for sel in [
        kAudioHardwarePropertyProcessObjectList,
        kAudioHardwarePropertyDefaultOutputDevice,
    ] {
        let flag = dirty.clone();
        let block: ListenerBlock = RcBlock::new(
            move |_n: u32, _addrs: NonNull<AudioObjectPropertyAddress>| {
                flag.store(true, Ordering::SeqCst);
            },
        );
        let a = addr(sel);
        let st = AudioObjectAddPropertyListenerBlock(
            kAudioObjectSystemObject as u32,
            NonNull::from(&a),
            None,
            RcBlock::as_ptr(&block) as *mut _,
        );
        if st == 0 {
            out.push((sel, block));
        }
    }
    out
}

unsafe fn remove_listeners(listeners: Vec<(AudioObjectPropertySelector, ListenerBlock)>) {
    for (sel, block) in listeners {
        let a = addr(sel);
        let _ = AudioObjectRemovePropertyListenerBlock(
            kAudioObjectSystemObject as u32,
            NonNull::from(&a),
            None,
            RcBlock::as_ptr(&block) as *mut _,
        );
    }
}
