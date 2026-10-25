/* ========= WS MESSAGE HANDLERS =========
 * Бизнес-логика room lifecycle: hello / create-room / join-room /
 * join-room-confirm / audio-state / screencast-state / leave-room /
 * disconnect / signal (offer/answer/ice).
 *
 * Состояние (rooms, stats) — через импорты из state.js / stats.js.
 * Ничего не знают про http/express/ws-сервер: чистые функции (ws, data) → effect.
 */

import crypto from "node:crypto";
import { log } from "./log.js";
import { roomRef } from "./privacy.js";
import { rooms, stats } from "./state.js";
import {
    bumpDaily,
    scheduleStatsWrite,
    captureSessionDuration,
    updatePeaks,
    pushIceFailure,
    noteRoomOccupancy,
    noteRoomUsed,
} from "./stats.js";
import {
    MAX_ROOM_USERS,
    ROOMS_CAP,
    MSG_BUCKET_CAPACITY,
    MSG_BUCKET_REFILL_PER_SEC,
    EMPTY_ROOM_TTL_MS,
    isValidCode,
    isReservedRoom,
    isValidUserId,
    sanitizeNickname,
    noteFailedJoin,
    isIpBlocked,
    takeRoomCreateSlot,
} from "./security.js";
import { issueResumeTicket, verifyResumeTicket } from "./resume-ticket.js";
import { newTurnSessionId, turnPayload } from "./turn.js";

/**
 * F11: безопасный broadcast по всем участникам комнаты. Каждый `ws.send`
 * обёрнут в try/catch, чтобы синхронное исключение (race в ws-library между
 * `readyState===1` check и фактическим send) не прервало рассылку посреди
 * `forEach`. До этого фикса часть участников могла не получить broadcast,
 * если один сокет вырубался ровно в момент отправки.
 *
 * Параметры:
 *   room        — объект из rooms Map
 *   message     — объект (будет JSON.stringify один раз снаружи цикла)
 *   exceptUserId? — userId, которого пропустить (обычно сам автор события)
 */
function broadcastToRoom(room, message, exceptUserId) {
    if (!room) return;
    const payload = JSON.stringify(message);
    room.users.forEach((u, id) => {
        if (exceptUserId !== undefined && id === exceptUserId) return;
        if (u.ws.readyState !== 1) return;
        try {
            u.ws.send(payload);
        } catch (err) {
            log.warn("ws", "broadcast send failed", { userId: id, err: err?.message || String(err) });
        }
    });
}

export function consumeToken(ws) {
    const b = ws._bucket;
    if (!b) return true;
    const now = Date.now();
    const elapsed = (now - b.lastRefill) / 1000;
    if (elapsed > 0) {
        b.tokens = Math.min(
            MSG_BUCKET_CAPACITY,
            b.tokens + elapsed * MSG_BUCKET_REFILL_PER_SEC
        );
        b.lastRefill = now;
    }
    if (b.tokens < 1) {
        /* Дроп сигналинга — это НЕ рядовое событие: потерянный ICE-кандидат
           никем не переспрашивается и всплывает потом как «remote: none» в
           failure-логе. Раньше дропали абсолютно молча, и подтвердить/опровергнуть
           эту версию было нечем. Логируем первый дроп на сокет и дальше каждый
           50-й, чтобы флудер не утопил лог. */
        b.dropped = (b.dropped || 0) + 1;
        if (b.dropped === 1 || b.dropped % 50 === 0) {
            log.warn("ws", "message dropped (rate limit)", {
                ip: ws._ip,
                code: ws.roomCode,
                dropped: b.dropped
            });
        }
        return false;
    }
    b.tokens -= 1;
    return true;
}

/**
 * Клиент шлёт hello один раз — сразу после открытия вкладки. На один сокет
 * принимаем максимум один hello, повторы игнорируем (защита от случайного
 * двойного отправления; reconnect клиент тоже не должен слать повторно).
 *
 * Две РАЗНЫЕ метрики:
 *   usersRegistered — открытия приложения. F5 = +1, вторая вкладка = +1. Меряет
 *     активность, а не аудиторию (в дашборде подписано «opens»).
 *   visitorsUnique  — уникальные посетители за день. Дедуплицирует сам браузер
 *     (см. markVisit в public/js/state.js) и присылает готовый флаг `fresh`.
 *   visitorsReturnedOnce — люди, вернувшиеся хотя бы раз. Момент «это мой первый
 *     возврат» тоже определяет браузер и присылает флагом `firstRet`.
 *
 * Из payload'а читаем ТОЛЬКО булевы флаги — никакого идентификатора клиент
 * не шлёт и слать не должен. Считать уникальных по IP или по стабильному id было
 * бы проще, но это ровно то, чего void не делает. Обратная сторона: цифру нельзя
 * перепроверить и клиент теоретически может соврать — для собственной метрики
 * роста это приемлемо, мотива врать нет.
 */
export function handleHello(ws, data = {}) {
    if (ws._registered) return;
    ws._registered = true;

    stats.usersRegistered += 1;
    bumpDaily("usersRegistered");

    if (data.fresh === true) {
        stats.visitorsUnique += 1;
        bumpDaily("visitorsUnique");
        if (data.ret === true) {
            stats.visitorsReturning += 1;
            bumpDaily("visitorsReturning");
            /* Первый в жизни возврат этого браузера. Считаем человека ровно один
               раз, тогда как visitorsReturning копит ДНИ возвратов и один
               активный юзер разгоняет его до бесконечности. Отношение к
               visitorsNew и есть ретеншн: «сколько из пришедших вернулось». */
            if (data.firstRet === true) {
                stats.visitorsReturnedOnce += 1;
                bumpDaily("visitorsReturnedOnce");
            }
        } else {
            stats.visitorsNew += 1;
            bumpDaily("visitorsNew");
        }
    }

    scheduleStatsWrite();
}

/**
 * Момент старта процесса. Нужен для ресуректа комнат после выкатки (см.
 * handleJoinRoom): окно, в котором мы верим клиенту, что комната была живой
 * до рестарта, — короткое и привязано к аптайму, а не к слову клиента.
 */
const BOOT_AT = Date.now();
const RESUME_WINDOW_MS = 2 * 60 * 1000;

/**
 * Завести объект комнаты под кодом и поставить его в `rooms`.
 *
 * Общая точка для трёх путей: обычного `create-room`, авто-подъёма
 * зарезервированной комнаты при входе и ресуректа после рестарта контейнера
 * (оба — в handleJoinRoom). Держим одной функцией, чтобы TTL-таймер и счётчики
 * не разъехались между ними.
 *
 * `resumed` — комната не новая, а восстановленная после выкатки. Тогда все
 * «первичные» счётчики гасим: иначе каждый деплой накручивал бы roomsCreated,
 * roomsUsed и roomsWithCall на ровном месте, ломая статистику тем сильнее,
 * чем чаще выкатываемся.
 */
function createRoomRecord(code, { resumed = false } = {}) {
    /** Если в течение TTL не пришёл join-room-confirm — комнату удаляем,
        чтобы её нельзя было заюзать как memory-DoS вектор. */
    const room = {
        code,
        users: new Map(),
        cleanupTimer: null,
        /* «Закрыть комнату» (см. handleRoomCloseVote): закрывается, когда
           проголосовали ВСЕ текущие участники. `pass` — общий пропуск тех, кто
           был внутри в момент закрытия: по нему пускаем обратно после обрыва
           сети / перезагрузки вкладки / выкатки. Один на комнату, а не на
           человека — иначе воскрешённая после рестарта комната знала бы только
           пропуск первого вернувшегося. */
        closed: false,
        pass: null,
        closeVotes: new Set(),
        /* userId → { at, token }: когда отвалился НЕ по своей воле
           (handleDisconnect) и с каким токеном сессии. В окне DROP_GRACE_MS
           этот userId занят за ним: вернуться под ним можно только с тем же
           токеном (см. sessionIdentity). */
        dropped: new Map()
    };
    /* F16: timer мог попасть в очередь event loop'а ДО того, как
       clearTimeout вызвался (например, между двумя WS-сообщениями).
       Проверяем что (а) timer ещё привязан к этой room (clearTimeout
       сбрасывает room.cleanupTimer = null) и (б) под кодом всё ещё ИМЕННО
       эта room (новый create-room после быстрого исчезновения мог
       перезаписать запись с тем же кодом). Без этих проверок коллбек мог
       удалить чужую свежую комнату. */
    const cleanupTimer = setTimeout(() => {
        if (room.cleanupTimer === null) return;
        if (rooms.get(code) !== room) return;
        if (room.users.size > 0) return;
        rooms.delete(code);
        log.info("room", "expired empty", { code });
    }, EMPTY_ROOM_TTL_MS);
    cleanupTimer.unref?.();
    room.cleanupTimer = cleanupTimer;

    rooms.set(code, room);

    if (resumed) {
        /* Комната уже была создана и уже была «использована» до рестарта —
           повторно в статистику не идёт. `_callStartedAt` НЕ ставим: его
           заново взведёт noteRoomOccupancy, когда соберутся хотя бы двое,
           и callSeconds продолжит капать (теряется только дыра рестарта). */
        room._countedUsed = true;
        room._countedCall = true;
    } else {
        stats.roomsCreated += 1;
        bumpDaily("roomsCreated");
    }
    updatePeaks();
    scheduleStatsWrite();

    return room;
}

/* Потолок комнат упёрся — пишем в лог не чаще раза в минуту, а не на каждый
   отказ: при атаке отказов тысячи. */
let _capWarnedAt = 0;

function roomsCapReached() {
    if (rooms.size < ROOMS_CAP) return false;
    const now = Date.now();
    if (now - _capWarnedAt > 60 * 1000) {
        _capWarnedAt = now;
        log.warn("security", "rooms cap reached", { rooms: rooms.size, cap: ROOMS_CAP });
    }
    return true;
}

function rejectCreate(ws, reason) {
    ws.send(JSON.stringify({ type: "room-created", success: false, reason }));
}

export function handleCreateRoom(ws, data) {

    const { code } = data;

    if (!isValidCode(code)) {
        rejectCreate(ws, "invalid-code");
        return;
    }

    /* Блок анти-перебора действует и здесь: code-taken — такой же ответ
       «комната жива», как успешный join, и раньше с заблокированного IP
       перебор просто продолжался через create-room. */
    if (isIpBlocked(ws._ip)) {
        rejectCreate(ws, "rate-limited");
        return;
    }

    /* Зарезервированные коды создаются только сами (при входе) — иначе любой,
       кто знает код, мог бы занять его заранее своим create-room и встречать
       там хозяина. Клиент такие коды не генерирует, но сообщение приходит с
       клиента, и подделать его тривиально.
       code-taken штрафуется как неудачный вход: клиент генерирует код сам, и
       честная коллизия на 60 млн кодов — редкость, а перебор через create
       упирается в тот же счётчик. */
    if (rooms.has(code) || isReservedRoom(code)) {
        noteFailedJoin(ws._ip, code);
        rejectCreate(ws, "code-taken");
        return;
    }

    if (roomsCapReached()) {
        rejectCreate(ws, "server-full");
        return;
    }
    if (!takeRoomCreateSlot(ws._ip)) {
        rejectCreate(ws, "rate-limited");
        return;
    }

    createRoomRecord(code);

    /** Разрешает ровно один последующий join-room-confirm на этот код с этого сокета. */
    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "room-created",
        success: true,
        code
    }));

    log.info("room", "created", { code, ip: ws._ip });
}

export function handleJoinRoom(ws, data) {

    const { code } = data;

    if (isIpBlocked(ws._ip)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "rate-limited"
        }));
        return;
    }

    if (!isValidCode(code)) {
        noteFailedJoin(ws._ip, code);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-code"
        }));
        return;
    }

    /* Зарезервированная комната доступна на вход всегда: нет в памяти — поднимаем
       здесь же. Держать её живой между сессиями не нужно и не нужно вовсе — при
       выходе последнего она удаляется как любая другая, и это ровно то, что
       требуется: комната есть всегда, а содержимое не переживает никого.
       Чат идёт по data channel мимо сервера, так что после удаления объекта от
       разговора не остаётся ничего. */
    if (!rooms.has(code) && isReservedRoom(code)) {
        createRoomRecord(code);
        log.info("room", "reserved room opened", { code });
    }

    /* Ресурект после выкатки. Комнаты живут только в памяти процесса, поэтому
       рестарт контейнера стирает их все — и вернувшийся клиент получал
       room-not-found, хотя его звук (P2P, мимо нас) в этот момент даже не
       прерывался. Поднимаем комнату обратно из его же join'а.

       Гейт — АПТАЙМ ПРОЦЕССА, а не слово клиента: комната воскресает только
       в первые RESUME_WINDOW_MS после старта. Иначе протухшая вкладка через
       час подняла бы комнату, которая честно умерла, и человек сидел бы один
       в пустой «восстановленной» комнате вместо честной ошибки.

       Открытая комната воскресает по слову клиента: занять свободный код и так
       можно обычным create-room, путь эквивалентен по возможностям (и тарифицируется
       тем же лимитом создания). Закрытая — ТОЛЬКО по подписанному билету
       (lib/resume-ticket.js), который сервер выдал её участникам вместе с
       пропуском. Раньше хватало флага closed и любого пропуска: чужак, знающий
       код, первым воскрешал комнату со своим пропуском, и настоящие участники
       оставались снаружи навсегда. Зарезервированные коды сюда не доходят. */
    const pass = isValidRoomPass(data.pass) ? data.pass : null;

    if (!rooms.has(code) && data.resume === true && (Date.now() - BOOT_AT) < RESUME_WINDOW_MS) {
        const wantClosed = data.closed === true;
        if (wantClosed && !(pass && verifyResumeTicket(data.ticket, code, pass))) {
            log.warn("room", "resurrect refused: closed room without a valid ticket", { code, ip: ws._ip });
        } else if (roomsCapReached()) {
            ws.send(JSON.stringify({ type: "join-failed", reason: "server-full" }));
            return;
        } else if (!takeRoomCreateSlot(ws._ip)) {
            ws.send(JSON.stringify({ type: "join-failed", reason: "rate-limited" }));
            return;
        } else {
            const revived = createRoomRecord(code, { resumed: true });
            if (wantClosed) {
                revived.closed = true;
                revived.pass = pass;
            }
            log.info("room", "resurrected after restart", { code, uptimeMs: Date.now() - BOOT_AT, closed: revived.closed });
        }
    }

    if (!rooms.has(code)) {
        noteFailedJoin(ws._ip, code);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    const room = rooms.get(code);
    const userId = isValidUserId(data.userId) ? data.userId : null;
    const token = typeof data.token === "string" ? data.token : null;
    const identity = sessionIdentity(room, userId, token, ws);

    /* room-full и room-closed тоже штрафуются: оба отвечают «комната жива»,
       а room-closed ещё и выдаёт момент приватного разговора. Счётчик считает
       разные коды, поэтому человек, повторяющий вход к другу, не копит штраф.
       Свой же слот (возврат с токеном) место не занимает. */
    const ownSlot = identity === "owner" && room.users.has(userId);
    if (room.users.size >= MAX_ROOM_USERS && !ownSlot) {
        noteFailedJoin(ws._ip, code);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    /* Закрыта — пускаем с пропуском или тем, кто доказал, что это его сессия
       (вернулся после обрыва с токеном). Голый userId больше не пропуск: его
       знает каждый в комнате, и раньше по нему входил кто угодно. */
    if (room.closed && !(passMatches(room, pass) || identity === "owner")) {
        noteFailedJoin(ws._ip, code);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-closed"
        }));
        return;
    }

    if (identity === "taken") {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "id-collision"
        }));
        return;
    }

    ws.authorizedJoinCode = code;
    ws._joinPass = pass;
    ws._joinToken = token;

    ws.send(JSON.stringify({
        type: "join-success",
        code
    }));
}

export function handleJoinConfirm(ws, data) {

    const { code, userId } = data;

    if (ws.authorizedJoinCode !== code) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "join-session-invalid"
        }));
        return;
    }

    ws.authorizedJoinCode = undefined;

    if (!isValidCode(code)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-code"
        }));
        return;
    }

    if (!isValidUserId(userId)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-user-id"
        }));
        return;
    }

    const cleanNick = sanitizeNickname(data.nickname);
    if (!cleanNick) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-nickname"
        }));
        return;
    }

    /* Сокет уже сидит в другой комнате (двойной клик «создать», самописный
       клиент) — сначала выводим его оттуда. Иначе ws.roomCode перезапишется,
       а старая запись навсегда останется в room.users: handleDisconnect
       чистит только текущую комнату. Это и были фантомы в /adminstats —
       комната с одним «юзером» и 0s presence, раздувавшая live и пики. */
    if (ws.roomCode && (ws.roomCode !== code || ws.userId !== userId)) {
        handleLeaveRoom(ws);
    }

    const room = rooms.get(code);

    if (!room) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    /* Между pre-flight и confirm комнату могли закрыть, а userId — занять или
       освободить. Всё перепроверяем по userId ИМЕННО из confirm: pre-flight мог
       прийти под другим. */
    const joinPass = ws._joinPass;
    const joinToken = ws._joinToken;
    ws._joinPass = undefined;
    ws._joinToken = undefined;
    const identity = sessionIdentity(room, userId, joinToken, ws);
    if (room.closed && !(passMatches(room, joinPass) || identity === "owner")) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-closed"
        }));
        return;
    }
    if (identity === "taken") {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "id-collision"
        }));
        return;
    }

    // Комната получает первого подтверждённого юзера — TTL больше не нужен.
    if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
    }

    /**
     * userId уже в комнате под ДРУГИМ сокетом, и новый сокет доказал токеном,
     * что это та же сессия: WS моргнул, а старый сокет сервер ещё считает живым
     * (half-open TCP, VPN-смена — heartbeat прибьёт его только через минуту).
     *
     * Раньше в этой ситуации был id-collision и клиент ждал heartbeat, а если
     * старый сокет уже умер — слот мог занять кто угодно под этим userId
     * (захват чужой личности с перехватом её сигналинга). Теперь хозяин
     * подменяет сокет в своём же слоте сразу и молча: соседи не получают
     * participant-left, их P2P-соединение с ним не рвётся (звук идёт мимо нас).
     * Старый сокет гасим и отвязываем — его будущий close ничего не тронет.
     */
    const existing = room.users.get(userId);
    if (existing && existing.ws !== ws) {
        retireSocket(existing.ws);
        room.users.delete(userId);
    }
    room.dropped.delete(userId);

    // После возможного delete выше — проверяем capacity заново.
    if (!room.users.has(userId) && room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.roomCode = code;
    ws.userId = userId;
    /* F12: ставим _joinedAt ДО room.users.set, чтобы между set и присваиванием
       не существовало окна, в котором ws закроется (close-event придёт в next
       tick) и handleDisconnect запишет сессию с `_joinedAt === undefined`. */
    ws._joinedAt = Date.now();

    /* Токен сессии. Знает его только владелец сокета (уходит ему одному в
       user-list), и он доказывает «это я»:
         - /api/leave-room (sendBeacon) принимается только с ним — раньше beacon
           верил любым {code, userId}, а userId соседей знает каждый в комнате;
         - вернуться под своим userId после обрыва можно только с ним
           (sessionIdentity) — иначе слот обрывшегося занимал кто угодно.
       Новый на каждый вход: старый после реконнекта больше ничего не открывает. */
    const leaveToken = crypto.randomBytes(16).toString("base64url");
    room.users.set(userId, {
        ws,
        nickname: cleanNick,
        mic: true,
        sound: true,
        screen: false,
        leaveToken
    });

    if (room.users.size > MAX_ROOM_USERS) {
        room.users.delete(userId);
        ws.roomCode = undefined;
        ws.userId = undefined;
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    /* Комната из «созданной» стала используемой, и, возможно, в ней начался
       разговор (≥2 человек). Считаем ПОСЛЕ проверки на переполнение — иначе
       откатанный вход накрутил бы метрику. */
    noteRoomUsed(room);
    noteRoomOccupancy(room);

    const usersList = [];

    room.users.forEach((user, id) => {
        if (id !== userId) {
            usersList.push({
                id,
                nickname: user.nickname,
                mic: user.mic,
                sound: user.sound,
                screen: user.screen
            });
        }
    });

    /* TURN-креды — только участнику и только в его персональный user-list
       (lib/turn.js). Новый sid на каждый вход: предыдущие креды этой вкладки
       дальше к человеку не привязаны. */
    ws._turnSid = newTurnSessionId();

    ws.send(JSON.stringify({
        type: "user-list",
        users: usersList,
        leaveToken,
        turn: turnPayload(ws._turnSid),
        ...closeStatePayload(room)
    }));

    // Сообщаем остальным, что появился новый
    broadcastToRoom(room, {
        type: "new-participant",
        userId,
        nickname: cleanNick,
        screen: false
    }, userId);

    /* Голосование за закрытие шло, а вошёл новый человек: голоса остальных
       сохраняются, у него просто пустой кружок — закрыть теперь можно только
       и с его голосом. Состояние разошлём всем (кружков стало больше). */
    if (room.closeVotes.size > 0) broadcastCloseState(room, userId);

    updatePeaks();
    scheduleStatsWrite();

    log.info("room", "joined", { code, userId });
}

/* ---------- «закрыть комнату» ---------- */

function isValidRoomPass(p) {
    return typeof p === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(p);
}

function passMatches(room, pass) {
    if (!room.pass || typeof pass !== "string") return false;
    const a = Buffer.from(room.pass), b = Buffer.from(pass);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const DROP_GRACE_MS = 2 * 60 * 1000;

function tokenMatches(expected, token) {
    if (typeof expected !== "string" || typeof token !== "string") return false;
    const a = Buffer.from(expected), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Кому принадлежит userId в этой комнате, с точки зрения того, кто входит:
 *   "free"  — никому: ни живой сессии, ни свежего обрыва;
 *   "owner" — входящий доказал, что это его сессия (токен сессии совпал,
 *             или это тот же самый сокет);
 *   "taken" — userId держит другая сессия (живая или обрывшаяся меньше
 *             DROP_GRACE_MS назад), а токена нет или он чужой.
 *
 * userId генерирует клиент и знают все в комнате, поэтому сам по себе он
 * ничего не доказывает. Раньше по голому userId обрывшегося участника входили
 * в закрытую комнату и занимали его место в открытой (с его ником и его
 * входящим сигналингом).
 */
function sessionIdentity(room, userId, token, ws) {
    if (!userId) return "free";
    const live = room.users.get(userId);
    if (live) {
        if (live.ws === ws) return "owner";
        return tokenMatches(live.leaveToken, token) ? "owner" : "taken";
    }
    const drop = room.dropped.get(userId);
    if (!drop || Date.now() - drop.at >= DROP_GRACE_MS) return "free";
    return tokenMatches(drop.token, token) ? "owner" : "taken";
}

/* Старый сокет той же сессии больше не нужен: время сессии в статистику,
   связь с комнатой рвём (его будущий close станет no-op) и закрываем. */
function retireSocket(oldWs) {
    captureSessionDuration(oldWs);
    oldWs.roomCode = undefined;
    oldWs.userId = undefined;
    try { oldWs.terminate?.(); } catch (_) {}
}

/* Пропуск и билет уходят только участникам (broadcast по room.users) — никогда
   наружу: join-failed про закрытую комнату их не содержит. Билет нужен, чтобы
   закрытая комната воскресла закрытой после рестарта сервера. */
function closeStatePayload(room) {
    return {
        closed: room.closed,
        closeVotes: [...room.closeVotes],
        ...(room.closed ? { pass: room.pass, ticket: issueResumeTicket(room.code, room.pass) } : {})
    };
}

function broadcastCloseState(room, exceptUserId) {
    broadcastToRoom(room, { type: "room-close-state", ...closeStatePayload(room) }, exceptUserId);
}

/* Закрываем, когда проголосовали ВСЕ, кто сейчас в комнате на живом сокете.
   Вызывается и на голосе, и на уходе участника: ушёл последний несогласный —
   комната закрылась. Сокет, который сервер ещё не успел признать мёртвым,
   голосовать не может и кворум не держит; его хозяин вернётся по токену. */
function maybeCloseRoom(room) {
    if (room.closed || room.users.size === 0 || room.closeVotes.size === 0) return false;
    let live = 0;
    for (const [id, u] of room.users) {
        if (u.ws.readyState !== 1) continue;
        live += 1;
        if (!room.closeVotes.has(id)) return false;
    }
    if (live === 0) return false;
    room.closed = true;
    room.pass = crypto.randomBytes(18).toString("base64url");
    room.closeVotes.clear();
    return true;
}

/* Голос за закрытие (`vote:true`) или отзыв (`vote:false`, повторное нажатие).
   Таймаута у голосования нет. */
export function handleRoomCloseVote(ws, data) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;
    if (room.closed) return;

    if (data.vote === true) room.closeVotes.add(ws.userId);
    else room.closeVotes.delete(ws.userId);

    if (maybeCloseRoom(room)) log.info("room", "closed by vote", { code: ws.roomCode, users: room.users.size });
    broadcastCloseState(room);
}

/* Открыть обратно может любой участник одним нажатием: открыть безопасно,
   а запереть всех навсегда из-за одного несогласного — плохо. */
export function handleRoomOpen(ws) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;
    if (!room.closed && room.closeVotes.size === 0) return;

    room.closed = false;
    room.pass = null;
    room.closeVotes.clear();
    log.info("room", "reopened", { code: ws.roomCode });
    broadcastCloseState(room);
}

/* Общий хвост всех путей ухода участника: его голос больше не считается, и
   уход последнего несогласного может закрыть комнату. */
function afterParticipantLeft(room) {
    if (room.users.size === 0 || room.closed) return;
    const hadVotes = room.closeVotes.size > 0;
    for (const id of [...room.closeVotes]) {
        if (!room.users.has(id)) room.closeVotes.delete(id);
    }
    const closedNow = maybeCloseRoom(room);
    if (hadVotes || closedNow) broadcastCloseState(room);
}

export function handleScreencastState(ws, data) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    /* Single-sharer enforcement (B13). Проверка «никто другой не шарит» и
       установка `user.screen` — один синхронный блок без `await` между ними.
       Node single-threaded: даже если два юзера прислали `screen:true`
       одновременно, их сообщения обрабатываются по очереди event-loop'ом —
       второй уже увидит `u.screen === true` от первого и получит reject.
       Это корректно атомарно по построению; при будущем рефакторинге держать
       проверку и присваивание в одном synchronous-блоке (никаких async
       операций между ними). */
    if (data.screen) {
        for (const [id, u] of room.users) {
            if (id !== ws.userId && u.screen) {
                ws.send(JSON.stringify({ type: "screencast-rejected" }));
                return;
            }
        }
    }

    user.screen = !!data.screen;

    broadcastToRoom(room, {
        type: "screencast-state",
        userId: ws.userId,
        screen: user.screen
    }, ws.userId);
}

/**
 * Смена ника на лету из настроек (см. public/js/app.js `void:nickname-changed`).
 * Поле `nickname` гоняется через тот же `sanitizeNickname`, что и при join — пустой
 * (после санитайза) игнорим. Сервер хранит ник в `room.users[userId].nickname` —
 * обновляем и рассылаем остальным `nickname-changed`. Себе эхо не шлём: клиент уже
 * локально обновил ник перед отправкой.
 */
export function handleNicknameUpdate(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    const cleanNick = sanitizeNickname(data.nickname);
    if (!cleanNick) return;

    if (user.nickname === cleanNick) return;

    user.nickname = cleanNick;

    broadcastToRoom(room, {
        type: "nickname-changed",
        userId: ws.userId,
        nickname: cleanNick
    }, ws.userId);
}

export function handleAudioState(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    user.mic = !!data.mic;
    user.sound = !!data.sound;

    broadcastToRoom(room, {
        type: "audio-state",
        userId: ws.userId,
        mic: user.mic,
        sound: user.sound
    }, ws.userId);
}

export function handleLeaveRoom(ws) {

    const code = ws.roomCode;
    if (!code) return;

    const userId = ws.userId;
    const roomData = rooms.get(code);
    if (!roomData) return;

    const existing = roomData.users.get(userId);
    if (!existing || existing.ws !== ws) return;

    roomData.users.delete(userId);
    ws.roomCode = undefined;
    ws.userId = undefined;
    captureSessionDuration(ws);
    noteRoomOccupancy(roomData);

    broadcastToRoom(roomData, { type: "participant-left", userId });
    afterParticipantLeft(roomData);

    if (roomData.users.size === 0) {
        if (roomData.cleanupTimer) {
            clearTimeout(roomData.cleanupTimer);
            roomData.cleanupTimer = null;
        }
        rooms.delete(code);
        log.info("room", "deleted", { code });
    }
}

export function handleDisconnect(ws) {

    if (!ws.roomCode) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const userId = ws.userId;
    const existing = room.users.get(userId);

    if (existing && existing.ws === ws) {
        room.users.delete(userId);
        captureSessionDuration(ws);
        noteRoomOccupancy(room);
        const now = Date.now();
        for (const [id, d] of room.dropped) if (now - d.at >= DROP_GRACE_MS) room.dropped.delete(id);
        room.dropped.set(userId, { at: now, token: existing.leaveToken });

        broadcastToRoom(room, { type: "participant-left", userId });
        afterParticipantLeft(room);
    }

    if (room.users.size === 0) {
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }
        rooms.delete(ws.roomCode);
        log.info("room", "deleted on disconnect", { code: ws.roomCode });
    }

    log.debug("ws", "client disconnected", { ip: ws._ip });
}

/**
 * T1.1: обработка leave-сигнала из `navigator.sendBeacon` (см. lib/leave-beacon.js).
 * Аналог `handleLeaveRoom`, но без `ws` — параметры взяты из HTTP body и уже
 * провалидированы в endpoint'е. Используем ws, лежащий в `room.users[userId]`,
 * чтобы зафиксировать session-duration и обнулить roomCode (это нейтрализует
 * последующий handleDisconnect от того же ws — он увидит roomCode=undefined и
 * выйдет рано, не дублируя broadcast).
 *
 * Идемпотентен: юзера нет → no-op. Это важно, потому что beacon и WS leave-room
 * могут прилететь оба — кто первый, тот и сработает.
 */
export function handleBeaconLeave(code, userId, token) {
    const room = rooms.get(code);
    if (!room) return;

    const existing = room.users.get(userId);
    if (!existing) return;

    /* Только владелец сессии: токен выдан ему одному в user-list. Без
       проверки любой участник (userId соседей знает каждый) выкидывал бы
       людей из звонка — их сокет жив, а все остальные рвут с ними P2P. */
    if (!tokenMatches(existing.leaveToken, token)) return;

    room.users.delete(userId);

    if (existing.ws) {
        existing.ws.roomCode = undefined;
        existing.ws.userId = undefined;
        captureSessionDuration(existing.ws);
    }
    noteRoomOccupancy(room);

    broadcastToRoom(room, { type: "participant-left", userId });
    afterParticipantLeft(room);

    if (room.users.size === 0) {
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }
        rooms.delete(code);
        log.info("room", "deleted via beacon", { code });
    }

    log.debug("beacon", "leave processed", { code, userId });
}

/**
 * Клиент сообщает, чем собралось peer-соединение: "direct" (host/srflx/prflx),
 * "relay" (через TURN) или "failed" (ушёл в "failed", не соединившись). Один
 * отчёт на peer-объект. Копим счётчики, чтобы по реальным данным решить —
 * нужен ли TURN. Принимаем только от юзеров внутри комнаты — мусор/спам вне
 * комнат отсекаем (плюс уже работает token-bucket в server.js).
 */
const ICE_RESULT_FIELD = {
    direct: "iceDirect",
    relay: "iceRelay",
    failed: "iceFailed",
    /* "dropped" — соединение УСТАНОВИЛОСЬ и потом оборвалось. Раньше такие
       случаи приходили как "failed" и завышали воронку: клиент не мог отличить
       «не смог соединиться» от «работал час и потерял сеть». Теперь это
       отдельная метрика стабильности — TURN тут ничего не решает. */
    dropped: "iceDropped"
};

/* Путь клиент→TURN из ice-report (RTCIceCandidateStats.relayProtocol).
   Белый список: поле клиентское, в stats попадает только известное значение. */
const RELAY_VIA_FIELD = { udp: "iceRelayUdp", tcp: "iceRelayTcp", tls: "iceRelayTls" };

/* Лимит отчётов на сокет. Честный клиент шлёт по одному отчёту на peer-соединение
   (в полной комнате — 9, при обрыве сети — ещё по одному failed на каждого), а
   раньше любой участник мог залпом из сотни фейковых failed вытеснить весь
   журнал провалов в админке и накрутить воронку. Слепков-диагностик (они и
   занимают журнал) — отдельно поменьше. */
const ICE_REPORT_WINDOW_MS = 60 * 1000;
const ICE_REPORTS_PER_WINDOW = 30;
const ICE_DIAGS_PER_WINDOW = 10;

function iceReportAllowed(ws, withDiag) {
    const now = Date.now();
    let q = ws._iceQuota;
    if (!q || now - q.windowStart > ICE_REPORT_WINDOW_MS) {
        q = ws._iceQuota = { windowStart: now, reports: 0, diags: 0 };
    }
    if (q.reports >= ICE_REPORTS_PER_WINDOW || (withDiag && q.diags >= ICE_DIAGS_PER_WINDOW)) {
        stats.iceReportRejected += 1;
        if (stats.iceReportRejected === 1 || stats.iceReportRejected % 50 === 0) {
            log.warn("ws", "ice-report rejected (rate limit)", { ip: ws._ip, rejectedTotal: stats.iceReportRejected });
        }
        scheduleStatsWrite();
        return false;
    }
    q.reports += 1;
    if (withDiag) q.diags += 1;
    return true;
}

/* room в failure-логе — roomRef (lib/privacy.js): видно, что два провала из
   одной комнаты (обе стороны пары репортят независимо), код не раскрыт. */
export function handleIceReport(ws, data) {
    if (!ws.roomCode || !ws.userId) return;

    const field = ICE_RESULT_FIELD[data.result];
    if (!field) return;
    if (!iceReportAllowed(ws, data.result === "failed" && !!data.diag)) return;

    stats[field] += 1;
    bumpDaily(field);

    const viaField = data.result === "relay" ? RELAY_VIA_FIELD[data.via] : null;
    if (viaField) {
        stats[viaField] += 1;
        bumpDaily(viaField);
    }

    /* К failed клиент прикладывает диагностический слепок (типы кандидатов,
       состояния пар, ошибки STUN/TURN) — копим последние N для админки.
       pushIceFailure сам санитизирует payload: он клиентский и уедет в HTML. */
    if (data.result === "failed" && data.diag) {
        pushIceFailure({ ...data.diag, at: Date.now(), room: roomRef(ws.roomCode) });
        return; // pushIceFailure уже дёрнул scheduleStatsWrite
    }

    scheduleStatsWrite();
}

/* Продление TURN-кредов: клиент просит новые незадолго до истечения (у звонка
   через relay может быть несколько часов). Только участнику комнаты — это
   единственный способ получить креды. Не чаще раза в 30 с на сокет: честный
   клиент просит раз в час. */
const TURN_REFRESH_MIN_INTERVAL_MS = 30 * 1000;

export function handleTurnRefresh(ws) {
    if (!ws.roomCode || !ws.userId || !ws._turnSid) return;
    const now = Date.now();
    if (ws._turnRefreshAt && now - ws._turnRefreshAt < TURN_REFRESH_MIN_INTERVAL_MS) return;
    ws._turnRefreshAt = now;
    ws.send(JSON.stringify({ type: "turn-credentials", turn: turnPayload(ws._turnSid) }));
}

export function handleSignal(ws, data) {

    if (!ws.roomCode || !ws.userId) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (typeof data.to !== "string") return;

    const targetUser = room.users.get(data.to);
    if (!targetUser || targetUser.ws.readyState !== 1) return;

    /**
     * Whitelist полей + структурная валидация (S-L2). Раньше тут был spread
     * `...data` после `from: ws.userId`, из-за чего payload-овский `from`
     * ПЕРЕТИРАЛ серверный — атакующий мог подделать источник signaling (S-C3).
     * Теперь явно перечисляем ровно те поля, которые ожидает клиент
     * (`public/webrtc.js`), и проверяем форму payload'а:
     *  - offer:  { offer:{type:"offer", sdp:string}, rebuild? }
     *  - answer: { answer:{type:"answer", sdp:string} }
     *  - ice:    { candidate:object|null }
     *
     * Лимит длины SDP — 48 КБ. Минимальный mesh-handshake укладывается в
     * 1-3 КБ, но скринкаст добавляет ещё 2 m-line'а (video + screen-audio),
     * VP9 codec preference и x-google-* fmtp-патчи расширяют каждую m-секцию.
     * Главное: при цикле stopScreenShare → startScreenShare Chrome может
     * НЕ переиспользовать transceiver'ы (если direction шифтится из sendrecv
     * в inactive/recvonly), и каждый ре-старт добавляет m-line'ы поверх
     * старых. За 2-3 цикла SDP перерастал 16 КБ → сервер тихо дропал offer →
     * negotiation навсегда зависала в have-local-offer (баг чёрного экрана
     * в v0.9.10-0.9.12). 48 КБ (v0.9.21) даёт запас на 5-mesh + screencast
     * с несколькими циклами re-share без риска упереться в лимит, и при
     * этом остаётся под WS max payload (64 КБ) с JSON-overhead'ом.
     * Клиентский soft warn в [public/webrtc.js] оставлен на 24 КБ — это
     * раннее предупреждение об утечке m-line'ов, не близость к серверному лимиту. */
    const MAX_SDP_BYTES = 48 * 1024;
    const out = {
        type: data.type,
        from: ws.userId,
        to: data.to
    };

    if (data.type === "offer") {
        if (!isValidSdp(data.offer, "offer", MAX_SDP_BYTES)) return;
        out.offer = data.offer;
        if (data.rebuild === true && allowRebuildFlag(room, ws.userId, data.to)) out.rebuild = true;
    } else if (data.type === "answer") {
        if (!isValidSdp(data.answer, "answer", MAX_SDP_BYTES)) return;
        out.answer = data.answer;
    } else if (data.type === "ice") {
        if (!isValidIceCandidate(data.candidate)) return;
        out.candidate = data.candidate;
    } else {
        return;
    }

    targetUser.ws.send(JSON.stringify(out));
}

/**
 * Флаг rebuild заставляет получателя снести peer-соединение и собрать новое
 * (у клиентов до 1.7.0 — безусловно и до проверки SDP). Пачкой таких offer'ов
 * участник комнаты держал соседа в вечной пересборке: CPU в потолок, TURN-квота
 * выжжена за секунду, его сигналинг забит ответами. Честному клиенту хватает
 * одной пересборки на эпизод (свои предохранители у него ≤4 в минуту), поэтому
 * пропускаем флаг не чаще раза в 10 с на пару; лишний стираем, а сам offer
 * идёт дальше как обычный — ренеготиацию он не ломает.
 */
const REBUILD_FLAG_COOLDOWN_MS = 10 * 1000;

function allowRebuildFlag(room, from, to) {
    if (!room._rebuildAt) room._rebuildAt = new Map();
    const key = `${from}>${to}`;
    const now = Date.now();
    const last = room._rebuildAt.get(key) || 0;
    if (now - last < REBUILD_FLAG_COOLDOWN_MS) {
        room._rebuildStripped = (room._rebuildStripped || 0) + 1;
        if (room._rebuildStripped === 1 || room._rebuildStripped % 50 === 0) {
            log.warn("ws", "rebuild flag stripped (cooldown)", { code: room.code, stripped: room._rebuildStripped });
        }
        return false;
    }
    /* Ключи — пары участников комнаты, растут не больше N²; живут вместе с
       комнатой. Протухшие подчищаем, когда карта заметно разрослась. */
    if (room._rebuildAt.size > 256) {
        for (const [k, t] of room._rebuildAt) if (now - t >= REBUILD_FLAG_COOLDOWN_MS) room._rebuildAt.delete(k);
    }
    room._rebuildAt.set(key, now);
    return true;
}

/**
 * RTCSessionDescription по спеке: `{type:"offer"|"answer"|"pranswer"|"rollback", sdp:string}`.
 * Принимаем offer/answer, sdp обязан быть строкой в пределах лимита. Жёсткий
 * парсинг SDP не делаем — браузер всё равно прогонит через `setRemoteDescription`,
 * наша задача только обрезать заведомо невалидное и слишком крупное.
 */
export function isValidSdp(desc, expectedType, maxBytes) {
    if (!desc || typeof desc !== "object") return false;
    if (desc.type !== expectedType) return false;
    if (typeof desc.sdp !== "string") return false;
    if (desc.sdp.length === 0 || desc.sdp.length > maxBytes) return false;
    return true;
}

/**
 * RTCIceCandidate приходит как `{candidate, sdpMid, sdpMLineIndex, ...}` ИЛИ
 * `null` (end-of-candidates сигнал, всё ещё валиден). Полей много, проверять
 * каждое — overkill; ограничиваемся типом и базовой санитизацией строки.
 */
function isValidIceCandidate(c) {
    if (c === null) return true;
    if (typeof c !== "object") return false;
    /* end-of-candidates тоже могут пнуть пустую candidate-строку — пропускаем. */
    if (c.candidate !== undefined && c.candidate !== null && typeof c.candidate !== "string") return false;
    if (typeof c.candidate === "string" && c.candidate.length > 2048) return false;
    return true;
}
