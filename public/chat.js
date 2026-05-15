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
 *  сотни МБ. Когда переполняем, прибиваем самый старый URL. */
const CHAT_MAX_LIVE_BLOB_URLS = 30;

/* Like-жест: время удержания pointer'а до показа всплывающего сердца,
   и максимальный сдвиг (px²) — больше → считаем за drag/scroll и отменяем. */
const LIKE_LONGPRESS_MS    = 420;
const LIKE_LONGPRESS_MAX_DIST_SQ = 100; // 10px радиус
const LIKE_POPUP_TIMEOUT_MS = 2600;
const LIKE_TARGET_MAX_LEN  = 80;        // sanity cap для msgId извне

/* ========= STATE ========= */

const chatChannels       = new Map(); // userId → RTCDataChannel
const channelSendQueues  = new Map(); // userId → Promise (последовательная очередь send'ов)
const channelInbox       = new Map(); // userId → {meta, chunks:[], received, totalBytes}
const objectUrlsToRevoke = new Set(); // URL.createObjectURL — чистим при выходе

/** msgId → Set<userId>. Лайки эфемерны как и сам чат: сохраняются только
 *  пока DOM-узел сообщения жив. Поздним джойнерам прошлые лайки не видны
 *  (как и сами прошлые сообщения). */
const messageLikes = new Map();

/** LRU для blob-URL'ов: Map сохраняет порядок вставки, переставляем
 *  через delete + set когда URL переиспользуется. */
const liveBlobUrls = new Map(); // url → addedAt

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
let messageSoundEl;

let chatOpen = false;
let chatToastTimer = null;
let chatHasMessages = false;
let dragCounter = 0;
let lightboxState = null; // {sourceImg, escHandler}
let lightboxCloseTimer = null;

let likePopupEl = null;
let likePopupTimer = null;
let likePopupOutsideHandler = null;

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
    messageSoundEl       = document.getElementById("messageSound");

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

    chatFileInput.addEventListener("change", (e) => {
        for (const f of e.target.files) addPendingAttachment(f, autoKindForFile(f));
        chatFileInput.value = "";
    });

    chatLightboxCloseBtn.addEventListener("click", closeLightbox);
    chatLightbox.addEventListener("click", (e) => {
        if (e.target === chatLightbox) closeLightbox();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (likePopupEl)   { hideLikePopup(); return; }
        if (lightboxState) { closeLightbox(); return; }
        if (chatOpen)      { setChatOpen(false); }
    });

    chatMessagesEl.addEventListener("scroll", refreshChatJumpButton);

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
    chatToggleBtn.title = chatOpen ? _ct("header.chat.close") : _ct("header.chat.show");
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

    channelInbox.clear();
    channelSendQueues.clear();
    messageLikes.clear();
    hideLikePopup();

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
    };
    channel.onclose = () => {
        if (chatChannels.get(userId) === channel) {
            chatChannels.delete(userId);
        }
        // Прибираем незавершённый приём с этого канала.
        const inbox = channelInbox.get(userId);
        if (inbox) {
            failPendingMessage(inbox.meta.msgId);
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
        failPendingMessage(inbox.meta.msgId);
        channelInbox.delete(userId);
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

function waitForLowBuffer(channel) {
    return new Promise((resolve) => {
        const onLow = () => {
            channel.removeEventListener("bufferedamountlow", onLow);
            resolve();
        };
        channel.addEventListener("bufferedamountlow", onLow);
    });
}

/* ========= RECEIVE ========= */

function handleIncoming(data, userId) {
    if (typeof data === "string") {
        let json;
        try { json = JSON.parse(data); } catch { return; }
        if (json.type !== "msg") return;

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
            applyLike(target, userId, json.op);
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
            if (prev) failPendingMessage(prev.meta.msgId);

            channelInbox.set(userId, {
                meta: json,
                chunks: [],
                received: 0,
                totalBytes: 0
            });
            appendMessage(json, false, { ready: false });
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

        if (inbox.totalBytes > inbox.meta.size + CHAT_CHUNK_BYTES) {
            log.warn("chat", "transfer overflow, aborting", { msgId: inbox.meta.msgId });
            failPendingMessage(inbox.meta.msgId);
            channelInbox.delete(userId);
            return;
        }

        updateMessageProgress(inbox.meta.msgId, inbox.received / inbox.meta.totalChunks);

        if (inbox.received >= inbox.meta.totalChunks) {
            const blob = new Blob(inbox.chunks, {
                type: inbox.meta.mime || "application/octet-stream"
            });
            const url = URL.createObjectURL(blob);
            trackBlobUrl(url);
            finalizeMessageAttachment(inbox.meta.msgId, url, inbox.meta);
            channelInbox.delete(userId);
        }
    }
}

/* ========= UI: messages list ========= */

function appendMessage(msg, isSelf, attachState = null) {
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
        nick.textContent = msg.nick || "—";
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
    renderLikeBadge(msg.msgId);

    if (!chatHasMessages) {
        chatHasMessages = true;
        chatPanel.classList.add("has-messages");
    }

    const nearBottom =
        chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 80;
    if (nearBottom || isSelf) {
        scrollChatToBottom(true);
    }

    if (!isSelf) {
        if (!chatOpen) {
            markUnread();
            playMessageSound();
        }
    }

    requestAnimationFrame(refreshChatJumpButton);
}

function renderTextWithLinks(el, text) {
    const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
    let lastIdx = 0;
    let m;
    while ((m = urlRegex.exec(text)) !== null) {
        if (m.index > lastIdx) {
            el.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        }
        const a = document.createElement("a");
        a.href = m[0];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "chat-msg-link";
        a.textContent = m[0];
        el.appendChild(a);
        lastIdx = m.index + m[0].length;
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

        const nm = document.createElement("div");
        nm.className = "chat-attach-file-name";
        nm.textContent = msg.name || "file";

        const sz = document.createElement("div");
        sz.className = "chat-attach-file-size";
        sz.textContent = formatSize(msg.size || 0);

        meta.appendChild(nm);
        meta.appendChild(sz);

        const dl = document.createElement("a");
        dl.className = "chat-attach-file-dl";
        dl.textContent = "↓";
        dl.title = _ct("chat.download");
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

function updateMessageProgress(msgId, frac) {
    const wrap = chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
    if (!wrap) return;
    const bar = wrap.querySelector(".chat-attach-progress-bar");
    if (bar) bar.style.width = Math.round(Math.min(1, frac) * 100) + "%";
}

function finalizeMessageAttachment(msgId, url, meta) {
    const wrap = chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
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
    const wrap = chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
    if (!wrap) return;
    const attach = wrap.querySelector(".chat-attach");
    if (attach) attach.classList.add("is-ready");
}

function failPendingMessage(msgId) {
    const wrap = chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
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

/* ========= LIKES =========
 * Двойной клик / долгое удержание на сообщении → toggle собственного лайка.
 * Несколько участников могут «накладывать» свои лайки — рисуем общий счётчик.
 * Кто конкретно лайкнул — намеренно не показываем. Состояние эфемерное:
 * хранится только пока DOM-узел сообщения жив (как и сам чат). Поздним
 * джойнерам прошлые лайки не приходят. */

function applyLike(msgId, userId, op) {
    /* Если сообщения нет в DOM (например, мы джойнились позже и не видели
       оригинал) — лайк игнорируем, чтобы не копить мёртвые записи в Map'е. */
    const wrap = chatMessagesEl?.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
    if (!wrap) return;

    let likers = messageLikes.get(msgId);
    if (!likers) {
        if (op === "remove") return;
        likers = new Set();
        messageLikes.set(msgId, likers);
    }
    const before = likers.size;
    if (op === "add") likers.add(userId);
    else likers.delete(userId);
    if (likers.size === 0) messageLikes.delete(msgId);
    if (likers.size !== before) renderLikeBadge(msgId);
}

function toggleOwnLike(msgId) {
    const selfId = getSelfId();
    const likers = messageLikes.get(msgId);
    const op = likers && likers.has(selfId) ? "remove" : "add";

    applyLike(msgId, selfId, op);

    const json = JSON.stringify({
        type: "msg",
        kind: "like",
        target: msgId,
        op,
        ts: Date.now(),
        from: selfId
    });
    chatChannels.forEach((channel, uid) => {
        enqueueSend(uid, async () => {
            if (channel.readyState !== "open") return;
            try { channel.send(json); }
            catch (err) { log.warn("chat", "like send failed", { userId: uid, err: err?.message || String(err) }); }
        });
    });
}

function renderLikeBadge(msgId) {
    const wrap = chatMessagesEl.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`);
    if (!wrap) return;
    const likers = messageLikes.get(msgId);
    const count = likers ? likers.size : 0;

    let badge = wrap.querySelector(":scope > .chat-msg-likes");
    if (count === 0) {
        if (badge) badge.remove();
        wrap.classList.remove("has-likes");
        return;
    }

    const isFirstAppearance = !badge;
    if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = "chat-msg-likes";
        badge.title = _ct("chat.like");
        badge.setAttribute("aria-label", _ct("chat.like"));

        const heart = document.createElement("span");
        heart.className = "chat-msg-likes-heart";
        heart.setAttribute("aria-hidden", "true");
        heart.innerHTML = HEART_SVG;

        const cnt = document.createElement("span");
        cnt.className = "chat-msg-likes-count";

        badge.appendChild(heart);
        badge.appendChild(cnt);
        badge.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleOwnLike(msgId);
        });
        wrap.appendChild(badge);
    }

    const isMine = likers.has(getSelfId());
    badge.classList.toggle("is-mine", isMine);

    const cntEl = badge.querySelector(".chat-msg-likes-count");
    const prevCount = Number(cntEl.textContent) || 0;
    cntEl.textContent = String(count);
    wrap.classList.add("has-likes");

    /* «Пульс» при изменении счётчика — отдельная одноразовая анимация на чипе.
       Класс снимаем после end, чтобы можно было запустить ещё раз. Первое
       появление берёт другую анимацию (см. CSS .chat-msg-likes:initial). */
    if (!isFirstAppearance && count !== prevCount) {
        badge.classList.remove("is-pulsing");
        // reflow — рестарт keyframes без него не сработает
        void badge.offsetWidth;
        badge.classList.add("is-pulsing");
    }
}

/* Material-style сердце. ViewBox 24×24, fill=currentColor — управляем
   цветом через .chat-msg-likes-heart / .chat-like-popup. */
const HEART_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 21.05l-1.32-1.2C5.6 15.16 2.25 12.12 2.25 8.4 2.25 5.36 4.64 3 7.7 3c1.73 0 3.39.8 4.3 2.07C12.91 3.8 14.57 3 16.3 3c3.06 0 5.45 2.36 5.45 5.4 0 3.72-3.35 6.76-8.43 11.46L12 21.05z"/>' +
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
        toggleOwnLike(msgId);
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

    /* Подавляем системное меню «копировать/выбрать» по long-press на тач —
       иначе наша всплывашка перебивается нативной. На мыши контекстное меню
       оставляем (правый клик не задействован). */
    wrap.addEventListener("contextmenu", (e) => {
        if (e.pointerType === "touch" || e.pointerType === "pen") e.preventDefault();
    });

    wrap.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (isInteractiveTarget(e.target)) return;

        const startX = e.clientX;
        const startY = e.clientY;
        let timer = setTimeout(() => {
            timer = null;
            cleanup();
            showLikePopup(msgId, startX, startY);
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

function showLikePopup(msgId, anchorX, anchorY) {
    hideLikePopup();

    const popup = document.createElement("button");
    popup.type = "button";
    popup.className = "chat-like-popup";
    popup.title = _ct("chat.like");
    popup.setAttribute("aria-label", _ct("chat.like"));
    popup.innerHTML = HEART_SVG;

    document.body.appendChild(popup);

    /* Позиционируем над пальцем/курсором, прижимая к viewport, чтобы не
       вылезти за край (актуально на тач — long-press у самого края экрана). */
    const w = popup.offsetWidth  || 40;
    const h = popup.offsetHeight || 40;
    const pad = 8;
    let x = anchorX - w / 2;
    let y = anchorY - h - 14;
    x = Math.max(pad, Math.min(window.innerWidth  - w - pad, x));
    y = Math.max(pad, Math.min(window.innerHeight - h - pad, y));
    popup.style.left = x + "px";
    popup.style.top  = y + "px";

    popup.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleOwnLike(msgId);
        hideLikePopup();
    });

    likePopupEl = popup;
    requestAnimationFrame(() => popup.classList.add("is-visible"));

    likePopupTimer = setTimeout(hideLikePopup, LIKE_POPUP_TIMEOUT_MS);

    /* Закрываем по любому касанию вне всплывашки. capture=true — ловим раньше,
       чем кто-то ещё успеет stopPropagation. Слушаем pointerdown — реагируем
       синхронно с тач-стартом, до click. */
    likePopupOutsideHandler = (ev) => {
        if (ev.target === popup || popup.contains(ev.target)) return;
        hideLikePopup();
    };
    document.addEventListener("pointerdown", likePopupOutsideHandler, true);
    chatMessagesEl?.addEventListener("scroll", hideLikePopup, { once: true });
}

function hideLikePopup() {
    if (likePopupTimer) { clearTimeout(likePopupTimer); likePopupTimer = null; }
    if (likePopupOutsideHandler) {
        document.removeEventListener("pointerdown", likePopupOutsideHandler, true);
        likePopupOutsideHandler = null;
    }
    if (likePopupEl) {
        const el = likePopupEl;
        likePopupEl = null;
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
        name.title = `${p.file.name} · ${formatSize(p.file.size)}`;
        name.textContent = p.file.name;
        item.appendChild(name);

        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "chat-pending-remove";
        rm.textContent = "×";
        rm.title = _ct("chat.remove");
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
    const next = Math.min(chatInputEl.scrollHeight, 120);
    chatInputEl.style.height = Math.max(34, next) + "px";
}

function showChatToast(text) {
    if (!chatToastEl) return;
    chatToastEl.textContent = text;
    chatToastEl.classList.add("is-visible");
    if (chatToastTimer) clearTimeout(chatToastTimer);
    chatToastTimer = setTimeout(() => {
        chatToastEl.classList.remove("is-visible");
        chatToastTimer = null;
    }, CHAT_TOAST_MS);
}

function markUnread() {
    if (chatToggleBtn) chatToggleBtn.classList.add("has-unread");
}

function clearUnreadBadge() {
    if (chatToggleBtn) chatToggleBtn.classList.remove("has-unread");
}

function playMessageSound() {
    if (!messageSoundEl) return;
    try {
        messageSoundEl.currentTime = 0;
        messageSoundEl.volume = 0.5;
        messageSoundEl.play().catch(() => {});
    } catch (_) {}
}

/* ========= IMAGE DOWNSCALE ========= */

async function downscaleImage(file, maxDim, quality) {
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
function trackBlobUrl(url) {
    if (!url) return;
    objectUrlsToRevoke.add(url);
    if (liveBlobUrls.has(url)) liveBlobUrls.delete(url);
    liveBlobUrls.set(url, Date.now());
    while (liveBlobUrls.size > CHAT_MAX_LIVE_BLOB_URLS) {
        const oldest = liveBlobUrls.keys().next().value;
        if (oldest == null) break;
        liveBlobUrls.delete(oldest);
        objectUrlsToRevoke.delete(oldest);
        try { URL.revokeObjectURL(oldest); } catch (_) {}
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
