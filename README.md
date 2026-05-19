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

### первый раз, с нуля (только VPS + репозиторий)

```bash
# 1. клонируешь репо
git clone <repo>
cd void

# 2. конфиг — копируешь шаблон и заполняешь свои значения
cp .env.example .env
nano .env   # или любой редактор

# 3. поднимаешь сервис(ы)
# вариант А — без TURN (только STUN, как раньше; ок для dev и MVP):
docker compose up -d --build

# вариант Б — с TURN (для пользователей за CG-NAT / симметричным NAT):
# (предварительно: A-запись turn.your-domain.com → IP vps; firewall ниже)
sudo ufw allow 3478/udp
sudo ufw allow 49152:49251/udp
docker compose --profile turn up -d --build

# 4. caddy + домен (один раз)
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 5. готово — https://void-room.space
```

caddy сам сходит за tls-сертификатом от let's encrypt и будет продлевать его раз в 60 дней без участия. для TURN caddy не нужен — coturn слушает UDP напрямую.

### повторный деплой

на проде висит github actions `.github/workflows/deploy.yml` — он триггерится на push в `main` и сам делает `git pull --ff-only && docker compose --profile turn up -d --build` по SSH. ничего вручную делать не надо: запушил → через ~30 секунд новая версия на проде. логи деплоя — в actions-вкладке репо.

ручной деплой (если actions упали или нужно проверить локально на VPS):

```bash
ssh user@vps
cd ~/void
git pull
docker compose --profile turn up -d --build
```

если меняешь только `.env` — `--build` не нужен:

```bash
docker compose --profile turn up -d
```

`.env` лежит только на сервере и в actions не передаётся — менять значения через ssh, рестарт компоуза подхватывает.

### переменные окружения

полный шаблон с комментариями — в `.env.example`. ключевое:

```env
# базовое — всё опционально, есть дефолты:
ADMIN_STATS_PASSWORD=        # пароль к /adminstats; без него — отключено
LOG_LEVEL=info               # error | warn | info | debug
ALLOWED_ORIGINS=             # через запятую
MAX_ROOM_USERS=5

# багрепорты по почте — опционально:
BUG_SMTP_USER=               # ящик-отправитель (Yandex)
BUG_SMTP_PASS=               # app-password Яндекс.Почты

# TURN — для прода с реальной аудиторией:
TURN_HOST=turn.your-domain.com
TURN_EXTERNAL_IP=1.2.3.4
TURN_SECRET=                 # `openssl rand -base64 48`
TURN_REALM=your-domain.com
```

### TURN (для symmetric NAT / CG-NAT)

опционально, но без TURN ~10-20% пар обламываются (CG-NAT, мобильные сети, корпоративные firewall). TURN добавляет relay-fallback. без TURN-инфры проект продолжает работать — клиент молча обходится STUN.

подъём:

1. **A-запись** для `turn.your-domain.com` → IP VPS (можно использовать прямой IP в `TURN_HOST`, но домен удобнее на случай миграции).
2. **TURN_SECRET** — `openssl rand -base64 48`, положить в `.env`.
3. **остальные TURN_* в .env**: `TURN_HOST`, `TURN_EXTERNAL_IP`, `TURN_REALM`.
4. **firewall** на VPS:

   ```bash
   sudo ufw allow 3478/udp
   sudo ufw allow 49152:49251/udp
   ```

   (если внешний firewall у хостера — там же открыть)

5. **запуск с `--profile turn`**:

   ```bash
   docker compose --profile turn up -d --build
   ```

проверка:

- `curl 'https://app.your-domain.com/api/turn-credentials?uid=test'` — должен вернуть JSON с `iceServers`, не 503.
- открыть [trickle-ice tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/), вставить `turn:turn.your-domain.com:3478` + `username/credential` из curl-ответа, нажать "Gather candidates" — должен появиться candidate `Type: relay` с IP VPS.
- созвониться вдвоём с разных сетей, открыть `/adminstats` → виджет "connectivity" покажет долю `direct/relay/failed`. **failed должен быть 0%.**

если не работает — `docker logs void-coturn`, проверить firewall, проверить `TURN_EXTERNAL_IP`.

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
