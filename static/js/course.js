/**
 * course.js — Course detail page with explicit 4-stage hierarchy:
 *   Course → Module (depth-0) → Lesson (depth-1) → Lecture (video)
 */

let courseData = null;

document.addEventListener("DOMContentLoaded", () => {
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    if (courseId) loadCourse(courseId);
});

async function loadCourse(courseId) {
    const data = await api.get(`/api/courses/${courseId}`);
    if (data.error) {
        document.getElementById("course-root").innerHTML =
            `<p style="color:var(--red);padding:48px">Course not found.</p>`;
        return;
    }
    courseData = data;
    renderHero(data);
    renderDescription(data);
    renderSections(data.sections);
    api.post(`/api/courses/${courseId}/touch`).catch(() => {});
}

// ── Hero ──────────────────────────────────────────────────────────────────────

const GRADIENTS = [
    "linear-gradient(135deg,#1a1744,#312e81)",
    "linear-gradient(135deg,#0c2340,#1e3a5f)",
    "linear-gradient(135deg,#1a2e1a,#14532d)",
    "linear-gradient(135deg,#2d1a1a,#7f1d1d)",
    "linear-gradient(135deg,#1a1a2e,#4a044e)",
    "linear-gradient(135deg,#1c1a0e,#713f12)",
    "linear-gradient(135deg,#0e1c1a,#134e4a)",
    "linear-gradient(135deg,#1a0e1c,#581c87)",
];

function titleGradient(title) {
    let hash = 0;
    for (let i = 0; i < title.length; i++)
        hash = (hash * 31 + title.charCodeAt(i)) & 0xffffffff;
    return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function renderHero(c) {
    document.getElementById("course-hero").style.background = titleGradient(c.title);
    document.getElementById("hero-title").textContent = c.title;

    // Count breakdown: modules (top-level) → lesson folders (depth-1) → lectures (videos)
    const moduleCount = c.sections.length;
    const lessonCount = c.sections.reduce((n, mod) => n + (mod.children?.length || 0), 0);
    const lectureCount = c.total_lessons;

    document.getElementById("hero-lessons").textContent =
        `${moduleCount} module${moduleCount !== 1 ? "s" : ""}`;
    document.getElementById("hero-sections").textContent =
        `${lessonCount || lectureCount} lesson${(lessonCount || lectureCount) !== 1 ? "s" : ""}`;
    document.getElementById("hero-duration").textContent =
        utils.formatDuration(c.progress.total_secs) || `${lectureCount} lectures`;

    document.getElementById("hero-pct").textContent   = `${Math.round(c.progress.percent)}%`;
    document.getElementById("hero-pct-bar").style.width = `${c.progress.percent}%`;
    document.getElementById("hero-completed").textContent =
        `${c.progress.completed_lessons} / ${lectureCount} lectures completed`;

    renderHeroTags(c.tags || []);

    const cta            = document.getElementById("hero-cta");
    const pct            = c.progress.percent;
    const hasAnyProgress = c.progress.has_any_progress;
    if (pct >= 100) {
        // All done — rewatch from the top
        const first = findNextLesson(c.sections);
        if (cta && first) {
            cta.href = `/player/${first.id}`;
            cta.textContent = "Rewatch";
        } else if (cta) {
            cta.style.display = "none";
        }
    } else if (pct > 0 || hasAnyProgress) {
        // Has progress — resume the in-progress lesson, or fall back to next uncompleted
        const resume = findResumeLesson(c.sections) || findNextLesson(c.sections);
        if (cta && resume) {
            cta.href = `/player/${resume.id}`;
            cta.textContent = "Resume Course";
        } else if (cta) {
            cta.style.display = "none";
        }
    } else {
        // Fresh start
        const next = findNextLesson(c.sections);
        if (cta && next) {
            cta.href = `/player/${next.id}`;
            cta.textContent = "Start Course";
        } else if (cta) {
            cta.style.display = "none";
        }
    }

    const manageLink = document.getElementById("manage-link");
    if (manageLink) manageLink.href = `/manage/${c.id}`;

    // Thumbnail: if set, show it; always show the camera button
    if (c.has_thumbnail) {
        const img = document.getElementById("hero-thumb");
        if (img) { img.src = `/api/courses/${c.id}/thumbnail`; img.style.display = "block"; }
    }
}

function findNextLesson(sections) {
    function searchNode(node) {
        for (const l of (node.lessons || [])) {
            if (!l.progress.is_completed) return l;
        }
        for (const child of (node.children || [])) {
            const found = searchNode(child);
            if (found) return found;
        }
        return null;
    }
    for (const sec of sections) {
        const found = searchNode(sec);
        if (found) return found;
    }
    // All done — return first lesson for rewatch
    return sections[0]?.lessons?.[0]
        || sections[0]?.children?.[0]?.lessons?.[0]
        || null;
}

/** Find the lesson the user was most recently watching (in-progress, not completed). */
function findResumeLesson(sections) {
    let best = null;
    function searchNode(node) {
        for (const l of (node.lessons || [])) {
            if (!l.progress.is_completed && l.progress.position_secs > 5) {
                if (!best || l.progress.position_secs > best.progress.position_secs)
                    best = l;
            }
        }
        for (const child of (node.children || [])) searchNode(child);
    }
    for (const sec of sections) searchNode(sec);
    return best;
}

// ── Section rendering — clean 4-stage hierarchy ───────────────────────────────
// depth=0 → MODULE   (.cv-mod)
// depth=1 → LESSON   (.cv-les inside a module)
// video rows → LECTURE (.cv-lec inside a lesson)

function renderSections(sections) {
    const container = document.getElementById("sections-container");
    if (!container) return;

    if (!sections || sections.length === 0) {
        container.innerHTML = `
            <div style="padding:48px;text-align:center;color:var(--text-3);">
                <p>No content found.</p>
                <p style="margin-top:8px;font-size:12px;">
                    Try <button onclick="rescanThisCourse()"
                        style="background:none;border:none;color:var(--accent);cursor:pointer;
                               font-size:12px;text-decoration:underline;">
                        rescanning this course
                    </button>.
                </p>
            </div>`;
        return;
    }

    container.innerHTML = sections.map((sec, i) =>
        renderSectionNode(sec, 0, i + 1)
    ).join("");
}

// SVG constants — only used inside <button> as phrasing content (SVG is valid, <div> is NOT)
const CHEVRON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2.5" aria-hidden="true">
  <polyline points="6 9 12 15 18 9"/>
</svg>`;

const CHECK_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2.5" aria-hidden="true">
  <polyline points="20 6 9 17 4 12"/>
</svg>`;

function renderSectionNode(sec, depth, moduleNum) {
    const allLessons  = flatLessons(sec);
    const completed   = allLessons.filter(l => l.progress.is_completed).length;
    const total       = allLessons.length;
    const pct         = total ? Math.round((completed / total) * 100) : 0;
    const hasChildren = sec.children && sec.children.length > 0;
    const hasLessons  = sec.lessons  && sec.lessons.length  > 0;

    if (depth === 0) {
        // MODULE — collapsed by default (body hidden, chevron rotated)
        const countLabel   = total ? `${completed}/${total}` : "—";
        const childrenHtml = hasChildren
            ? sec.children.map(child => renderSectionNode(child, 1, moduleNum)).join("")
            : "";
        const lecturesHtml = hasLessons ? makeLecList(sec.lessons) : "";

        return `
<div class="cv-mod" id="section-${sec.id}">
  <button class="cv-mod-hd" onclick="toggleSection(${sec.id})"
          aria-expanded="false" aria-controls="secbody-${sec.id}">
    <span class="cv-mod-chevron" id="chev-${sec.id}" style="transform:rotate(-90deg)">${CHEVRON_SVG}</span>
    <span class="cv-mod-title">${utils.escHtml(sec.title)}</span>
    <span class="cv-mod-right">
      <span class="cv-mod-count">${countLabel}</span>
      <span class="cv-mod-bar"><span class="cv-mod-bar-fill" style="width:${pct}%"></span></span>
    </span>
  </button>
  <div class="cv-mod-body" id="secbody-${sec.id}" style="display:none">${childrenHtml}${lecturesHtml}</div>
</div>`;
    }

    if (depth === 1) {
        // LESSON — collapsed by default
        const countLabel   = `${total} lecture${total !== 1 ? "s" : ""}`;
        const lecturesHtml = hasLessons ? makeLecList(sec.lessons) : "";
        const deeperHtml   = hasChildren
            ? sec.children.map(child => renderSectionNode(child, 2, moduleNum)).join("")
            : "";

        return `
<div class="cv-les" id="section-${sec.id}">
  <button class="cv-les-hd" onclick="toggleSection(${sec.id})"
          aria-expanded="false" aria-controls="secbody-${sec.id}">
    <span class="cv-les-chevron" id="chev-${sec.id}" style="transform:rotate(-90deg)">${CHEVRON_SVG}</span>
    <span class="cv-les-title">${utils.escHtml(sec.title)}</span>
    <span class="cv-les-right"><span class="cv-les-count">${countLabel}</span></span>
  </button>
  <div class="cv-les-body" id="secbody-${sec.id}" style="display:none">${deeperHtml}${lecturesHtml}</div>
</div>`;
    }

    // depth >= 2: lecture list only
    return hasLessons ? makeLecList(sec.lessons) : "";
}

/** Collect all lessons under a node recursively */
function flatLessons(node) {
    return [...(node.lessons || []), ...(node.children || []).flatMap(flatLessons)];
}

/** Wrap lecture rows in a <ul> */
function makeLecList(lessons) {
    return `<ul class="cv-lec-list">${lessons.map((l, i) => lectureRow(l, i + 1)).join("")}</ul>`;
}

function lectureRow(les, num) {
    const p   = les.progress;
    const pct = p.percent_watched || 0;
    const dur = utils.formatTime(les.duration_secs);
    const pos = p.position_secs > 5 ? utils.formatTime(p.position_secs) : null;

    let rowCls = "cv-lec";
    if (p.is_completed)  rowCls += " lec-done";
    else if (pct > 0)    rowCls += " lec-progress";

    const extText = les.needs_remux
        ? `⟳ ${(les.file_ext || "").toUpperCase()}`
        : (les.file_ext || "").toUpperCase();
    const extTitle = les.needs_remux
        ? `This ${(les.file_ext || "").toUpperCase()} file needs conversion — click to open in player and convert`
        : "";
    const extCls  = les.needs_remux ? "cv-lec-ext ext-remux" : "cv-lec-ext";

    const check = p.is_completed
        ? `<span class="cv-lec-check">${CHECK_SVG}</span>` : "";

    const strip = (pct > 0 && !p.is_completed)
        ? `<div class="cv-lec-strip"><div class="cv-lec-strip-fill" style="width:${pct}%"></div></div>`
        : "";

    return `
<li class="${rowCls}" onclick="location.href='/player/${les.id}'" role="listitem">
  <span class="cv-lec-num">${num}</span>
  <span class="cv-lec-title">${utils.escHtml(les.title)}</span>
  ${pos ? `<span class="cv-lec-resume">↩ ${pos}</span>` : ""}
  ${extText ? `<span class="${extCls}"${extTitle ? ` title="${extTitle}"` : ""}>${extText}</span>` : ""}
  <span class="cv-lec-dur">${dur !== "0:00" ? dur : "—"}</span>
  ${check}
  ${strip}
</li>`;
}

// ── Accordion toggle ──────────────────────────────────────────────────────────

function toggleSection(secId) {
    const body = document.getElementById(`secbody-${secId}`);
    const chev = document.getElementById(`chev-${secId}`);
    const btn  = body?.previousElementSibling;
    if (!body) return;
    const open = body.style.display !== "none";
    body.style.display   = open ? "none" : "";
    chev.style.transform = open ? "rotate(-90deg)" : "rotate(0deg)";
    btn?.setAttribute("aria-expanded", String(!open));
}

function expandAll() {
    document.querySelectorAll("[id^='secbody-']").forEach(body => {
        const id   = body.id.replace("secbody-", "");
        const chev = document.getElementById(`chev-${id}`);
        const btn  = body.previousElementSibling;
        body.style.display   = "";
        if (chev) chev.style.transform = "rotate(0deg)";
        btn?.setAttribute("aria-expanded", "true");
    });
}

function collapseAll() {
    document.querySelectorAll("[id^='secbody-']").forEach(body => {
        const id   = body.id.replace("secbody-", "");
        const chev = document.getElementById(`chev-${id}`);
        const btn  = body.previousElementSibling;
        body.style.display   = "none";
        if (chev) chev.style.transform = "rotate(-90deg)";
        btn?.setAttribute("aria-expanded", "false");
    });
}

// ── Cover image ───────────────────────────────────────────────────────────────

async function setCourseCover() {
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    if (!courseId) return;

    // Try pywebview native picker first, fall back gracefully
    let filePath = null;
    try {
        if (window.pywebview?.api?.pick_file) {
            filePath = await window.pywebview.api.pick_file(
                ["Image files (*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp)"]
            );
        }
    } catch (e) {
        console.warn("pick_file unavailable:", e);
    }

    if (!filePath) return;  // User cancelled

    const result = await api.put(`/api/courses/${courseId}/thumbnail`, { file_path: filePath });
    if (result.ok) {
        const img = document.getElementById("hero-thumb");
        if (img) {
            img.src = `/api/courses/${courseId}/thumbnail?t=${Date.now()}`;
            img.style.display = "block";
        }
        if (courseData) courseData.has_thumbnail = true;
        utils.toast("Cover image updated", "success");
    } else {
        utils.toast(result.error || "Failed to set cover image", "error");
    }
}

// ── Description ──────────────────────────────────────────────────────────────

function renderDescription(c) {
    const wrap = document.getElementById("course-description-wrap");
    const el   = document.getElementById("course-description");
    if (!wrap || !el) return;
    if (c.description) {
        el.textContent    = c.description;
        wrap.style.display = "block";
    } else {
        el.textContent    = "Add a description…";
        el.classList.add("course-desc-placeholder");
        wrap.style.display = "block";
    }
}

async function editDescription() {
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    const el       = document.getElementById("course-description");
    if (!el || el.tagName === "TEXTAREA") return;

    const current = courseData?.description || "";
    const ta      = document.createElement("textarea");
    ta.className  = "course-description course-desc-editing";
    ta.value      = current;
    ta.rows        = 4;
    ta.placeholder = "Add a description…";
    el.replaceWith(ta);
    ta.focus();

    async function save() {
        const newVal = ta.value.trim();
        const result = await api.put(`/api/courses/${courseId}/description`, { description: newVal });
        const div    = document.createElement("div");
        div.id        = "course-description";
        div.className = "course-description" + (newVal ? "" : " course-desc-placeholder");
        div.title     = "Click to edit";
        div.onclick   = editDescription;
        div.textContent = newVal || "Add a description…";
        ta.replaceWith(div);
        if (result.ok && courseData) courseData.description = newVal;
    }

    ta.addEventListener("blur",    save);
    ta.addEventListener("keydown", e => {
        if (e.key === "Escape") { ta.value = current; ta.blur(); }
        if (e.key === "Enter" && e.ctrlKey) ta.blur();
    });
}

// ── Tags ──────────────────────────────────────────────────────────────────────

let _editingTags = [];

function renderHeroTags(tags) {
    const el = document.getElementById("hero-tags");
    if (!el) return;
    if (!tags || tags.length === 0) { el.innerHTML = ""; return; }
    el.innerHTML = tags.map(t =>
        `<a class="hero-tag" href="/library?tag=${encodeURIComponent(t)}"
            onclick="event.stopPropagation()">${utils.escHtml(t)}</a>`
    ).join("");
}

function manageTags() {
    _editingTags = [...(courseData?.tags || [])];
    renderTagPills();
    document.getElementById("tag-modal").style.display = "flex";
    setTimeout(() => document.getElementById("tag-input")?.focus(), 50);
}

function closeTagModal() {
    document.getElementById("tag-modal").style.display = "none";
    document.getElementById("tag-input").value = "";
}

function renderTagPills() {
    const wrap = document.getElementById("tag-pills");
    if (!wrap) return;
    if (_editingTags.length === 0) {
        wrap.innerHTML = `<span style="font-size:12px;color:var(--text-3)">No tags yet</span>`;
        return;
    }
    wrap.innerHTML = _editingTags.map((t, i) =>
        `<span class="tag-pill-edit">
            ${utils.escHtml(t)}
            <button onclick="removeTagAt(${i})" aria-label="Remove ${t}">✕</button>
        </span>`
    ).join("");
}

function removeTagAt(i) {
    _editingTags.splice(i, 1);
    renderTagPills();
}

function addTag() {
    const input = document.getElementById("tag-input");
    const val   = input?.value.trim();
    if (!val) return;
    if (!_editingTags.includes(val)) {
        _editingTags.push(val);
        renderTagPills();
    }
    if (input) input.value = "";
}

async function saveTags() {
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    const result   = await api.put(`/api/courses/${courseId}/tags`, { tags: _editingTags });
    if (result.ok) {
        if (courseData) courseData.tags = result.tags;
        renderHeroTags(result.tags);
        utils.toast("Tags saved", "success");
        closeTagModal();
    } else {
        utils.toast("Failed to save tags", "error");
    }
}

// ── Progress reset ────────────────────────────────────────────────────────────

async function resetCourseProgress() {
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    if (!courseId) return;
    if (!confirm("Reset all progress for this course? This cannot be undone.")) return;
    const result = await api.delete(`/api/courses/${courseId}/progress`);
    if (result.ok) {
        utils.toast("Progress reset", "success");
        await loadCourse(courseId);
    } else {
        utils.toast("Failed to reset progress", "error");
    }
}

// ── Export course notes ───────────────────────────────────────────────────────

function exportCourseNotes(e) {
    e.preventDefault();
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    if (!courseId) return;
    window.location.href = `/api/courses/${courseId}/notes/export?format=md`;
}

// ── Rescan this course ────────────────────────────────────────────────────────

async function rescanThisCourse() {
    const courseId = parseInt(document.getElementById("course-root")?.dataset.courseId, 10);
    if (!courseId) return;
    utils.toast("Rescanning…", "info", 1500);
    const result = await api.post(`/api/courses/${courseId}/rescan`);
    if (result.ok) {
        utils.toast(`Rescan complete — ${result.lessons} lectures found`, "success");
        await loadCourse(courseId);
    } else {
        utils.toast(result.error || "Rescan failed", "error");
    }
}
