/* ============ Tray state sync (desktop-only) ============
   Хранит зеркало client-side состояния (в комнате / mic muted / screen sharing)
   и шлёт его в Rust через Tauri event при изменениях.
   Rust-сторона (lib.rs) слушает "void:set-tray-state" и обновляет tooltip/icon
   трея. В web-сборке модуль ничего не делает — Tauri runtime отсутствует. */

(function () {
    "use strict";

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__ || !window.__TAURI__.event) {
        console.warn("[tray] Tauri event API not available");
        return;
    }

    const state = {
        inRoom: false,
        roomCode: null,
        micMuted: false,
        screenSharing: false
    };

    /* Приоритет: screen_sharing → mic_muted → in_room → idle.
       Screen-share и mic-mute видим только в комнате. */
    function compute() {
        if (state.screenSharing) return "screen_sharing";
        if (state.inRoom && state.micMuted) return "mic_muted";
        if (state.inRoom) return "in_room";
        return "idle";
    }

    /* Каноничный домен для share-ссылки. В desktop location.origin =
       tauri://localhost, поэтому ссылку строить от origin НЕЛЬЗЯ — берём
       публичный домен (VoidApiBase его уже знает, см. desktop-bootstrap.js). */
    const SHARE_BASE = window.VoidApiBase || "https://app.void-room.space";
    function roomLink() {
        return state.roomCode
            ? `${SHARE_BASE}/?room=${encodeURIComponent(state.roomCode)}`
            : null;
    }

    /* Composite key для dedupe: если меняется только roomCode (а state тот же),
       нам всё равно нужно перепослать в Rust, чтобы tooltip обновился. */
    let last = null;
    function sync() {
        const next = compute();
        const key = `${next}|${state.roomCode || ""}`;
        if (key === last) return;
        last = key;
        window.__TAURI__.event
            .emit("void:set-tray-state", {
                state: next,
                roomCode: state.roomCode,
                roomLink: roomLink()
            })
            .catch((e) => console.warn("[tray] emit failed", e));
    }

    /* Публичный API — call-sites из room.js / controls.js / etc. шлют
       сюда patch объекта (только изменённые поля). Дедупликация sync(). */
    window.VoidDesktop = window.VoidDesktop || {};
    window.VoidDesktop.setTrayState = function (patch) {
        if (patch && typeof patch === "object") Object.assign(state, patch);
        sync();
    };

    /* Initial sync — на старте состояние "idle". */
    sync();
})();
