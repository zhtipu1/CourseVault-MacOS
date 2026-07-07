/**
 * library.js — Course library grid with filtering and search.
 */

let allCourses   = [];
let activeFilter = "all";   // all | in-progress | completed | favorites
let searchQuery  = "";
let activeTag    = "";      // tag filter from URL or tag click

document.addEventListener("DOMContentLoaded", () => {
    // Pre-select filter from URL query param (?filter=favorites etc.)
    if (window._libraryInitialFilter) {
        activeFilter = window._libraryInitialFilter;
        document.querySelectorAll("[data-filter]").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.filter === activeFilter);
        });
    }
    // Pre-select tag from URL query param (?tag=IELTS etc.)
    const urlTag = new URLSearchParams(window.location.search).get("tag");
    if (urlTag) activeTag = urlTag;

    loadLibrary();
    bindEvents();
});

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadLibrary() {
    showSkeleton();

    const [courses, stats] = await Promise.all([
        api.get("/api/courses"),
        api.get("/api/courses/stats"),
    ]);

    if (courses.error) {
        showError("Could not load courses.");
        return;
    }

    allCourses = courses;
    renderStats(stats);
    renderGrid();
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function renderStats(stats) {
    const el = document.getElementById("stats-bar");
    if (!el || !stats) return;

    const totalH = Math.floor((stats.total_duration_secs || 0) / 3600);
    const pct    = stats.total_lessons
        ? Math.round((stats.completed_lessons / stats.total_lessons) * 100)
        : 0;

    el.innerHTML = `
        <span>${stats.total_courses} courses</span>
        <span class="stats-dot">·</span>
        <span>${stats.total_lessons} lessons</span>
        <span class="stats-dot">·</span>
        <span>${totalH}h of content</span>
        <span class="stats-dot">·</span>
        <span style="color:var(--accent)">${pct}% overall complete</span>
    `;
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function getFilteredCourses() {
    let list = allCourses;

    // Text search
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(c => c.title.toLowerCase().includes(q));
    }

    // Tab filter
    switch (activeFilter) {
        case "in-progress":
            list = list.filter(c => (c.progress.percent > 0 || c.progress.has_any_progress) && c.progress.percent < 100);
            break;
        case "completed":
            list = list.filter(c => c.progress.percent >= 100);
            break;
        case "favorites":
            list = list.filter(c => c.is_favorite);
            break;
    }

    // Tag filter
    if (activeTag) {
        list = list.filter(c => Array.isArray(c.tags) && c.tags.includes(activeTag));
    }

    return list;
}

function clearTagFilter() {
    activeTag = "";
    renderGrid();
}

// ── Grid render ───────────────────────────────────────────────────────────────

function renderGrid() {
    const grid    = document.getElementById("course-grid");
    const empty   = document.getElementById("empty-state");
    const filtered = getFilteredCourses();

    if (!grid) return;

    // Tag filter banner
    let banner = document.getElementById("tag-filter-banner");
    if (activeTag) {
        if (!banner) {
            banner = document.createElement("div");
            banner.id        = "tag-filter-banner";
            banner.className = "tag-filter-banner";
            grid.parentNode.insertBefore(banner, grid);
        }
        banner.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
            Filtered by tag: <strong>${utils.escHtml(activeTag)}</strong>
            <button onclick="clearTagFilter()" title="Clear tag filter">✕</button>`;
    } else if (banner) {
        banner.remove();
    }

    if (allCourses.length === 0) {
        grid.style.display  = "none";
        empty.style.display = "flex";
        return;
    }

    grid.style.display  = "grid";
    empty.style.display = "none";

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column:1/-1; padding:48px; text-align:center; color:var(--text-3);">
                No courses match your filter.
            </div>`;
        return;
    }

    grid.innerHTML = filtered.map(courseCard).join("");

    // Animate cards in
    grid.querySelectorAll(".course-card").forEach((el, i) => {
        el.style.animationDelay = `${i * 40}ms`;
    });
}

// ── Card HTML ─────────────────────────────────────────────────────────────────

const GRADIENTS = [
    "linear-gradient(135deg,#1a1744 0%,#312e81 50%,#1e1b4b 100%)",
    "linear-gradient(135deg,#0c2340 0%,#1e3a5f 50%,#0d3050 100%)",
    "linear-gradient(135deg,#1a2e1a 0%,#14532d 50%,#0f3d22 100%)",
    "linear-gradient(135deg,#2d1a1a 0%,#7f1d1d 50%,#450a0a 100%)",
    "linear-gradient(135deg,#1a1a2e 0%,#4a044e 50%,#2d0036 100%)",
    "linear-gradient(135deg,#1c1a0e 0%,#713f12 50%,#451a03 100%)",
    "linear-gradient(135deg,#0e1c1a 0%,#134e4a 50%,#042f2e 100%)",
    "linear-gradient(135deg,#1a0e1c 0%,#581c87 50%,#3b0764 100%)",
];

function titleGradient(title) {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = (hash * 31 + title.charCodeAt(i)) & 0xffffffff;
    }
    return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function statusBadge(pct, hasAnyProgress) {
    if (pct >= 100)                    return `<span class="card-badge badge-done">Completed</span>`;
    if (pct > 0 || hasAnyProgress)     return `<span class="card-badge badge-progress">In Progress</span>`;
    return                                    `<span class="card-badge badge-new">New</span>`;
}

function ctaLabel(pct, hasAnyProgress) {
    if (pct >= 100)                return "Rewatch";
    if (pct > 0 || hasAnyProgress) return "Continue";
    return "Start";
}

function courseCard(c) {
    const pct            = c.progress.percent;
    const hasAnyProgress = c.progress.has_any_progress;
    const totalH   = c.progress.total_secs
        ? utils.formatDuration(c.progress.total_secs)
        : `${c.total_lessons} lessons`;
    const accessed = c.last_accessed ? utils.timeAgo(c.last_accessed) : "Never opened";
    const gradient = titleGradient(c.title);
    const thumbUrl = c.has_thumbnail ? `/api/courses/${c.id}/thumbnail` : null;
    const starFill = c.is_favorite ? "#fb923c" : "none";
    const starStroke = c.is_favorite ? "#fb923c" : "currentColor";

    return `
    <article class="course-card" onclick="location.href='/course/${c.id}'">

        <!-- Thumbnail -->
        <div class="card-thumb" style="background:${gradient}">
            ${thumbUrl ? `<img src="${thumbUrl}" class="card-thumb-img" alt="" onerror="this.remove()"/>` : ""}
            <div class="card-thumb-overlay"></div>

            <button class="card-star ${c.is_favorite ? 'starred' : ''}"
                    onclick="toggleFav(event,${c.id},this)"
                    title="${c.is_favorite ? 'Remove from favorites' : 'Add to favorites'}"
                    aria-label="Favorite">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="${starFill}"
                     stroke="${starStroke}" stroke-width="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02
                                     12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
            </button>

            ${statusBadge(pct, hasAnyProgress)}

            ${c.progress.next_lesson_id ? `
            <a class="card-play-hint" href="/player/${c.progress.next_lesson_id}"
               onclick="event.stopPropagation()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                ${ctaLabel(pct, hasAnyProgress)}
            </a>` : ''}
        </div>

        <!-- Body -->
        <div class="card-body">
            <h3 class="card-title" title="${utils.escHtml(c.title)}">${utils.escHtml(c.title)}</h3>
            <p class="card-meta">
                ${c.section_count > 0 ? `${c.section_count} module${c.section_count !== 1 ? 's' : ''} · ` : ''}${c.total_lessons} lecture${c.total_lessons !== 1 ? 's' : ''}
                · ${totalH}
            </p>

            <!-- Progress bar -->
            <div class="card-progress-wrap">
                <div class="card-progress-track">
                    <div class="card-progress-fill" style="width:${pct}%"></div>
                </div>
                <span class="card-progress-pct">${Math.round(pct)}%</span>
            </div>

            <p class="card-accessed">${accessed}</p>
        </div>
    </article>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function toggleFav(event, courseId, btn) {
    event.stopPropagation();
    const result = await api.post(`/api/courses/${courseId}/favorite`);
    if (result.ok) {
        const isFav = result.is_favorite;
        btn.classList.toggle("starred", isFav);
        btn.title = isFav ? "Remove from favorites" : "Add to favorites";
        btn.querySelector("svg").setAttribute("fill", isFav ? "#fb923c" : "none");
        btn.querySelector("svg").setAttribute("stroke", isFav ? "#fb923c" : "currentColor");
        // Update local cache
        const c = allCourses.find(x => x.id === courseId);
        if (c) c.is_favorite = isFav;
        if (activeFilter === "favorites") renderGrid();
        utils.toast(isFav ? "Added to favorites" : "Removed from favorites", "success");
    }
}

async function triggerRescan() {
    const btn = document.getElementById("rescan-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }

    const result = await api.post("/api/scan");

    if (btn) { btn.disabled = false; btn.textContent = "Rescan"; }

    if (result.ok) {
        const detail = (result.detail || [])
            .map(d => `${d.title}: ${d.modules} modules, ${d.lessons} lessons, ${d.lectures} lectures`)
            .join("\n");
        const summary = `Scan complete: ${result.courses} course${result.courses !== 1 ? "s" : ""}, ${result.lessons} lectures`;
        utils.toast(summary, "success", 5000);
        if (detail) console.info("[CourseVault scan]\n" + detail);
        await loadLibrary();
    } else {
        utils.toast("Scan failed", "error");
    }
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function showSkeleton() {
    const grid = document.getElementById("course-grid");
    if (!grid) return;
    grid.style.display = "grid";
    grid.innerHTML = Array(6).fill(`
        <div class="course-card skeleton-card">
            <div class="card-thumb skeleton-thumb"></div>
            <div class="card-body">
                <div class="skel skel-title"></div>
                <div class="skel skel-meta"></div>
                <div class="skel skel-bar"></div>
            </div>
        </div>
    `).join("");
}

function showError(msg) {
    const grid = document.getElementById("course-grid");
    if (grid) {
        grid.style.display = "grid";
        grid.innerHTML = `<p style="grid-column:1/-1;color:var(--red);padding:48px;">${msg}</p>`;
    }
}

// ── Add Course modal ──────────────────────────────────────────────────────────

// Aliases so existing HTML onclick="openImportModal()" keeps working
function openImportModal() { openAddCourse(); }
function closeImportModal() { closeAddCourse(); }

function openAddCourse() {
    document.getElementById("ac-modal").style.display = "flex";
    acShowPage("mode");
}

function closeAddCourse() {
    document.getElementById("ac-modal").style.display = "none";
}

function acShowPage(page) {
    ["mode", "import", "manual"].forEach(p => {
        const el = document.getElementById(`ac-${p}`);
        if (el) el.style.display = (p === page) ? "" : "none";
    });
    // Reset errors
    const importErr = document.getElementById("import-error");
    if (importErr) importErr.style.display = "none";
    const builderErr = document.getElementById("ac-builder-error");
    if (builderErr) builderErr.style.display = "none";

    if (page === "manual") _acResetBuilder();
    if (page === "import") setTimeout(() => document.getElementById("import-path")?.focus(), 50);
    if (page === "manual") setTimeout(() => document.getElementById("ac-title")?.focus(), 50);
}

async function browseFolderForImport() {
    if (window.pywebview && window.pywebview.api) {
        const btn = document.getElementById("browse-btn");
        btn.disabled = true; btn.textContent = "Picking…";
        try {
            const path = await window.pywebview.api.pick_folder();
            if (path) document.getElementById("import-path").value = path;
        } finally {
            btn.disabled = false; btn.textContent = "Browse…";
        }
    } else {
        utils.toast("Native folder picker only available in the desktop app.", "info");
    }
}

async function doImportCourse() {
    const folderPath = document.getElementById("import-path").value.trim();
    const errEl      = document.getElementById("import-error");
    errEl.style.display = "none";

    if (!folderPath) {
        errEl.textContent = "Please enter or browse to a folder path.";
        errEl.style.display = "block";
        return;
    }

    const btn = document.getElementById("import-btn");
    btn.disabled = true; btn.textContent = "Importing…";
    const result = await api.post("/api/courses/import", { folder_path: folderPath });
    btn.disabled = false; btn.textContent = "Import Course";

    if (result.ok) {
        closeAddCourse();
        utils.toast(`"${result.title}" imported: ${result.lessons} lessons`, "success");
        await loadLibrary();
    } else {
        errEl.textContent = result.error || "Import failed.";
        errEl.style.display = "block";
    }
}


// ── Manual course builder ─────────────────────────────────────────────────────

let _acModCounter = 0;   // ever-increasing id for modules
let _acLecCounter = 0;   // ever-increasing id for lectures

function _acResetBuilder() {
    document.getElementById("ac-title").value = "";
    document.getElementById("ac-desc").value  = "";
    document.getElementById("ac-modules").innerHTML = "";
    document.getElementById("ac-no-modules").style.display = "";
    _acModCounter = 0;
    _acLecCounter = 0;
}

function acAddModule() {
    const list = document.getElementById("ac-modules");
    const hint = document.getElementById("ac-no-modules");
    if (hint) hint.style.display = "none";

    const mid    = ++_acModCounter;
    const modNum = list.children.length + 1;

    const div = document.createElement("div");
    div.className = "ac-module";
    div.dataset.mid = mid;
    div.innerHTML = `
        <div class="ac-module-hd">
            <span class="ac-mod-num">Module ${modNum}</span>
            <input type="text" class="cv-input ac-mod-title-input"
                   placeholder="Module title (e.g. Introduction)" autocomplete="off"/>
            <button class="ac-icon-btn ac-mod-remove" onclick="acRemoveModule(this)"
                    title="Remove module" aria-label="Remove module">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
        <div class="ac-lec-list" id="ac-ll-${mid}"></div>
        <p class="ac-no-lecs" id="ac-nl-${mid}">No lectures yet.</p>
        <button class="ac-add-lec-btn" onclick="acAddLecture(${mid})">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Lecture
        </button>`;

    list.appendChild(div);
    div.querySelector(".ac-mod-title-input")?.focus();
}

function acRemoveModule(btn) {
    const mod = btn.closest(".ac-module");
    if (!mod) return;
    mod.remove();
    _acRenumberModules();
    if (!document.querySelectorAll("#ac-modules .ac-module").length)
        document.getElementById("ac-no-modules").style.display = "";
}

function _acRenumberModules() {
    document.querySelectorAll("#ac-modules .ac-module").forEach((el, i) => {
        const num = el.querySelector(".ac-mod-num");
        if (num) num.textContent = `Module ${i + 1}`;
    });
}

function acAddLecture(mid) {
    const list = document.getElementById(`ac-ll-${mid}`);
    const hint = document.getElementById(`ac-nl-${mid}`);
    if (!list) return;
    if (hint) hint.style.display = "none";

    const lid    = ++_acLecCounter;
    const lecNum = list.children.length + 1;

    const div = document.createElement("div");
    div.className = "ac-lecture";
    div.dataset.lid = lid;
    div.innerHTML = `
        <span class="ac-lec-num">${lecNum}</span>
        <input type="text" class="cv-input ac-lec-title-input"
               placeholder="Lecture title…" autocomplete="off"/>
        <button class="ac-lec-file-btn" id="ac-lfb-${lid}"
                onclick="acBrowseLecture(${mid}, ${lid})"
                title="Select video file">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
            </svg>
            <span class="ac-lec-fname" id="ac-lfn-${lid}">Pick file</span>
        </button>
        <input type="hidden" class="ac-lec-path" id="ac-lp-${lid}" value=""/>
        <button class="ac-icon-btn ac-lec-remove" onclick="acRemoveLecture(this, ${mid})"
                title="Remove lecture" aria-label="Remove lecture">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>`;

    list.appendChild(div);
    _acRenumberLectures(mid);
}

function acRemoveLecture(btn, mid) {
    const lec = btn.closest(".ac-lecture");
    if (!lec) return;
    lec.remove();
    _acRenumberLectures(mid);
    if (!document.getElementById(`ac-ll-${mid}`)?.children.length)
        document.getElementById(`ac-nl-${mid}`).style.display = "";
}

function _acRenumberLectures(mid) {
    document.querySelectorAll(`#ac-ll-${mid} .ac-lecture`).forEach((el, i) => {
        const num = el.querySelector(".ac-lec-num");
        if (num) num.textContent = i + 1;
    });
}

async function acBrowseLecture(mid, lid) {
    if (!window.pywebview?.api) {
        utils.toast("File picker only available in the desktop app.", "info");
        return;
    }
    const fileBtn = document.getElementById(`ac-lfb-${lid}`);
    if (fileBtn) { fileBtn.disabled = true; }

    try {
        const VIDEO_TYPES = [
            "Video files (*.mp4;*.mkv;*.avi;*.webm;*.mov;*.ts;*.m2ts;*.flv;*.wmv;*.m4v;*.mpeg;*.mpg;*.3gp)"
        ];
        const filePath = await window.pywebview.api.pick_file(VIDEO_TYPES);
        if (!filePath) return;

        document.getElementById(`ac-lp-${lid}`).value = filePath;

        // Show just the filename
        const fname = filePath.replace(/.*[/\\]/, "");
        const fnEl = document.getElementById(`ac-lfn-${lid}`);
        if (fnEl) { fnEl.textContent = fname; fnEl.title = filePath; }
        if (fileBtn) fileBtn.classList.add("has-file");

        // Auto-fill title if the title input is empty
        const lecDiv = fileBtn?.closest(".ac-lecture");
        const titleIn = lecDiv?.querySelector(".ac-lec-title-input");
        if (titleIn && !titleIn.value.trim()) {
            // Strip leading numbers + underscores → human-readable title
            const stem = fname
                .replace(/\.[^.]+$/, "")
                .replace(/^\d+[\.\-\s_]+/, "")
                .replace(/_/g, " ")
                .trim();
            if (stem) titleIn.value = stem;
        }
    } finally {
        if (fileBtn) fileBtn.disabled = false;
    }
}

async function doCreateManual() {
    const title   = document.getElementById("ac-title")?.value.trim();
    const desc    = document.getElementById("ac-desc")?.value.trim();
    const errEl   = document.getElementById("ac-builder-error");
    const createBtn = document.getElementById("ac-create-btn");
    errEl.style.display = "none";

    if (!title) {
        errEl.textContent = "Course title is required.";
        errEl.style.display = "block";
        document.getElementById("ac-title")?.focus();
        return;
    }

    // Collect modules + lectures from the DOM
    const modules = [];
    let totalFiles = 0;

    document.querySelectorAll("#ac-modules .ac-module").forEach(modEl => {
        const modTitle = modEl.querySelector(".ac-mod-title-input")?.value.trim() || "Module";
        const lectures = [];
        modEl.querySelectorAll(".ac-lecture").forEach(lecEl => {
            const lecTitle = lecEl.querySelector(".ac-lec-title-input")?.value.trim() || "";
            const lecPath  = lecEl.querySelector(".ac-lec-path")?.value || "";
            if (lecPath) {
                lectures.push({ title: lecTitle, file_path: lecPath });
                totalFiles++;
            }
        });
        if (lectures.length) modules.push({ title: modTitle, lectures });
    });

    if (!totalFiles) {
        errEl.textContent = "Add at least one lecture with a video file selected.";
        errEl.style.display = "block";
        return;
    }

    createBtn.disabled = true;
    createBtn.textContent = "Creating…";

    const result = await api.post("/api/courses/manual", {
        title, description: desc || "", modules
    });

    createBtn.disabled = false;
    createBtn.textContent = "Create Course";

    if (result.ok) {
        closeAddCourse();
        utils.toast(
            `"${result.title}" created: ${result.lessons} lecture${result.lessons !== 1 ? "s" : ""}`,
            "success", 4000
        );
        await loadLibrary();
        if (result.course_id) location.href = `/course/${result.course_id}`;
    } else {
        errEl.textContent = result.error || "Failed to create course.";
        errEl.style.display = "block";
    }
}


// ── Bind events ───────────────────────────────────────────────────────────────

function bindEvents() {
    // Filter tabs
    document.querySelectorAll("[data-filter]").forEach(btn => {
        btn.addEventListener("click", () => {
            activeFilter = btn.dataset.filter;
            document.querySelectorAll("[data-filter]").forEach(b =>
                b.classList.toggle("active", b === btn)
            );
            renderGrid();
        });
    });

    // Search
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        searchInput.addEventListener("input", utils.debounce(e => {
            searchQuery = e.target.value.trim();
            renderGrid();
        }, 250));
    }

    // Rescan button
    document.getElementById("rescan-btn")?.addEventListener("click", triggerRescan);

    // Close Add Course modal on Escape
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeAddCourse();
    });
}
