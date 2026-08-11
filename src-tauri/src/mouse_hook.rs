/* ============ Глобальные хоткеи на кнопки мыши (Windows) ============
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ tauri-plugin-global-shortcut.
 * Плагин разбирает акселератор в `keyboard-types::Code` — в этом enum НЕТ ни
 * одного мышиного варианта (проверено по исходнику крейта). Мышь через него
 * зарегистрировать нельзя в принципе, поэтому здесь свой низкоуровневый хук.
 *
 * Биндится: средняя кнопка, две боковые (X1/X2) и колесо. Левая и правая
 * НЕ поддерживаются намеренно — мьют на левый клик делает машину неюзабельной.
 *
 * ТРИ ИНВАРИАНТА, КОТОРЫЕ ЛЕГКО СЛОМАТЬ ПРИ ПРАВКАХ:
 *
 * 1. Событие ВСЕГДА уходит дальше по цепочке (`CallNextHookEx`). Хук ничего не
 *    съедает: иначе бинд мьюта на среднюю кнопку сломал бы её во всех остальных
 *    программах. Так же ведёт себя Discord.
 * 2. Колбэк обязан отрабатывать за микросекунды. Пока он выполняется, ВЕСЬ ввод
 *    мыши в системе стоит, а Windows молча снимает хуки, вылезшие за
 *    `LowLevelHooksTimeout`. Поэтому: сначала дешёвый фильтр по типу сообщения
 *    (движения мыши отсеиваются первой же проверкой, не трогая блокировки),
 *    дальше `try_lock` вместо `lock` — потерять нажатие хоткея не страшно,
 *    заморозить мышь пользователю страшно. Ни IPC, ни emit внутри колбэка нет:
 *    действие уходит в канал, а разбирает его отдельный поток.
 * 3. Хук живёт на СОБСТВЕННОМ потоке с циклом сообщений. `WH_MOUSE_LL` дёргается
 *    на каждое движение мыши; вешать это на UI-поток — готовый источник
 *    подлагиваний интерфейса.
 */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, MSG,
    MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_XBUTTONDOWN, XBUTTON1, XBUTTON2,
};

/// Что именно нажали. Левая/правая сюда не попадают by design (см. шапку).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Middle,
    X1,
    X2,
    WheelUp,
    WheelDown,
}

/// Битовая маска модификаторов — в том же порядке, что и в акселераторе.
const MOD_CTRL: u8 = 1;
const MOD_SHIFT: u8 = 2;
const MOD_ALT: u8 = 4;
const MOD_SUPER: u8 = 8;

pub struct Binding {
    trigger: Trigger,
    mods: u8,
    action: String,
}

/// Разобрать акселератор вида `Ctrl+Mouse4`. Возвращает None для всего, что не
/// является мышиным биндом, — по этому же признаку lib.rs отделяет мышь от
/// клавиатуры, так что функция обязана быть строгой.
pub fn parse_binding(accel: &str, action: &str) -> Option<Binding> {
    let mut mods = 0u8;
    let mut trigger = None;

    for part in accel.split('+') {
        match part.trim() {
            "Ctrl" | "Control" => mods |= MOD_CTRL,
            "Shift" => mods |= MOD_SHIFT,
            "Alt" => mods |= MOD_ALT,
            "Super" | "Meta" | "Win" => mods |= MOD_SUPER,
            "Mouse3" => trigger = Some(Trigger::Middle),
            "Mouse4" => trigger = Some(Trigger::X1),
            "Mouse5" => trigger = Some(Trigger::X2),
            "WheelUp" => trigger = Some(Trigger::WheelUp),
            "WheelDown" => trigger = Some(Trigger::WheelDown),
            // Любая клавиатурная часть — значит это не наш бинд.
            _ => return None,
        }
    }

    trigger.map(|trigger| Binding {
        trigger,
        mods,
        action: action.to_string(),
    })
}

/// Есть ли в строке мышиный триггер. Дешёвая проверка для разделения биндингов.
pub fn is_mouse_accel(accel: &str) -> bool {
    accel.split('+').any(|p| {
        matches!(
            p.trim(),
            "Mouse3" | "Mouse4" | "Mouse5" | "WheelUp" | "WheelDown"
        )
    })
}

static BINDINGS: Mutex<Vec<Binding>> = Mutex::new(Vec::new());
static ACTION_TX: Mutex<Option<Sender<String>>> = Mutex::new(None);
/// Хук уже поднят. Ставится через compare_exchange, чтобы два одновременных
/// сохранения настроек не установили два хука (действие сработало бы дважды).
static STARTED: AtomicBool = AtomicBool::new(false);

/// Установить набор биндов; хук поднимается лениво — при первом мышином бинде.
///
/// Снятия хука здесь НЕТ, и это осознанно. Пара stop→start даёт гонку: поток
/// ещё разбирает старый хук, а новый уже ставится — можно получить два живых
/// хука (действие сработает дважды) либо затёртый id потока, который потом не
/// погасить. Цена ошибки в этом коде — замороженная мышь во всей системе, так
/// что берём вариант без гонок: пустой список биндов делает колбэк no-op'ом
/// (первая же проверка не находит совпадения), а сам хук доживает до выхода из
/// приложения, где его снимет система. Выключенные хоткеи при этом реально не
/// срабатывают — а именно это и требуется.
pub fn apply<F>(bindings: Vec<Binding>, on_action: F)
where
    F: Fn(&str) + Send + 'static,
{
    let empty = bindings.is_empty();

    if let Ok(mut guard) = BINDINGS.lock() {
        *guard = bindings;
    }

    if !empty {
        start(on_action);
    }
}

/// Идемпотентно: повторный вызов при уже живом хуке ничего не делает.
fn start<F>(on_action: F)
where
    F: Fn(&str) + Send + 'static,
{
    if STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let (tx, rx) = channel::<String>();
    if let Ok(mut guard) = ACTION_TX.lock() {
        *guard = Some(tx);
    }

    /* Поток-диспетчер: сюда приходят уже разобранные действия. Всё «тяжёлое»
       (emit в webview, переключение окна) происходит здесь, а не в колбэке. */
    std::thread::spawn(move || {
        while let Ok(action) = rx.recv() {
            on_action(&action);
        }
    });

    /* Поток хука: ставит хук и крутит цикл сообщений. Без цикла WH_MOUSE_LL
       молчит — система доставляет события хука через очередь сообщений потока,
       который его установил. Поток живёт до конца процесса (см. apply). */
    std::thread::spawn(|| unsafe {
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(_) => {
                STARTED.store(false, Ordering::SeqCst); // дать шанс повторной попытке
                return;
            }
        };

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}

        let _ = UnhookWindowsHookEx(hook);
        STARTED.store(false, Ordering::SeqCst);
    });
}

/// Состояние модификаторов В МОМЕНТ нажатия.
///
/// Именно `GetAsyncKeyState`, а не `GetKeyState`: второй отдаёт состояние из
/// очереди сообщений ВЫЗЫВАЮЩЕГО потока, а наш поток пользовательский ввод не
/// обрабатывает и видел бы всегда «ничего не нажато».
fn current_mods() -> u8 {
    let down = |vk: u16| unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 };
    let mut m = 0u8;
    if down(VK_CONTROL.0) {
        m |= MOD_CTRL;
    }
    if down(VK_SHIFT.0) {
        m |= MOD_SHIFT;
    }
    if down(VK_MENU.0) {
        m |= MOD_ALT;
    }
    if down(VK_LWIN.0) || down(VK_RWIN.0) {
        m |= MOD_SUPER;
    }
    m
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    /* Порядок проверок = порядок дешевизны. Движения мыши (их подавляющее
       большинство) отсеиваются здесь и до блокировок не доходят. */
    if code == HC_ACTION as i32 {
        if let Some(trigger) = trigger_from(wparam.0 as u32, lparam) {
            dispatch(trigger);
        }
    }
    // ВСЕГДА пропускаем событие дальше — хук ничего не съедает (см. шапку).
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe fn trigger_from(message: u32, lparam: LPARAM) -> Option<Trigger> {
    match message {
        WM_MBUTTONDOWN => Some(Trigger::Middle),
        WM_XBUTTONDOWN => {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            // Какая из боковых нажата — в старшем слове mouseData.
            match (info.mouseData >> 16) as u16 {
                XBUTTON1 => Some(Trigger::X1),
                XBUTTON2 => Some(Trigger::X2),
                _ => None,
            }
        }
        WM_MOUSEWHEEL => {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            // Дельта — знаковое старшее слово: вверх «от себя» положительна.
            let delta = ((info.mouseData >> 16) as u16) as i16;
            if delta > 0 {
                Some(Trigger::WheelUp)
            } else if delta < 0 {
                Some(Trigger::WheelDown)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn dispatch(trigger: Trigger) {
    let mods = current_mods();

    /* try_lock, а не lock: блокировка занята только в момент перерегистрации
       биндов (доли миллисекунды, происходит при сохранении настроек). Ждать её
       внутри хука нельзя — это заморозило бы мышь во всей системе. Потерять
       одно нажатие в этот момент — приемлемая цена. */
    let Ok(binds) = BINDINGS.try_lock() else {
        return;
    };
    let Some(found) = binds
        .iter()
        .find(|b| b.trigger == trigger && b.mods == mods)
    else {
        return;
    };
    let action = found.action.clone();
    drop(binds);

    if let Ok(guard) = ACTION_TX.try_lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(action);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Разбор акселератора — то место, где ошибка тихо ломает всю фичу: бинд
       сохранится в настройках, но никогда не сработает. Клавиатурный путь
       ломать тоже нельзя — is_mouse_accel решает, кому достанется бинд. */

    #[test]
    fn keyboard_accels_are_not_mouse() {
        for accel in ["Ctrl+M", "Alt+F4", "F7", "Ctrl+Shift+Space", ""] {
            assert!(!is_mouse_accel(accel), "клавиатурный бинд ушёл в мышь: {accel}");
            assert!(parse_binding(accel, "toggleMic").is_none());
        }
    }

    #[test]
    fn mouse_accels_are_detected() {
        for accel in ["Mouse3", "Mouse4", "Mouse5", "Ctrl+WheelUp", "Alt+Mouse5"] {
            assert!(is_mouse_accel(accel), "мышиный бинд не опознан: {accel}");
            assert!(parse_binding(accel, "toggleMic").is_some());
        }
    }

    #[test]
    fn triggers_and_mods_parse() {
        let b = parse_binding("Mouse4", "toggleMic").unwrap();
        assert_eq!(b.trigger, Trigger::X1);
        assert_eq!(b.mods, 0);
        assert_eq!(b.action, "toggleMic");

        let b = parse_binding("Ctrl+Shift+Mouse3", "leaveRoom").unwrap();
        assert_eq!(b.trigger, Trigger::Middle);
        assert_eq!(b.mods, MOD_CTRL | MOD_SHIFT);

        assert_eq!(
            parse_binding("Alt+WheelDown", "toggleSound").unwrap().trigger,
            Trigger::WheelDown
        );
        assert_eq!(
            parse_binding("Super+Mouse5", "toggleWindow").unwrap().mods,
            MOD_SUPER
        );
    }

    #[test]
    fn garbage_is_rejected() {
        // Модификатор без кнопки — не бинд.
        assert!(parse_binding("Ctrl", "toggleMic").is_none());
        // Смесь клавиатуры и мыши: is_mouse_accel скажет «мышь», а parse обязан
        // отказать — иначе бинд повис бы между двумя путями и не работал нигде.
        assert!(parse_binding("Ctrl+M+Mouse4", "toggleMic").is_none());
        assert!(parse_binding("Mouse1", "toggleMic").is_none()); // левая не биндится
        assert!(parse_binding("Mouse2", "toggleMic").is_none()); // правая тоже
    }
}
