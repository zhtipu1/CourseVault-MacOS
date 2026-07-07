/**
 * player.js — CourseVault video player.
 * Updated sidebar renders nested section → subsection → lesson hierarchy.
 */

const player = (() => {

    let vid, lessonId, lessonData, settings;
    let saveTimer          = null;
    let controlsTimer      = null;
    let isDragging         = false;
    let dragPct            = 0;
    let markedComplete     = false;
    let speedMenuOpen      = false;
    let _videoEvtAttached  = false;   // guard — attach video listeners only once

    let skipSecs  = 10;
    let threshold = 90;
    let autoNext  = true;

    async function init(id) {
        lessonId = id;
        vid = document.getElementById("video");
        await _loadSettings();
        await _loadLesson();
    }

    async function _loadSettings() {
        const s = await api.get("/api/settings");
        settings  = s;
        skipSecs  = parseInt(s.skip_seconds       || "10", 10);
        threshold = parseFloat(s.complete_threshold || "90");
        autoNext  = s.auto_play_next !== "false";
        vid.volume = parseFloat(s.player_volume || "0.8");
        _id("skip-back-n").textContent = skipSecs;
        _id("skip-fwd-n").textContent  = skipSecs;
    }

    async function _loadLesson() {
        const data = await api.get(`/api/lessons/${lessonId}`);
        if (data.error) { _showError("Lesson not found."); return; }
        lessonData = data;

        document.title = `${data.title} — CourseVault`;
        _id("topbar-lesson-title").textContent = data.title;
        const backLink = _id("back-link");
        backLink.href = `/course/${data.course_id}`;
        backLink.querySelector("span").textContent = data.course_title;

        sessionStorage.setItem("now-playing", JSON.stringify({
            lessonTitle: data.title,
            courseTitle: data.course_title,
            lessonId, courseId: data.course_id,
            percent: data.progress.percent_watched || 0,
        }));

        _loadSidebar(data.course_id);
        _updateNextBtn();

        if (data.needs_remux) { _checkMkvStatus(); return; }

        _attachVideoEvents();
        vid.src = `/video/${lessonId}`;
        vid.load();
        _restoreProgress(data.progress);
        _loadSubtitle(data.has_subtitle);
    }

    // ── Video events ───────────────────────────────────────────────────────────

    function _attachVideoEvents() {
        if (_videoEvtAttached) return;   // never register twice on the same element
        _videoEvtAttached = true;

        vid.addEventListener("timeupdate",     _onTimeUpdate);
        vid.addEventListener("ended",          _onEnded);
        vid.addEventListener("loadedmetadata", _onMetadata);
        vid.addEventListener("progress",       _onBuffered);
        vid.addEventListener("play",  () => _updatePlayBtn(true));
        vid.addEventListener("pause", () => _updatePlayBtn(false));
        vid.addEventListener("volumechange", _updateVolumeUI);
        vid.addEventListener("error", _onVideoError);

        _id("video-wrap").addEventListener("mousemove",  _showControls);
        _id("video-wrap").addEventListener("mouseleave", () => {
            if (!vid.paused) _startControlsTimer();
        });

        _initSeekBar();

        _id("vol-range").value = vid.volume;
        _id("vol-range").addEventListener("input", e => {
            vid.volume = parseFloat(e.target.value);
            vid.muted  = vid.volume === 0;
        });

        document.addEventListener("keydown", _handleKey);
        document.addEventListener("click", e => {
            if (!_id("speed-wrap")?.contains(e.target)) _closeSpeedMenu();
        });

        // Save on hide/navigate-away using sendBeacon (non-blocking, works on tab close too).
        // Guard flag prevents visibilitychange + beforeunload both firing on the same navigation.
        let _saveFired = false;
        saveTimer = setInterval(() => { if (!_saveFired) _saveOnUnload(); }, 5000);
        document.addEventListener("visibilitychange", () => {
            if (document.hidden && !_saveFired) { _saveFired = true; _saveOnUnload(); }
        });
        window.addEventListener("beforeunload", () => {
            clearInterval(saveTimer);
            if (!_saveFired) { _saveFired = true; _saveOnUnload(); }
        });

        _showControls();
    }

    function _onMetadata() {
        _id("t-total").textContent          = utils.formatTime(vid.duration);
        _id("seek-time-total").textContent  = utils.formatTime(vid.duration);
    }

    function _onTimeUpdate() {
        if (isDragging) return;
        const pct = vid.duration ? (vid.currentTime / vid.duration) * 100 : 0;
        _id("t-current").textContent         = utils.formatTime(vid.currentTime);
        _id("seek-time-current").textContent = utils.formatTime(vid.currentTime);
        _id("seek-fill").style.width         = pct + "%";
        _id("seek-thumb").style.left         = pct + "%";
        if (!markedComplete && pct >= threshold) {
            markedComplete = true;
            _saveOnUnload();
            _checkCourseComplete();
        }
    }

    function _onBuffered() {
        if (!vid.duration || !vid.buffered.length) return;
        const pct = (vid.buffered.end(vid.buffered.length - 1) / vid.duration) * 100;
        _id("seek-buffered").style.width = pct + "%";
    }

    function _onVideoError() {
        const err = vid.error;
        if (!err) return;
        // code 1 = aborted (user navigation away — ignore)
        if (err.code === MediaError.MEDIA_ERR_ABORTED) return;

        // For remux lessons: an error here almost always means the cached file
        // was caught mid-write (race condition) or the conversion had a problem.
        // Re-check the status so the UI shows the correct state rather than
        // mis-labelling it "unsupported format".
        if (lessonData?.needs_remux) {
            // Stop the element trying to load the bad/incomplete file
            vid.removeAttribute("src");
            vid.load();
            _checkMkvStatus();
            return;
        }

        // Native format that the browser engine genuinely can't decode
        const msgs = {
            [MediaError.MEDIA_ERR_NETWORK]:           "Network error while loading video.",
            [MediaError.MEDIA_ERR_DECODE]:            "Video decode error — codec may be unsupported.",
            [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "This video format is not supported by the built-in player.",
        };
        const msg = msgs[err.code] || "Video playback error.";
        _showMkvOverlay("unsupported", 0, msg);
    }

    function _onEnded() {
        _saveOnUnload();
        if (autoNext && lessonData.next_id) {
            setTimeout(() => { window.location.href = `/player/${lessonData.next_id}`; }, 1200);
        }
    }

    // ── Progress ───────────────────────────────────────────────────────────────

    function _restoreProgress(prog) {
        if (!prog || prog.position_secs < 5) return;
        const toast = document.createElement("div");
        toast.className = "resume-toast";
        toast.innerHTML = `
            <span>Resume from <strong>${utils.formatTime(prog.position_secs)}</strong>?</span>
            <button class="resume-toast-btn" id="resume-yes">Resume</button>
            <button class="resume-toast-dismiss" id="resume-no">✕</button>`;
        _id("video-wrap").appendChild(toast);
        _id("resume-yes").onclick = () => { vid.currentTime = prog.position_secs; toast.remove(); };
        _id("resume-no").onclick  = () => toast.remove();
        setTimeout(() => toast.remove(), 8000);
    }

    async function _saveProgress(force = false) {
        if (!vid.duration) return;
        const pct = (vid.currentTime / vid.duration) * 100;
        await api.post(`/api/progress/${lessonId}`, {
            position_secs:   vid.currentTime,
            duration_secs:   vid.duration,
            percent_watched: pct,
        });
    }

    function _saveOnUnload() {
        if (!vid || !vid.duration) return;
        const pct  = (vid.currentTime / vid.duration) * 100;
        const data = JSON.stringify({
            position_secs:   vid.currentTime,
            duration_secs:   vid.duration,
            percent_watched: pct,
        });
        navigator.sendBeacon(
            `/api/progress/${lessonId}`,
            new Blob([data], { type: "application/json" })
        );
    }

    function _updateNextBtn() {
        const btn = _id("next-video-btn");
        if (!btn) return;
        if (lessonData?.next_id) {
            btn.href = `/player/${lessonData.next_id}`;
            btn.style.display = "";
        } else {
            btn.style.display = "none";
        }
    }

    // ── Controls ───────────────────────────────────────────────────────────────

    function togglePlay() {
        vid.paused ? vid.play() : vid.pause();
        _flashIcon(vid.paused ? "pause" : "play");
    }

    function skip(secs) {
        vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + secs));
        _showControls();
    }

    function setSpeed(rate) {
        vid.playbackRate = rate;
        _id("speed-curr-btn").textContent = rate + "×";
        _id("speed-menu").querySelectorAll("button").forEach(b =>
            b.classList.toggle("active", parseFloat(b.dataset.rate) === rate)
        );
        _closeSpeedMenu();
    }

    function toggleSpeedMenu() {
        speedMenuOpen = !speedMenuOpen;
        _id("speed-menu").style.display = speedMenuOpen ? "block" : "none";
    }

    function _closeSpeedMenu() {
        speedMenuOpen = false;
        if (_id("speed-menu")) _id("speed-menu").style.display = "none";
    }

    function toggleMute() {
        vid.muted = !vid.muted;
        if (!vid.muted && vid.volume === 0) vid.volume = 0.5;
    }

    function toggleFullscreen() {
        const wrap = _id("video-wrap");
        if (!document.fullscreenElement) wrap.requestFullscreen().catch(() => {});
        else document.exitFullscreen();
    }

    function _updatePlayBtn(playing) {
        _id("play-icon").style.display  = playing ? "none"  : "block";
        _id("pause-icon").style.display = playing ? "block" : "none";
        if (playing) _startControlsTimer(); else _showControls();
    }

    function _updateVolumeUI() {
        const v = vid.muted ? 0 : vid.volume;
        _id("vol-range").value = v;
        const icon = _id("vol-icon");
        if (v === 0)
            icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
        else
            icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>`;
    }

    function _flashIcon(type) {
        const el = _id("play-flash");
        el.innerHTML = type === "play"
            ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
            : `<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
    }

    // ── Controls visibility ────────────────────────────────────────────────────

    function _showControls() {
        _id("controls")?.classList.add("visible");
        _id("video-wrap")?.classList.add("controls-visible");
        clearTimeout(controlsTimer);
        _startControlsTimer();
    }

    function _startControlsTimer() {
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            if (!vid.paused) {
                _id("controls")?.classList.remove("visible");
                _id("video-wrap")?.classList.remove("controls-visible");
            }
        }, 3000);
    }

    // ── Seek bar ───────────────────────────────────────────────────────────────

    function _initSeekBar() {
        const track = _id("seek-track");
        if (!track) return;

        function getPct(e) {
            const r = track.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        }

        track.addEventListener("mousedown", e => {
            isDragging = true; dragPct = getPct(e);
            track.classList.add("dragging");
            _updateSeekVisual(dragPct * 100);
            e.preventDefault();
        });
        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            dragPct = getPct(e);
            _updateSeekVisual(dragPct * 100);
        });
        document.addEventListener("mouseup", () => {
            if (!isDragging) return;
            isDragging = false;
            track.classList.remove("dragging");
            if (vid.duration) vid.currentTime = dragPct * vid.duration;
        });
        track.addEventListener("click", e => {
            if (vid.duration) vid.currentTime = getPct(e) * vid.duration;
        });
    }

    function _updateSeekVisual(pct) {
        _id("seek-fill").style.width  = pct + "%";
        _id("seek-thumb").style.left  = pct + "%";
        if (vid.duration)
            _id("seek-time-current").textContent = utils.formatTime((pct / 100) * vid.duration);
    }

    // ── Keyboard ───────────────────────────────────────────────────────────────

    function _handleKey(e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        switch (e.code) {
            case "Space":       e.preventDefault(); togglePlay(); break;
            case "ArrowLeft":   e.preventDefault(); skip(-skipSecs); break;
            case "ArrowRight":  e.preventDefault(); skip(+skipSecs); break;
            case "ArrowUp":     e.preventDefault(); vid.volume = Math.min(1, vid.volume + 0.1); break;
            case "ArrowDown":   e.preventDefault(); vid.volume = Math.max(0, vid.volume - 0.1); break;
            case "KeyF":        toggleFullscreen(); break;
            case "KeyM":        toggleMute(); break;
            case "KeyN":        if (lessonData?.next_id) location.href = `/player/${lessonData.next_id}`; break;
            case "KeyP":        if (lessonData?.prev_id) location.href = `/player/${lessonData.prev_id}`; break;
            case "KeyB":        addBookmark(); break;
            case "KeyC":        toggleCC(); break;
            case "Slash":       if (e.shiftKey) toggleShortcutsPanel(); break;
            default:
                if (e.code.startsWith("Digit") && vid.duration) {
                    vid.currentTime = (parseInt(e.key, 10) / 10) * vid.duration;
                    _showControls();
                }
        }
    }

    // ── Sidebar ────────────────────────────────────────────────────────────────

    async function _loadSidebar(courseId) {
        const course = await api.get(`/api/courses/${courseId}`);
        if (course.error) return;

        const link = _id("sidebar-course-link");
        if (link) { link.textContent = course.title; link.href = `/course/${courseId}`; }

        const pct = course.progress?.percent || 0;
        const fill = _id("sidebar-prog-fill");
        const pctEl = _id("sidebar-prog-pct");
        if (fill)  fill.style.width      = pct + "%";
        if (pctEl) pctEl.textContent     = Math.round(pct) + "%";

        const list = _id("sidebar-list");
        if (!list) return;
        list.innerHTML = "";

        _renderSidebarNodes(course.sections, list, 0);

        // Scroll active into view
        setTimeout(() => {
            list.querySelector(".sidebar-lesson.active")
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 300);
    }

    const _SO_CHEV = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>`;

    /** Returns true if this node or any descendant contains lessonId */
    function _nodeHasActive(node) {
        if ((node.lessons || []).some(l => l.id === lessonId)) return true;
        return (node.children || []).some(_nodeHasActive);
    }

    function _renderSidebarNodes(nodes, container, depth) {
        let lecNum = 1; // running counter across all lectures in scope

        for (const node of nodes) {
            const containsActive = _nodeHasActive(node);
            const allLessons     = _flatLessons(node);
            const done           = allLessons.filter(l => l.progress.is_completed).length;
            const total          = allLessons.length;

            if (depth === 0) {
                // ── MODULE accordion ──
                // Spans only inside <button>
                const modDiv = document.createElement("div");
                modDiv.className = "so-mod" + (containsActive ? " so-mod--active" : "");

                const bodyId = `so-body-mod-${node.id}`;
                const chevId = `so-chev-mod-${node.id}`;
                const isOpen = containsActive; // auto-expand if contains active lesson

                const btn = document.createElement("button");
                btn.className = "so-mod-btn";
                btn.setAttribute("aria-expanded", String(isOpen));
                btn.innerHTML = `
                  <span class="so-mod-chev" id="${chevId}"
                        style="transform:rotate(${isOpen ? "0" : "-90"}deg)">${_SO_CHEV}</span>
                  <svg class="so-icon so-mod-icon" viewBox="0 0 16 16"><path d="M9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31zM2 3.5a.5.5 0 0 0-.5.5v.5l.5-.5h.5zm3-2A1.5 1.5 0 0 0 3.5 3H1.5A1.5 1.5 0 0 0 0 4.5v.5h12V4a1 1 0 0 0-1-1H6.5a.5.5 0 0 1-.354-.146z"/></svg>
                  <span class="so-mod-title-wrap">
                    <span class="so-mod-title">${utils.escHtml(node.title)}</span>
                  </span>
                  <span class="so-mod-count">${done}/${total}</span>`;
                btn.addEventListener("click", () => _soToggle(bodyId, chevId, btn));

                const body = document.createElement("div");
                body.id = bodyId;
                body.className = "so-body";
                body.dataset.open = String(isOpen);
                // max-height set after DOM insertion so scrollHeight is available
                requestAnimationFrame(() => {
                    body.style.maxHeight = isOpen ? "none" : "0";
                });

                modDiv.appendChild(btn);
                modDiv.appendChild(body);
                container.appendChild(modDiv);

                // Recurse: lessons go into body
                _renderSidebarNodes(node.children || [], body, 1);
                _appendLectures(node.lessons || [], body, lecNum, 0);
                lecNum += (node.lessons || []).length;

            } else if (depth === 1) {
                // ── LESSON sub-accordion ──
                const lesDiv = document.createElement("div");
                lesDiv.className = "so-les" + (containsActive ? " so-les--active" : "");

                const bodyId = `so-body-les-${node.id}`;
                const chevId = `so-chev-les-${node.id}`;
                const isOpen = containsActive;

                const btn = document.createElement("button");
                btn.className = "so-les-btn";
                btn.setAttribute("aria-expanded", String(isOpen));
                btn.innerHTML = `
                  <span class="so-les-chev" id="${chevId}"
                        style="transform:rotate(${isOpen ? "0" : "-90"}deg)">${_SO_CHEV}</span>
                  <svg class="so-icon so-les-icon" viewBox="0 0 16 16"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5zm8 0A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5zm-8 8A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5zm8 0A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5z"/></svg>
                  <span class="so-les-title-wrap">
                    <span class="so-les-title">${utils.escHtml(node.title)}</span>
                  </span>
                  <span class="so-les-count">${total}</span>`;
                btn.addEventListener("click", () => _soToggle(bodyId, chevId, btn));

                const body = document.createElement("div");
                body.id = bodyId;
                body.className = "so-body";
                body.dataset.open = String(isOpen);
                requestAnimationFrame(() => {
                    body.style.maxHeight = isOpen ? "none" : "0";
                });

                lesDiv.appendChild(btn);
                lesDiv.appendChild(body);
                container.appendChild(lesDiv);

                _renderSidebarNodes(node.children || [], body, 2);
                _appendLectures(node.lessons || [], body, lecNum, 1);
                lecNum += (node.lessons || []).length;

            } else {
                // ── SUB-LESSON sub-accordion (depth ≥ 2) ──
                const subDiv = document.createElement("div");
                subDiv.className = "so-sub" + (containsActive ? " so-sub--active" : "");

                const bodyId = `so-body-sub-${node.id}`;
                const chevId = `so-chev-sub-${node.id}`;
                const isOpen = containsActive;

                const btn = document.createElement("button");
                btn.className = "so-sub-btn";
                btn.setAttribute("aria-expanded", String(isOpen));
                btn.innerHTML = `
                  <span class="so-sub-chev" id="${chevId}"
                        style="transform:rotate(${isOpen ? "0" : "-90"}deg)">${_SO_CHEV}</span>
                  <svg class="so-icon so-sub-icon" viewBox="0 0 16 16"><path d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5M3.854 2.146a.5.5 0 0 0-.708.708L4.293 4l-1.147 1.146a.5.5 0 1 0 .708.708l1.5-1.5a.5.5 0 0 0 0-.708z"/></svg>
                  <span class="so-sub-title-wrap">
                    <span class="so-sub-title">${utils.escHtml(node.title)}</span>
                  </span>
                  <span class="so-sub-count">${total}</span>`;
                btn.addEventListener("click", () => _soToggle(bodyId, chevId, btn));

                const body = document.createElement("div");
                body.id = bodyId;
                body.className = "so-body";
                body.dataset.open = String(isOpen);
                requestAnimationFrame(() => {
                    body.style.maxHeight = isOpen ? "none" : "0";
                });

                subDiv.appendChild(btn);
                subDiv.appendChild(body);
                container.appendChild(subDiv);

                _renderSidebarNodes(node.children || [], body, 3);
                _appendLectures(node.lessons || [], body, lecNum, 2);
                lecNum += (node.lessons || []).length;
            }
        }
    }

    function _soToggle(bodyId, chevId, btn) {
        const body = document.getElementById(bodyId);
        const chev = document.getElementById(chevId);
        if (!body) return;
        const isOpen = body.dataset.open === "true";

        if (isOpen) {
            // Closing: pin concrete height first so transition has a start point
            body.style.maxHeight = body.scrollHeight + "px";
            body.dataset.open = "false";
            requestAnimationFrame(() => requestAnimationFrame(() => {
                body.style.maxHeight = "0";
            }));
            if (chev) chev.style.transform = "rotate(-90deg)";
            btn.setAttribute("aria-expanded", "false");
        } else {
            // Opening: animate to content height, then release constraint
            body.dataset.open = "true";
            body.style.maxHeight = body.scrollHeight + "px";
            body.addEventListener("transitionend", function release() {
                body.removeEventListener("transitionend", release);
                if (body.dataset.open === "true") body.style.maxHeight = "none";
            });
            if (chev) chev.style.transform = "rotate(0deg)";
            btn.setAttribute("aria-expanded", "true");
        }
    }

    function _flatLessons(node) {
        return [...(node.lessons || []), ...(node.children || []).flatMap(_flatLessons)];
    }

    function _appendLectures(lessons, container, startNum, lesDepth = 0) {
        lessons.forEach((les, i) => {
            const num      = startNum + i;
            const isActive = les.id === lessonId;
            const isDone   = les.progress.is_completed;
            const pct      = les.progress.percent_watched || 0;
            const dur      = les.duration_secs ? utils.formatTime(les.duration_secs) : "";

            let cls = "so-lec";
            if (lesDepth >= 2) cls += " so-lec--deep";
            else if (lesDepth >= 1) cls += " so-lec--mid";
            if (isActive) cls += " active";
            if (isDone)   cls += " done";

            const strip = pct > 0 && !isDone
                ? `<div class="so-lec-strip"><div class="so-lec-strip-fill" style="width:${pct}%"></div></div>`
                : "";

            const playIcon = isDone
                ? `<svg class="so-lec-icon" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="m10.97 4.97-.02.022-3.473 4.425-2.093-2.094a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05"/></svg>`
                : `<svg class="so-lec-icon" viewBox="0 0 16 16"><path d="M6 3.5a.5.5 0 0 1 .757-.429l7 4a.5.5 0 0 1 0 .858l-7 4A.5.5 0 0 1 6 12.5v-9z"/></svg>`;

            const a = document.createElement("a");
            a.className = cls;
            a.href      = `/player/${les.id}`;
            a.dataset.id = les.id;
            a.innerHTML = `
              <span class="so-lec-num">${num}</span>
              ${playIcon}
              <span class="so-lec-title-wrap">
                <span class="so-lec-title">${utils.escHtml(les.title)}</span>
              </span>
              <span class="so-lec-dur">${dur}</span>
              ${strip}`;

            if (isActive) a.addEventListener("click", e => e.preventDefault());

            // Measure overflow after paint and set --so-overflow for marquee
            requestAnimationFrame(() => {
                const wrap  = a.querySelector(".so-lec-title-wrap");
                const title = a.querySelector(".so-lec-title");
                if (wrap && title) {
                    const overflow = title.scrollWidth - wrap.clientWidth;
                    if (overflow > 2) {
                        a.style.setProperty("--so-overflow", `-${overflow + 6}px`);
                    }
                }
            });

            container.appendChild(a);
        });
    }

    // ── MKV overlay ───────────────────────────────────────────────────────────

    let _pollTimer   = null;
    let _convertMode = "copy";   // "copy" | "transcode" — reported by the backend

    async function _checkMkvStatus() {
        const status = await _bgFetch(`/api/video/${lessonId}/status`);
        if (status.status === "ready") {
            _dismissMkvOverlay();
            return;
        }
        if (status.status === "in_progress") {
            if (status.mode) _convertMode = status.mode;
            _showMkvOverlay("converting", status.percent || 0);
            _startMkvPoll();
            return;
        }
        if (status.status === "error") {
            _showMkvOverlay("error", 0, status.error);
            return;
        }
        // needs_remux — show the Convert Now button
        _showMkvOverlay("needs_remux", 0);
    }

    function _showMkvOverlay(mode, percent, errorMsg) {
        const o = _id("mkv-overlay"); if (!o) return;
        o.style.display = "flex";

        const spinner     = _id("mkv-spinner-wrap");
        const icon        = _id("mkv-icon-wrap");
        const title       = _id("mkv-title");
        const pctEl       = _id("mkv-pct");
        const convertBtn  = _id("mkv-convert-btn");
        const externalBtn = _id("mkv-external-btn");
        const errEl       = _id("mkv-error");
        const hint        = _id("mkv-hint");

        // Reset all buttons/errors
        if (errEl)       { errEl.style.display = "none"; errEl.textContent = ""; }
        if (convertBtn)  convertBtn.style.display  = "none";
        if (externalBtn) externalBtn.style.display = "none";

        if (mode === "converting") {
            spinner.style.display = "block";
            icon.style.display    = "none";
            title.textContent     = "Converting video…";
            pctEl.textContent     = percent > 0 ? percent + "%" : "";
            if (hint) hint.textContent = _convertMode === "transcode"
                ? "Re-encoding to H.264 — this codec needs full conversion, may take a while."
                : "Stream copy — no re-encoding. Should be fast.";

        } else if (mode === "error") {
            spinner.style.display = "none";
            icon.style.display    = "block";
            title.textContent     = "Conversion failed";
            pctEl.textContent     = "";
            if (errEl) { errEl.textContent = errorMsg || "An error occurred."; errEl.style.display = "block"; }
            if (convertBtn)  { convertBtn.textContent = "Retry"; convertBtn.style.display = "inline-block"; }
            if (externalBtn) externalBtn.style.display = "inline-flex";   // fallback always available
            if (hint) hint.textContent = "Make sure FFmpeg path is set in Settings, or open externally.";

        } else if (mode === "unsupported") {
            // Video loaded but browser can't decode it (video element 'error' event)
            spinner.style.display = "none";
            icon.style.display    = "block";
            title.textContent     = "Unsupported format";
            pctEl.textContent     = "";
            if (errEl) { errEl.textContent = errorMsg || "Your browser cannot play this video format."; errEl.style.display = "block"; }
            if (externalBtn) externalBtn.style.display = "inline-flex";
            if (convertBtn && lessonData?.needs_remux) { convertBtn.textContent = "Convert Now"; convertBtn.style.display = "inline-block"; }
            if (hint) hint.textContent = "Open in VLC, MPV, or another external player.";

        } else {
            // needs_remux — show both options
            spinner.style.display = "none";
            icon.style.display    = "block";
            title.textContent     = "Video conversion required";
            pctEl.textContent     = "";
            if (convertBtn)  { convertBtn.textContent = "Convert Now"; convertBtn.style.display = "inline-block"; }
            if (externalBtn) externalBtn.style.display = "inline-flex";  // watch immediately without converting
            if (hint) hint.textContent = "Convert for in-app playback, or open directly in an external player.";
        }
    }

    function _dismissMkvOverlay() {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
        const o = _id("mkv-overlay");
        if (o) o.style.display = "none";
        _attachVideoEvents();
        vid.src = `/video/${lessonId}`;
        vid.load();
        _restoreProgress(lessonData.progress);
    }

    async function _bgFetch(url) {
        try {
            const r = await fetch(url, { cache: "no-store" });
            return r.ok ? r.json() : null;
        } catch { return null; }
    }

    function _startMkvPoll() {
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = setInterval(async () => {
            const s = await _bgFetch(`/api/video/${lessonId}/status`);
            if (s.status === "ready") {
                clearInterval(_pollTimer); _pollTimer = null;
                _dismissMkvOverlay();
            } else if (s.status === "in_progress") {
                const pctEl = _id("mkv-pct");
                if (pctEl) pctEl.textContent = s.percent > 0 ? s.percent + "%" : "";
                // Update the hint if the backend reports a different mode
                // (codec probe finishes shortly after the job starts)
                if (s.mode && s.mode !== _convertMode) {
                    _convertMode = s.mode;
                    const hint = _id("mkv-hint");
                    if (hint) hint.textContent = _convertMode === "transcode"
                        ? "Re-encoding to H.264 — this codec needs full conversion, may take a while."
                        : "Stream copy — no re-encoding. Should be fast.";
                }
            } else if (s.status === "error") {
                clearInterval(_pollTimer); _pollTimer = null;
                _showMkvOverlay("error", 0, s.error);
            }
        }, 1500);
    }

    async function startRemux() {
        const btn = _id("mkv-convert-btn");
        if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }

        const result = await api.post(`/api/video/${lessonId}/remux`);

        if (result.ok) {
            if (result.status === "ready") {
                // Was already cached somehow
                _dismissMkvOverlay();
            } else {
                _showMkvOverlay("converting", 0);
                _startMkvPoll();
            }
        } else {
            if (btn) { btn.disabled = false; btn.textContent = "Retry"; }
            const errEl = _id("mkv-error");
            if (errEl) {
                errEl.textContent = result.error || "Failed to start conversion.";
                errEl.style.display = "block";
            }
        }
    }

    async function openExternally() {
        const result = await api.post(`/api/video/${lessonId}/open-external`);
        if (result?.ok) {
            utils.toast("Opening in external player…", "info", 2500);
        } else {
            utils.toast(result?.error || "Could not launch external player.", "error", 4000);
        }
    }

    // ── Sidebar tabs ─────────────────────────────────────────────────────────

    let _activeTab = "outline";

    function switchTab(tab) {
        _activeTab = tab;
        document.querySelectorAll(".sidebar-tab").forEach(btn => {
            const isActive = btn.dataset.tab === tab;
            btn.classList.toggle("active", isActive);
            btn.setAttribute("aria-selected", String(isActive));
        });
        ["outline", "notes", "bookmarks"].forEach(t => {
            const panel = _id(`panel-${t}`);
            if (panel) panel.style.display = t === tab ? "" : "none";
        });
        if (tab === "notes")     _refreshNotes();
        if (tab === "bookmarks") _refreshBookmarks();
        if (tab === "notes") {
            // Update timestamp label with current time
            const tsLabel = _id("note-ts-label");
            if (tsLabel && vid && vid.duration)
                tsLabel.textContent = `at ${utils.formatTime(vid.currentTime)}`;
        }
    }

    // ── Notes ─────────────────────────────────────────────────────────────────

    let _notes = [];

    async function _refreshNotes() {
        _notes = await api.get(`/api/lessons/${lessonId}/notes`);
        _renderNotes();
    }

    function _renderNotes() {
        const list = _id("notes-list");
        if (!list) return;
        if (!_notes.length) {
            list.innerHTML = `<p class="panel-empty">No notes yet.<br>Write one above.</p>`;
            return;
        }
        list.innerHTML = _notes.map(n => `
            <div class="note-item" data-id="${n.id}">
                <div class="note-item-header">
                    ${n.timestamp_secs != null
                        ? `<button class="note-ts-btn" onclick="player.seekTo(${n.timestamp_secs})"
                                   title="Jump to this moment">${utils.formatTime(n.timestamp_secs)}</button>`
                        : `<span class="note-no-ts">—</span>`}
                    <span class="note-date">${utils.timeAgo(n.updated_at || n.created_at)}</span>
                    <button class="note-delete-btn" onclick="player.deleteNote(${n.id})"
                            title="Delete note" aria-label="Delete note">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <p class="note-content">${utils.escHtml(n.content)}</p>
            </div>`).join("");
    }

    async function addNote() {
        const input   = _id("note-input");
        const content = input?.value.trim();
        if (!content) return;

        const ts = (vid && vid.duration && vid.currentTime > 0)
            ? vid.currentTime
            : null;

        const result = await api.post(`/api/lessons/${lessonId}/notes`, { content, timestamp_secs: ts });
        if (result.id) {
            input.value = "";
            await _refreshNotes();
        }
    }

    async function deleteNote(noteId) {
        await api.delete(`/api/notes/${noteId}`);
        await _refreshNotes();
    }

    function exportNotes() {
        // Trigger browser download — no JS needed, just navigate to the export URL
        window.location.href = `/api/lessons/${lessonId}/notes/export?format=md`;
    }

    // ── Bookmarks ─────────────────────────────────────────────────────────────

    let _bookmarks = [];

    async function _refreshBookmarks() {
        _bookmarks = await api.get(`/api/lessons/${lessonId}/bookmarks`);
        _renderBookmarks();
    }

    function _renderBookmarks() {
        const list = _id("bookmarks-list");
        if (!list) return;
        if (!_bookmarks.length) {
            list.innerHTML = `<p class="panel-empty">No bookmarks yet.<br>Press <strong>B</strong> while watching.</p>`;
            return;
        }
        list.innerHTML = _bookmarks.map(bm => `
            <div class="bm-item" data-id="${bm.id}">
                <button class="bm-seek-btn" onclick="player.seekTo(${bm.timestamp_secs})"
                        title="Jump to ${utils.formatTime(bm.timestamp_secs)}">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                    ${utils.formatTime(bm.timestamp_secs)}
                </button>
                <span class="bm-label">${utils.escHtml(bm.label || "")}</span>
                <button class="bm-delete-btn" onclick="player.deleteBookmark(${bm.id})"
                        title="Remove bookmark" aria-label="Remove bookmark">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>`).join("");
    }

    async function addBookmark() {
        if (!vid || !vid.duration) return;
        const ts = vid.currentTime;
        const result = await api.post(`/api/lessons/${lessonId}/bookmarks`,
            { timestamp_secs: ts, label: null });
        if (result.id) {
            utils.toast(`Bookmark added at ${utils.formatTime(ts)}`, "success", 2000);
            if (_activeTab === "bookmarks") await _refreshBookmarks();
        }
    }

    async function deleteBookmark(bmId) {
        await api.delete(`/api/bookmarks/${bmId}`);
        await _refreshBookmarks();
    }

    function seekTo(secs) {
        if (!vid) return;
        vid.currentTime = secs;
        vid.play();
        _showControls();
    }

    // ── Subtitles / CC ────────────────────────────────────────────────────────

    let _ccEnabled = false;

    function _loadSubtitle(hasSubtitle) {
        const ccBtn = _id("cc-btn");
        const track = _id("subtitle-track");
        if (!track) return;

        if (hasSubtitle) {
            track.src  = `/api/lessons/${lessonId}/subtitle`;
            track.mode = "hidden";    // hidden by default; user activates with C
            _ccEnabled = false;
            if (ccBtn) ccBtn.style.display = "";
        } else {
            track.removeAttribute("src");
            track.mode = "disabled";
            if (ccBtn) ccBtn.style.display = "none";
        }
    }

    function toggleCC() {
        const track = _id("subtitle-track");
        const btn   = _id("cc-btn");
        if (!track || !track.src) return;

        _ccEnabled = !_ccEnabled;
        track.mode = _ccEnabled ? "showing" : "hidden";
        btn?.classList.toggle("cc-active", _ccEnabled);
        utils.toast(_ccEnabled ? "Subtitles on" : "Subtitles off", "info", 1500);
    }

    // ── Shortcuts panel ────────────────────────────────────────────────────────

    function toggleShortcutsPanel() {
        let panel = _id("shortcuts-panel");
        if (panel) { panel.remove(); return; }
        panel = document.createElement("div");
        panel.id = "shortcuts-panel"; panel.className = "shortcuts-panel";
        panel.onclick = e => { if (e.target === panel) panel.remove(); };
        panel.innerHTML = `<div class="shortcuts-box">
            <div class="shortcuts-title">Keyboard Shortcuts</div>
            ${[["Space","Play / Pause"],["← / →",`Skip ${skipSecs}s`],["↑ / ↓","Volume"],
               ["0–9","Jump to 0–90%"],["F","Fullscreen"],["M","Mute"],
               ["C","Toggle subtitles"],["B","Bookmark current time"],
               ["N","Next lesson"],["P","Prev lesson"],["Shift+/","This panel"]]
              .map(([k,d]) => `<div class="shortcut-row"><span class="shortcut-key">${k}</span><span class="shortcut-desc">${d}</span></div>`).join("")}
        </div>`;
        document.body.appendChild(panel);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _id(id) { return document.getElementById(id); }
    function _showError(msg) { document.body.innerHTML = `<p style="color:var(--red);padding:48px;">${msg}</p>`; }
    function handleVideoClick(e) { if (e.detail === 2 || e.button !== 0) return; togglePlay(); _showControls(); }

    // ── Sidebar collapse ──────────────────────────────────────────────────────
    function toggleSidebar() {
        const sb   = document.querySelector(".player-sidebar");
        const icon = document.getElementById("sidebar-collapse-icon");
        if (!sb) return;
        const collapsed = sb.classList.toggle("collapsed");
        if (icon) {
            // Arrow points right when collapsed (to expand), left when open
            icon.innerHTML = collapsed
                ? `<polyline points="9 18 15 12 9 6"/>`
                : `<polyline points="15 18 9 12 15 6"/>`;
        }
        const btn = document.getElementById("sidebar-collapse-btn");
        if (btn) btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    }

    // ── Course complete ───────────────────────────────────────────────────────

    async function _checkCourseComplete() {
        if (!lessonData?.course_id) return;
        // Small delay so sendBeacon has time to write before we query
        await new Promise(r => setTimeout(r, 800));
        const res = await _bgFetch(`/api/courses/${lessonData.course_id}/completion`);
        if (res?.complete) _showCongrats(res);
    }

    let _confettiRaf = null;

    function _showCongrats(data) {
        const overlay = _id("congrats-overlay");
        const nameEl  = _id("congrats-course-name");
        const statsEl = _id("congrats-stats");
        if (!overlay) return;

        if (nameEl) nameEl.textContent = lessonData.course_title || "";
        if (statsEl) statsEl.innerHTML = `
            <div class="congrats-stat">
                <span class="congrats-stat-value">${data.total}</span>
                <span class="congrats-stat-label">Lessons</span>
            </div>
            <div class="congrats-stat">
                <span class="congrats-stat-value">${data.total_hours}</span>
                <span class="congrats-stat-label">Hours</span>
            </div>
            <div class="congrats-stat">
                <span class="congrats-stat-value">100%</span>
                <span class="congrats-stat-label">Complete</span>
            </div>`;

        overlay.style.display = "flex";
        _startConfetti();

        // Close on backdrop click
        overlay.addEventListener("click", e => {
            if (e.target === overlay) dismissCongrats();
        }, { once: true });
    }

    function dismissCongrats() {
        const overlay = _id("congrats-overlay");
        if (overlay) overlay.style.display = "none";
        if (_confettiRaf) { cancelAnimationFrame(_confettiRaf); _confettiRaf = null; }
        const canvas = _id("confetti-canvas");
        if (canvas) { const ctx = canvas.getContext("2d"); ctx.clearRect(0,0,canvas.width,canvas.height); }
    }

    function _startConfetti() {
        const canvas = _id("confetti-canvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");

        canvas.width  = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;

        const COLORS = ["#7c6dfa","#5a8fa8","#a082dc","#4ade80","#fb923c","#f472b6","#facc15"];
        const COUNT  = 120;

        const pieces = Array.from({ length: COUNT }, (_, i) => ({
            x:    Math.random() * canvas.width,
            y:    Math.random() * -canvas.height,
            w:    6 + Math.random() * 8,
            h:    4 + Math.random() * 5,
            r:    Math.random() * Math.PI * 2,
            dr:   (Math.random() - .5) * .12,
            vy:   2.5 + Math.random() * 3.5,
            vx:   (Math.random() - .5) * 1.8,
            color: COLORS[i % COLORS.length],
            wave: Math.random() * Math.PI * 2,
        }));

        const tick = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let allGone = true;
            for (const p of pieces) {
                p.y    += p.vy;
                p.x    += p.vx + Math.sin(p.wave) * .6;
                p.r    += p.dr;
                p.wave += .04;
                if (p.y < canvas.height + 20) allGone = false;

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.r);
                ctx.fillStyle = p.color;
                ctx.globalAlpha = Math.min(1, (canvas.height - p.y) / 120 + .3);
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            }
            if (!allGone) _confettiRaf = requestAnimationFrame(tick);
        };
        _confettiRaf = requestAnimationFrame(tick);
    }

    return {
        init, togglePlay, skip, setSpeed, toggleSpeedMenu,
        toggleMute, toggleFullscreen, toggleShortcutsPanel,
        handleVideoClick, startRemux, openExternally,
        switchTab, addNote, deleteNote, exportNotes,
        addBookmark, deleteBookmark, seekTo,
        toggleCC, toggleSidebar, dismissCongrats,
    };

})();
