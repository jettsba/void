/* ========= SHARED STATE =========
 * Все мутабельные коллекции, которые обмениваются между stats / security /
 * handlers / admin-stats. Map'ы передаются по ссылке — модули читают и
 * пишут одни и те же объекты.
 *
 * Только декларации. Никаких функций — иначе циклические импорты.
 */

/**
 * Простая статистика beta-теста: сколько комнат/сессий/минут присутствия.
 * Хранится в одном JSON-файле, который смонтирован volume'ом — при ребилде
 * контейнера данные не теряются. Реальный voice-трафик идёт P2P, сервер
 * байты не видит — поэтому в качестве «минут разговора» считаем
 * participant-seconds (сумма по всем сессиям длительности «юзер был в комнате»).
 */
export const stats = {
    since: Date.now(),
    roomsCreated: 0,
    /**
     * Количество "регистраций" — клиент сгенерировал ник/userId и подключился.
     * Считается по сообщению "hello" (один раз на загрузку вкладки).
     * Не включает входы в комнаты — туда метрика участия идёт через
     * participantSeconds.
     */
    usersRegistered: 0,
    participantSeconds: 0,
    peakConcurrentRooms: 0,
    peakConcurrentUsers: 0,
    /**
     * Воронка P2P-связности: чем собирались peer-соединения. Клиент шлёт один
     * "ice-report" на peer-объект. Нужно чтобы по реальным данным решить —
     * нужен ли TURN-релей.
     *   iceDirect — пробились напрямую (host/srflx/prflx)
     *   iceRelay  — через TURN (пока всегда 0 — TURN не подключён)
     *   iceFailed — peer ушёл в "failed", так и не соединившись (тут помог бы TURN)
     */
    iceDirect: 0,
    iceRelay: 0,
    iceFailed: 0,
    /**
     * Счётчик скачиваний desktop с зеркала void-room.space/dl (клик-бикон
     * POST /api/dl-hit, см. lib/dl-beacon.js). Раньше брали из GitHub Releases
     * API, но загрузки переехали на свой домен (GitHub в РФ нестабилен) —
     * считаем сами. Updater-пинги (void_setup) сюда не попадают.
     */
    installerDownloads: 0,
    portableDownloads: 0,
    /**
     * Кольцевой буфер диагностики провалившихся peer-соединений (последние
     * ICE_FAIL_LOG_CAP штук, см. lib/stats.js). Наполняется из "ice-report"
     * с result:"failed" — клиент прикладывает слепок: типы собранных кандидатов,
     * состояния пар, ошибки STUN/TURN, был ли TURN в конфиге. Без этого
     * счётчик iceFailed говорит «5% не собрались», но не говорит ПОЧЕМУ.
     *
     * Адреса кандидатов НЕ храним — только типы и счётчики. UA клиента храним
     * (иначе непонятно, у какого браузера/платформы рвётся) — это единственное
     * PII-подобное поле, попадающее в stats.json; буфер ограничен и перезаписывается.
     */
    iceFailLog: [],
    /** Дневные срезы. Ключ — "YYYY-MM-DD" в UTC. */
    daily: {},
    updatedAt: Date.now()
};

/*
Структура rooms:

Map {
  roomCode => {
    users: Map {
      userId => { ws, nickname, mic, sound, screen }
    },
    cleanupTimer: setTimeout id | null
  }
}
*/
export const rooms = new Map();

/** ip -> count активных WS */
export const ipConnections = new Map();

/** ip -> { count, windowStart, blockedUntil } */
export const ipFailedJoins = new Map();
