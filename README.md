<div align="center">

<img src="https://void-room.space/og.png" alt="void — leaves no trace." width="680">

**a phone call for the internet — no accounts, no history, peer-to-peer.**

<sub>[void-room.space](https://void-room.space) · [try the web app](https://app.void-room.space) · [download for windows](https://github.com/jettsba/void/releases/latest/download/void_installer.exe)</sub>

<br>

[![void-room.space](https://img.shields.io/badge/site-void--room.space-101012?labelColor=2a2a2f)](https://void-room.space)

[![web app](https://img.shields.io/badge/web-launch-101012?labelColor=2a2a2f)](https://app.void-room.space)
[![desktop](https://img.shields.io/badge/desktop-download-101012?labelColor=2a2a2f)](https://github.com/jettsba/void/releases/latest/download/void_installer.exe)

</div>

---

## what it is

Open a room, share the short code, talk — and the moment the last person leaves, the
room is gone. Nothing was written down, because there was nowhere to write it.

Voice, text chat, file transfer and screen sharing, all **peer-to-peer over WebRTC**.
The server exists only to introduce two browsers to each other; once they shake hands,
your audio goes straight from one person to the other. No sign-up. No database. No
recording. **Nothing to leak, because nothing is stored.**

> Try it right now, no install → **[app.void-room.space](https://app.void-room.space)**

---

## how it works

```text
   you ──── mic ──── webrtc ──── mic ──── friend
                        │
                   signalling
                   (~5–20 kb/s)
                        │
                     void.srv
```

The server's entire job is to help two peers find each other — offers, answers, a
handful of ICE candidates. After that it is out of the loop. **It never sees a single
byte of your audio, your messages, or your files.** When direct connection is impossible
(symmetric / CG-NAT), a TURN relay carries the still-encrypted stream — the relay can't
read it either.

This isn't a privacy *policy*. It's the architecture. There is no media server in the
middle, no message store, no user table. The strongest guarantee a service can make is
to not have the data in the first place.

---

## try it

| | |
|---|---|
| **Web** — works in any modern browser, nothing to install | **[app.void-room.space](https://app.void-room.space)** |
| **Windows desktop** — native app: tray, global hotkeys, auto-update | **[download the installer](https://github.com/jettsba/void/releases/latest/download/void_installer.exe)** — one click, installs and auto-updates |

The web app and the desktop app are the **same codebase** — the desktop is the web client
running natively in a Tauri shell, with native Windows touches layered on top.

---

## what's inside

- **voice** — full-mesh WebRTC, direct peer-to-peer audio between everyone in the room (up to 5 by design), no server in the path
- **noise suppression** — RNNoise (ML model, WASM/AudioWorklet) strips out fans, keyboards, and background hum
- **chat & files** — over the data channel: text, files up to 100 MB, images up to 10 MB
- **screen sharing** — with real system audio, up to 1080p60
- **resilient by design** — perfect negotiation, automatic ICE-restart, peer rebuild, a watchdog that detects "dead-but-connected" peers
- **bilingual** — English / Russian, switchable in settings
- **streamer mode** — hides the room code so it never leaks on stream
- **native desktop** — frameless titlebar, system tray with live in-room status, global hotkeys, signed in-app auto-updates, `void://` deep links

---

## what void deliberately doesn't have

- no accounts, profiles, or avatars
- no database, no message history, no recording
- no analytics, no trackers, no third-party scripts
- no media server sitting between you and the other person
- no cookies or local storage holding anything personal

The only thing the server keeps on disk is a single JSON file of anonymous counters —
rooms created, peak concurrent users, connection-success ratio. No user data ever
touches it.

---

## built without the usual stack

No React. No bundlers. No `npm run build`. No TypeScript toolchain.

The entire frontend is **vanilla JavaScript**, loaded with `<script defer>` and served
as-is — the browser figures it out. The backend is ~200 lines of entry-point plus a
handful of focused modules. The whole thing is meant to be **read**: a complete,
production-hardened WebRTC system you can actually follow end to end, rather than a black
box behind an SDK.

| layer | tech |
|---|---|
| signalling | Node.js 20 · Express · ws |
| media transport | WebRTC mesh (perfect negotiation, DTLS-SRTP) |
| chat & files | RTCDataChannel (binary chunked transfer) |
| audio DSP | Web Audio API — RNNoise → high/low-pass → compressor → noise gate |
| frontend | vanilla JS, no frameworks, no build step |
| desktop | Tauri 2 (Rust + WebView2) |
| relay | coturn (TURN, HMAC short-lived credentials) |
| reverse proxy | Caddy (automatic HTTPS) |
| deploy | Docker + docker-compose, CI on push |

Production hardening is built in, not bolted on: strict CSP, security headers, origin
allow-listing, per-IP connection caps, token-bucket flood control, anti-bruteforce on
room joins, timing-safe admin auth, a read-only hardened container, and ed25519-signed
desktop updates.

---

## status

Active development — currently **v0.12.10**. Web and desktop ship independently.

**Done:** voice · chat · file & image transfer · screen share with system audio ·
reconnect / perfect negotiation / ICE-restart / zombie-watchdog · RNNoise · TURN (live
in production) · i18n · invite links & `void://`
deep-links · full Windows desktop (tray, hotkeys, autostart, signed auto-updater, custom
installer/uninstaller).

**Possible directions** (not commitments): camera video · push-to-talk · macOS / Linux
desktop · optional local recording · themes.

---

## for developers

Run it locally:

```bash
git clone https://github.com/jettsba/void.git
cd void
npm ci
npm start          # → http://localhost:3000
```

Self-hosting, environment variables, the TURN setup, the desktop build pipeline and the
in-browser debugging tools are all documented in **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

---

## feedback

Bugs, ideas, questions → open an [issue](https://github.com/jettsba/void/issues) or
reach out on [Telegram](https://t.me/mtbibltww). The web app ships fixes continuously;
the desktop app updates itself.

---

## license

[AGPL-3.0](LICENSE) © 2026 void — open source, copyleft. You're free to use, study, and
self-host it; network deployments of modified versions must share their changes.

---

<div align="center">
<br>
<sub>crafted by <a href="https://t.me/mtbibltww">casheaterr</a></sub>
<br>
</div>
