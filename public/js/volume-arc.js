/* ===== Arc volume control =====
   Геометрия в координатах SVG 84×84 (совпадает с .users-area --avatar-size).
   Арка концентрична с аватаром, радиус чуть больше — чтобы "огибала" блоб справа. */
const VOLUME_ARC = {
    cx: 42,
    cy: 42,
    r: 46,
    startDeg: -55,
    endDeg: 55
};

function volumeArcPolar(angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return {
        x: VOLUME_ARC.cx + VOLUME_ARC.r * Math.cos(rad),
        y: VOLUME_ARC.cy + VOLUME_ARC.r * Math.sin(rad)
    };
}

function volumeArcPath(angleStart, angleEnd) {
    const s = volumeArcPolar(angleStart);
    const e = volumeArcPolar(angleEnd);
    const large = Math.abs(angleEnd - angleStart) > 180 ? 1 : 0;
    const sweep = angleEnd > angleStart ? 1 : 0;
    return `M ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${VOLUME_ARC.r} ${VOLUME_ARC.r} 0 ${large} ${sweep} ${e.x.toFixed(3)} ${e.y.toFixed(3)}`;
}

function toggleVolumeControl(participant, userId) {

    const existing = participant.querySelector(".volume-arc");
    if (existing) {
        // closeVolumeArc removes .blob-active via the hook above
        closeVolumeArc(existing);
        return;
    }

    // Close any other active blobs first (removes their .blob-active too)
    document.querySelectorAll(".volume-arc").forEach(closeVolumeArc);

    participant.classList.add("blob-active");

    const arc = createVolumeArc(participant, userId);
    participant.appendChild(arc);

    requestAnimationFrame(() => {
        arc.classList.add("is-visible");
    });
}

function closeVolumeArc(arcEl) {
    if (!arcEl || arcEl.dataset.closing === "1") return;
    arcEl.dataset.closing = "1";
    arcEl._cleanup?.();

    // Sync: closing the arc always deactivates the parent blob
    arcEl.closest(".participant")?.classList.remove("blob-active");

    arcEl.classList.remove("is-visible");

    const fallback = setTimeout(() => arcEl.remove(), 500);
    arcEl.addEventListener("transitionend", () => {
        clearTimeout(fallback);
        arcEl.remove();
    }, { once: true });
}

function createVolumeArc(participant, userId) {

    const wrapper = document.createElement("div");
    wrapper.className = "volume-arc";

    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 84 84");
    svg.setAttribute("aria-hidden", "true");

    const fullPath = volumeArcPath(VOLUME_ARC.startDeg, VOLUME_ARC.endDeg);

    const track = document.createElementNS(SVGNS, "path");
    track.setAttribute("class", "volume-arc-track");
    track.setAttribute("d", fullPath);

    const fill = document.createElementNS(SVGNS, "path");
    fill.setAttribute("class", "volume-arc-fill");
    fill.setAttribute("d", "");

    const handle = document.createElementNS(SVGNS, "circle");
    handle.setAttribute("class", "volume-arc-handle");
    handle.setAttribute("r", "3");

    const hit = document.createElementNS(SVGNS, "path");
    hit.setAttribute("class", "volume-arc-hit");
    hit.setAttribute("d", fullPath);

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(handle);
    svg.appendChild(hit);
    wrapper.appendChild(svg);

    const applyVolume = (v) => {
        v = Math.max(0, Math.min(1, v));
        const angle = VOLUME_ARC.endDeg - (VOLUME_ARC.endDeg - VOLUME_ARC.startDeg) * v;

        if (v > 0.001) {
            fill.setAttribute("d", volumeArcPath(VOLUME_ARC.endDeg, angle));
        } else {
            fill.setAttribute("d", "");
        }

        const p = volumeArcPolar(angle);
        handle.setAttribute("cx", p.x.toFixed(3));
        handle.setAttribute("cy", p.y.toFixed(3));

        volumeMap.set(userId, v);
        const audio = audioMap.get(userId);
        if (audio) audio.volume = v;
    };

    applyVolume(volumeMap.get(userId) ?? 1);

    const pointToVolume = (clientX, clientY) => {
        const rect = svg.getBoundingClientRect();
        const sx = (clientX - rect.left) / rect.width * 84;
        const sy = (clientY - rect.top) / rect.height * 84;
        const dx = Math.max(sx - VOLUME_ARC.cx, 0.001);
        const dy = sy - VOLUME_ARC.cy;
        const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        const clamped = Math.max(VOLUME_ARC.startDeg, Math.min(VOLUME_ARC.endDeg, angleDeg));
        return (VOLUME_ARC.endDeg - clamped) / (VOLUME_ARC.endDeg - VOLUME_ARC.startDeg);
    };

    let dragging = false;
    let pointerId = null;

    const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        applyVolume(pointToVolume(e.clientX, e.clientY));
    };

    const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        wrapper.classList.remove("is-dragging");
        try { hit.releasePointerCapture(pointerId); } catch {}
        pointerId = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
    };

    const onDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        pointerId = e.pointerId;
        try { hit.setPointerCapture(pointerId); } catch {}
        wrapper.classList.add("is-dragging");
        applyVolume(pointToVolume(e.clientX, e.clientY));
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    };

    hit.addEventListener("pointerdown", onDown);
    wrapper.addEventListener("click", (e) => e.stopPropagation());

    /* Колесо мыши: ±5% за «щелчок». Слушаем на всём блобе (participant),
       а не только на арке — так регулировка работает и при наведении на
       аватар. Нормализуем по знаку deltaY (deltaMode разный в FF/Chrome). */
    const onWheel = (e) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const current = volumeMap.get(userId) ?? 1;
        applyVolume(current + dir * 0.05);
    };
    participant.addEventListener("wheel", onWheel, { passive: false });

    const onOutsideClick = (e) => {
        if (dragging) return;
        if (participant.contains(e.target)) return;
        closeVolumeArc(wrapper);
    };

    setTimeout(() => {
        document.addEventListener("click", onOutsideClick);
    }, 0);

    wrapper._cleanup = () => {
        document.removeEventListener("click", onOutsideClick);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        participant.removeEventListener("wheel", onWheel);
    };

    return wrapper;
}

window.onVolumeChange = function(userId, volume) {
    const participant = document.querySelector(`.participant[data-user-id="${userId}"]`);
    if (!participant) return;

    participant.classList.toggle("speaking", volume > 18);
};
