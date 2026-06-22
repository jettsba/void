# void — разработка и эксплуатация

Технический док для мейнтейнера void. Публичный обзор — в [../README.md](../README.md);
плотный снапшот архитектуры для LLM — в [../rules/CONTEXT.md](../rules/CONTEXT.md). Этот
файл — человеческое руководство по эксплуатации: как запустить, задеплоить, настроить и
отладить.

> Текущая версия: **0.12.10**. Версионирование батчевое — см. `../CLAUDE.md` и
> `../rules/current-commit.md`. Версия держится синхронно в `package.json`,
> `public/settings.js` (`APP_VERSION`), `src-tauri/Cargo.toml` и
> `src-tauri/tauri.conf.json`.

---

## что это, в одном абзаце

Эфемерные P2P голосовые комнаты. Без аккаунтов, без базы данных, без медиа-сервера в
аудио-потоке. Голос, текстовый чат, передача файлов и демонстрация экрана работают
peer-to-peer поверх WebRTC; Node-сервер занимается только сигналингом (обмен
offer/answer/ICE) и раздачей статики. Две поверхности, одна кодовая база: веб-приложение
(`app.void-room.space`) и нативное десктоп-приложение под Windows (Tauri 2), которое
грузит тот же веб-клиент и добавляет трей, хоткеи, авто-обновление и deep-links. Комнаты
живут в памяти и исчезают, когда уходит последний участник.

---

## архитектура в общих чертах

```text
                  ┌────────────┐
   you ──── mic ──┤ webrtc P2P ├── mic ──── friend
                  └─────┬──────┘
              (если прямой путь невозможен — relay через coturn)
                        │  сигналинг: offer / answer / ICE  (~5–20 kb/s)
                  ┌─────┴──────┐     ┌──────────────────────────┐
                  │  void.srv  │     │  coturn                  │
                  │  rooms{}   │     │  3478/udp + 49152..49251 │
                  └─────┬──────┘     │  use-auth-secret +       │
                        │            │  HMAC-SHA1 credentials   │
                        │  /api/turn-credentials → HMAC creds
                        │  /adminstats (HTML-дашборд, Basic auth)
                        │  ./data/stats.json (debounced persist, только метрики)
                        ▼
                   Caddy :443 → localhost:3000

  Desktop = тот же веб-клиент внутри Tauri WebView2-окна
  (грузит app.void-room.space; сервер платформу почти не различает).
```

- Сервер **никогда не видит ни одного аудио-байта** — только сводит пиров.
- Чат и файлы — тоже P2P, через `RTCDataChannel`. Сервер о них ничего не знает.
- Полный mesh: для N юзеров → `N*(N-1)/2` соединений. `MAX_ROOM_USERS=5` — намеренный
  потолок mesh-топологии (дальше нужен SFU).
- TURN **включён в проде** (релеит примерно 40–45% пар на CG-NAT). Если `TURN_HOST` /
  `TURN_SECRET` не заданы — endpoint отдаёт 503, и клиенты откатываются на STUN-only.

---

## стек

| слой | технологии |
|------|------------|
| сигналинг | Node.js 20 · Express 4 · ws 8 (ESM) |
| транспорт медиа | WebRTC mesh — perfect negotiation, DTLS-SRTP |
| чат / файлы | RTCDataChannel, бинарный chunked transfer |
| Audio DSP | Web Audio API: RNNoise (WASM/AudioWorklet) → highpass → lowpass → compressor → gain → noise gate |
| фронтенд | vanilla JS — без бандлеров, без React, без TypeScript |
| десктоп | Tauri 2 (Rust + WebView2 на Windows), remote-only webview на прод-домен |
| reverse proxy | Caddy (авто-HTTPS от Let's Encrypt) |
| TURN-relay | coturn 4.6-alpine, опциональный compose-сервис (`--profile turn`), HMAC-credentials |
| deploy (web) | Docker + docker-compose; CI `.github/workflows/deploy.yml` |
| deploy (desktop) | GitHub Actions → GitHub Releases (`jettsba/void`) + зеркало на `void-room.space/dl` (scp на VPS), подпись апдейтов ed25519 |
| persistence | один JSON-файл `data/stats.json` — только анонимные метрики, никаких пользовательских данных |

Рантайм-зависимости (server): `express`, `ws`, `nodemailer` (SMTP-багрепорты).
devDeps: `@tauri-apps/cli`, `@jitsi/rnnoise-wasm`, `nodemon`. Никаких ORM, очередей, БД.

---

## структура репозитория

```text
.
├── server.js                  — entry point: Express + WSS + heartbeat + graceful shutdown
├── lib/
│   ├── handlers.js            — WS-бизнес-логика: hello / create / join / signal / disconnect
│   ├── state.js               — общие mutable Map'ы (rooms, ipConnections, ipFailedJoins, stats)
│   ├── security.js            — лимиты, валидаторы, origin-check, getClientIp (XFF anti-spoof), anti-bruteforce
│   ├── stats.js               — daily/lifetime метрики, debounced JSON-persist (tmp+rename, retry)
│   ├── admin-stats.js         — HTML-дашборд /adminstats (timing-safe auth, ICE-воронка, счётчик загрузок)
│   ├── desktop-downloads.js   — поллинг GitHub Releases API → счётчики загрузок installer+portable
│   ├── bug-report.js          — POST /api/report-bug → Yandex SMTP (nodemailer)
│   ├── leave-beacon.js        — POST /api/leave-room (navigator.sendBeacon на pagehide)
│   ├── turn.js                — GET /api/turn-credentials, HMAC-SHA1 короткие creds для coturn
│   └── log.js                 — structured JSON-line logger
├── public/                    — веб-фронт (отдаётся на app.void-room.space, грузится и в desktop)
│   ├── index.html             — DOM-скелет: titlebar (desktop) + intro + app + chat + screen overlay
│   ├── settings.js            — i18n (ru/en) + панель настроек + APP_VERSION + support-модалка
│   ├── socket.js              — WS-клиент: reconnect backoff+jitter, liveness watchdog, id-collision retry
│   ├── webrtc.js              — peer setup, perfect negotiation, recovery state machine, RNNoise, screenshare
│   ├── chat.js                — DataChannel-протокол, chunking, передача файлов/картинок, лайки, lightbox
│   ├── desktop-bootstrap.js   — ранний детект Tauri (IS_DESKTOP), подгрузка desktop-модулей
│   ├── ui-scale-bootstrap.js  — расчёт --auto-scale по screen.width (вынесен из inline ради CSP)
│   ├── js/                    — оркестратор по модулям: config, state, app, room, controls, participants,
│   │                            toasts, app-settings, volume-arc, ping-panel, audio, background, intro,
│   │                            username, screen-overlay, и js/desktop/* (titlebar, tray, deep-link, updater)
│   ├── css/                   — ~20 файлов: base, app, header, titlebar, stage, panel, chat, settings, …
│   ├── audio/                 — rnnoise-processor.js (AudioWorklet), rnnoise-sync.js, screen-audio-feeder.js
│   └── static/               — favicon, манифест, шрифты JetBrains Mono, mp3 (ambient/join/leave/message)
├── landing/                   — статический маркетинговый сайт (void-room.space), RU по умолчанию + /en
├── src-tauri/                 — Tauri 2 desktop-крейт (окно, трей, хоткеи, autostart, deep-link,
│                                updater, нативный WASAPI loopback для звука демки, скрытие индикатора захвата)
├── installer/                 — отдельный Tauri-крейт: кастомный webview-установщик (скин поверх тихого NSIS /S)
├── uninstaller/              — отдельный Tauri-крейт: кастомный webview-деинсталлятор
├── scripts/                   — rename-bundles.mjs, build-manifest.mjs (latest.json для updater)
├── data/                      — bind-mount volume, stats.json
├── coturn/                    — turnserver.conf + logs (опц., --profile turn)
├── Dockerfile, docker-compose.yml, docker-entrypoint.sh, Caddyfile, .env.example
├── CLAUDE.md                  — workflow-правила агента (батч-коммиты)
└── rules/                     — CONTEXT.md, VOID_STYLE_GUIDE.md, lessons.md, current-commit.md
```

---

## запуск локально

```bash
git clone https://github.com/jettsba/void.git
cd void
npm ci
npm start
# → http://localhost:3000
```

Микрофон браузер запросит при первом входе в комнату. Интро-пароль — `тишина` (часть
лора; intro-экран по умолчанию отключён).

Для десктоп-приложения:

```bash
npm run tauri:dev      # dev-сборка, грузит локальный/dev URL
npm run tauri:build    # прод-сборка → NSIS-установщик + portable
```

---

## деплой (web, на VPS)

### первый раз, с нуля

```bash
# 1. клонируешь
git clone https://github.com/jettsba/void.git
cd void

# 2. конфиг — копируешь шаблон и заполняешь свои значения
cp .env.example .env
nano .env

# 3. поднимаешь сервис(ы)
# вариант А — только STUN (ок для dev / MVP):
docker compose up -d --build

# вариант Б — с TURN (для юзеров за CG-NAT / симметричным NAT):
#   предусловие: A-запись turn.your-domain.com → IP VPS; firewall ниже
sudo ufw allow 3478/udp
sudo ufw allow 49152:49251/udp
docker compose --profile turn up -d --build

# 4. Caddy + домен (один раз)
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 5. готово → https://void-room.space
```

Caddy сам берёт и продлевает TLS-сертификат у Let's Encrypt. TURN'у Caddy не нужен —
coturn слушает UDP напрямую.

### повторные деплои

`.github/workflows/deploy.yml` подключён к проду: триггерится на push в `main` и делает
`git pull --ff-only && docker compose --profile turn up -d --build` по SSH. Push → через
~30 с новая версия в проде. Логи деплоя — во вкладке Actions репозитория.

Ручной деплой (если CI упал или хочешь проверить прямо на VPS):

```bash
ssh user@vps
cd ~/void
git pull
docker compose --profile turn up -d --build
```

Если менял только `.env` — `--build` не нужен:

```bash
docker compose --profile turn up -d
```

`.env` лежит только на сервере (в CI не передаётся) — правь его по SSH; рестарт compose
подхватывает новые значения. Каталог `data/` — bind-mount, переживает rebuild. Контейнер
запускается с `read_only` / `tmpfs:/tmp` / `no-new-privileges` / `USER node`, с лимитами
ресурсов и ротацией логов.

---

## переменные окружения

Полный шаблон с комментариями — в `.env.example`. Всё опционально (есть разумные
дефолты), кроме TURN — его нужно настроить, чтобы включить relay.

| переменная | дефолт | где |
|------------|--------|-----|
| `PORT` | 3000 | server.js |
| `BIND_HOST` | 127.0.0.1 (вне Docker) / 0.0.0.0 (compose) | server.js |
| `ADMIN_STATS_PASSWORD` | — (нет → /adminstats отдаёт 503) | lib/admin-stats.js |
| `LOG_LEVEL` | info — `error \| warn \| info \| debug` | lib/log.js |
| `ALLOWED_ORIGINS` | void-room.space + www + app | lib/security.js |
| `MAX_ROOM_USERS` | 5 | lib/security.js |
| `STATS_FILE` | `./data/stats.json` | lib/stats.js |
| `BUG_SMTP_USER` / `BUG_SMTP_PASS` / `BUG_SMTP_TO` | — / — / =USER | lib/bug-report.js |
| `TURN_HOST` / `TURN_SECRET` | — (нет → 503, STUN-only) | lib/turn.js + coturn |
| `TURN_EXTERNAL_IP` / `TURN_REALM` | — / void-room.space | docker-compose.yml (coturn) |

---

## TURN (для symmetric NAT / CG-NAT)

Опционально, но без TURN примерно 10–20% пар не могут соединиться (CG-NAT, мобильные
сети, корпоративные firewall). TURN добавляет relay-fallback. Без TURN-инфры проект всё
равно работает — клиент молча откатывается на STUN.

1. **A-запись** для `turn.your-domain.com` → IP VPS (можно и прямой IP в `TURN_HOST`, но
   домен удобнее на случай миграции).
2. **TURN_SECRET** — `openssl rand -base64 48`, положить в `.env`.
3. **остальные `TURN_*` в `.env`**: `TURN_HOST`, `TURN_EXTERNAL_IP`, `TURN_REALM`.
4. **firewall** на VPS:

   ```bash
   sudo ufw allow 3478/udp
   sudo ufw allow 49152:49251/udp
   ```

   (если у хостера внешний firewall — открыть и там)
5. **запуск с `--profile turn`**:

   ```bash
   docker compose --profile turn up -d --build
   ```

Как это работает: coturn в режиме `use-auth-secret`. Сервер выдаёт короткоживущие
credentials через `GET /api/turn-credentials?uid=` —
`username = ${expiry}:${userId}`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`,
TTL ~1ч. coturn валидирует тем же `--static-auth-secret`. Базы нет, ротация автоматическая.

### проверка TURN

- `curl 'https://app.your-domain.com/api/turn-credentials?uid=test'` — должен вернуть JSON
  с `iceServers`, не 503.
- Открыть [trickle-ice tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/),
  вставить `turn:turn.your-domain.com:3478` + `username`/`credential` из ответа curl,
  нажать **Gather candidates** — должен появиться candidate `Type: relay` с IP VPS.
- Созвониться вдвоём из разных сетей, открыть `/adminstats` → виджет «connectivity»
  покажет долю `direct / relay / failed`. **failed должен быть 0%.**

Если не работает: `docker logs void-coturn`, проверить firewall, проверить `TURN_EXTERNAL_IP`.

---

## деплой (desktop)

- `npm run tauri:build` → NSIS (`void_setup.exe`) + portable (через `rename-bundles.mjs`).
  CI дополнительно собирает кастомный `void_installer.exe` (installer-крейт вшивает
  `void_setup.exe`) и `void-uninstaller.exe`.
- Релиз уходит в GitHub Releases основного репо `jettsba/void` И дублируется на свой
  домен `void-room.space/dl` (scp на VPS, перезаписью = всегда последняя версия) —
  GitHub в РФ нестабилен. `build-manifest.mjs` генерит `latest.json` в двух вариантах
  (url → GitHub и url → /dl). Апдейтер (`tauri-plugin-updater`) ходит по endpoints из
  `tauri.conf.json`: сперва `/dl`, GitHub как fallback.
- Сборка десктопа **3-стадийная**: uninstaller → main app → installer. Требует заранее
  собранный `src-tauri/bundled/void-uninstaller.exe` (его кладёт CI).
- У апдейтера два режима: режим A (silent на старте, до главного окна, с окном прогресса;
  check timeout 2.5с) и режим B (in-app баннер; первая перепроверка ~40с, далее каждые
  15 мин, snooze 24ч). **Инвариант: не перезапускать во время живого звонка** — silent
  только до входа в комнату.
- Web и desktop релизы независимы: веб-фикс деплоится без пересборки exe (десктоп грузит
  прод-домен).

---

## отладка в браузере

В браузере доступна глобальная `window.log` с уровнями (`error`/`warn`/`info`/`debug`),
ring buffer'ом на 300 последних записей и набором утилит. Дефолтный уровень — `info`.

| команда | что делает |
|---------|------------|
| `log.getLevel()` | текущий уровень |
| `log.setLevel("debug")` | подробные логи, сохраняются в localStorage |
| `log.setLevel("warn")` | потише — только проблемы |
| `log.clearLevel()` | сброс в дефолт (`info`) |
| `log.dump()` | массив из последних 300 записей (любого уровня) |
| `log.dumpString()` | то же одной строкой — удобно копипастить |
| `log.clearBuffer()` | обнулить ring buffer (например, перед воспроизведением бага) |
| `await log.dumpStats()` | `console.table` со статой по пирам: rtt, jitter, lost/sent |
| `await log.bugReport()` | JSON со всем нужным для багрепорта |

Быстрый багрепорт одной командой:

```js
copy(await log.bugReport())
```

Enter → в буфер обмена ложится JSON с историей логов, peer stats, версией, URL,
user-agent и id текущей комнаты. Если баг воспроизводим: `log.clearBuffer()`, повторить
ровно те же шаги, потом `log.bugReport()` — получишь чистый лог с момента триггера.

`?debug=1` в URL поднимает уровень до `debug` на одну загрузку, не трогая localStorage.
На сервере то же самое — через `LOG_LEVEL` (см. деплой).

---

## конвенции

- **Версионирование / коммиты:** батч через `rules/current-commit.md` — копим строки
  правок, bump версии ТОЛЬКО на «выкатываем» (см. `CLAUDE.md`). Версия синхронна в 4
  файлах (package.json, settings.js `APP_VERSION`, Cargo.toml, tauri.conf.json) + `?v=`
  cache-buster для затронутых CSS/JS в index.html.
- **Naming:** JS `camelCase`, файлы `kebab-case.js`, CSS-классы `kebab-case`.
- **Никаких бандлеров.** `<script defer>` в index.html, порядок важен. Desktop-only код
  гейтится `if (IS_DESKTOP)` / динамическим import.
- **UI scaling:** корневой `font-size = calc(14px * var(--auto-scale) * var(--ui-scale))`.
  Размеры в **rem**; хайрлайны (border 1–2px, shadow, blur, radius ≤4px) — в px.
  `--auto-scale` ставится по `screen.width` (иммунен к browser zoom; `vw` не используем).
- **i18n:** `t("key")` / `data-i18n`, слушать `void:locale-changed`. ru (дефолт) + en,
  один источник строк — `DICTIONARY` в settings.js.
- **Комментарии:** объясняют WHY и инварианты (race conditions, perfect negotiation,
  single-sharer atomicity, XFF anti-spoof), а не WHAT.
- **Визуальные задачи:** сверяться с `rules/VOID_STYLE_GUIDE.md`.

---

## известные ограничения

- **Mesh scalability:** 5 — потолок. Дальше нужен SFU (смена архитектуры).
- **Spoofable userId:** клиент сам генерирует `userId` (сервер валидирует формат).
  Некритично — нет состояния между сессиями для угона.
- **Reconnect = полная пересборка mesh:** короткий аудио-провал; локальный mic сохраняется.
- **Рестарт сервера = всё пропало:** комнаты in-memory by design (эфемерность).
- **Desktop:** только Windows x64. Web и desktop настройки не шарятся (разный origin).
  Оффлайн = «нет интернета» (remote-only by design).
- **Никаких пушей в браузере:** закрыта вкладка = ничего не услышишь (десктоп частично
  закрывает это через трей / мигание окна).

---

Плотный справочник по архитектуре (WS-протокол, peer-стейт-машины, security-слои,
WebRTC-внутренности) — в `../rules/CONTEXT.md`.
