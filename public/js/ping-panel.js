/* ===== Ping panel ===== */

function togglePingPanel() {
    if (pingPanelOpen) closePingPanel();
    else openPingPanel();
}

function openPingPanel() {
    if (pingPanelOpen || !pingPanel) return;
    pingPanelOpen = true;
    pingPanel.classList.add("is-visible");
    pingPanel.setAttribute("aria-hidden", "false");

    renderPingPanelSkeleton();
    schedulePingPoll();

    pingPanelOutsideHandler = (e) => {
        if (connState && connState.contains(e.target)) return;
        closePingPanel();
    };
    setTimeout(() => {
        document.addEventListener("click", pingPanelOutsideHandler);
    }, 0);
}

function schedulePingPoll() {
    if (!pingPanelOpen) return;
    refreshPingPanel().finally(() => {
        if (!pingPanelOpen) return;
        const hasPeers = typeof peers !== "undefined" && peers.size > 0;
        pingPollTimer = setTimeout(schedulePingPoll, hasPeers ? 1000 : 5000);
    });
}

function closePingPanel() {
    if (!pingPanelOpen) return;
    pingPanelOpen = false;

    if (pingPanel) {
        pingPanel.classList.remove("is-visible");
        pingPanel.setAttribute("aria-hidden", "true");
    }

    if (pingPollTimer) {
        clearTimeout(pingPollTimer);
        pingPollTimer = null;
    }

    if (pingPanelOutsideHandler) {
        document.removeEventListener("click", pingPanelOutsideHandler);
        pingPanelOutsideHandler = null;
    }
}

function renderPingPanelSkeleton() {
    if (!pingPanelList) return;

    if (typeof peers === "undefined" || peers.size === 0) {
        pingPanelList.innerHTML = `<div class="ping-row ping-row-empty">${escapeHtml(_t("ping.empty"))}</div>`;
        return;
    }

    const rows = [...peers.keys()].map(userId => {
        const nick = nicknameMap.get(userId) || "—";
        return `<div class="ping-row" data-uid="${escapeAttr(userId)}">
            <span class="ping-name">${escapeHtml(nick)}</span>
            <span class="ping-value ping-na">—</span>
        </div>`;
    });

    pingPanelList.innerHTML = rows.join("");
}

async function refreshPingPanel() {
    if (!pingPanelOpen || !pingPanelList) return;

    if (typeof peers === "undefined" || peers.size === 0) {
        pingPanelList.innerHTML = `<div class="ping-row ping-row-empty">${escapeHtml(_t("ping.empty"))}</div>`;
        return;
    }

    for (const userId of peers.keys()) {
        const ping = await getPeerPing(userId);
        if (!pingPanelOpen) return;
        const row = pingPanelList.querySelector(`[data-uid="${escapeAttr(userId)}"]`);
        if (!row) continue;
        const valEl = row.querySelector(".ping-value");
        if (!valEl) continue;
        valEl.className = "ping-value " + pingClass(ping);
        valEl.textContent = ping == null ? "—" : `${ping} ms`;
    }
}

function pingClass(ms) {
    if (ms == null) return "ping-na";
    if (ms <= 80) return "ping-good";
    if (ms <= 180) return "ping-mid";
    return "ping-bad";
}

/* ===== Connection quality dot on blobs ===== */

let _connQualityTimer = null;

async function refreshPeerConnQuality() {
    if (!isJoined || typeof peers === "undefined") return;
    for (const userId of peers.keys()) {
        const ms = await getPeerPing(userId);
        const el = participantElements?.get(userId) ||
            document.querySelector(`.participant[data-user-id="${userId}"]`);
        if (!el) continue;
        if (ms == null || ms > 180) el.dataset.conn = "poor";
        else delete el.dataset.conn;
    }
}

function startConnQualityMonitor() {
    if (_connQualityTimer) return;
    _connQualityTimer = setInterval(refreshPeerConnQuality, 5000);
}

function stopConnQualityMonitor() {
    if (_connQualityTimer) {
        clearInterval(_connQualityTimer);
        _connQualityTimer = null;
    }
    document.querySelectorAll(".participant[data-conn]").forEach(el => {
        delete el.dataset.conn;
    });
}

function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = String(s);
    return div.innerHTML;
}

function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
}
