/* ============ WHAT'S NEW — заметки к ТЕКУЩЕМУ релизу ============
   Единственный файл, который правится на выкатке. Читает его
   public/js/desktop/whats-new.js: после авто-обновления desktop-приложения
   показывает баннер «void обновлён до vX.Y.Z» и модалку со списком.

   Правила заполнения:

   - `version` — РОВНО та версия, к которой относится список. Баннер покажется,
     только если она совпала с версией запущенного приложения. Забыл обновить —
     баннера просто не будет: чужой changelog не показываем никогда.
   - Пустой `version` или пустые списки = микрофикс, баннера нет. Это штатный
     режим, а не поломка.
   - Строка = один пункт списка. Готовым текстом, нижним регистром, без точки
     в конце (голос интерфейса — rules/VOID_STYLE_GUIDE.md).
   - Обычный пункт — БЕЗ префикса, просто текст: баннер и модалка рендерят
     список сами и рисуют свой буллет. Тире с пробелом («— …») ставится ТОЛЬКО
     на строку-дополнение, которая раскрывает предыдущий пункт и читается как
     его продолжение. Тире на каждой строке давало двойной маркер («· — текст»).
   - `ru` обязателен, `en` желателен: если для языка интерфейса списка нет —
     покажем русский, молчать о релизе хуже. Подписи самого UI («что нового»)
     живут в DICTIONARY в settings.js — здесь только контент релиза.

   Пример заполненного релиза:

       window.VoidWhatsNew = {
           version: "1.0.1",
           ru: [
               "добавлены хоткеи на кнопки мыши",
               "— в том числе на боковые и колесо",
               "исправлен звук демонстрации экрана"
           ],
           en: [
               "mouse-button hotkeys",
               "— side buttons and the wheel included",
               "fixed screen-share audio"
           ]
       };

   Посмотреть, как это выглядит, ДО выкатки: `VoidWhatsNewPreview()` в консоли. */

window.VoidWhatsNew = {
    version: "1.3.0",
    ru: [
        "зажатая горячая клавиша больше не переключает состояние без остановки",
        "звук старта и остановки демонстрации больше не двоится",
        "если выбранный микрофон исчез, берётся системный вместо ошибки «нет доступа»",
        "фон пересчитывается при переносе окна между экранами разной плотности",
        "ambient-фон замирает, когда в системе включено «уменьшение движения»",
        "шестерёнка в логотипе больше не залипает после закрытия настроек",
        "большое количество изменений для поддержки macOS в веб-версии",
        "— масштаб на retina, отрисовка шрифта, демонстрация экрана, горячие клавиши, громкость колесом и прочее"
    ],
    en: [
        "holding a hotkey no longer toggles it over and over",
        "screen share start and stop sounds no longer play twice",
        "if the selected mic is gone, the system one is used instead of a no-access error",
        "the background is recalculated when the window moves between displays of different density",
        "the ambient background freezes when the system asks for reduced motion",
        "the gear icon no longer sticks after the settings panel closes",
        "a big pass on macOS support in the web version",
        "— ui scale on retina, type rendering, screen sharing, hotkeys, volume by wheel and more"
    ]
};
