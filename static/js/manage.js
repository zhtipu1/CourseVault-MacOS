/**
 * manage.js — Manual course structure management.
 * Rename, reorder, add sections/subsections, add lessons by file path, delete.
 */

let courseId   = null;
let courseData = null;

document.addEventListener("DOMContentLoaded", () => {
    courseId = parseInt(document.getElementById("manage-root")?.dataset.courseId, 10);
    if (courseId) loadStructure();
});

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadStructure() {
    const data = await api.get(`/api/courses/${courseId}/structure`);
    if (data.error) {
        document.getElementById("manage-tree").innerHTML =
            `<p style="color:var(--red)">Failed to load: ${data.error}</p>`;
        return;
    }
    courseData = data;
    document.getElementById("course-title-display").textContent = data.title;
    const _ds = document.getElementById("course-depth-select");
    if (_ds) _ds.value = String(data.scan_depth || 0);
    renderTree(data.sections);
}

// ── Tree rendering ────────────────────────────────────────────────────────────

function renderTree(sections) {
    const tree = document.getElementById("manage-tree");
    if (!sections.length) {
        tree.innerHTML = `
            <div class="manage-empty">
                No sections yet. Click <strong>Add section</strong> above to start,
                or <strong>Rescan folder</strong> to import automatically.
            </div>`;
        return;
    }
    tree.innerHTML = sections.map(s => renderSectionNode(s, 0)).join("");
}

function renderSectionNode(sec, depth) {
    const indent = depth * 22;
    const hasKids = sec.children?.length > 0;

    return `
    <div class="manage-section" id="msec-${sec.id}" data-depth="${depth}">
        <div class="manage-section-hd" style="padding-left:${indent + 12}px">
            <span class="manage-drag-handle" title="Drag to reorder">⠿</span>
            <span class="manage-section-title" id="msec-title-${sec.id}">${utils.escHtml(sec.title)}</span>
            <span class="manage-section-count">${countLessons(sec)} lessons</span>
            <div class="manage-actions">
                <button class="manage-btn" onclick="editSectionTitle(${sec.id})" title="Rename">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="manage-btn" onclick="addSubsection(${sec.id})" title="Add subsection">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Sub
                </button>
                <button class="manage-btn" onclick="addLessonToSection(${sec.id})" title="Add lesson">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    + Lesson
                </button>
                <button class="manage-btn manage-btn-danger" onclick="deleteSection(${sec.id})" title="Delete section">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                </button>
            </div>
        </div>

        ${hasKids ? sec.children.map(c => renderSectionNode(c, depth + 1)).join("") : ""}

        ${sec.lessons?.length ? `
        <ul class="manage-lesson-list" style="padding-left:${indent + 32}px">
            ${sec.lessons.map(l => renderLessonRow(l, sec.id)).join("")}
        </ul>` : ""}
    </div>`;
}

function renderLessonRow(les, sectionId) {
    const dur  = les.duration_secs ? utils.formatDuration(les.duration_secs) : "—";
    const done = les.progress?.is_completed;
    return `
    <li class="manage-lesson" id="mles-${les.id}">
        <span class="manage-drag-handle">⠿</span>
        <span class="manage-lesson-status ${done ? 'done' : ''}">
            ${done ? '✓' : '○'}
        </span>
        <span class="manage-lesson-title" id="mles-title-${les.id}">${utils.escHtml(les.title)}</span>
        <span class="manage-lesson-ext">.${les.file_ext || '?'}</span>
        <span class="manage-lesson-dur">${dur}</span>
        <div class="manage-actions">
            <button class="manage-btn" onclick="editLessonTitle(${les.id})" title="Rename">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="manage-btn manage-btn-danger" onclick="deleteLesson(${les.id})" title="Remove from library">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
            </button>
            <a class="manage-btn" href="/player/${les.id}" title="Play">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </a>
        </div>
    </li>`;
}

function countLessons(node) {
    return (node.lessons?.length || 0) + (node.children || []).reduce((s, c) => s + countLessons(c), 0);
}

// ── Course title ──────────────────────────────────────────────────────────────

async function editCourseTitle() {
    const current = document.getElementById("course-title-display").textContent;
    const title   = await promptInline("Rename course", current);
    if (!title || title === current) return;
    const r = await api.put(`/api/courses/${courseId}/title`, { title });
    if (r.ok) {
        document.getElementById("course-title-display").textContent = title;
        utils.toast("Course renamed", "success");
    }
}

// ── Section actions ───────────────────────────────────────────────────────────

async function addTopSection() {
    const title = await promptInline("New section name");
    if (!title) return;
    const r = await api.post(`/api/courses/${courseId}/sections`, { title });
    if (r.ok) { utils.toast("Section added", "success"); loadStructure(); }
    else utils.toast(r.error || "Failed", "error");
}

async function addSubsection(parentId) {
    const title = await promptInline("New subsection name");
    if (!title) return;
    const r = await api.post(`/api/sections/${parentId}/subsection`, { title });
    if (r.ok) { utils.toast("Subsection added", "success"); loadStructure(); }
    else utils.toast(r.error || "Failed", "error");
}

async function editSectionTitle(sectionId) {
    const el      = document.getElementById(`msec-title-${sectionId}`);
    const current = el?.textContent || "";
    const title   = await promptInline("Rename section", current);
    if (!title || title === current) return;
    const r = await api.put(`/api/sections/${sectionId}`, { title });
    if (r.ok) { el.textContent = title; utils.toast("Renamed", "success"); }
}

async function deleteSection(sectionId) {
    const el = document.getElementById(`msec-title-${sectionId}`);
    if (!confirm(`Delete section "${el?.textContent}"?\nAll lessons in it will be removed from the library (files stay on disk).`)) return;
    const r = await api.delete(`/api/sections/${sectionId}`);
    if (r.ok) {
        document.getElementById(`msec-${sectionId}`)?.remove();
        utils.toast("Section deleted", "success");
    }
}

// ── Lesson actions ────────────────────────────────────────────────────────────

async function addLessonToSection(sectionId) {
    const filePath = await promptInline("Paste full video file path");
    if (!filePath) return;
    const r = await api.post("/api/lessons/add", { section_id: sectionId, file_path: filePath });
    if (r.ok) { utils.toast("Lesson added", "success"); loadStructure(); }
    else utils.toast(r.error || "Failed", "error");
}

async function editLessonTitle(lessonId) {
    const el      = document.getElementById(`mles-title-${lessonId}`);
    const current = el?.textContent || "";
    const title   = await promptInline("Rename lesson", current);
    if (!title || title === current) return;
    const r = await api.put(`/api/lessons/${lessonId}/meta`, { title });
    if (r.ok) { el.textContent = title; utils.toast("Renamed", "success"); }
}

async function deleteLesson(lessonId) {
    if (!confirm("Remove this lesson from the library? The video file on disk is NOT deleted.")) return;
    const r = await api.delete(`/api/lessons/${lessonId}`);
    if (r.ok) {
        document.getElementById(`mles-${lessonId}`)?.remove();
        utils.toast("Lesson removed", "success");
    }
}

// ── Depth
async function saveCourseDepth(value) {
    const depth = parseInt(value, 10);
    const r = await api.put(`/api/courses/${courseId}/scan-depth`, { depth });
    if (r.ok) utils.toast(depth === 0 ? "Depth: global setting" : `Depth: ${depth} level${depth!==1?"s":""}`, "info");
}

// ── Rescan ────────────────────────────────────────────────────────────────────

async function rescanCourse() {
    const btn = document.querySelector('[onclick="rescanCourse()"]');
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    const _depth = parseInt(document.getElementById('course-depth-select')?.value||'0',10);
    const r = await api.post(`/api/courses/${courseId}/rescan`, { depth: _depth });
    if (btn) { btn.disabled = false; btn.textContent = "Rescan folder"; }
    if (r.ok) {
        const _dl = _depth===0?'auto':`${_depth} level${_depth!==1?'s':''}`;
        utils.toast(`Found ${r.lessons} lessons (depth: ${_dl})`, "success");
        loadStructure();
    } else {
        utils.toast(r.error || "Scan failed", "error");
    }
}

// ── Inline prompt (no native prompt() — looks terrible in pywebview) ──────────

function promptInline(label, defaultValue = "") {
    return new Promise(resolve => {
        // Remove any existing prompt
        document.getElementById("cv-inline-prompt")?.remove();

        const backdrop = document.createElement("div");
        backdrop.id        = "cv-inline-prompt";
        backdrop.className = "manage-prompt-backdrop";
        backdrop.innerHTML = `
            <div class="manage-prompt-box" role="dialog" aria-label="${label}">
                <p class="manage-prompt-label">${utils.escHtml(label)}</p>
                <input class="cv-input" id="prompt-input" value="${utils.escHtml(defaultValue)}" autocomplete="off"/>
                <div class="manage-prompt-btns">
                    <button class="btn btn-secondary" id="prompt-cancel">Cancel</button>
                    <button class="btn btn-primary"   id="prompt-ok">OK</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const input  = document.getElementById("prompt-input");
        const ok     = document.getElementById("prompt-ok");
        const cancel = document.getElementById("prompt-cancel");

        input.focus();
        input.select();

        function done(value) {
            backdrop.remove();
            resolve(value);
        }

        ok.onclick     = ()  => done(input.value.trim());
        cancel.onclick = ()  => done(null);
        backdrop.onclick = e => { if (e.target === backdrop) done(null); };
        input.onkeydown = e => {
            if (e.key === "Enter")  done(input.value.trim());
            if (e.key === "Escape") done(null);
        };
    });
}
