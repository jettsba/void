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
    refreshPingPanel();
    pingPollTimer = setInterval(refreshPingPanel, 1000);

    pingPanelOutsideHandler = (e) => {
        if (connState && connState.contains(e.target)) return;
        closePingPanel();
    };
    setTimeout(() => {
        document.addEventListener("click", pingPanelOutsideHandler);
    }, 0);
}

function closePingPanel() {
    if (!pingPanelOpen) return;
    pingPanelOpen = false;

    if (pingPanel) {
        pingPanel.classList.remove("is-visible");
        pingPanel.setAttribute("aria-hidden", "true");
    }

    if (pingPollTimer) {
        clearInterval(pingPollTimer);
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

    const entries = [];
    for (const userId of peers.keys()) {
        const ping = await getPeerPing(userId);
        entries.push({
            userId,
            nickname: nicknameMap.get(userId) || "—",
            ping
        });
    }

    if (!pingPanelOpen) return;

    entries.sort((a, b) => a.nickname.localeCompare(b.nickname));

    pingPanelList.innerHTML = entries.map(e => {
        const cls = pingClass(e.ping);
        const val = e.ping == null ? "—" : `${e.ping} ms`;
        return `<div class="ping-row" data-uid="${escapeAttr(e.userId)}">
            <span class="ping-name">${escapeHtml(e.nickname)}</span>
            <span class="ping-value ${cls}">${val}</span>
        </div>`;
    }).join("");
}

function pingClass(ms) {
    if (ms == null) return "ping-na";
    if (ms <= 80) return "ping-good";
    if (ms <= 180) return "ping-mid";
    return "ping-bad";
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
