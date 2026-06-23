// Скрытие окна-индикатора захвата экрана.
//
// ПРОБЛЕМА:
//   На время getDisplayMedia WebView2/Chromium спавнит отдельное top-level окно
//   «<origin> предоставляет доступ к экрану/окну» — оно лезет отдельным
//   приложением в таскбар + рисует экранную плашку. Официального API подавить
//   это у WebView2 нет (WebView2Feedback#2442 висит «tracked» с 2022).
//
// ИДЕНТИФИКАЦИЯ (по данным enum top-level окон):
//   Окно-индикатор — top-level окно класса «Chrome_WidgetWin_1» в нашем дереве
//   процессов (живёт в дочернем msedgewebview2.exe). Внутри нашего дерева это
//   ЕДИНСТВЕННОЕ такое окно: главное окно — класс «Tauri Window», webview-виджет
//   — дочернее (WS_CHILD), single-instance — свой класс «{id}-sic». Окно ПИКЕРА
//   выбора источника под этот критерий НЕ подходит (рендерится иначе — в дампе
//   во время пикера top-level Chrome_WidgetWin_1 в дереве нет), поэтому хук
//   можно держать активным и во время пикера, не пряча его. Заголовок НЕ
//   используем — он локале/режимо-зависим («…к экрану/окну/звуку»).
//
// РЕШЕНИЕ:
//   1. Превентивно: хук ставится ДО getDisplayMedia (на «arming»), поэтому он
//      жив в момент создания окна-индикатора → ловим EVENT_OBJECT_CREATE/SHOW и
//      прячем ShowWindow(SW_HIDE) в том же тике цикла сообщений — до отрисовки,
//      без мелькания. Класс известен уже при создании (в отличие от заголовка).
//   2. Бэкстоп: короткий поллинг от старта захвата (вдруг хук пропустил окно).
//   SW_HIDE прячет и таскбар-кнопку, и плашку; захват НЕ прерывается (индикатор
//   чисто информационный — равнозначно клику «Скрыть»). Главное окно исключаем
//   по HWND. Фейл безопасен: в худшем случае индикатор останется, без крашей.

use std::collections::HashSet;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use windows::core::{Result, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClassNameW, GetWindowLongPtrW, GetWindowThreadProcessId,
    IsWindowVisible, ShowWindow, EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, GWL_STYLE, OBJID_WINDOW,
    SW_HIDE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WS_CHILD,
};

use crate::proc_tree::collect_process_tree;

/// Класс окна-индикатора захвата (Chromium top-level widget).
const INDICATOR_CLASS: &str = "Chrome_WidgetWin_1";

/// Контекст WinEvent-хука (дерево процессов + HWND главного окна), доступный
/// callback'у (он `extern "system"` и не может захватывать переменные).
struct HookCtx {
    tree: HashSet<u32>,
    main_hwnd: isize,
}
static HOOK_CTX: Mutex<Option<HookCtx>> = Mutex::new(None);
/// HWINEVENTHOOK как isize (0 = не установлен).
static HOOK_HANDLE: AtomicIsize = AtomicIsize::new(0);

struct ScanCtx {
    tree: HashSet<u32>,
    /// HWND главного окна — исключаем, чтобы случайно не спрятать его из таскбара.
    main_hwnd: isize,
    hidden: bool,
}

/// Ищет окно-индикатор захвата в нашем дереве процессов и прячет его (SW_HIDE).
/// Возвращает true, если найдено и спрятано. Бэкстоп к WinEvent-хуку.
pub fn hide_capture_indicator_for_our_tree(main_hwnd: isize) -> Result<bool> {
    let tree = unsafe { collect_process_tree(GetCurrentProcessId())? };
    let mut ctx = ScanCtx {
        tree,
        main_hwnd,
        hidden: false,
    };
    unsafe {
        // Ошибку EnumWindows глотаем (в т.ч. штатный обрыв по нашему FALSE).
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut _ as isize));
    }
    Ok(ctx.hidden)
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut ScanCtx);

    if hwnd.0 as isize == ctx.main_hwnd {
        return TRUE; // главное окно не трогаем
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || !ctx.tree.contains(&pid) {
        return TRUE;
    }
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    if !is_capture_indicator_window(hwnd) {
        return TRUE;
    }

    let _ = ShowWindow(hwnd, SW_HIDE);
    ctx.hidden = true;
    BOOL(0) // нашли — останавливаем перечисление
}

/// true, если это окно-индикатор захвата: top-level (не WS_CHILD) класса
/// Chrome_WidgetWin_1. Вызывающий уже проверил, что pid в нашем дереве и это не
/// главное окно — внутри дерева такое окно единственное (см. шапку модуля).
unsafe fn is_capture_indicator_window(hwnd: HWND) -> bool {
    // Дочерние окна (webview-виджет — тоже Chrome_WidgetWin_1, но WS_CHILD)
    // не трогаем, иначе сломаем рендеринг.
    if (GetWindowLongPtrW(hwnd, GWL_STYLE) & WS_CHILD.0 as isize) != 0 {
        return false;
    }
    let mut buf = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut buf);
    if len <= 0 {
        return false;
    }
    String::from_utf16_lossy(&buf[..len as usize]) == INDICATOR_CLASS
}

/// Ставит WinEvent-хук на появление окон, чтобы поймать окно-индикатор в момент
/// создания/показа и спрятать мгновенно (без мелькания). Идемпотентно.
///
/// ВАЖНО: вызывать с главного потока (у него цикл сообщений; OUTOFCONTEXT
/// доставляет callback именно туда). UnhookWinEvent — с того же потока.
pub fn install_indicator_hook(main_hwnd: isize) {
    let tree = unsafe { collect_process_tree(GetCurrentProcessId()) }.unwrap_or_default();
    if let Ok(mut g) = HOOK_CTX.lock() {
        *g = Some(HookCtx { tree, main_hwnd });
    }
    // Уже стоит — не плодим второй.
    if HOOK_HANDLE.load(Ordering::SeqCst) != 0 {
        return;
    }
    // SKIPOWNPROCESS: индикатор живёт в дочернем msedgewebview2.exe (другой PID),
    // поэтому не отфильтруется; зато не реагируем на показы наших же окон.
    let hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_SHOW,
            None,
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    HOOK_HANDLE.store(hook.0 as isize, Ordering::SeqCst);
}

/// Снимает WinEvent-хук (с главного потока). No-op если не стоял.
pub fn uninstall_indicator_hook() {
    let h = HOOK_HANDLE.swap(0, Ordering::SeqCst);
    if h != 0 {
        unsafe {
            let _ = UnhookWinEvent(HWINEVENTHOOK(h as *mut core::ffi::c_void));
        }
    }
    if let Ok(mut g) = HOOK_CTX.lock() {
        *g = None;
    }
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // Только событие самого окна (не дочерних accessibility-объектов).
    if id_object != OBJID_WINDOW.0 || id_child != 0 {
        return;
    }
    if event != EVENT_OBJECT_CREATE && event != EVENT_OBJECT_SHOW {
        return;
    }
    if hwnd.0.is_null() {
        return;
    }

    let Ok(mut guard) = HOOK_CTX.lock() else {
        return;
    };
    let Some(ctx) = guard.as_mut() else {
        return;
    };
    if hwnd.0 as isize == ctx.main_hwnd {
        return;
    }

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return;
    }
    if !ctx.tree.contains(&pid) {
        // Процесс мог появиться после установки хука — освежаем дерево один раз.
        match collect_process_tree(GetCurrentProcessId()) {
            Ok(t) if t.contains(&pid) => ctx.tree = t,
            _ => return,
        }
    }

    if is_capture_indicator_window(hwnd) {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

/// Прячет скрытое IPC-окно плагина single-instance.
///
/// Плагин создаёт окно с классом «{identifier}-sic» и заголовком
/// «{identifier}-siw» (см. tauri-plugin-single-instance/.../windows.rs). Оно
/// WS_VISIBLE (нужно ему для WM_PAINT) и потому всплывает отдельным пунктом
/// «space.void-room.app-siw» в нативном пикере getDisplayMedia. WM_COPYDATA
/// (по которому работает single-instance) доставляется и в невидимое окно →
/// прячем его SW_HIDE один раз на старте. Из пикера пропадает, single-instance
/// продолжает ловить повторные запуски и deep-link'и.
pub fn hide_single_instance_window(identifier: &str) {
    let class = encode_wide(&format!("{identifier}-sic"));
    let title = encode_wide(&format!("{identifier}-siw"));
    unsafe {
        if let Ok(hwnd) = FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr())) {
            if !hwnd.0.is_null() {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

fn encode_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
