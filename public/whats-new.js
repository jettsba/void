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
    version: "1.7.0",
    ru: [
        "большое техническое обновление  - void стал еще безопаснее",
        "закрытую комнату больше нельзя занять или открыть снаружи — в том числе пока сервер обновляется",
        "— свои возвращаются после обрыва связи и обновления сервера сами, разговор не прерывается",
        "вход по ссылке теперь всегда спрашивает подтверждение",
        "код безопасности больше нельзя «заморозить»: если он долго не сходится, появится предупреждение",
        "чат защищён от флуда и от подмены чужих картинок и файлов",
        "программы, присланные в чат, помечаются и сохраняются только повторным нажатием",
        "— сохранённые файлы из чата windows теперь считает скачанными из интернета и предупредит перед запуском",
        "двойное нажатие на «создать» или «войти» больше не выкидывает из комнаты"
    ],
    en: [
        "a big technical update — void is now even more secure",
        "a closed room can no longer be taken over or opened from outside — not even while the server updates",
        "— your people get back in on their own after a dropped connection or a server update, the call keeps going",
        "joining through a link now always asks for confirmation",
        "the security code can no longer be \"frozen\": if it takes too long to match, you'll see a warning",
        "the chat is protected from flooding and from someone swapping other people's images and files",
        "programs sent in the chat are marked and only saved on a second click",
        "— windows now treats files saved from the chat as downloaded from the internet and warns before running them",
        "double-clicking create or join no longer kicks you out of the room"
    ]
};
