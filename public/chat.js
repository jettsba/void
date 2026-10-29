/* ========= CHAT =========
 * P2P чат поверх RTCDataChannel. Сервер не участвует, истории нет —
 * полностью в духе остального приложения.
 *
 * --- Протокол ---
 * Каждый канал ordered:true. Поэтому всё, что мы пишем в канал, придёт
 * в том же порядке, что и было отправлено. Этим пользуемся:
 *
 *   STRING (JSON):
 *     {type:"msg", kind:"text", msgId, ts, from, nick, text}
 *     {type:"msg", kind:"attachment", mediaKind:"image"|"file",
 *        msgId, ts, from, nick, name, mime, size, totalChunks}
 *
 *   BINARY (ArrayBuffer):
 *     сырые байты очередного чанка ТЕКУЩЕГО attachment'а на этом канале.
 *
 * После attachment-meta получатель ждёт ровно totalChunks бинарных
 * сообщений и складывает их в Blob. Никаких заголовков в чанках нет.
 *
 * --- Параллелизм ---
 * Чтобы текст / новый файл не вклинились между чанками текущей передачи,
 * ВСЕ отправки на канал прогоняются через per-channel send-queue (mutex).
 */

const CHAT_CHUNK_BYTES   = 60 * 1024;          // safe < 64KB SCTP recommended cap
const CHAT_HIGH_WATER    = 4 * 1024 * 1024;    // 4 MB — свыше — ждём опустошения
const CHAT_LOW_WATER     = 1 * 1024 * 1024;

/** F14: per-inbox watchdog. Если между чанками прошло больше — считаем
 *  передачу стухшей, освобождаем chunks[] (могут быть десятки МБ),
 *  помечаем сообщение как failed. До F14 удержание длилось до закрытия
 *  канала, которое могло прийти только после полного ICE-таймаута (~10s
 *  + 5s grace + 8s restart). */
const CHAT_INBOX_STALL_MS = 60_000;

const CHAT_MAX_IMAGE_MB  = 10;                 // исходник; даунскейлим до отправки
const CHAT_MAX_FILE_MB   = 100;                 // raw, без обработки
const CHAT_IMAGE_MAX_DIM = 1920;
const CHAT_IMAGE_QUALITY = 0.85;
const CHAT_TOAST_MS      = 2400;
const CHAT_JUMP_THRESHOLD_PX = 96;

/** Cap на длину принимаемого text-сообщения. Локально <textarea maxlength=2000>;
 *  принимаем с запасом ×2 — для будущих локалей с длинными словами или
 *  расширений (markdown). Всё, что больше — peer ведёт себя нечестно. */
const CHAT_MAX_TEXT_LEN = 4000;

/** LRU-кап на «живые» blob-URL'ы в чате. Раньше освобождались только
 *  при `resetChatOnLeave` — за долгую сессию с сотней картинок копится
 *  сотни МБ. Когда переполняем, прибиваем самый старый URL.
 *  Квота — НА КАЖДОГО отправителя: при общей квоте 31 мини-вложение одного
 *  участника отзывало все картинки и файлы остальных. */
const CHAT_MAX_LIVE_BLOB_URLS = 30;

/** Сколько сообщений чата держим в DOM. Чат эфемерный, но без потолка поток
 *  от одного участника растил DOM и память у всех без ограничений. 1000 —
 *  больше, чем набирается в самом длинном живом разговоре. */
const CHAT_MAX_MESSAGES = 1000;

/** Приём от одного участника: не больше N сообщений (текст, вложения, реакции)
 *  в секунду. Руками больше трёх не набрать, вставка — одно сообщение. Всё,
 *  что сверху, — флуд: молча отбрасываем. */
const CHAT_INBOUND_PER_SEC = 20;

/** Ник и имя файла от собеседника режем до этой длины (ник 200 тысяч
 *  символов рендерился целиком). msgId — идентификатор, а не текст. */
const CHAT_MAX_NAME_LEN = 64;
const CHAT_MAX_MSGID_LEN = 64;

/* Long-press-жест: время удержания pointer'а до показа контекстного меню,
   и максимальный сдвиг (px²) — больше → считаем за drag/scroll и отменяем. */
const LIKE_LONGPRESS_MS    = 420;
const LIKE_LONGPRESS_MAX_DIST_SQ = 100; // 10px радиус
const LIKE_TARGET_MAX_LEN  = 80;        // sanity cap для msgId извне

/* ========= STATE ========= */

const chatChannels       = new Map(); // userId → RTCDataChannel
const channelSendQueues  = new Map(); // userId → Promise (последовательная очередь send'ов)
const channelInbox       = new Map(); // userId → {meta, chunks:[], received, totalBytes}
const objectUrlsToRevoke = new Set(); // URL.createObjectURL — чистим при выходе

/** msgId → Map<userId, "like"|"dislike">. Реакции эфемерны как и сам чат:
 *  хранятся только пока DOM-узел сообщения жив. У каждого юзера ОДНА реакция на
 *  сообщение (лайк ЛИБО дизлайк — взаимоисключающие). Поздним джойнерам прошлые
 *  реакции не видны (как и сами прошлые сообщения). */
const messageReactions = new Map();

/** LRU для blob-URL'ов: Map сохраняет порядок вставки, переставляем
 *  через delete + set когда URL переиспользуется. */
const liveBlobUrls = new Map(); // url → owner userId

/** msgId → userId автора. msgId генерирует отправитель, и раньше любой мог
 *  прислать вложение с ЧУЖИМ msgId: при сборке файла поиск по id находил узел
 *  жертвы и подменял в нём картинку или файл («invoice.pdf.exe» под ником
 *  честного человека). Первый, кто занял msgId, им и владеет; повтор — отбой. */
const msgOwners = new Map();

/** userId → {windowStart, count, warned} — счётчик приёма для CHAT_INBOUND_PER_SEC. */
const inboundRate = new Map();

let chatPendingAttachments = []; // [{id, file, kind, previewUrl}]

let chatPanel;
let chatToggleBtn;
let chatJumpBtn;
let chatMessagesEl;
let chatPendingEl;
let chatToastEl;
let chatInputEl;
let chatSendBtn;
let chatAttachBtn;
let chatFileInput;
let chatDropOverlay;
let chatLightbox;
let chatLightboxImg;
let chatLightboxCloseBtn;

let chatOpen = false;
let chatToastTimer = null;
let chatHasMessages = false;
let dragCounter = 0;
let lightboxState = null; // {sourceImg, escHandler}
let lightboxCloseTimer = null;

let ctxMenuEl = null;
let ctxMenuOutsideHandler = null;

/* ========= INIT ========= */

function initChat() {
    chatPanel            = document.getElementById("chatPanel");
    chatToggleBtn        = document.getElementById("chatToggleBtn");
    chatJumpBtn          = document.getElementById("chatJumpBtn");
    chatMessagesEl       = document.getElementById("chatMessages");
    chatPendingEl        = document.getElementById("chatPending");
    chatToastEl          = document.getElementById("chatToast");
    chatInputEl          = document.getElementById("chatInput");
    chatSendBtn          = document.getElementById("chatSendBtn");
    chatAttachBtn        = document.getElementById("chatAttachBtn");
    chatFileInput        = document.getElementById("chatFileInput");
    chatDropOverlay      = document.getElementById("chatDropOverlay");
    chatLightbox         = document.getElementById("chatLightbox");
    chatLightboxImg      = document.getElementById("chatLightboxImg");
    chatLightboxCloseBtn = document.getElementById("chatLightboxClose");

    if (!chatPanel || !chatToggleBtn) return;

    chatToggleBtn.addEventListener("click", toggleChat);
    chatJumpBtn?.addEventListener("click", () => {
        scrollChatToBottom(true);
        refreshChatJumpButton();
    });
    chatSendBtn  .addEventListener("click", sendChatFromInput);
    chatAttachBtn.addEventListener("click", () => chatFileInput.click());

    chatInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendChatFromInput();
        }
    });
    chatInputEl.addEventListener("input", autoResizeInput);
    chatInputEl.addEventListener("paste", handleChatPaste);
    // Стартовая синхронизация: браузер может восстановить значение textarea
    // после reload, а input-события при этом не будет.
    autoResizeInput();

    chatFileInput.addEventListener("change", (e) => {
        for (const f of e.target.files) addPendingAttachment(f, autoKindForFile(f));
        chatFileInput.value = "";
    });

    chatLightboxCloseBtn.addEventListener("click", closeLightbox);
    chatLightbox.addEventListener("click", (e) => {
        if (e.target === chatLightbox) closeLightbox();
    });

    /* ПКМ по увеличенному фото — своё меню вместо дефолтного webview/браузера.
       Пункты строим от исходного thumbnail-<img> (lightboxState.sourceImg) —
       у него есть .chat-attach-image класс и alt/src, которые buildContextMenuItems
       ожидает; сам chatLightboxImg — другой узел с другим классом. */
    chatLightboxImg.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!lightboxState || !lightboxState.sourceImg) return;
        const img = lightboxState.sourceImg;
        const wrap = img.closest(".chat-msg");
        const msgId = wrap?.dataset.msgId;
        openContextMenu(buildContextMenuItems(img, wrap, msgId), e.clientX, e.clientY);
    });

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (ctxMenuEl)     { closeContextMenu(); return; }
        if (lightboxState) { closeLightbox(); return; }
        if (chatOpen)      { setChatOpen(false); }
    });

    chatMessagesEl.addEventListener("scroll", refreshChatJumpButton);

    /* Делегированный клик по ссылке / кнопке скачивания файла. После добавления
       контекстного меню (v0.14.0) голый <a> перестал работать в desktop-webview:
       ссылки не открывали браузер (навигация из вебвью заблокирована), а
       <a download blob:> тихо лил файл в «Загрузки» мимо нативного диалога.
       Перехватываем оба клика здесь. Long-press-жест гасит свой ghost-click
       capture-листенером на .chat-msg (см. armGhostClickSuppression) — он
       stopPropagation'ит раньше, чем событие дойдёт сюда, так что меню и
       обычный клик не конфликтуют. */
    chatMessagesEl.addEventListener("click", (e) => {
        const link = e.target.closest?.(".chat-msg-link");
        if (link) {
            e.preventDefault();
            openExternalUrl(link.href);
            return;
        }
        const fileDl = e.target.closest?.(".chat-attach-file-dl");
        if (fileDl && fileDl.href) {
            e.preventDefault();
            saveBlobUrl(fileDl.href, fileDl.download || "file");
        }
    });

    if (typeof ResizeObserver !== "undefined" && chatMessagesEl) {
        const roJump = new ResizeObserver(refreshChatJumpButton);
        roJump.observe(chatMessagesEl);
    }

    setupGlobalDragAndDrop();
    syncChatToggleLabel();

    document.addEventListener("void:locale-changed", () => {
        /* applyI18n уже прошёлся по DOM (и по data-i18n="chat.you" в истории
           сообщений), здесь добиваем динамику, не обвязанную атрибутами. */
        syncChatToggleLabel();
    });
}

function _ct(key, vars) {
    return (typeof window !== "undefined" && window.VoidI18n)
        ? window.VoidI18n.t(key, vars)
        : key;
}

function syncChatToggleLabel() {
    if (!chatToggleBtn) return;
    chatToggleBtn.setAttribute("aria-label", chatOpen ? _ct("header.chat.close") : _ct("header.chat.show"));
    chatToggleBtn.setAttribute("aria-expanded", chatOpen ? "true" : "false");
}

function refreshChatJumpButton() {
    if (!chatJumpBtn || !chatMessagesEl) return;
    let show = false;
    if (chatOpen && chatHasMessages) {
        const gap =
            chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight;
        show = gap > CHAT_JUMP_THRESHOLD_PX;
    }
    chatJumpBtn.classList.toggle("is-visible", show);
    chatJumpBtn.setAttribute("aria-hidden", show ? "false" : "true");
}

/* ========= OPEN / CLOSE ========= */

function toggleChat() {
    setChatOpen(!chatOpen);
}

function setChatOpen(open) {
    chatOpen = !!open;
    chatPanel.classList.toggle("is-open", chatOpen);
    // inert: браузер сам уводит фокус наружу + блокирует клики/таб. Парный
    // aria-hidden оставляем для старых ассистивных технологий, которые ещё
    // не научились читать inert (без inert получаем варнинг "aria-hidden on
    // an element with focused descendant").
    chatPanel.toggleAttribute("inert", !chatOpen);
    chatPanel.setAttribute("aria-hidden", chatOpen ? "false" : "true");
    chatToggleBtn.classList.toggle("is-open", chatOpen);
    chatToggleBtn.setAttribute("aria-pressed", chatOpen ? "true" : "false");
    document.body.classList.toggle("chat-open", chatOpen);
    syncChatToggleLabel();

    /* Сцена сужается/расширяется под чат-панель (padding-right, ~t-med) →
       корона участников переезжает в новую область. Второй вызов после
       перехода — досадить финальную геометрию. */
    if (typeof scheduleParticipantsLayout === "function") {
        scheduleParticipantsLayout(false);
        setTimeout(() => scheduleParticipantsLayout(false), 360);
    }

    if (chatOpen) {
        clearUnreadBadge();
        setTimeout(() => chatInputEl.focus({ preventScroll: true }), 120);
        scrollChatToBottom(false);
        requestAnimationFrame(refreshChatJumpButton);
        return;
    }
    refreshChatJumpButton();
}

/** Полный сброс чата при выходе из комнаты. */
function resetChatOnLeave() {
    setChatOpen(false);
    clearUnreadBadge();

    chatPendingAttachments.forEach(p => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    });
    chatPendingAttachments = [];
    renderPendingAttachments();

    chatInputEl.value = "";
    autoResizeInput();

    /* M10: сначала revoke, потом стираем DOM. Иначе между двумя строками
       порядок «GC уже забрал blob» не гарантирован, и img.src=blob:... может
       тянуть мёртвую ссылку. */
    objectUrlsToRevoke.forEach(url => {
        try { URL.revokeObjectURL(url); } catch (_) {}
    });
    objectUrlsToRevoke.clear();
    liveBlobUrls.clear();

    chatMessagesEl.innerHTML = "";
    chatHasMessages = false;
    chatPanel.classList.remove("has-messages");

    /* F14: гасим per-inbox таймеры перед clear, чтобы не тикали впустую после
       leave room. Сам failPendingMessage safe (querySelector null-guarded). */
    channelInbox.forEach(inbox => clearInboxWatchdog(inbox));
    channelInbox.clear();
    channelSendQueues.clear();
    messageReactions.clear();
    msgOwners.clear();
    inboundRate.clear();
    closeContextMenu();

    if (lightboxState) closeLightbox();

    dragCounter = 0;
    if (chatDropOverlay) chatDropOverlay.classList.remove("is-active");
    refreshChatJumpButton();
}

/* ========= DATA CHANNEL HOOKS (вызываются из webrtc.js) ========= */

function setupChatChannelForPeer(peer, userId, isInitiator) {
    if (isInitiator) {
        try {
            const channel = peer.createDataChannel("chat", { ordered: true });
            bindChatChannel(channel, userId);
        } catch (err) {
            log.warn("chat", "createDataChannel failed", { err: err?.message || String(err) });
        }
    } else {
        peer.addEventListener("datachannel", (e) => {
            if (e.channel && e.channel.label === "chat") {
                bindChatChannel(e.channel, userId);
            }
        });
    }
}

function bindChatChannel(channel, userId) {
    chatChannels.set(userId, channel);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = CHAT_LOW_WATER;

    channel.onopen = () => {
        log.debug("chat", "channel open", { userId });
        window.VoidSafety?.onChannelOpen(userId);
    };
    channel.onclose = () => {
        if (chatChannels.get(userId) === channel) {
            chatChannels.delete(userId);
        }
        // Прибираем незавершённый приём с этого канала.
        const inbox = channelInbox.get(userId);
        if (inbox) {
            clearInboxWatchdog(inbox);
            failPendingMessage(inbox.node);
            channelInbox.delete(userId);
        }
    };
    channel.onerror = (e) => {
        const err = e?.error;
        const msg = err?.message || e?.message || "";
        /* SCTP "User-Initiated Abort" (cause code 12) — это штатное закрытие
           канала нашей же стороной (peer.close() в cleanupPeerSlot, либо явный
           channel.close() в detachChatChannelForUser). Не ошибка, не логируем.
           Чекаем и структурно (errorDetail/sctpCauseCode), и по тексту —
           структурные поля есть не во всех браузерах. */
        if (err?.errorDetail === "sctp-failure" && err?.sctpCauseCode === 12) return;
        if (/User-Initiated Abort.*Close called/i.test(msg)) return;
        log.warn("chat", "channel error", { userId, err: msg });
    };
    channel.onmessage = (e) => handleIncoming(e.data, userId);
}

function detachChatChannelForUser(userId) {
    const ch = chatChannels.get(userId);
    if (ch) {
        try { ch.close(); } catch (_) {}
        chatChannels.delete(userId);
    }
    channelSendQueues.delete(userId);
    const inbox = channelInbox.get(userId);
    if (inbox) {
        clearInboxWatchdog(inbox);
        failPendingMessage(inbox.node);
        channelInbox.delete(userId);
    }
}

/* F14: per-inbox stall watchdog. Сбрасывается на каждый новый чанк; если за
   CHAT_INBOX_STALL_MS не пришло ни одного — считаем передачу стухшей и
   освобождаем chunks (могут быть десятки МБ в RAM). */
function startInboxWatchdog(userId, inbox) {
    clearInboxWatchdog(inbox);
    inbox._timer = setTimeout(() => {
        log.warn("chat", "inbox stalled, dropping", {
            userId, msgId: inbox.meta.msgId,
            received: inbox.received, total: inbox.meta.totalChunks
        });
        failPendingMessage(inbox.node);
        channelInbox.delete(userId);
    }, CHAT_INBOX_STALL_MS);
}

function clearInboxWatchdog(inbox) {
    if (inbox?._timer) {
        clearTimeout(inbox._timer);
        inbox._timer = null;
    }
}

/* ========= SEND ========= */

/**
 * Per-channel mutex: каждое следующее задание ждёт предыдущее.
 * Гарантирует, что текст и чанки разных attachment'ов не перемешаются.
 */
function enqueueSend(userId, work) {
    const prev = channelSendQueues.get(userId) || Promise.resolve();
    const next = prev.then(work).catch(err => {
        log.warn("chat", "send work failed", { userId, err: err?.message || String(err) });
    });
    channelSendQueues.set(userId, next);
    return next;
}

function sendChatFromInput() {
    const text = (chatInputEl.value || "").trim();
    const hasAttachments = chatPendingAttachments.length > 0;

    if (!text && !hasAttachments) return;

    if (text) {
        sendChatText(text);
        chatInputEl.value = "";
        autoResizeInput();
    }

    if (hasAttachments) {
        const queue = chatPendingAttachments.slice();
        chatPendingAttachments = [];
        renderPendingAttachments();
        // Шлём по очереди — не забиваем буфер всем разом.
        // Очередь не блокирует ввод следующих сообщений: работает в фоне.
        (async () => {
            for (const item of queue) {
                try {
                    await sendChatAttachment(item.file, item.kind);
                } catch (err) {
                    log.warn("chat", "send attachment failed", { err: err?.message || String(err) });
                    showChatToast(_ct("chat.send.failed"));
                }
                if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
            }
        })();
    }
}

function sendChatText(text) {
    const msg = {
        type: "msg",
        kind: "text",
        msgId: newMsgId(),
        ts: Date.now(),
        from: getSelfId(),
        nick: getSelfNick(),
        text
    };
    appendMessage(msg, true);
    const json = JSON.stringify(msg);
    chatChannels.forEach((channel, uid) => {
        enqueueSend(uid, async () => {
            if (channel.readyState !== "open") return;
            try { channel.send(json); }
            catch (err) { log.warn("chat", "text send failed", { userId: uid, err: err?.message || String(err) }); }
        });
    });
}

async function sendChatAttachment(file, kind) {
    let payloadBytes;
    let displayName = file.name || (kind === "image" ? "image" : "file");
    let displayMime = file.type || "application/octet-stream";

    if (kind === "image") {
        try {
            const blob = await downscaleImage(file, CHAT_IMAGE_MAX_DIM, CHAT_IMAGE_QUALITY);
            payloadBytes = await blob.arrayBuffer();
            displayMime = blob.type || "image/jpeg";
            if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(displayName)) {
                displayName = displayName.replace(/\.[^.]+$/, "") + ".jpg";
            }
        } catch (err) {
            log.warn("chat", "image downscale failed, sending original", { err: err?.message || String(err) });
            payloadBytes = await file.arrayBuffer();
        }
    } else {
        payloadBytes = await file.arrayBuffer();
    }

    const totalChunks = Math.max(1, Math.ceil(payloadBytes.byteLength / CHAT_CHUNK_BYTES));
    const msgId = newMsgId();
    const meta = {
        type: "msg",
        kind: "attachment",
        mediaKind: kind,
        msgId,
        ts: Date.now(),
        from: getSelfId(),
        nick: getSelfNick(),
        name: displayName,
        mime: displayMime,
        size: payloadBytes.byteLength,
        totalChunks
    };

    // Локально показываем сразу. Если в комнате никого — сразу ready.
    const localBlob = new Blob([payloadBytes], { type: displayMime });
    const localUrl = URL.createObjectURL(localBlob);
    trackBlobUrl(localUrl);
    appendMessage(meta, true, { url: localUrl, ready: chatChannels.size === 0 });

    if (chatChannels.size === 0) return;

    const json = JSON.stringify(meta);
    const tasks = [];
    chatChannels.forEach((channel, uid) => {
        tasks.push(enqueueSend(uid, async () => {
            if (channel.readyState !== "open") return;
            try { channel.send(json); }
            catch (err) { log.warn("chat", "meta send failed", { userId: uid, err: err?.message || String(err) }); return; }
            await sendChunksToChannel(channel, payloadBytes, totalChunks);
        }));
    });
    await Promise.all(tasks);
    markOwnAttachmentReady(meta.msgId);
}

async function sendChunksToChannel(channel, buffer, totalChunks) {
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < totalChunks; i++) {
        if (channel.readyState !== "open") return;

        const start = i * CHAT_CHUNK_BYTES;
        const end = Math.min(start + CHAT_CHUNK_BYTES, bytes.byteLength);
        // .slice(...) копирует — у получившейся Uint8Array свой ArrayBuffer
        // ровно нужного размера, без хвоста родительского буфера.
        const slice = bytes.slice(start, end);

        if (channel.bufferedAmount > CHAT_HIGH_WATER) {
            await waitForLowBuffer(channel);
            if (channel.readyState !== "open") return;
        }

        try {
            channel.send(slice);
        } catch (err) {
            log.warn("chat", "chunk send failed", { err: err?.message || String(err) });
            return;
        }
    }
}

/* F6: peer может сдохнуть, пока буфер всё ещё выше CHAT_HIGH_WATER, и тогда
   `bufferedamountlow` НИКОГДА не сработает. Без timeout/onclose-резолва Promise
   висит вечно → per-channel mutex заперт → любые следующие отправки на этот
   канал блокируются навсегда, а ArrayBuffer текущего чанка (до 100 MB)
   удерживается в RAM через async-кадр. Резолвим по любому из трёх условий:
   bufferedamountlow, close канала, либо 30s hard cap. */
const CHAT_LOW_BUFFER_TIMEOUT_MS = 30_000;

function waitForLowBuffer(channel) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            channel.removeEventListener("bufferedamountlow", onLow);
            channel.removeEventListener("close", finish);
            channel.removeEventListener("error", finish);
            clearTimeout(timer);
            resolve();
        };
        const onLow = () => finish();
        channel.addEventListener("bufferedamountlow", onLow);
        channel.addEventListener("close", finish);
        channel.addEventListener("error", finish);
        const timer = setTimeout(finish, CHAT_LOW_BUFFER_TIMEOUT_MS);
    });
}

/* ========= RECEIVE ========= */

/* Окно в секунду на каждого собеседника. Предупреждение в лог — один раз на
   окно, иначе флудер утопил бы и лог. */
function inboundAllowed(userId) {
    const now = Date.now();
    let r = inboundRate.get(userId);
    if (!r || now - r.windowStart >= 1000) {
        r = { windowStart: now, count: 0, warned: false };
        inboundRate.set(userId, r);
    }
    r.count += 1;
    if (r.count <= CHAT_INBOUND_PER_SEC) return true;
    if (!r.warned) {
        r.warned = true;
        log.warn("chat", "inbound flood dropped", { userId });
    }
    return false;
}

function isValidMsgId(id) {
    return typeof id === "string" && id.length > 0 && id.length <= CHAT_MAX_MSGID_LEN;
}

/* Имя файла от собеседника → безопасное для показа и для диска:
   - управляющие символы и bidi-override'ы (U+202E «развернуть»: «gpj.exe»
     показывается как «exe.jpg») вон;
   - запрещённые в Windows символы → «_», без ведущих/хвостовых точек и пробелов
     («фото.jpg .exe» → обход проверки расширения);
   - зарезервированные имена Windows (CON, NUL, COM1…) → с префиксом;
   - не длиннее CHAT_MAX_NAME_LEN, расширение при обрезке сохраняем.
   Тот же фильтр повторяет Rust при записи на диск (save_file) — последний рубеж. */
const FILENAME_STRIP_RX = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const FILENAME_RESERVED_RX = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

function safeFileName(raw, fallback = "file") {
    let name = typeof raw === "string" ? raw : "";
    name = name.replace(FILENAME_STRIP_RX, "")
        .replace(/[<>:"/\\|?*]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^[\s.]+|[\s.]+$/g, "");
    if (!name) return fallback;
    if (FILENAME_RESERVED_RX.test(name)) name = "_" + name;
    if (name.length > CHAT_MAX_NAME_LEN) {
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
        name = name.slice(0, CHAT_MAX_NAME_LEN - ext.length) + ext;
    }
    return name;
}

/* Расширения, которые Windows запускает двойным кликом. Такие файлы от
   собеседника передаём (друзья пересылают друг другу программы), но в чате
   помечаем, а перед сохранением на десктопе переспрашиваем. */
const EXECUTABLE_EXT_RX = /\.(exe|msi|msix|msp|bat|cmd|com|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|jar|appx|appxbundle|application|gadget|inf|scf|sct)$/i;

function isExecutableName(name) {
    return typeof name === "string" && EXECUTABLE_EXT_RX.test(name);
}

function handleIncoming(data, userId) {
    if (typeof data === "string") {
        let json;
        try { json = JSON.parse(data); } catch { return; }
        /* «null», числа, массивы — валидный JSON, но не сообщение. Раньше
           строка "null" роняла обработчик (json.type у null). */
        if (!json || typeof json !== "object" || Array.isArray(json)) return;
        /* Код безопасности (js/safety-code.js) едет по тому же каналу:
           отправитель — владелец канала, поле from не нужно. Под лимит чата не
           попадает: у него свой бюджет в safety-code.js. */
        if (json.type === "sas") {
            window.VoidSafety?.onMessage(json, userId);
            return;
        }
        if (json.type !== "msg") return;
        if (!inboundAllowed(userId)) return;

        /* B1: anti-spoof. Канал был открыт под конкретный userId — это и есть
           логический отправитель. Если peer прислал свой json с чужим `from`,
           отбрасываем: иначе UI припишет сообщение жертве и ломается атрибуция
           в групповом чате. nick оставляем как пришло (это display name, не
           идентичность), но `from` жёстко переписываем на владельца канала. */
        if (json.from && json.from !== userId) {
            log.warn("chat", "from-spoof rejected", { channel: userId, claimed: json.from });
            return;
        }
        json.from = userId;

        if (json.kind === "like") {
            const target = json.target;
            if (typeof target !== "string" || !target || target.length > LIKE_TARGET_MAX_LEN) return;
            if (json.op !== "add" && json.op !== "remove") return;
            /* feel — новое поле (v0.15.3). Старые клиенты его не шлют → дефолт
               "like" (обратная совместимость: их лайки остаются лайками). */
            const feel = json.feel === "dislike" ? "dislike" : "like";
            applyReaction(target, userId, json.op, feel);
            return;
        }

        if (json.kind !== "text" && json.kind !== "attachment") return;

        /* msgId: непустая строка разумной длины и ещё никем не занятая — ни
           нашим сообщением, ни чужим, ни прошлым этого же собеседника. */
        if (!isValidMsgId(json.msgId)) return;
        if (msgOwners.has(json.msgId)) {
            log.warn("chat", "colliding msgId rejected", { userId, owner: msgOwners.get(json.msgId) });
            return;
        }

        if (json.kind === "text") {
            /* B2: cap длины. Локально <textarea maxlength="2000">, но peer
               может прислать любой размер. Без cap'а можно положить layout
               5-мегабайтным текстом. */
            if (typeof json.text !== "string" || json.text.length > CHAT_MAX_TEXT_LEN) {
                log.warn("chat", "rejected oversized text", { userId, len: json.text?.length });
                return;
            }
            appendMessage(json, false);
            return;
        }

        if (json.kind === "attachment") {
            json.name = safeFileName(json.name, json.mediaKind === "image" ? "image" : "file");
            // sanity
            const cap = (json.mediaKind === "image" ? CHAT_MAX_IMAGE_MB : CHAT_MAX_FILE_MB) * 1024 * 1024;
            if (typeof json.size !== "number" || json.size <= 0 || json.size > cap * 1.5) {
                log.warn("chat", "rejected oversized attachment", { userId, size: json.size });
                return;
            }
            /* B3: totalChunks привязываем к реальному лимиту файла, а не к
               абстрактным 200000 (× 60 КБ ≈ 12 ГБ — в 1000× больше cap'а).
               +5% запаса покрывает округление и meta-overhead. */
            const expectedMaxChunks = Math.ceil(cap * 1.05 / CHAT_CHUNK_BYTES);
            if (typeof json.totalChunks !== "number"
                || json.totalChunks <= 0
                || json.totalChunks > expectedMaxChunks) {
                log.warn("chat", "rejected attachment with bad chunk count", { userId, totalChunks: json.totalChunks });
                return;
            }
            // Если предыдущий приём не завершился — закрываем его как failed.
            const prev = channelInbox.get(userId);
            if (prev) {
                clearInboxWatchdog(prev);
                failPendingMessage(prev.node);
            }

            /* node — прямая ссылка на узел ЭТОГО сообщения: прогресс и готовый
               файл пишем только в него, а не в «первый найденный по msgId». */
            const newInbox = {
                meta: json,
                node: null,
                chunks: [],
                received: 0,
                totalBytes: 0,
                _timer: null
            };
            channelInbox.set(userId, newInbox);
            startInboxWatchdog(userId, newInbox);
            newInbox.node = appendMessage(json, false, { ready: false });
            return;
        }
        return;
    }

    if (data instanceof ArrayBuffer) {
        const inbox = channelInbox.get(userId);
        if (!inbox) {
            log.warn("chat", "unexpected binary chunk (no inbox)", { userId });
            return;
        }
        inbox.chunks.push(data);
        inbox.received += 1;
        inbox.totalBytes += data.byteLength;
        /* F14: пришёл свежий чанк — пересбрасываем watchdog. */
        startInboxWatchdog(userId, inbox);

        if (inbox.totalBytes > inbox.meta.size + CHAT_CHUNK_BYTES) {
            log.warn("chat", "transfer overflow, aborting", { msgId: inbox.meta.msgId });
            clearInboxWatchdog(inbox);
            failPendingMessage(inbox.node);
            channelInbox.delete(userId);
            return;
        }

        updateMessageProgress(inbox.node, inbox.received / inbox.meta.totalChunks);

        if (inbox.received >= inbox.meta.totalChunks) {
            clearInboxWatchdog(inbox);
            const blob = new Blob(inbox.chunks, {
                type: inbox.meta.mime || "application/octet-stream"
            });
            const url = URL.createObjectURL(blob);
            trackBlobUrl(url, userId);
            finalizeMessageAttachment(inbox.node, url, inbox.meta);
            channelInbox.delete(userId);
        }
    }
}

/* ========= UI: messages list ========= */

/* Имя автора входящего сообщения — из реестра участников (nicknameMap), который
   ведёт сервер, а не из поля nick в самом сообщении: его пишет отправитель, и
   раньше можно было подписаться чужим именем. Если такой же ник в комнате у
   кого-то ещё (включая нас) — добавляем хвост id, чтобы дубль был различим.
   Участник уже ушёл, а канал ещё донёс сообщение — имени в реестре нет:
   честно пишем «неизвестный», без доверия к присланному. */
function chatAuthorName(userId) {
    const nick = typeof nicknameMap !== "undefined" ? nicknameMap.get(userId) : null;
    if (!nick) return { text: _ct("chat.unknown"), unverified: true };
    const key = nick.toLowerCase();
    let dup = false;
    if (typeof nicknameMap !== "undefined") {
        for (const [id, other] of nicknameMap) {
            if (id !== userId && typeof other === "string" && other.toLowerCase() === key) { dup = true; break; }
        }
    }
    return { text: dup ? `${nick} #${String(userId).slice(0, 4)}` : nick, unverified: false };
}

/* Звук и бейдж непрочитанного — не чаще раза в секунду, даже если сообщения
   сыплются пачкой. */
let _lastMessageSoundAt = 0;

/* Потолок истории: старейшие сообщения уходят из DOM вместе со своими
   реакциями и записью о владельце msgId. */
function trimChatHistory() {
    while (chatMessagesEl.childElementCount > CHAT_MAX_MESSAGES) {
        const oldest = chatMessagesEl.firstElementChild;
        if (!oldest) break;
        const id = oldest.dataset.msgId;
        if (id) {
            messageReactions.delete(id);
            msgOwners.delete(id);
        }
        oldest.remove();
    }
}

function appendMessage(msg, isSelf, attachState = null) {
    msgOwners.set(msg.msgId, isSelf ? getSelfId() : msg.from);

    const wrap = document.createElement("div");
    wrap.className = "chat-msg" + (isSelf ? " chat-msg-self" : "");
    wrap.dataset.msgId = msg.msgId;

    const head = document.createElement("div");
    head.className = "chat-msg-head";

    const nick = document.createElement("span");
    nick.className = "chat-msg-nick";
    if (isSelf) {
        nick.dataset.i18n = "chat.you";
        nick.textContent = _ct("chat.you");
    } else {
        const author = chatAuthorName(msg.from);
        nick.textContent = author.text;
        if (author.unverified) nick.classList.add("is-unverified");
    }

    const time = document.createElement("span");
    time.className = "chat-msg-time";
    time.textContent = formatTime(msg.ts);

    head.appendChild(nick);
    head.appendChild(time);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "chat-msg-body";

    if (msg.kind === "text") {
        renderTextWithLinks(body, msg.text || "");
    } else if (msg.kind === "attachment") {
        body.appendChild(renderAttachment(msg, isSelf, attachState));
    }

    wrap.appendChild(body);
    attachLikeGestures(wrap, msg.msgId);
    chatMessagesEl.appendChild(wrap);
    renderReactionBadge(msg.msgId);
    trimChatHistory();

    if (!chatHasMessages) {
        chatHasMessages = true;
        chatPanel.classList.add("has-messages");
    }

    const nearBottom =
        chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 80;
    if (nearBottom || isSelf) {
        scrollChatToBottom(true);
    }

    if (!isSelf && !chatOpen) {
        const now = Date.now();
        if (now - _lastMessageSoundAt >= 1000) {
            _lastMessageSoundAt = now;
            markUnread();
            playMessageSound();
        }
    }

    requestAnimationFrame(refreshChatJumpButton);
    return wrap;
}

/* Домен без протокола (claude.ai, example.co.uk) тоже линкуется — не только
   явный https://. Финальный лейбл обязан быть буквенным 2-24 симв. (TLD),
   поэтому "e.g." / "3.14" / версии вида "1.2.3" не задеваются (см. VOID
   CLAUDE.md-обсуждение). Протокол в href всегда есть — bare-домен получает
   https:// сам (иначе браузер трактует "claude.ai" как relative-путь). */
const DOMAIN_LABEL_RX = "[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";
const URL_RX = new RegExp(
    "(?:https?://)?(?:" + DOMAIN_LABEL_RX + "\\.)+[a-zA-Z]{2,24}(?::\\d{1,5})?(?:/[^\\s<>\"']*)?",
    "g"
);

function renderTextWithLinks(el, text) {
    URL_RX.lastIndex = 0;
    let lastIdx = 0;
    let m;
    while ((m = URL_RX.exec(text)) !== null) {
        if (m.index > lastIdx) {
            el.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        }
        const raw = m[0];
        const href = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "chat-msg-link";
        a.textContent = raw;
        el.appendChild(a);
        lastIdx = m.index + raw.length;
    }
    if (lastIdx < text.length) {
        el.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
}

function renderAttachment(msg, isSelf, attachState) {
    const container = document.createElement("div");
    container.className = "chat-attach";
    container.dataset.msgId = msg.msgId;

    if (msg.mediaKind === "image") {
        const img = document.createElement("img");
        img.className = "chat-attach-image";
        img.alt = msg.name || "image";
        if (attachState && attachState.url) {
            img.src = attachState.url;
        } else {
            img.classList.add("is-loading");
        }
        img.addEventListener("click", () => {
            if (img.src) openLightbox(img);
        });
        container.appendChild(img);
    } else {
        const fi = document.createElement("div");
        fi.className = "chat-attach-file";

        const ic = document.createElement("span");
        ic.className = "chat-attach-file-ico";
        ic.textContent = "◫";

        const meta = document.createElement("div");
        meta.className = "chat-attach-file-meta";

        const title = document.createElement("div");
        title.className = "chat-attach-file-title";

        const nm = document.createElement("div");
        nm.className = "chat-attach-file-name";
        nm.textContent = msg.name || "file";
        title.appendChild(nm);

        /* Программа или скрипт от собеседника — видно сразу, до скачивания:
           значок (!) после имени, объяснение — всплывашкой при наведении
           (initExeTips ниже). Строкой под размером оно растягивало карточку. */
        if (!isSelf && isExecutableName(msg.name)) {
            fi.classList.add("is-executable");
            const warn = document.createElement("span");
            warn.className = "chat-attach-file-exe";
            warn.tabIndex = 0;
            warn.setAttribute("role", "img");
            warn.dataset.i18nAttr = "aria-label:chat.exe.badge";
            warn.setAttribute("aria-label", _ct("chat.exe.badge"));
            warn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4"/><path d="M8 4.6v4.2"/><circle class="dot" cx="8" cy="11.2" r=".55"/></svg>';
            title.appendChild(warn);
        }

        const sz = document.createElement("div");
        sz.className = "chat-attach-file-size";
        sz.textContent = formatSize(msg.size || 0);

        meta.appendChild(title);
        meta.appendChild(sz);

        const dl = document.createElement("a");
        dl.className = "chat-attach-file-dl";
        dl.textContent = "↓";
        dl.setAttribute("aria-label", _ct("chat.download"));
        dl.download = msg.name || "file";
        if (attachState && attachState.url) dl.href = attachState.url;

        fi.appendChild(ic);
        fi.appendChild(meta);
        fi.appendChild(dl);
        container.appendChild(fi);
    }

    const progress = document.createElement("div");
    progress.className = "chat-attach-progress";
    const bar = document.createElement("div");
    bar.className = "chat-attach-progress-bar";
    if (attachState && attachState.ready) bar.style.width = "100%";
    progress.appendChild(bar);
    container.appendChild(progress);

    if (attachState && attachState.ready) {
        container.classList.add("is-ready");
    }

    return container;
}

/* Узел сообщения: входящие вложения передают прямую ссылку (inbox.node),
   свои — msgId (он наш и гарантированно уникален). Узел, вытесненный из
   истории потолком CHAT_MAX_MESSAGES, уже не в DOM — писать в него незачем. */
function msgNode(target) {
    if (!target) return null;
    if (typeof target !== "string") return target.isConnected ? target : null;
    return chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(target)}"]`);
}

function updateMessageProgress(target, frac) {
    const wrap = msgNode(target);
    if (!wrap) return;
    const bar = wrap.querySelector(".chat-attach-progress-bar");
    if (bar) bar.style.width = Math.round(Math.min(1, frac) * 100) + "%";
}

function finalizeMessageAttachment(target, url, meta) {
    const wrap = msgNode(target);
    if (!wrap) return;
    const attach = wrap.querySelector(".chat-attach");
    if (!attach) return;

    if (meta.mediaKind === "image") {
        const img = attach.querySelector(".chat-attach-image");
        if (img) {
            img.src = url;
            img.classList.remove("is-loading");
        }
    } else {
        const dl = attach.querySelector(".chat-attach-file-dl");
        if (dl) {
            dl.href = url;
            dl.download = meta.name || "file";
        }
    }
    attach.classList.add("is-ready");
    requestAnimationFrame(refreshChatJumpButton);
}

function markOwnAttachmentReady(msgId) {
    const wrap = msgNode(msgId);
    if (!wrap) return;
    const attach = wrap.querySelector(".chat-attach");
    if (attach) attach.classList.add("is-ready");
}

function failPendingMessage(target) {
    const wrap = msgNode(target);
    if (!wrap) return;
    const attach = wrap.querySelector(".chat-attach");
    if (!attach) return;
    const bar = attach.querySelector(".chat-attach-progress-bar");
    if (bar) bar.style.background = "var(--signal-warn)";
}

function scrollChatToBottom(smooth) {
    if (!chatMessagesEl) return;
    chatMessagesEl.scrollTo({
        top: chatMessagesEl.scrollHeight,
        behavior: smooth ? "smooth" : "auto"
    });
    if (!smooth) refreshChatJumpButton();
}

/* ========= РЕАКЦИИ (лайки / дизлайки) =========
 * Двойной клик / долгое удержание → toggle собственного ЛАЙКА. Дизлайк ставится
 * из контекстного меню. У каждого юзера ОДНА реакция на сообщение: лайк ЛИБО
 * дизлайк (взаимоисключающие). Несколько участников «накладывают» свои реакции —
 * рисуем два счётчика (стопка ♥ и стопка серых разбитых ♥). Кто именно —
 * намеренно не показываем. Состояние эфемерное: живёт пока жив DOM-узел (как и
 * сам чат); поздним джойнерам прошлые реакции не приходят. */

/* Применить реакцию (свою или чужую). op=add ставит feel, ЗАМЕЩАЯ другую реакцию
   того же юзера (взаимоисключение). op=remove снимает только если текущая
   реакция совпадает с feel (защита от гонок / устаревших remove). */
function applyReaction(msgId, userId, op, feel) {
    /* Нет сообщения в DOM (джойнились позже) — игнор, чтобы не копить мусор. */
    const wrap = chatMessagesEl?.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
    if (!wrap) return;

    let reactions = messageReactions.get(msgId);
    if (op === "add") {
        if (!reactions) { reactions = new Map(); messageReactions.set(msgId, reactions); }
        reactions.set(userId, feel);
    } else {
        if (!reactions) return;
        if (reactions.get(userId) === feel) reactions.delete(userId);
        if (reactions.size === 0) messageReactions.delete(msgId);
    }
    renderReactionBadge(msgId);
}

/* Клик юзера: поставить/снять свою реакцию feel. Тот же feel повторно → снять
   (toggle off); другой feel → заместить (лайк↔дизлайк). Один broadcast покрывает
   и замену — add нового feel у получателя тоже заместит старую реакцию. */
function setOwnReaction(msgId, feel) {
    const selfId = getSelfId();
    const reactions = messageReactions.get(msgId);
    const current = reactions && reactions.get(selfId);
    const op = current === feel ? "remove" : "add";

    applyReaction(msgId, selfId, op, feel);
    broadcastReaction(msgId, op, feel, selfId);
}

function broadcastReaction(msgId, op, feel, from) {
    const json = JSON.stringify({
        type: "msg",
        kind: "like",
        target: msgId,
        op,
        feel,
        ts: Date.now(),
        from
    });
    chatChannels.forEach((channel, uid) => {
        enqueueSend(uid, async () => {
            if (channel.readyState !== "open") return;
            try { channel.send(json); }
            catch (err) { log.warn("chat", "reaction send failed", { userId: uid, err: err?.message || String(err) }); }
        });
    });
}

/* Визуально: вместо «♥ N» рендерим N иконок подряд (cap = LIKE_MAX_HEARTS,
   совпадает с MAX_ROOM_USERS=10). Иконки заезжают друг на друга (margin-left
   отрицательный, см. .chat-msg-likes-heart в CSS), так что бейдж почти не
   растягивается. Цифру не показываем намеренно. Лайки и дизлайки — два отдельных
   бейджа в обёртке .chat-msg-reactions (лайки слева, дизлайки справа). */
const LIKE_MAX_HEARTS = 10;

function renderReactionBadge(msgId) {
    const wrap = chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
    if (!wrap) return;
    const reactions = messageReactions.get(msgId);

    let likeCount = 0, dislikeCount = 0, mine = null;
    const selfId = getSelfId();
    if (reactions) {
        reactions.forEach((feel, uid) => {
            if (feel === "dislike") dislikeCount++; else likeCount++;
            if (uid === selfId) mine = feel;
        });
    }

    let container = wrap.querySelector(":scope > .chat-msg-reactions");
    if (likeCount === 0 && dislikeCount === 0) {
        if (container) container.remove();
        wrap.classList.remove("has-reactions");
        return;
    }
    if (!container) {
        container = document.createElement("div");
        container.className = "chat-msg-reactions";
        wrap.appendChild(container);
    }
    wrap.classList.add("has-reactions");

    renderReactionGroup(container, msgId, "like", likeCount, mine === "like");
    renderReactionGroup(container, msgId, "dislike", dislikeCount, mine === "dislike");
}

/* Один бейдж (стопка иконок) под конкретный feel. Создаёт/обновляет/удаляет
   .chat-msg-likes или .chat-msg-dislikes внутри обёртки .chat-msg-reactions. */
function renderReactionGroup(container, msgId, feel, count, isMine) {
    const cls = feel === "dislike" ? "chat-msg-dislikes" : "chat-msg-likes";
    const icon = feel === "dislike" ? BROKEN_HEART_SVG : HEART_SVG;
    let badge = container.querySelector(":scope > ." + cls);

    if (count === 0) {
        if (badge) badge.remove();
        return;
    }

    const isFirstAppearance = !badge;
    if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = cls;
        badge.setAttribute("aria-label", _ct(feel === "dislike" ? "chat.dislike" : "chat.like"));
        badge.addEventListener("click", (e) => {
            e.stopPropagation();
            setOwnReaction(msgId, feel);
        });
        /* Порядок фиксирован: лайки слева (prepend), дизлайки справа (append) —
           независимо от того, какой бейдж появился первым. */
        if (feel === "dislike") container.appendChild(badge);
        else container.prepend(badge);
    }
    badge.classList.toggle("is-mine", isMine);

    /* Ребилдим стопку на каждом изменении: N ≤ 10, дешевле чем диффить. */
    const shown = Math.min(count, LIKE_MAX_HEARTS);
    const prev = badge.childElementCount;
    badge.innerHTML = "";
    for (let i = 0; i < shown; i++) {
        const h = document.createElement("span");
        h.className = "chat-msg-likes-heart";
        h.setAttribute("aria-hidden", "true");
        h.innerHTML = icon;
        badge.appendChild(h);
    }

    /* Пульс — лёгкая реакция на изменение количества (вверх или вниз). */
    if (!isFirstAppearance && shown !== prev) {
        badge.classList.remove("is-pulsing");
        void badge.offsetWidth;
        badge.classList.add("is-pulsing");
    }
}

/* Material-style сердце. ViewBox 24×24, fill=currentColor — управляем
   цветом через .chat-msg-likes-heart / .chat-ctx-item-icon.is-like. */
const HEART_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 21.05l-1.32-1.2C5.6 15.16 2.25 12.12 2.25 8.4 2.25 5.36 4.64 3 7.7 3c1.73 0 3.39.8 4.3 2.07C12.91 3.8 14.57 3 16.3 3c3.06 0 5.45 2.36 5.45 5.4 0 3.72-3.35 6.76-8.43 11.46L12 21.05z"/>' +
    '</svg>';

/* Сердце для пунктов меню — тот же контур, но уменьшенный (scale вокруг
   центра 12,12): исходный Material-путь рисован edge-to-edge на 24×24 и
   рядом с компактными copy/save/link/open выглядел заметно крупнее их. Сам
   HEART_SVG (бейдж под сообщением) не трогаем — там масштаб уже верный. */
const HEART_MENU_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<g transform="translate(12 12) scale(0.78) translate(-12 -12)">' +
    '<path d="M12 21.05l-1.32-1.2C5.6 15.16 2.25 12.12 2.25 8.4 2.25 5.36 4.64 3 7.7 3c1.73 0 3.39.8 4.3 2.07C12.91 3.8 14.57 3 16.3 3c3.06 0 5.45 2.36 5.45 5.4 0 3.72-3.35 6.76-8.43 11.46L12 21.05z"/>' +
    '</g></svg>';

/* «Убрать лайк» — тот же уменьшенный контур, просто outline (не залитый),
   без перечёркивания — диагональ на кривых сердца читалась неровно на любом
   исполнении (bg-cutout не спас), проще и чище без неё. */
const HEART_OUTLINE_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<g transform="translate(12 12) scale(0.78) translate(-12 -12)">' +
    '<path d="M12 21.05l-1.32-1.2C5.6 15.16 2.25 12.12 2.25 8.4 2.25 5.36 4.64 3 7.7 3c1.73 0 3.39.8 4.3 2.07C12.91 3.8 14.57 3 16.3 3c3.06 0 5.45 2.36 5.45 5.4 0 3.72-3.35 6.76-8.43 11.46L12 21.05z"/>' +
    '</g>' +
    '</svg>';

/* Разбитое сердце для бейджа под сообщением — залитое тело (тот же путь, что
   HEART_SVG) + «разрез»: зигзаг цветом фона бейджа (см. .chat-msg-dislikes
   .bh-crack в chat.css) создаёт иллюзию трещины на залитом сердце. */
const BROKEN_HEART_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 21.05l-1.32-1.2C5.6 15.16 2.25 12.12 2.25 8.4 2.25 5.36 4.64 3 7.7 3c1.73 0 3.39.8 4.3 2.07C12.91 3.8 14.57 3 16.3 3c3.06 0 5.45 2.36 5.45 5.4 0 3.72-3.35 6.76-8.43 11.46L12 21.05z"/>' +
    '<path class="bh-crack" d="M12.7 4 L10 9.2 L13 11.3 L10.4 15 L12 20.2"/>' +
    '</svg>';

/* Разбитое сердце для пунктов меню — уменьшенный monoline (как copy/link):
   контур сердца + зигзаг-трещина, оба штрихом через default .chat-ctx-item-icon
   svg (серый). Отдельного iconClass не нужно — дефолтный цвет уже серый. */
const BROKEN_HEART_MENU_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<g transform="translate(12 12) scale(0.78) translate(-12 -12)">' +
    '<path d="M12 21.05l-1.32-1.2C5.6 15.16 2.25 12.12 2.25 8.4 2.25 5.36 4.64 3 7.7 3c1.73 0 3.39.8 4.3 2.07C12.91 3.8 14.57 3 16.3 3c3.06 0 5.45 2.36 5.45 5.4 0 3.72-3.35 6.76-8.43 11.46L12 21.05z"/>' +
    '<path d="M12.7 4 L10 9.2 L13 11.3 L10.4 15 L12 20.2"/>' +
    '</g>' +
    '</svg>';

/* ========= Иконки контекстного меню =========
   Переиспользуем существующие монолайн-SVG из других частей приложения
   (единый визуальный язык), кроме ICON_OPEN — для него аналога не было. */
const ICON_COPY =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="1.4"/>' +
    '<path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/>' +
    '</svg>';
const ICON_SAVE =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 19.5h14"/>' +
    '</svg>';
const ICON_LINK =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
    '</svg>';
const ICON_OPEN =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>' +
    '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>' +
    '</svg>';

/* Биндим жесты на каждое сообщение. Pointer Events унифицируют мышь/тач. */
function attachLikeGestures(wrap, msgId) {
    /* Двойной клик — мгновенный toggle. Игнорируем, если попали по
       интерактивному элементу (ссылка, картинка, скачать) — у них своё.
       После toggle снимаем системное выделение слова: dblclick по
       умолчанию выделяет слово/чип, и preventDefault не везде это
       подавляет — снимаем явно через Selection API. */
    wrap.addEventListener("dblclick", (e) => {
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        /* Дабл-клик = быстрый лайк (при активном дизлайке — переключит на лайк). */
        setOwnReaction(msgId, "like");
        try {
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
        } catch (_) {}
    });

    /* Подавляем mousedown-выделение при втором клике дабл-кликовой пары:
       первый pointerdown уже поставил каретку; на втором (detail===2) браузер
       начинает выделять слово ДО того, как сработает наш dblclick.
       preventDefault на mousedown отменяет это, не ломая обычное drag-select. */
    wrap.addEventListener("mousedown", (e) => {
        if (e.detail >= 2 && !isInteractiveTarget(e.target)) e.preventDefault();
    });

    /* ПКМ — открываем контекстное меню вместо системного. */
    wrap.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openContextMenu(buildContextMenuItems(e.target, wrap, msgId), e.clientX, e.clientY);
    });

    /* Long-press (тач и мышь) — то же меню. Фильтр цели — НЕ isInteractiveTarget:
       long-press должен доставать до пунктов картинки/ссылки, а не только текста. */
    wrap.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (isMenuGestureBlockedTarget(e.target)) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const startTarget = e.target;
        let timer = setTimeout(() => {
            timer = null;
            cleanup();
            armGhostClickSuppression(wrap);
            openContextMenu(buildContextMenuItems(startTarget, wrap, msgId), startX, startY);
        }, LIKE_LONGPRESS_MS);

        const onMove = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (dx * dx + dy * dy > LIKE_LONGPRESS_MAX_DIST_SQ) cleanup();
        };
        const cleanup = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            wrap.removeEventListener("pointermove",   onMove);
            wrap.removeEventListener("pointerup",     cleanup);
            wrap.removeEventListener("pointercancel", cleanup);
            wrap.removeEventListener("pointerleave",  cleanup);
        };
        wrap.addEventListener("pointermove",   onMove);
        wrap.addEventListener("pointerup",     cleanup);
        wrap.addEventListener("pointercancel", cleanup);
        wrap.addEventListener("pointerleave",  cleanup);
    });
}

function isInteractiveTarget(node) {
    return !!(node && node.closest &&
        node.closest("a, button, input, textarea, .chat-attach-image"));
}

/* Уже сами являются пунктом действия (кнопка лайка, скачивание файла) или
   системным контролом — long-press на них не должен открывать меню. Ссылки
   и картинки НАМЕРЕННО не исключены — на них меню как раз и нужно. */
function isMenuGestureBlockedTarget(node) {
    return !!(node && node.closest &&
        node.closest("button, input, textarea, .chat-attach-file-dl"));
}

/* После long-press браузер всё равно шлёт "призрачный" click по pointerup —
   он открыл бы lightbox (по клику на картинку) или увёл по ссылке. Гасим его
   capture-листенером на wrap: перехватывает раньше, чем событие дойдёт до
   <img>/<a>, а preventDefault там же отменяет и переход по ссылке. */
function armGhostClickSuppression(wrap) {
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    wrap.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => wrap.removeEventListener("click", swallow, true), 500);
}

/* ========= Контекстное меню ========= */

function buildContextMenuItems(targetEl, wrap, msgId) {
    const items = [];
    const link = targetEl.closest?.(".chat-msg-link");
    /* .chat-attach — ОБЩИЙ контейнер и для картинки, и для файла (иконка+имя+
       размер+↓). Ищем от wrap (всё сообщение), а не от targetEl (closest) —
       у вложения ещё есть .chat-msg-head (ник+время) РЯДОМ с .chat-attach, а
       не внутри неё; клик по нику/времени тоже должен резолвиться как
       «это attachment-сообщение», а не проваливаться в text-ветку и
       копировать мусор из textContent (глиф+имя+размер+"↓"). */
    const attach = !link ? wrap?.querySelector(".chat-attach") : null;
    const img = attach?.querySelector(".chat-attach-image");
    const fileDl = (attach && !(img && img.src)) ? attach.querySelector(".chat-attach-file-dl") : null;

    if (link) {
        items.push({
            icon: ICON_LINK, label: _ct("invite.copy-link"), flashCopied: true,
            onClick: () => copyText(link.href)
        });
        items.push({
            icon: ICON_OPEN, label: _ct("chat.open-link"),
            onClick: () => { openExternalUrl(link.href); return true; }
        });
    } else if (img && img.src) {
        items.push({
            icon: ICON_COPY, label: _ct("chat.copy"), flashCopied: true,
            onClick: () => copyImage(img.src)
        });
        items.push({
            icon: ICON_SAVE, label: _ct("chat.download"),
            onClick: () => saveBlobUrl(img.src, img.alt || "image")
        });
    } else if (fileDl && fileDl.href) {
        items.push({
            icon: ICON_SAVE, label: _ct("chat.download"),
            onClick: () => saveBlobUrl(fileDl.href, fileDl.download || "file")
        });
    } else if (!attach) {
        items.push({
            icon: ICON_COPY, label: _ct("chat.copy"), flashCopied: true,
            onClick: () => copyText(wrap.querySelector(".chat-msg-body")?.textContent || "")
        });
    }
    /* else: attach есть, но ни картинка, ни файл ещё не готовы (в процессе
       передачи) — copy/save не показываем, только лайк ниже. */

    if (msgId) {
        items.push({ divider: true });
        const reactions = messageReactions.get(msgId);
        const mine = reactions && reactions.get(getSelfId());
        if (mine === "like") {
            /* Свой лайк → «убрать лайк» / «поставить дизлайк». */
            items.push({
                icon: HEART_OUTLINE_SVG,
                label: _ct("chat.like.remove"),
                onClick: () => { setOwnReaction(msgId, "like"); return true; }
            });
            items.push({
                icon: BROKEN_HEART_MENU_SVG,
                label: _ct("chat.dislike.add"),
                onClick: () => { setOwnReaction(msgId, "dislike"); return true; }
            });
        } else if (mine === "dislike") {
            /* Свой дизлайк → «поставить лайк» / «убрать дизлайк». */
            items.push({
                icon: HEART_MENU_SVG,
                iconClass: "is-like",
                label: _ct("chat.like.add"),
                onClick: () => { setOwnReaction(msgId, "like"); return true; }
            });
            items.push({
                icon: BROKEN_HEART_MENU_SVG,
                label: _ct("chat.dislike.remove"),
                onClick: () => { setOwnReaction(msgId, "dislike"); return true; }
            });
        } else {
            /* Реакции нет → «лайкнуть» / «дизлайкнуть». */
            items.push({
                icon: HEART_MENU_SVG,
                iconClass: "is-like",
                label: _ct("chat.like.add"),
                onClick: () => { setOwnReaction(msgId, "like"); return true; }
            });
            items.push({
                icon: BROKEN_HEART_MENU_SVG,
                label: _ct("chat.dislike.add"),
                onClick: () => { setOwnReaction(msgId, "dislike"); return true; }
            });
        }
    }

    return items;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        log.warn("chat", "copy failed", { err: e?.message || String(e) });
        return false;
    }
}

/* Перекодировать картинку из blob:-URL в PNG.

   Не косметика: async-clipboard принимает для изображений ТОЛЬКО image/png —
   Safari по жёсткому whitelist'у типов, Chrome тем же списком. Вложения в чате
   пережаты в JPEG (downscaleImage), поэтому прежний
   `ClipboardItem({[blob.type]: blob})` с image/jpeg отвергался молча: ни
   исключения, ни картинки в буфере. */
function imageUrlToPngBlob(url) {
    return loadImage(url).then((img) => new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        canvas.getContext("2d").drawImage(img, 0, 0);
        canvas.toBlob(
            (b) => b ? resolve(b) : reject(new Error("png encode failed")),
            "image/png"
        );
    }));
}

async function copyImage(url) {
    try {
        /* WebView2 не тянет navigator.clipboard.write() с картинками надёжно —
           на десктопе идём в обход через нативный Tauri clipboard-plugin
           (js/desktop/clipboard.js). В web-сборке VoidDesktop не определён. */
        if (window.VoidDesktop && typeof window.VoidDesktop.copyImage === "function") {
            await window.VoidDesktop.copyImage(url);
            return true;
        }
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
        /* Промис отдаём в ClipboardItem КАК ЕСТЬ, не дожидаясь его. Safari
           засчитывает жест пользователя только если write() позван в том же
           тике: любой await до вызова съедает user activation, и запись
           отклоняется с NotAllowedError. Асинхронную часть за нас подождёт сам
           ClipboardItem — ради этого он и принимает промисы. */
        await navigator.clipboard.write([
            new ClipboardItem({ "image/png": imageUrlToPngBlob(url) })
        ]);
        return true;
    } catch (e) {
        log.warn("chat", "copy image failed", { err: e?.message || String(e) });
        return false;
    }
}

/* Исполняемый файл от собеседника сохраняем только вторым нажатием в течение
   5 с: первое показывает предупреждение. Так программа из чата не ложится на
   диск по случайному клику, а друзьям переслать её всё ещё можно. */
let _exeSaveArmed = null; // {url, until}

async function saveBlobUrl(url, filename) {
    if (isExecutableName(filename) && liveBlobUrls.get(url) !== getSelfId()) {
        const now = Date.now();
        if (!_exeSaveArmed || _exeSaveArmed.url !== url || now > _exeSaveArmed.until) {
            _exeSaveArmed = { url, until: now + 5000 };
            showChatToast(_ct("chat.exe.confirm"));
            return;
        }
        _exeSaveArmed = null;
    }

    /* `<a download>` на blob:-URL молча не срабатывает в WebView2 (клик
       проходит без единой ошибки — ни исключения, ни события, поэтому
       раньше это выглядело как полная тишина даже с log level=info: логировать
       было просто нечего). На десктопе идём в обход через нативный диалог
       сохранения + запись байт (js/desktop/save-file.js). */
    if (window.VoidDesktop && typeof window.VoidDesktop.saveFile === "function") {
        try {
            const saved = await window.VoidDesktop.saveFile(url, filename);
            /* saved === false → юзер отменил диалог сохранения, молчим. */
            if (saved) showChatToast(_ct("chat.download.saved"), "info");
        } catch (e) {
            log.warn("chat", "native save failed", { err: e?.message || String(e) });
            showChatToast(_ct("chat.download.failed"));
        }
        return;
    }

    try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
        showChatToast(_ct("chat.download.saved"), "info");
    } catch (e) {
        log.warn("chat", "save failed", { err: e?.message || String(e) });
        showChatToast(_ct("chat.download.failed"));
    }
}

function openContextMenu(items, x, y) {
    closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "chat-ctx-menu";

    items.forEach((item) => {
        if (item.divider) {
            const d = document.createElement("div");
            d.className = "chat-ctx-divider";
            menu.appendChild(d);
            return;
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-ctx-item";

        const icon = document.createElement("span");
        icon.className = "chat-ctx-item-icon" + (item.iconClass ? " " + item.iconClass : "");
        icon.innerHTML = item.icon;

        const label = document.createElement("span");
        label.className = "chat-ctx-item-label";
        label.textContent = item.label;

        btn.appendChild(icon);
        btn.appendChild(label);

        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await item.onClick();
            if (item.flashCopied && ok !== false) {
                label.textContent = _ct("support.copied");
                btn.disabled = true;
                setTimeout(closeContextMenu, 700);
            } else {
                closeContextMenu();
            }
        });

        menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    /* Прижимаем к viewport, чтобы не вылезти за край (тот же приём, что был
       у прежней like-всплывашки). */
    const w = menu.offsetWidth, h = menu.offsetHeight, pad = 8;
    const cx = Math.max(pad, Math.min(window.innerWidth  - w - pad, x));
    const cy = Math.max(pad, Math.min(window.innerHeight - h - pad, y));
    menu.style.left = cx + "px";
    menu.style.top  = cy + "px";

    ctxMenuEl = menu;
    requestAnimationFrame(() => menu.classList.add("is-visible"));

    /* Закрываем по любому касанию вне меню. capture=true — ловим раньше,
       чем кто-то ещё успеет stopPropagation. */
    ctxMenuOutsideHandler = (ev) => {
        if (ev.target === menu || menu.contains(ev.target)) return;
        closeContextMenu();
    };
    document.addEventListener("pointerdown", ctxMenuOutsideHandler, true);
    chatMessagesEl?.addEventListener("scroll", closeContextMenu, { once: true });
}

function closeContextMenu() {
    if (ctxMenuOutsideHandler) {
        document.removeEventListener("pointerdown", ctxMenuOutsideHandler, true);
        ctxMenuOutsideHandler = null;
    }
    if (ctxMenuEl) {
        const el = ctxMenuEl;
        ctxMenuEl = null;
        el.classList.remove("is-visible");
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 160);
    }
}

/* ========= UI: pending attachments ========= */

function autoKindForFile(file) {
    return /^image\//.test(file.type) ? "image" : "file";
}

function addPendingAttachment(file, kind) {
    const cap = (kind === "image" ? CHAT_MAX_IMAGE_MB : CHAT_MAX_FILE_MB) * 1024 * 1024;
    if (file.size > cap) {
        showChatToast(_ct("chat.file.tooBig", {
            mb: kind === "image" ? CHAT_MAX_IMAGE_MB : CHAT_MAX_FILE_MB
        }));
        return;
    }

    const item = {
        id: newMsgId(),
        file,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : null
    };

    chatPendingAttachments.push(item);
    renderPendingAttachments();

    /* Enter отправляет только из поля ввода, а после системного окна выбора
       файла (и перетаскивания) фокуса в нём нет — прикреплённое уходило
       только кликом по стрелке. Возвращаем фокус в поле, чтобы хватало Enter.
       Не на тач-устройствах: там фокус открыл бы экранную клавиатуру. */
    if (window.matchMedia?.("(pointer: fine)").matches) chatInputEl?.focus();
}

function removePendingAttachment(id) {
    const idx = chatPendingAttachments.findIndex(p => p.id === id);
    if (idx < 0) return;
    const [removed] = chatPendingAttachments.splice(idx, 1);
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    renderPendingAttachments();
}

function renderPendingAttachments() {
    if (!chatPendingEl) return;
    chatPendingEl.innerHTML = "";

    if (chatPendingAttachments.length === 0) {
        chatPendingEl.hidden = true;
        return;
    }
    chatPendingEl.hidden = false;

    for (const p of chatPendingAttachments) {
        const item = document.createElement("div");
        item.className = "chat-pending-item";

        if (p.kind === "image" && p.previewUrl) {
            const img = document.createElement("img");
            img.className = "chat-pending-thumb";
            img.src = p.previewUrl;
            img.alt = "";
            item.appendChild(img);
        } else {
            const g = document.createElement("span");
            g.className = "chat-pending-glyph";
            g.textContent = p.kind === "image" ? "◇" : "◫";
            item.appendChild(g);
        }

        const name = document.createElement("span");
        name.className = "chat-pending-name";
        name.textContent = p.file.name;
        item.appendChild(name);

        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "chat-pending-remove";
        rm.textContent = "×";
        rm.setAttribute("aria-label", _ct("chat.remove"));
        rm.addEventListener("click", () => removePendingAttachment(p.id));
        item.appendChild(rm);

        chatPendingEl.appendChild(item);
    }
}

/* ========= PASTE & DRAG-AND-DROP ========= */

function handleChatPaste(e) {
    if (!e.clipboardData) return;

    const files = Array.from(e.clipboardData.files || []);
    if (files.length > 0) {
        e.preventDefault();
        for (const f of files) addPendingAttachment(f, autoKindForFile(f));
        return;
    }

    // Скриншоты часто приходят только через items, без files.
    const items = Array.from(e.clipboardData.items || []);
    let handled = false;
    for (const item of items) {
        if (item.kind === "file" && /^image\//.test(item.type)) {
            const blob = item.getAsFile();
            if (blob) {
                addPendingAttachment(blob, "image");
                handled = true;
            }
        }
    }
    if (handled) e.preventDefault();
}

function isFileDrag(e) {
    if (!e.dataTransfer) return false;
    const types = Array.from(e.dataTransfer.types || []);
    return types.includes("Files");
}

function setupGlobalDragAndDrop() {
    if (!chatDropOverlay) return;

    document.addEventListener("dragenter", (e) => {
        if (!isFileDrag(e)) return;
        if (typeof isJoined !== "undefined" && !isJoined) return;
        dragCounter++;
        chatDropOverlay.classList.add("is-active");
    });

    document.addEventListener("dragover", (e) => {
        if (isFileDrag(e)) e.preventDefault(); // разрешаем drop
    });

    document.addEventListener("dragleave", (e) => {
        if (!isFileDrag(e)) return;
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) chatDropOverlay.classList.remove("is-active");
    });

    document.addEventListener("drop", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragCounter = 0;
        chatDropOverlay.classList.remove("is-active");

        if (typeof isJoined !== "undefined" && !isJoined) return;

        const files = Array.from(e.dataTransfer.files || []);
        if (files.length === 0) return;

        if (!chatOpen) setChatOpen(true);
        for (const f of files) addPendingAttachment(f, autoKindForFile(f));
    });
}

/* ========= LIGHTBOX (FLIP-style enlarge) ========= */

function openLightbox(sourceImg) {
    if (lightboxState) return;
    if (!chatLightbox || !chatLightboxImg) return;
    if (!sourceImg.src) return;

    /* Если предыдущий close ещё доигрывает свой 380ms-таймер — отменяем его
       и выполняем cleanup сразу. Иначе stale-timer стрельнёт после того, как
       мы уже выставили новый src/onload, и обнулит их → блюр без картинки. */
    if (lightboxCloseTimer) {
        clearTimeout(lightboxCloseTimer);
        lightboxCloseTimer = null;
        chatLightbox.classList.remove("is-closing");
        chatLightboxImg.style.transition = "none";
        chatLightboxImg.style.transform = "";
        chatLightboxImg.onload = null;
    }

    // Сразу резервируем state — на случай если пользователь успеет нажать Esc
    // ещё до того, как изображение загрузится.
    lightboxState = { sourceImg, ready: false };

    chatLightboxImg.src = sourceImg.src;
    chatLightbox.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    const start = () => {
        // Если за время загрузки уже закрыли — ничего не делаем.
        if (!lightboxState) return;

        chatLightboxImg.style.transition = "none";
        chatLightboxImg.style.transform = "none";

        // Заставляем layout рассчитаться (final = во весь overlay с object-fit:contain).
        const finalRect = chatLightboxImg.getBoundingClientRect();
        const startRect = sourceImg.getBoundingClientRect();

        // Если миниатюра уже не в DOM (свернули чат и т.п.) — просто открываем.
        if (!finalRect.width || !startRect.width) {
            chatLightboxImg.style.transition = "";
            chatLightboxImg.style.transform = "";
            chatLightbox.classList.add("is-visible");
            lightboxState.ready = true;
            return;
        }

        const scale =
            Math.min(startRect.width / finalRect.width, startRect.height / finalRect.height);

        const startCx = startRect.left + startRect.width / 2;
        const startCy = startRect.top + startRect.height / 2;
        const finalCx = finalRect.left + finalRect.width / 2;
        const finalCy = finalRect.top + finalRect.height / 2;

        chatLightboxImg.style.transform =
            `translate(${(startCx - finalCx).toFixed(2)}px, ${(startCy - finalCy).toFixed(2)}px) scale(${scale.toFixed(4)})`;

        // Двойной rAF — чтобы стартовые стили зафиксировались ДО анимации.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!lightboxState) return;
                chatLightboxImg.style.transition = "";
                chatLightboxImg.style.transform = "";
                chatLightbox.classList.add("is-visible");
                lightboxState.ready = true;
            });
        });
    };

    if (chatLightboxImg.complete && chatLightboxImg.naturalWidth > 0) {
        start();
    } else {
        chatLightboxImg.onload = start;
    }
}

function closeLightbox() {
    if (!lightboxState) return;
    const { sourceImg, ready } = lightboxState;
    lightboxState = null;

    // Не успели открыться — мгновенно сворачиваем без анимации.
    if (!ready) {
        chatLightbox.classList.remove("is-visible");
        chatLightbox.classList.remove("is-closing");
        chatLightbox.setAttribute("aria-hidden", "true");
        chatLightboxImg.style.transition = "none";
        chatLightboxImg.style.transform = "";
        chatLightboxImg.removeAttribute("src");
        chatLightboxImg.onload = null;
        document.body.style.overflow = "";
        requestAnimationFrame(() => { chatLightboxImg.style.transition = ""; });
        return;
    }

    const startRect = chatLightboxImg.getBoundingClientRect();
    const targetRect = sourceImg.getBoundingClientRect();
    const sourceVisible = targetRect.width > 0 && targetRect.height > 0
        && document.body.contains(sourceImg);

    if (sourceVisible) {
        const scale =
            Math.min(targetRect.width / startRect.width, targetRect.height / startRect.height);
        const startCx = startRect.left + startRect.width / 2;
        const startCy = startRect.top + startRect.height / 2;
        const targetCx = targetRect.left + targetRect.width / 2;
        const targetCy = targetRect.top + targetRect.height / 2;

        chatLightboxImg.style.transform =
            `translate(${(targetCx - startCx).toFixed(2)}px, ${(targetCy - startCy).toFixed(2)}px) scale(${scale.toFixed(4)})`;
    }

    chatLightbox.classList.add("is-closing");
    chatLightbox.classList.remove("is-visible");

    lightboxCloseTimer = setTimeout(() => {
        lightboxCloseTimer = null;
        chatLightbox.classList.remove("is-closing");
        chatLightbox.setAttribute("aria-hidden", "true");
        chatLightboxImg.style.transition = "none";
        chatLightboxImg.style.transform = "";
        chatLightboxImg.removeAttribute("src");
        chatLightboxImg.onload = null;
        document.body.style.overflow = "";
        requestAnimationFrame(() => { chatLightboxImg.style.transition = ""; });
    }, 380);
}

/* ========= UI: misc ========= */

function autoResizeInput() {
    if (!chatInputEl) return;
    chatInputEl.style.height = "auto";
    // CSS даёт инпуту height: 2.43rem (≡ 34px на дефолтном font-size).
    // Корневой font-size — clamp() (fluid scaling), поэтому считаем
    // минимум и максимум динамически от текущего rem, а не от 34/120 в px.
    // Иначе на 4K-экране кнопки send/attach растут с font-size, а инпут
    // остаётся жёсткие 34px — нарушается визуальный baseline.
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
    const minH = 2.43 * rootPx;
    const maxH = 8.57 * rootPx;
    /* scrollHeight меряет padding-box, а box-sizing у нас border-box — в
       style.height надо доложить рамки. Без них поле систематически на 2px
       ниже собственного содержимого: даже пустой инпут «переполнен» на доли
       пикселя и рисует вертикальный скролл. */
    const cs = getComputedStyle(chatInputEl);
    const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const full = chatInputEl.scrollHeight + borders;
    chatInputEl.style.height = Math.max(minH, Math.min(full, maxH)) + "px";
    /* Скролл включаем только когда реально упёрлись в максимум — иначе
       субпиксельные остатки округления дают полосу на пустом поле. */
    chatInputEl.style.overflowY = full > maxH ? "auto" : "hidden";
}

/* kind: "warn" (по умолчанию — сбой или предупреждение, тёплый цвет) или
   "info" (просто сообщили, что всё получилось, нейтральный цвет). */
function showChatToast(text, kind = "warn") {
    if (!chatToastEl) return;
    chatToastEl.textContent = text;
    chatToastEl.classList.toggle("is-info", kind === "info");
    chatToastEl.classList.add("is-visible");
    if (chatToastTimer) clearTimeout(chatToastTimer);
    chatToastTimer = setTimeout(() => {
        chatToastEl.classList.remove("is-visible");
        chatToastTimer = null;
    }, CHAT_TOAST_MS);
}

/* Всплывашка к значку (!) у исполняемого файла. Одна на документ, fixed и
   в body: список сообщений прокручивается и обрезает всё, что торчит за его
   край, — подсказка внутри карточки срезалась бы у верхнего сообщения.
   Текст берём из aria-label значка (он же переводится вместе с языком). */
(function initExeTips() {
    let tip = null;
    let anchor = null;

    function show(el) {
        if (!tip) {
            tip = document.createElement("div");
            tip.className = "chat-exe-tip";
            tip.setAttribute("role", "tooltip");
            document.body.appendChild(tip);
        }
        anchor = el;
        tip.textContent = el.getAttribute("aria-label") || "";
        tip.classList.add("is-visible");
        const r = el.getBoundingClientRect();
        const t = tip.getBoundingClientRect();
        const gap = 8;
        /* Над значком; не влезает сверху — под ним. По горизонтали по центру
           значка, но в пределах окна. */
        let top = r.top - t.height - gap;
        if (top < gap) top = r.bottom + gap;
        let left = r.left + r.width / 2 - t.width / 2;
        left = Math.max(gap, Math.min(left, window.innerWidth - t.width - gap));
        tip.style.top = `${Math.round(top)}px`;
        tip.style.left = `${Math.round(left)}px`;
    }

    function hide(el) {
        if (!tip || (el && el !== anchor)) return;
        tip.classList.remove("is-visible");
        anchor = null;
    }

    const exeOf = (e) => e.target instanceof Element ? e.target.closest(".chat-attach-file-exe") : null;
    document.addEventListener("mouseover", (e) => { const el = exeOf(e); if (el) show(el); });
    document.addEventListener("mouseout", (e) => {
        const el = exeOf(e);
        /* Переход между частями svg внутри значка — не уход с него. */
        if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide(el);
    });
    document.addEventListener("focusin", (e) => { const el = exeOf(e); if (el) show(el); });
    document.addEventListener("focusout", (e) => { const el = exeOf(e); if (el) hide(el); });
    /* Прокрутка уводит значок из-под всплывашки — прячем, а не тащим следом. */
    document.addEventListener("scroll", () => hide(), true);
})();

function markUnread() {
    if (chatToggleBtn) chatToggleBtn.classList.add("has-unread");
}

function clearUnreadBadge() {
    if (chatToggleBtn) chatToggleBtn.classList.remove("has-unread");
}

/* playMessageSound() определён в js/audio.js (синтез, js/void-sfx.js). */

/* ========= IMAGE DOWNSCALE ========= */

async function downscaleImage(file, maxDim, quality) {
    /* GIF отдаём как есть. Перекодировка через canvas забирает только первый
       кадр — анимация умирает (в превью-миниатюре она живая, потому что там
       показывается исходный файл, а не результат downscale). Размер уже
       ограничен CHAT_MAX_IMAGE_MB на этапе прикрепления. */
    if (/^image\/gif$/i.test(file.type)) return file;

    // Маленькие jpeg отдаём как есть — экономим CPU и не дрочим качество.
    if (file.size < 350 * 1024 && /^image\/jpe?g$/i.test(file.type)) {
        return file;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const img = await loadImage(dataUrl);

    let { width, height } = img;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width  = Math.round(width  * scale);
    height = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx2 = canvas.getContext("2d");
    ctx2.drawImage(img, 0, 0, width, height);

    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error("toBlob failed")),
            "image/jpeg",
            quality
        );
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image load failed"));
        img.src = src;
    });
}

/* ========= HELPERS ========= */

function newMsgId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/**
 * Регистрация blob-URL'а в LRU-кеше. При переполнении сбрасываем самый старый
 * URL — освобождается память, картинка/файл перестаёт быть кликабельным
 * (для пользователя это «выпал из истории», что и должно случиться).
 * Дублирующая запись в `objectUrlsToRevoke` нужна, чтобы при выходе из
 * комнаты ОБЕ коллекции (LRU + leave-cleanup) вычистили всё, что было.
 */
function trackBlobUrl(url, owner = getSelfId()) {
    if (!url) return;
    objectUrlsToRevoke.add(url);
    if (liveBlobUrls.has(url)) liveBlobUrls.delete(url);
    liveBlobUrls.set(url, owner);
    /* Квота на отправителя: вытесняем самый старый URL ЭТОГО же владельца,
       чужие не трогаем. */
    let mine = 0;
    for (const o of liveBlobUrls.values()) if (o === owner) mine += 1;
    for (const [u, o] of liveBlobUrls) {
        if (mine <= CHAT_MAX_LIVE_BLOB_URLS) break;
        if (o !== owner) continue;
        liveBlobUrls.delete(u);
        objectUrlsToRevoke.delete(u);
        try { URL.revokeObjectURL(u); } catch (_) {}
        mine -= 1;
    }
}

function getSelfId() {
    return typeof clientId !== "undefined" ? clientId : "local";
}

function getSelfNick() {
    return typeof currentUsername !== "undefined" && currentUsername
        ? currentUsername
        : "anon";
}

function formatTime(ts) {
    const d = new Date(ts || Date.now());
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} b`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kb`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} mb`;
}

function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
