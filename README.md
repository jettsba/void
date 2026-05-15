<div align="center">

<img src="public/static/favicon/web-app-manifest-512x512.png" width="120" alt="void" />

# void

**ephemeral voice rooms — no accounts, no history, peer-to-peer.**

<sub>[void-room.space](https://void-room.space)</sub>

</div>

---

## ▸ что это

тихая голосовая комната, которая исчезает вместе с последним участником.

создаёшь комнату → даёшь код другу → разговариваете напрямую.
ни аккаунтов, ни историй, ни сервера в середине вашего голоса.

```text
  you ──── mic ──── webrtc ──── mic ──── friend
                       │
                  signalling
                  (5–20 kb/s)
                       │
                    void.srv
```

сервер живёт только для того, чтобы вы нашли друг друга. дальше — мимо него.

---

## ▸ что внутри

- **голос** — webrtc mesh, до 5 человек на комнату
- **чат** — поверх datachannel: текст, файлы до 100мб, картинки до 10мб
- **демонстрация экрана** — с системным звуком, до 1080p60
- **арки громкости** — у каждого, с индикацией «говорит»
- **ru / en** — переключение прямо в настройках
- **режим стримера** — прячет код комнаты в футере
- **мобильный лейаут** — отдельные стили, без bloat'а
- **админ-дашборд** — `/adminstats` со statистикой за всё время

---

## ▸ чего здесь нет

- регистраций, профилей, аватаров
- базы данных и хранения сообщений
- аналитики и трекеров
- медиа-серверов между вами
- куки и localStorage с pii

---

## ▸ tech stack

| layer        | tech                                  |
|--------------|---------------------------------------|
| signalling   | node.js · express · ws                |
| transport    | webrtc (perfect negotiation, mesh)    |
| audio dsp    | web audio api (highpass/lowpass/comp) |
| ui           | vanilla js, no frameworks             |
| reverse proxy| caddy (auto-https)                    |
| deploy       | docker + docker-compose               |

вот и всё. никакого react, никаких сборщиков, никакого `npm run build`.
кладёшь файлы рядом — браузер сам разбирается.

---

## ▸ быстрый старт (локально)

```bash
git clone <repo>
cd void
npm ci
npm start
# → http://localhost:3000
```

микрофон браузер попросит на первом входе в комнату. интро-пароль — `тишина` (часть лора).

---

## ▸ деплой (vps)

```bash
# 1. поднимаешь сервер
docker compose up -d --build

# 2. caddy уже знает про домен — просто:
sudo systemctl reload caddy

# 3. готово — https://void-room.space
```

caddy сам сходит за tls-сертификатом от let's encrypt и будет продлевать его раз в 60 дней без участия.

переменные окружения (опционально, всё с дефолтами):

```env
ADMIN_STATS_PASSWORD=...     # пароль к /adminstats; без него — отключено
LOG_LEVEL=info               # error | warn | info | debug
ALLOWED_ORIGINS=https://...  # через запятую
BIND_HOST=127.0.0.1          # в docker — 0.0.0.0
MAX_ROOM_USERS=5
```

---

## ▸ структура

```text
.
├── server.js               — тонкий entry-point (~200 строк)
├── lib/
│   ├── handlers.js         — обработчики ws-сообщений
│   ├── security.js         — лимиты, валидаторы, anti-bruteforce
│   ├── admin-stats.js      — /adminstats endpoint
│   ├── stats.js            — persistent статистика
│   ├── state.js            — общие mutable коллекции
│   └── log.js              — structured logger
├── public/
│   ├── index.html
│   ├── css/                — 14 файлов: base, intro, app, chat, ...
│   ├── js/                 — 13 файлов: config, state, controls, ...
│   ├── webrtc.js           — peer setup + recovery
│   ├── socket.js           — ws клиент + reconnect
│   ├── chat.js             — datachannel чат
│   ├── settings.js         — i18n + настройки
│   └── log.js
├── Caddyfile               — reverse-proxy + security headers
├── Dockerfile              — node:20-alpine, USER node
└── docker-compose.yml      — read-only fs, limits, log rotation
```

---

## ▸ отладка

в браузере доступна глобальная `window.log` с уровнями (`error`/`warn`/`info`/`debug`),
ring buffer'ом на 300 последних записей и набором утилит. дефолт — `info`,

доступные команды:

| команда | что делает |
| --- | --- |
| `log.getLevel()` | текущий уровень |
| `log.setLevel("debug")` | включить подробные логи, сохранить в localStorage |
| `log.setLevel("warn")` | потише — только проблемы |
| `log.clearLevel()` | сбросить в дефолт (`info`) |
| `log.dump()` | массив из последних 300 записей (любого уровня) |
| `log.dumpString()` | то же, но одной строкой — удобно копипастить |
| `log.clearBuffer()` | обнулить ring buffer (например, перед воспроизведением бага) |
| `await log.dumpStats()` | `console.table` со статой по всем peer'ам: rtt, jitter, lost/sent |
| `await log.bugReport()` | json со всем нужным для багрепорта: история + peers + окружение |

быстрый багрепорт одной командой:

```js
copy(await log.bugReport())
```

enter → в буфер вносится json с историей, peer stats, версией, url, user-agent
и id текущей комнаты

если баг воспроизводится — `log.clearBuffer()` и повторить ровно, потом
`log.bugReport()`. получится чистый лог с момента триггера.

ещё есть `?debug=1` в url — поднимает уровень до `debug` на одну загрузку без
изменения localStorage. полезно когда не хочется лезть в консоль чтобы что-то поменять.

на сервере — то же самое через env `LOG_LEVEL` (см. секцию деплоя).

---

## ▸ roadmap

- [x] голос + чат + screen share
- [x] reconnect, perfect negotiation, ice restart
- [x] i18n + режим стримера
- [x] settings панель
- [x] прод-хардненинг (security headers, timing-safe auth, mem-leaks)
- [ ] turn-сервер (для мобильных за симметричным NAT)
- [ ] полноценное видео (камера)
- [ ] ссылка-приглашение с `?room=ABCD`
- [ ] постоянный никнейм в localStorage

---

<div align="center">
<sub>void 2026 · all rights reserved · made with care</sub>
</div>
