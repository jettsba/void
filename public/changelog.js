/* ============ CHANGELOG — история изменений void ============
   Единственный файл с заметками к релизам. Читают его:
     - js/changelog.js — окно «история изменений» (клик по пилюле версии
       в футере настроек; ссылка внизу окна «что нового»);
     - js/desktop/whats-new.js — баннер «void обновлён» + окно «что нового»
       после авто-обновления desktop-приложения: берёт запись, у которой
       `version` совпадает с версией запущенного приложения.

   На выкатке: новая запись — В НАЧАЛО массива. Микрофикс, о котором нечего
   сказать, — записи не добавляем: тогда нет ни баннера, ни строки в истории.

   Правила записи:
   - `version` — ровно версия релиза ("1.12.0"). У старых сводок по минорам
     (до 1.0) — "0.12": одна запись на всю ветку.
   - `date` — YYYY-MM-DD, дата выкатки.
   - Строка = пункт. Нижним регистром, без точки в конце (голос интерфейса —
     rules/VOID_STYLE_GUIDE.md).
   - Подпункт — строка, начинающаяся с «- » (обычный минус с пробелом). Она
     раскрывает ближайший обычный пункт выше и рисуется под ним веткой, бледнее.
     Подпунктов у одного пункта может быть несколько.
   - `ru` обязателен, `en` желателен: если списка на языке интерфейса нет —
     покажем русский.
   - npm test проверяет: версии уникальны, идут от новой к старой и не выше
     текущей, у каждой записи есть дата и непустой `ru`.

   Предпросмотр баннера до выкатки: `VoidWhatsNewPreview("1.12.0")` в консоли. */

window.VoidChangelog = [
    {
        version: "1.12.0",
        date: "2026-11-23",
        ru: [
            "появилась история изменений: открывается при нажатии на версию настройках",
            "- там все обновления void, начиная с первой версии"
        ],
        en: [
            "a changelog is here: click the version at the bottom of settings",
            "- every void update, from the first version to this one"
        ],
    },
    {
        version: "1.11.0",
        date: "2026-11-23",
        ru: [
            "добавлена полноценная синхронизация данных между устройствами",
            "в профиле добавлен список связанных устройств",
            "перенос на другое устройство теперь забирает и настройки: ник, язык, тему, звуки",
            "полностью переработан интерфейс на телефоне",
            "код комнаты вводится в любой раскладке",
            "кнопка входа в комнату стала стрелкой",
            "громкость звуков приложения сохраняется после перезапуска",
            "удалённые друзья больше не возвращаются после переноса",
        ],
        en: [
            "full data sync between your devices",
            "your profile now lists your linked devices",
            "moving to another device now brings your settings too: nick, language, theme, sounds",
            "the phone interface was fully reworked",
            "the room code can be typed in any keyboard layout",
            "the join button is now an arrow",
            "app sound volume is kept after a restart",
            "removed friends no longer come back after a device move",
        ],
    },
    {
        version: "1.10.0",
        date: "2026-11-22",
        ru: [
            "теперь в void есть друзья. добавляй людей из комнаты, по qr, ссылке или по нику",
            "- все по-прежнему приватно: void ничего не знает о твоих друзьях. список хранится только на твоем устройстве, у каждой дружбы свой секретный ключ",
            "- видно, кто из друзей онлайн и в какой он комнате, зайти к нему можно в один клик",
            "режим невидимки и перенос списка друзей на другое устройство через qr",
            "профиль человека открывается двойным кликом по нему в комнате",
            "обновлён внешний вид: окна, кнопки, отступы и анимации приведены к одному стилю",
            "у кода комнаты появилась кнопка копирования",
            "длинные уведомления на телефоне больше не обрезаются",
        ],
        en: [
            "void now has friends. add people from a room, by qr, by link or by a nick#0000 code",
            "- still private: void knows nothing about your friends. the list lives only on your device, every friendship has its own key",
            "- see which friends are online and in which room, and join them in one click",
            "invisible mode and moving your friends list to another device via qr",
            "double-click someone in a room to open their profile",
            "refreshed look: windows, buttons, spacing and animations now share one style",
            "the room code got a copy button",
            "long notifications on phones no longer get cut off",
        ],
    },
    {
        version: "1.9.4",
        date: "2026-11-14",
        ru: [
            "демонстрация экрана теперь занимает окно целиком, вместе с верхней полосой",
            "исправлен внешний вид клавиатуры в настройках для macos",
            "- кнопка win на windows-раскладке теперь отображается логотипом",
            "кнопки play/pause на клавиатуре больше не проигрывают звук входа в комнату",
            "переключатели в настройках снова выглядят как переключатели",
        ],
        en: [
            "screen share now fills the whole window, top strip included",
            "the hotkeys keyboard on mac now looks like a real mac keyboard",
            "- the win key on the windows layout now shows the logo",
            "keyboard play/pause keys no longer play the room join sound",
            "toggles in settings look like toggles again",
        ],
    },
    {
        version: "1.9.3",
        date: "2026-11-13",
        ru: [
            "на маке демонстрация экрана теперь идет со звуком",
            "- в демку попадает звук системы, но не голоса собеседников",
            "- при первой демонстрации macos спросит доступ к записи звука системы",
            "иконка вкладки в safari — светящееся кольцо без фона",
        ],
        en: [
            "on mac, screen share now has sound",
            "- system audio goes into the demo, the voices of other people do not",
            "- on the first share macos will ask for system audio recording access",
            "tab icon in safari — a glowing ring with no background",
        ],
    },
    {
        version: "1.9.2",
        date: "2026-11-11",
        ru: [
            "если прямое соединение с собеседником начинает сбоить, звонок сам переходит на резервный канал",
            "звонок больше не рвется, когда у собеседника на секунду пропадает интернет",
            "демонстрация экрана показывает картинку сразу, без черного экрана в первые секунды",
            "кнопка демонстрации сразу открывает выбор экрана, без промежуточного окна",
        ],
        en: [
            "when the direct connection to a peer starts failing, the call switches to a backup route on its own",
            "calls no longer drop when a peer loses internet for a second",
            "screen share shows the picture right away, no black screen in the first seconds",
            "the screen share button opens the screen picker right away, no extra dialog",
        ],
    },
    {
        version: "1.9.1",
        date: "2026-11-02",
        ru: [
            "демонстрация экрана плавнее на компьютерах без аппаратного кодирования видео",
            "меньше подтормаживаний у зрителя при резкой смене картинки",
        ],
        en: [
            "smoother screen sharing on computers without hardware video encoding",
            "fewer stutters for viewers on sudden full-screen changes, like switching desktops",
        ],
    },
    {
        version: "1.9.0",
        date: "2026-11-01",
        ru: [
            "демонстрация экрана стала плавнее",
            "качество демонстрации подстраивается само — выбирать разрешение и частоту кадров больше не нужно",
            "статус-бар не врет, если с кем-то из комнаты не удалось соединиться",
        ],
        en: [
            "screen sharing is smoother now",
            "screen share quality adjusts by itself — no need to pick resolution and frame rate anymore",
            "the status bar no longer says «connected» when someone in the room can't be reached",
        ],
    },
    {
        version: "1.8.0",
        date: "2026-10-30",
        ru: [
            "void теперь доступен на macos — скачать можно на void-room.space",
            "снова сохраняются файлы и картинки из чата",
            "прикреплённый файл можно отправить по enter",
            "программы в чате помечены значком, пояснение — при наведении",
            "регуляторы громкости на тачпаде крутятся быстрее",
            "мелкие правки интерфейса",
        ],
        en: [
            "void is now available on macos — get it at void-room.space",
            "saving files and images from the chat works again",
            "an attached file can now be sent with enter",
            "programs in the chat are marked with an icon, hover it for details",
            "volume sliders move faster on a touchpad",
            "small interface fixes",
        ],
    },
    {
        version: "1.7.0",
        date: "2026-10-25",
        ru: [
            "большое техническое обновление: void стал ещё безопаснее",
            "закрытую комнату больше нельзя занять или открыть снаружи — в том числе пока сервер обновляется",
            "- свои возвращаются после обрыва связи и обновления сервера сами, разговор не прерывается",
            "вход по ссылке теперь всегда спрашивает подтверждение",
            "код безопасности больше нельзя «заморозить»: если он долго не сходится, появится предупреждение",
            "чат защищён от флуда и от подмены чужих картинок и файлов",
            "программы, присланные в чат, помечаются и сохраняются только повторным нажатием",
            "- сохранённые файлы из чата windows теперь считает скачанными из интернета и предупредит перед запуском",
            "двойное нажатие на «создать» или «войти» больше не выкидывает из комнаты",
        ],
        en: [
            "a big technical update: void is now even more secure",
            "a closed room can no longer be taken over or opened from outside — not even while the server updates",
            "- your people get back in on their own after a dropped connection or a server update, the call keeps going",
            "joining through a link now always asks for confirmation",
            "the security code can no longer be \"frozen\": if it takes too long to match, you'll see a warning",
            "the chat is protected from flooding and from someone swapping other people's images and files",
            "programs sent in the chat are marked and only saved on a second click",
            "- windows now treats files saved from the chat as downloaded from the internet and warns before running them",
            "double-clicking create or join no longer kicks you out of the room",
        ],
    },
    {
        version: "1.6.0",
        date: "2026-10-11",
        ru: [
            "добавлен код безопасности звонка: разговор защищен, если символы у всех совпадают",
            "- символы в панели связи внизу, нажми на них, чтобы узнать подробнее",
            "вход в комнату можно закрыть, когда согласятся все участники",
            "- свои вернутся даже после обрыва связи или перезапуска приложения",
            "шумоподавление бережнее к тихому голосу",
            "приложение теперь загружается быстрее",
        ],
        en: [
            "call security code added: if everyone sees the same symbols, the call is secure",
            "- the symbols live in the connection panel below, tap them to learn more",
            "a room can now be closed to newcomers once everyone agrees",
            "- your people still get back in after a dropped connection or an app restart",
            "noise suppression is gentler with quiet voices",
            "the app loads faster",
        ],
    },
    {
        version: "1.5.0",
        date: "2026-09-17",
        ru: [
            "гифки в чате теперь воспроизводятся",
            "голоса собеседников больше не хрипят, когда у тебя выключен микрофон",
            "стабильнее связь в больших комнатах",
            "- свёрнутое окно или заблокированный телефон у кого-то из участников больше не рвут соединение",
            "участники ровнее располагаются на экране, особенно на телефоне",
            "из поля ввода в чате пропали лишние полосы прокрутки",
        ],
        en: [
            "gifs in the chat now play",
            "other people's voices no longer crackle while your mic is off",
            "steadier connection in big rooms",
            "- a minimized window or a locked phone no longer drops anyone's connection",
            "participants are laid out more evenly, especially on phones",
            "no more stray scrollbars in the chat input",
        ],
    },
    {
        version: "1.4.0",
        date: "2026-09-03",
        ru: [
            "звонок теперь подключается в сетях, где раньше не соединялся",
            "- появился запасной путь на случай, если провайдер режет основной",
            "в многолюдных комнатах связь устанавливается надёжнее",
            "первый собеседник больше не остаётся без резервного канала связи",
        ],
        en: [
            "calls now connect on networks where they used to fail",
            "- a fallback route was added in case the provider blocks the main one",
            "connections hold up better in crowded rooms",
            "the first person you connect to no longer ends up without a fallback route",
        ],
    },
    {
        version: "1.3.0",
        date: "2026-09-02",
        ru: [
            "зажатая горячая клавиша больше не переключает состояние без остановки",
            "звук старта и остановки демонстрации больше не двоится",
            "если выбранный микрофон пропал, берётся системный вместо ошибки «нет доступа»",
            "фон пересчитывается при переносе окна между экранами разной плотности",
            "ambient-фон замирает, когда в системе включено «уменьшение движения»",
            "шестерёнка в логотипе больше не залипает после закрытия настроек",
            "большое количество изменений для поддержки macOS в веб-версии",
            "- масштаб на retina, отрисовка шрифта, демонстрация экрана, горячие клавиши, громкость колесом и прочее",
        ],
        en: [
            "holding a hotkey no longer toggles it over and over",
            "screen share start and stop sounds no longer play twice",
            "if the selected mic is gone, the system one is used instead of a no-access error",
            "the background is recalculated when the window moves between displays of different density",
            "the ambient background freezes when the system asks for reduced motion",
            "the gear icon no longer sticks after the settings panel closes",
            "a big pass on macOS support in the web version",
            "- ui scale on retina, type rendering, screen sharing, hotkeys, volume by wheel and more",
        ],
    },
    {
        version: "1.2.0",
        date: "2026-09-01",
        ru: [
            "переработана отрисовка фона: убраны полосы и ступени на градиентах",
            "- он также стал легче и меньше нагружает видеокарту",
            "демонстрация экрана больше не мылит картинку на retina-экранах",
            "на macOS в настройках теперь отображается маковская клавиатура",
        ],
        en: [
            "the ambient background was rebuilt: no more bands and steps on gradients",
            "- it also got lighter on the GPU than before",
            "screen sharing no longer looks blurry on retina displays",
            "on macOS the settings now show a mac keyboard layout",
        ],
    },
    {
        version: "1.1.1",
        date: "2026-08-24",
        ru: [
            "горячие клавиши теперь выключены по умолчанию: включить можно в настройках",
            "на тильду (~) теперь можно назначить бинд без ctrl и shift",
            "карта клавиатуры в настройках стала полной — с цифрами, F-рядом, стрелками и мышью",
            "появилась кнопка «восстановить» — для возврата комбинаций по умолчанию",
        ],
        en: [
            "hotkeys are now off by default: turn them on in settings",
            "the tilde key (~) can be bound on its own, without ctrl or shift",
            "the keyboard map in settings is now complete — numbers, F-row, arrows and a mouse",
            "added a «restore» button to bring back the default bindings",
        ],
    },
    {
        version: "1.1.0",
        date: "2026-08-13",
        ru: [
            "обновления сервиса больше не прерывают разговор",
            "после обновления показывается баннер со списком изменений",
            "аватар больше не схлопывается при демонстрации экрана",
            "участник плавно гаснет при выходе из комнаты",
        ],
        en: [
            "service updates no longer interrupt your call",
            "now shows a banner with a list of changes after an update",
            "the avatar no longer collapses when you go quiet during a screen share",
            "participants fade out smoothly when they leave the room",
        ],
    },
    {
        version: "1.0.0",
        date: "2026-08-11",
        ru: [
            "релиз 1.0",
            "- соединение стало стабильнее в сложных сетях",
            "- горячие клавиши можно повесить на кнопки мыши",
            "- много визуальных правок",
        ],
        en: [
            "release 1.0",
            "- steadier connections on tricky networks",
            "- hotkeys can be bound to mouse buttons",
            "- lots of visual fixes",
        ],
    },
    {
        version: "0.16",
        date: "2026-07-14",
        ru: [
            "в комнату теперь помещается до 10 человек",
            "- новая раскладка участников на экране",
            "качество демонстрации подстраивается под число зрителей",
        ],
        en: [
            "rooms now fit up to 10 people",
            "- a new layout for participants on screen",
            "screen share quality adapts to the number of viewers",
        ],
    },
    {
        version: "0.15",
        date: "2026-07-03",
        ru: [
            "громкость звуков приложения настраивается в настройках",
            "проверка микрофона и динамиков переработана",
            "у демонстрации появился свой регулятор громкости",
            "- панель управления демонстрацией прячется сама",
            "в чате появился дизлайк",
            "исправлены ссылки, скачивание и перетаскивание файлов в чате",
            "в микшере windows приложение теперь называется void",
        ],
        en: [
            "app sound volume can be set in settings",
            "mic and speaker tests were reworked",
            "screen share got its own volume control",
            "- the screen share controls hide on their own",
            "the chat got a dislike reaction",
            "fixed links, downloads and drag-and-drop of files in the chat",
            "the app is now called void in the windows volume mixer",
        ],
    },
    {
        version: "0.14",
        date: "2026-07-01",
        ru: [
            "у сообщений в чате появилось меню: копировать, сохранить, открыть ссылку, лайкнуть",
        ],
        en: [
            "chat messages got a menu: copy, save, open link, like",
        ],
    },
    {
        version: "0.13",
        date: "2026-06-30",
        ru: [
            "новые звуки интерфейса: микрофон, звук, демонстрация, сообщения",
        ],
        en: [
            "new interface sounds: mic, sound, screen share, messages",
        ],
    },
    {
        version: "0.12",
        date: "2026-06-26",
        ru: [
            "настройки переделаны и разложены по категориям",
            "у приложения своё меню в трее",
            "демонстрация экрана в приложении",
            "- аппаратное кодирование видео: меньше нагрузка, плавнее картинка",
            "- звук демки без голосов собеседников",
            "- смотреть демонстрацию можно на весь экран",
            "интерфейс приложения больше не раздувается на 2k и 4k мониторах",
            "кнопка «проверить обновления» в настройках",
            "при запуске больше нет белой вспышки",
        ],
        en: [
            "settings were redesigned and split into categories",
            "the app has its own tray menu",
            "screen sharing in the app",
            "- hardware video encoding: less load, smoother picture",
            "- demo sound without the other people's voices",
            "- shared screens can be watched full screen",
            "the app interface no longer looks oversized on 2k and 4k monitors",
            "a «check for updates» button in settings",
            "no more white flash on launch",
        ],
    },
    {
        version: "0.11",
        date: "2026-06-17",
        ru: [
            "свой установщик и деинсталлятор в стиле void",
            "в трее можно скопировать код и ссылку комнаты",
            "ссылки-приглашения открываются сразу в приложении",
        ],
        en: [
            "a custom installer and uninstaller in the void style",
            "the tray can copy the room code and link",
            "invite links open straight in the app",
        ],
    },
    {
        version: "0.10",
        date: "2026-06-04",
        ru: [
            "появилось приложение void для windows",
            "- сворачивается в трей",
            "- глобальные горячие клавиши",
            "- обновляется само",
            "интерфейс подстраивается под любой экран",
            "- масштаб можно поменять в настройках",
            "шумоподавление всегда включено",
            "звук демонстрации стал стерео и чище",
            "вышедшие участники больше не зависают в комнате призраками",
        ],
        en: [
            "the void app for windows is out",
            "- hides to the tray",
            "- global hotkeys",
            "- updates itself",
            "the interface adapts to any screen",
            "- the scale can be changed in settings",
            "noise suppression is always on",
            "screen share audio is now stereo and cleaner",
            "people who left no longer hang in the room as ghosts",
        ],
    },
    {
        version: "0.9",
        date: "2026-05-26",
        ru: [
            "темы фона на выбор: тишина, туманность, сетка",
            "клик по коду комнаты: скопировать код или ссылку",
            "- по ссылке заходишь в комнату сразу",
            "реакции сердечками в чате",
            "на iphone и android звук и ввод кода работают как надо",
            "звук демонстрации без искажений",
            "после обрыва сети звонок снова переподключается сам",
        ],
        en: [
            "background themes to choose from: silence, nebula, grid",
            "click the room code to copy the code or a link",
            "- the link takes you straight into the room",
            "heart reactions in the chat",
            "sound and code entry work properly on iphone and android",
            "screen share audio without distortion",
            "the call reconnects on its own after a network drop again",
        ],
    },
    {
        version: "0.8",
        date: "2026-05-19",
        ru: [
            "добавлен резервный сервер связи для сетей, где прямое соединение не проходит",
        ],
        en: [
            "a backup relay server for networks where a direct connection can't get through",
        ],
    },
    {
        version: "0.5",
        date: "2026-05-16",
        ru: [
            "кнопка «сообщить о баге» в настройках",
            "полосы прокрутки в стиле void",
        ],
        en: [
            "a «report a bug» button in settings",
            "scrollbars in the void style",
        ],
    },
    {
        version: "0.4",
        date: "2026-05-15",
        ru: [
            "реакции в чате",
            "смена ника видна всем сразу",
            "звук демонстрации без эха и двойного воспроизведения",
            "звонок надёжнее восстанавливается после сбоев",
            "всё работает быстрее",
        ],
        en: [
            "chat reactions",
            "nick changes show up for everyone right away",
            "screen share audio without echo or double playback",
            "calls recover more reliably after glitches",
            "everything runs faster",
        ],
    },
    {
        version: "0.3",
        date: "2026-05-14",
        ru: [
            "выбор микрофона и динамиков",
            "регуляторы громкости в настройках",
        ],
        en: [
            "mic and speaker selection",
            "volume controls in settings",
        ],
    },
    {
        version: "0.2",
        date: "2026-05-14",
        ru: [
            "свой ник в настройках",
            "подсказка, если браузер не дал доступ к микрофону",
        ],
        en: [
            "your own nick in settings",
            "a hint when the browser blocks the mic",
        ],
    },
    {
        version: "0.1",
        date: "2026-05-09",
        ru: [
            "первая версия: голосовые комнаты по коду, чат и демонстрация экрана",
        ],
        en: [
            "the first version: voice rooms by code, chat and screen sharing",
        ],
    },
];
