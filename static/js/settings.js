/**
 * settings.js — Settings page: load, edit, verify, and save all settings.
 */

document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    bindEvents();
    _resumeDlPollIfActive();
});

// ── Load & populate ───────────────────────────────────────────────────────────

async function loadSettings() {
    const data = await api.get("/api/settings");
    if (data.error) {
        utils.toast("Failed to load settings", "error");
        return;
    }

    // FFmpeg — populate saved path, or auto-fill default if none saved
    const ffmpegInput = document.getElementById("ffmpeg-path");
    if (ffmpegInput) {
        if (data.ffmpeg_path) {
            ffmpegInput.value = data.ffmpeg_path;
            verifyFfmpeg(data.ffmpeg_path, true);
        } else {
            // Try to auto-populate with the bundled default path
            const def = await api.get("/api/settings/ffmpeg-default-path");
            if (def.path) {
                ffmpegInput.value = def.path;
                verifyFfmpeg(def.path, true);
            }
        }
    }

    // Course folders
    const folders = Array.isArray(data.course_folders) ? data.course_folders : [];
    renderFolders(folders);

    // Player settings
    setValue("volume",             data.player_volume     || "0.8");
    setValue("skip-seconds",       data.skip_seconds      || "10");
    setValue("complete-threshold", data.complete_threshold|| "90");
    setToggle("auto-play-next",      data.auto_play_next      !== "false");
    setToggle("cache-beside-source", data.cache_beside_source === "true");
    setToggle("debug-mode",          data.debug_mode          === "true");

    // Show debug folder path
    const pathEl = document.getElementById("debug-folder-path");
    if (pathEl && data.debug_folder_path) pathEl.textContent = data.debug_folder_path;

    // Cache info
    updateCacheInfo();
}

function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
    // Update range display if there's a paired label
    const label = document.getElementById(id + "-display");
    if (label) label.textContent = value;
}

function setToggle(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
}

// ── Event bindings ────────────────────────────────────────────────────────────

function bindEvents() {
    // Save button
    document.getElementById("save-btn")?.addEventListener("click", saveSettings);

    // FFmpeg: verify on Enter or button click
    document.getElementById("ffmpeg-verify-btn")?.addEventListener("click", () => {
        const path = document.getElementById("ffmpeg-path")?.value.trim();
        verifyFfmpeg(path);
    });
    document.getElementById("ffmpeg-path")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const path = e.target.value.trim();
            verifyFfmpeg(path);
        }
    });

    // Add folder
    document.getElementById("add-folder-btn")?.addEventListener("click", addFolder);
    document.getElementById("folder-input")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addFolder();
    });

    // Range sliders → show live value
    ["volume", "skip-seconds", "complete-threshold"].forEach(id => {
        const el = document.getElementById(id);
        const label = document.getElementById(id + "-display");
        if (el && label) {
            el.addEventListener("input", () => { label.textContent = el.value; });
        }
    });

    // Clear cache
    document.getElementById("clear-cache-btn")?.addEventListener("click", clearCache);
}

// ── FFmpeg browse (pywebview native file picker) ──────────────────────────────

async function browseFfmpegPath() {
    const btn = document.getElementById("ffmpeg-browse-btn");
    if (!window.pywebview || !window.pywebview.api) {
        utils.toast("Native file picker is only available in the desktop app.", "info");
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Picking…"; }
    try {
        const path = await window.pywebview.api.pick_file(["All files (*.*)"]);  // macOS: no .exe extension;
        if (path) {
            const input = document.getElementById("ffmpeg-path");
            if (input) input.value = path;
            verifyFfmpeg(path);
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Browse…"; }
    }
}

// ── Folder browse (pywebview native picker) ───────────────────────────────────

async function browseFolderForSettings() {
    const btn = document.getElementById("browse-folder-btn");
    if (!window.pywebview || !window.pywebview.api) {
        utils.toast("Native folder picker is only available in the desktop app.", "info");
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Picking…"; }
    try {
        const path = await window.pywebview.api.pick_folder();
        if (path) {
            const input = document.getElementById("folder-input");
            if (input) input.value = path;
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Browse…"; }
    }
}

// ── Rescan ────────────────────────────────────────────────────────────────────

async function triggerRescan() {
    const btn    = document.getElementById("rescan-btn");
    const status = document.getElementById("rescan-status");
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    if (status) status.textContent = "Scanning…";

    const result = await api.post("/api/scan");

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
        </svg> Rescan Now`;
    }

    if (result.ok) {
        const detail = (result.detail || [])
            .map(d => `${d.title}: ${d.modules} modules / ${d.lessons} lessons / ${d.lectures} lectures`)
            .join(" · ") || "no courses found";
        if (status) status.textContent = detail;
        utils.toast(`Scan complete: ${result.courses} course${result.courses !== 1 ? "s" : ""}`, "success");
        if (result.errors && result.errors.length) console.warn("Scan errors:", result.errors);
    } else {
        if (status) status.textContent = "Scan failed";
        utils.toast("Scan failed", "error");
    }
}

// ── Folder management ─────────────────────────────────────────────────────────

let currentFolders = [];

function toggleLibrary() {
    const body   = document.getElementById("library-body");
    const toggle = document.getElementById("library-toggle");
    if (!body) return;
    const isOpen = body.classList.contains("open");
    body.classList.toggle("open", !isOpen);
    body.setAttribute("aria-hidden", String(isOpen));
    toggle.setAttribute("aria-expanded", String(!isOpen));
}

function _openLibrary() {
    const body   = document.getElementById("library-body");
    const toggle = document.getElementById("library-toggle");
    if (!body || body.classList.contains("open")) return;
    body.classList.add("open");
    body.setAttribute("aria-hidden", "false");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
}

function renderFolders(folders) {
    currentFolders = folders;
    const list  = document.getElementById("folder-list");
    const badge = document.getElementById("folder-count-badge");
    if (!list) return;

    if (badge) badge.textContent = folders.length + (folders.length === 1 ? " folder" : " folders");

    if (folders.length === 0) {
        list.innerHTML = `<p class="text-sm" style="color:var(--text-3)">No course folders added yet.</p>`;
        return;
    }

    list.innerHTML = folders.map((f, i) => `
        <div class="folder-row" data-index="${i}">
            <span class="folder-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                </svg>
            </span>
            <span class="folder-path" id="folder-path-${i}">${utils.escHtml(f)}</span>
            <div class="folder-actions">
                <button class="folder-action-btn" onclick="rescanFolder(${i})" title="Rescan this folder">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"/>
                        <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                    </svg>
                    Rescan
                </button>
                <button class="folder-action-btn" onclick="editFolder(${i})" id="edit-btn-${i}" title="Edit path">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Edit
                </button>
                <button class="folder-action-btn danger" onclick="removeFolder(${i})" title="Remove folder">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                    </svg>
                    Remove
                </button>
            </div>
        </div>
    `).join("");
}

async function addFolder() {
    const input = document.getElementById("folder-input");
    const path  = input?.value.trim();
    if (!path) return;

    const indicator = document.getElementById("folder-verify-indicator");
    const btn       = document.getElementById("add-folder-btn");

    if (indicator) { indicator.textContent = "Checking…"; indicator.className = "verify-checking"; }

    const result = await api.post("/api/settings/verify-folder", { path });

    if (!result.ok) {
        if (indicator) { indicator.textContent = `✗ ${result.error}`; indicator.className = "verify-error"; }
        setTimeout(() => { if (indicator) indicator.textContent = ""; }, 4000);
        return;
    }

    if (currentFolders.includes(path)) {
        if (indicator) { indicator.textContent = "Already added"; indicator.className = "verify-warn"; }
        setTimeout(() => { if (indicator) indicator.textContent = ""; }, 4000);
        return;
    }

    // Add to list, save to settings, and reveal the library panel
    currentFolders.push(path);
    renderFolders(currentFolders);
    _openLibrary();
    if (input) input.value = "";
    await api.post("/api/settings", { course_folders: currentFolders });

    // Scan just this folder — no need to rescan everything
    if (indicator) { indicator.textContent = "Scanning…"; indicator.className = "verify-checking"; }
    if (btn) btn.disabled = true;

    const scan = await api.post("/api/scan/folder", { folder: path });

    if (btn) btn.disabled = false;

    if (scan.ok) {
        const detail = scan.title
            ? `✓ Imported "${scan.title}": ${scan.lectures} lecture${scan.lectures !== 1 ? "s" : ""}`
            : `✓ Imported: ${scan.lectures} lecture${scan.lectures !== 1 ? "s" : ""}`;
        if (indicator) { indicator.textContent = detail; indicator.className = "verify-ok"; }
        utils.toast(`Course imported successfully`, "success");
    } else {
        if (indicator) { indicator.textContent = `⚠ Folder saved but scan failed: ${scan.error || "unknown error"}`; indicator.className = "verify-warn"; }
    }

    setTimeout(() => { if (indicator) indicator.textContent = ""; }, 6000);
}

function removeFolder(index) {
    currentFolders.splice(index, 1);
    renderFolders(currentFolders);
    api.post("/api/settings", { course_folders: currentFolders });
}

async function rescanFolder(index) {
    const folder  = currentFolders[index];
    const btn     = document.querySelector(`.folder-row[data-index="${index}"] .folder-action-btn`);
    const pathEl  = document.getElementById(`folder-path-${index}`);
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }

    const scan = await api.post("/api/scan/folder", { folder });

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
        </svg> Rescan`;
    }

    if (scan.ok) {
        utils.toast(scan.title
            ? `Rescanned "${scan.title}": ${scan.lectures} lesson${scan.lectures !== 1 ? "s" : ""}`
            : "Rescan complete", "success");
    } else {
        utils.toast(`Rescan failed: ${scan.error || "unknown error"}`, "error");
    }
}

function editFolder(index) {
    const pathEl = document.getElementById(`folder-path-${index}`);
    const editBtn = document.getElementById(`edit-btn-${index}`);
    if (!pathEl) return;

    const current = currentFolders[index];
    pathEl.outerHTML = `<input class="folder-path-input" id="folder-path-${index}"
        value="${utils.escHtml(current)}"
        onkeydown="if(event.key==='Enter') saveEditFolder(${index}); if(event.key==='Escape') renderFolders(currentFolders);"
    />`;
    if (editBtn) {
        editBtn.textContent = "Save";
        editBtn.onclick = () => saveEditFolder(index);
    }
    document.getElementById(`folder-path-${index}`)?.focus();
}

async function saveEditFolder(index) {
    const input = document.getElementById(`folder-path-${index}`);
    const newPath = input?.value.trim();
    if (!newPath) return;

    const indicator = document.getElementById("folder-verify-indicator");
    if (indicator) { indicator.textContent = "Verifying…"; indicator.className = "verify-checking"; }

    const result = await api.post("/api/settings/verify-folder", { path: newPath });
    if (!result.ok) {
        if (indicator) { indicator.textContent = `✗ ${result.error}`; indicator.className = "verify-error"; }
        setTimeout(() => { if (indicator) indicator.textContent = ""; }, 4000);
        return;
    }

    currentFolders[index] = newPath;
    renderFolders(currentFolders);
    _openLibrary();
    await api.post("/api/settings", { course_folders: currentFolders });
    if (indicator) { indicator.textContent = ""; }
    utils.toast("Folder path updated", "success");
}

// ── FFmpeg verification ───────────────────────────────────────────────────────

async function verifyFfmpeg(path, silent = false) {
    const statusEl = document.getElementById("ffmpeg-status");
    if (!statusEl) return;

    statusEl.textContent   = "Checking...";
    statusEl.className     = "ffmpeg-status checking";

    const result = await api.post("/api/settings/verify-ffmpeg", { path });

    if (result.ok) {
        statusEl.textContent = `● FFmpeg ready (v${result.version})`;
        statusEl.className   = "ffmpeg-status ok";
        if (!silent) utils.toast(`FFmpeg v${result.version} detected`, "success");
    } else {
        statusEl.textContent = `● ${result.error || "Not found"}`;
        statusEl.className   = "ffmpeg-status error";
        if (!silent) utils.toast("FFmpeg not found at that path", "error");
    }
}

// ── Save all settings ─────────────────────────────────────────────────────────

async function saveSettings() {
    const btn = document.getElementById("save-btn");
    if (btn) { btn.textContent = "Saving..."; btn.disabled = true; }

    const payload = {
        ffmpeg_path:          document.getElementById("ffmpeg-path")?.value.trim()         || "",
        course_folders:       currentFolders,
        player_volume:        document.getElementById("volume")?.value                      || "0.8",
        skip_seconds:         document.getElementById("skip-seconds")?.value               || "10",
        complete_threshold:   document.getElementById("complete-threshold")?.value          || "90",
        auto_play_next:       document.getElementById("auto-play-next")?.checked      ? "true" : "false",
        cache_beside_source:  document.getElementById("cache-beside-source")?.checked  ? "true" : "false",
        debug_mode:           document.getElementById("debug-mode")?.checked           ? "true" : "false",
    };

    const result = await api.post("/api/settings", payload);

    if (btn) { btn.textContent = "Save Settings"; btn.disabled = false; }

    if (result.ok) {
        utils.toast("Settings saved", "success");
    } else {
        utils.toast("Failed to save settings", "error");
    }
}

// ── Fix durations ─────────────────────────────────────────────────────────────

async function fixDurations() {
    const btn    = document.getElementById("fix-dur-btn");
    const status = document.getElementById("fix-dur-status");
    if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
    if (status) status.textContent = "Extracting durations…";

    const result = await api.post("/api/courses/backfill-durations");

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg> Fix Durations`;
    }

    if (result.ok) {
        if (status) status.textContent =
            result.updated > 0
                ? `✓ Fixed ${result.updated} of ${result.total} lessons`
                : result.total === 0
                    ? "All durations already set"
                    : `Could not extract. Is ffprobe available?`;
        if (result.updated > 0) utils.toast(`Durations fixed for ${result.updated} lessons`, "success");
    } else {
        if (status) status.textContent = "Failed";
        utils.toast("Duration backfill failed", "error");
    }

    setTimeout(() => { if (status) status.textContent = ""; }, 6000);
}

// ── Cache info ────────────────────────────────────────────────────────────────

async function updateCacheInfo() {
    const el = document.getElementById("cache-size");
    if (!el) return;
    el.textContent = "Calculating…";
    const result = await api.get("/api/cache/info");
    if (result.ok) {
        el.textContent = result.label || `${result.size_mb} MB`;
    } else {
        el.textContent = "Unknown";
    }
}

async function openDebugFolder() {
    const btn = document.getElementById("open-debug-btn");
    if (btn) { btn.disabled = true; }
    const result = await api.post("/api/settings/open-debug-folder");
    if (btn) { btn.disabled = false; }
    if (!result.ok) utils.toast(result.error || "Could not open folder", "error");
}

// ── FFmpeg download ───────────────────────────────────────────────────────────

let _dlPollTimer = null;

async function _resumeDlPollIfActive() {
    const p = await api.get("/api/settings/download-ffmpeg/progress");
    if (!p) return;
    if (p.status !== "downloading" && p.status !== "extracting") return;

    // A download is already running — show the UI and start polling
    const wrap  = document.getElementById("ffmpeg-dl-progress-wrap");
    const btn   = document.getElementById("ffmpeg-dl-btn");
    if (wrap) wrap.style.display = "block";
    if (btn)  { btn.disabled = true; btn.textContent = "Downloading…"; }
    clearInterval(_dlPollTimer);
    _dlPollTimer = setInterval(_pollDlProgress, 500);
}

async function downloadFfmpeg() {
    const btn      = document.getElementById("ffmpeg-dl-btn");
    const wrap     = document.getElementById("ffmpeg-dl-progress-wrap");
    const statusEl = document.getElementById("ffmpeg-dl-status");

    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }

    const result = await api.post("/api/settings/download-ffmpeg");
    if (!result.ok) {
        utils.toast(result.error || "Could not start download", "error");
        if (btn) { btn.disabled = false; btn.textContent = "Download FFmpeg"; }
        return;
    }

    if (wrap) wrap.style.display = "block";
    if (statusEl) statusEl.textContent = "Connecting…";

    // Poll progress every 500ms
    clearInterval(_dlPollTimer);
    _dlPollTimer = setInterval(_pollDlProgress, 500);
}

function _fmtBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024)    return (b / 1024).toFixed(0) + " KB";
    return b + " B";
}

async function _pollDlProgress() {
    const p = await api.get("/api/settings/download-ffmpeg/progress");
    if (!p) return;

    const statusEl = document.getElementById("ffmpeg-dl-status");
    const speedEl  = document.getElementById("ffmpeg-dl-speed");
    const fillEl   = document.getElementById("ffmpeg-dl-fill");
    const bytesEl  = document.getElementById("ffmpeg-dl-bytes");
    const pctEl    = document.getElementById("ffmpeg-dl-pct");
    const btn      = document.getElementById("ffmpeg-dl-btn");

    if (fillEl) fillEl.style.width = (p.percent || 0) + "%";
    if (pctEl)  pctEl.textContent  = p.total ? `${p.percent}%` : "";
    if (bytesEl && p.total) {
        bytesEl.textContent = `${_fmtBytes(p.received)} / ${_fmtBytes(p.total)}`;
    }
    if (speedEl) {
        speedEl.textContent = p.speed > 0 ? `${_fmtBytes(p.speed)}/s` : "";
    }

    if (p.status === "downloading") {
        if (statusEl) statusEl.textContent = "Downloading…";
    } else if (p.status === "extracting") {
        if (statusEl) statusEl.textContent = "Extracting…";
        if (speedEl)  speedEl.textContent  = "";
        if (fillEl)   fillEl.style.width   = "100%";
    } else if (p.status === "done") {
        clearInterval(_dlPollTimer);
        if (statusEl) statusEl.textContent = "✓ FFmpeg downloaded successfully";
        if (speedEl)  speedEl.textContent  = "";
        if (fillEl)   fillEl.style.width   = "100%";
        if (btn) {
            btn.disabled    = false;
            btn.textContent = "Download FFmpeg";
        }
        // Populate the path field and verify
        if (p.path) {
            const input = document.getElementById("ffmpeg-path");
            if (input) input.value = p.path;
            verifyFfmpeg(p.path, true);
        }
        utils.toast("FFmpeg downloaded and configured", "success");
        setTimeout(() => {
            const wrap = document.getElementById("ffmpeg-dl-progress-wrap");
            if (wrap) wrap.style.display = "none";
        }, 4000);
    } else if (p.status === "error") {
        clearInterval(_dlPollTimer);
        if (statusEl) { statusEl.textContent = `✗ ${p.error}`; statusEl.style.color = "var(--red)"; }
        if (btn) { btn.disabled = false; btn.textContent = "Download FFmpeg"; }
        utils.toast(`Download failed: ${p.error}`, "error");
    }
}

async function clearCache() {
    if (!confirm("Clear all remuxed video cache files? Original files are not affected.")) return;
    const btn = document.getElementById("clear-cache-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Clearing…"; }
    const result = await api.post("/api/cache/clear");
    if (btn) { btn.disabled = false; btn.textContent = "Clear Cache"; }
    if (result.ok) {
        utils.toast(`Cache cleared — ${result.removed} file${result.removed !== 1 ? "s" : ""} removed`, "success");
        updateCacheInfo();
    } else {
        utils.toast(result.error || "Failed to clear cache", "error");
    }
}
