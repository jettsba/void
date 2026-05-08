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
