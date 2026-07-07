"""
routes/api_courses.py — Course and lesson API endpoints.
Updated for multi-level section hierarchy.
"""

import json
import time as _time
from pathlib import Path
from datetime import datetime
from flask   import Blueprint, jsonify, request, send_file, abort

from config   import REMUX_EXTENSIONS
from database import get_db, get_setting
from scanner  import scan_all_folders, scan_single_course, get_duration_secs

courses_bp = Blueprint("api_courses", __name__, url_prefix="/api")


def _now():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


# ── Section tree helpers ──────────────────────────────────────────────────────

def _flat_lesson(l: dict, prog: dict) -> dict:
    return {
        "id":              l["id"],
        "title":           l["title"],
        "file_ext":        l.get("file_ext"),
        "duration_secs":   l.get("duration_secs", 0),
        "file_size_bytes": l.get("file_size_bytes", 0),
        "sort_order":      l.get("sort_order", 0),
        "needs_remux":     bool(l.get("needs_remux", 0)),
        "progress":        prog,
    }


def _build_nested_sections(sections: list[dict],
                            lessons:  list[dict],
                            prog_map: dict) -> list[dict]:
    """
    Convert flat sections + lessons lists into a nested tree.
    Each section node: { id, title, depth, sort_order, lessons[], children[] }
    Children are sorted by sort_order; leaves carry their lessons.
    """
    # Build id → node map
    nodes: dict[int, dict] = {}
    for s in sections:
        nodes[s["id"]] = {
            "id":         s["id"],
            "title":      s["title"],
            "depth":      s.get("depth", 0),
            "sort_order": s.get("sort_order", 0),
            "parent_id":  s.get("parent_id"),
            "lessons":    [],
            "children":   [],
        }

    # Attach lessons to their section
    for l in lessons:
        sid = l.get("section_id") or l.get("section_id")
        if sid in nodes:
            nodes[sid]["lessons"].append(_flat_lesson(l, prog_map.get(l["id"], _empty_prog())))

    # Sort lessons within each section
    for node in nodes.values():
        node["lessons"].sort(key=lambda x: (x["sort_order"], x["title"]))

    # Wire parent→child relationships
    roots: list[dict] = []
    for node in nodes.values():
        parent_id = node["parent_id"]
        if parent_id and parent_id in nodes:
            nodes[parent_id]["children"].append(node)
        else:
            roots.append(node)

    # Sort children and roots
    def _sort_key(n):
        return (n["sort_order"], n["title"])

    for node in nodes.values():
        node["children"].sort(key=_sort_key)
    roots.sort(key=_sort_key)

    return roots


def _empty_prog() -> dict:
    return {"position_secs": 0, "percent_watched": 0,
            "is_completed": False, "last_watched": None}


def _lesson_progress(conn, lesson_id: int) -> dict:
    row = conn.execute("SELECT * FROM progress WHERE lesson_id=?", (lesson_id,)).fetchone()
    if not row:
        return _empty_prog()
    return {
        "position_secs":   row["position_secs"],
        "percent_watched": row["percent_watched"],
        "is_completed":    bool(row["is_completed"]),
        "last_watched":    row["last_watched"],
    }


def _course_progress(conn, course_id: int) -> dict:
    row = conn.execute("""
        SELECT COUNT(l.id)                                          AS total,
               SUM(CASE WHEN p.is_completed=1 THEN 1 ELSE 0 END)  AS completed,
               SUM(COALESCE(p.position_secs,0))                    AS watched_secs,
               SUM(l.duration_secs)                                AS total_secs,
               MAX(CASE WHEN COALESCE(p.position_secs,0) > 0 THEN 1 ELSE 0 END) AS any_progress
        FROM lessons l
        LEFT JOIN progress p ON p.lesson_id = l.id
        WHERE l.course_id = ?
    """, (course_id,)).fetchone()

    total     = row["total"]     or 0
    completed = row["completed"] or 0

    # Find the next lesson to play: first incomplete in DFS order, or first lesson
    ordered = _ordered_lessons(conn, course_id)
    next_id = None
    if ordered:
        for les in ordered:
            prog = conn.execute(
                "SELECT is_completed FROM progress WHERE lesson_id=?", (les["id"],)
            ).fetchone()
            if not prog or not prog["is_completed"]:
                next_id = les["id"]
                break
        if next_id is None:
            next_id = ordered[0]["id"]  # all done — rewatch from start

    return {
        "total_lessons":     total,
        "completed_lessons": completed,
        "percent":           round(completed / total * 100, 1) if total else 0.0,
        "has_any_progress":  bool(row["any_progress"]),
        "watched_secs":      int(row["watched_secs"] or 0),
        "total_secs":        int(row["total_secs"]   or 0),
        "next_lesson_id":    next_id,
    }


# ── DFS-ordered flat lesson list (for player prev/next) ──────────────────────

def _ordered_lessons(conn, course_id: int) -> list:
    """
    Return all lessons for a course in continuous-play order
    using depth-first traversal of the section tree.
    """
    sections_raw = conn.execute(
        "SELECT id, parent_id, sort_order FROM sections WHERE course_id=? ORDER BY sort_order, title",
        (course_id,)
    ).fetchall()

    lessons_raw = conn.execute(
        "SELECT id, section_id, sort_order, title FROM lessons WHERE course_id=?",
        (course_id,)
    ).fetchall()

    # id → {children, lessons}
    tree: dict[int, dict] = {
        s["id"]: {"parent_id": s["parent_id"], "sort_order": s["sort_order"],
                  "children": [], "lessons": []}
        for s in sections_raw
    }
    roots: list[int] = []

    for s in sections_raw:
        pid = s["parent_id"]
        if pid and pid in tree:
            tree[pid]["children"].append(s["id"])
        else:
            roots.append(s["id"])

    for l in lessons_raw:
        sid = l["section_id"]
        if sid in tree:
            tree[sid]["lessons"].append(l)

    # Sort children and lessons
    for node in tree.values():
        node["children"].sort(key=lambda cid: (tree[cid]["sort_order"], cid))
        node["lessons"].sort(key=lambda x: (x["sort_order"], x["title"]))

    roots.sort(key=lambda rid: (tree[rid]["sort_order"], rid))

    result: list = []
    def dfs(sid: int):
        node = tree[sid]
        result.extend(node["lessons"])
        for child_id in node["children"]:
            dfs(child_id)

    for rid in roots:
        dfs(rid)

    return result


# ── GET /api/courses ──────────────────────────────────────────────────────────

@courses_bp.route("/courses", methods=["GET"])
def list_courses():
    conn = get_db()
    rows = conn.execute("""
        SELECT c.*, COUNT(DISTINCT s.id) AS section_count
        FROM   courses c
        LEFT JOIN sections s ON s.course_id = c.id AND s.parent_id IS NULL
        GROUP BY c.id
        ORDER BY CASE WHEN c.last_accessed IS NULL THEN 1 ELSE 0 END,
                 c.last_accessed DESC, c.date_added DESC
    """).fetchall()

    result = []
    for r in rows:
        prog = _course_progress(conn, r["id"])
        try: tags = json.loads(r["tags"] or "[]")
        except Exception: tags = []
        result.append({
            "id":            r["id"],
            "title":         r["title"],
            "folder_path":   r["folder_path"],
            "has_thumbnail": bool(r["thumbnail_path"]),
            "total_lessons": r["total_lessons"],
            "section_count": r["section_count"],   # top-level sections only
            "date_added":    r["date_added"],
            "last_accessed": r["last_accessed"],
            "is_favorite":   bool(r["is_favorite"]),
            "tags":          tags,
            "progress":      prog,
        })
    conn.close()
    return jsonify(result)


# ── GET /api/courses/stats ────────────────────────────────────────────────────

@courses_bp.route("/courses/stats", methods=["GET"])
def library_stats():
    conn = get_db()
    row  = conn.execute("""
        SELECT COUNT(DISTINCT c.id)                                AS total_courses,
               COUNT(DISTINCT l.id)                               AS total_lessons,
               SUM(CASE WHEN p.is_completed=1 THEN 1 ELSE 0 END) AS completed_lessons,
               SUM(l.duration_secs)                               AS total_duration_secs
        FROM courses c
        LEFT JOIN lessons  l ON l.course_id = c.id
        LEFT JOIN progress p ON p.lesson_id = l.id
    """).fetchone()
    conn.close()
    return jsonify({
        "total_courses":       row["total_courses"]       or 0,
        "total_lessons":       row["total_lessons"]       or 0,
        "completed_lessons":   row["completed_lessons"]   or 0,
        "total_duration_secs": int(row["total_duration_secs"] or 0),
    })


# ── POST /api/courses/backfill-durations ─────────────────────────────────────

@courses_bp.route("/courses/backfill-durations", methods=["POST"])
def backfill_durations():
    """
    Re-extract duration_secs for every lesson that currently has 0 or NULL.
    Runs synchronously — returns when done. Typically fast for MP4/WebM
    because ffprobe only reads the container header.
    """
    from scanner import get_duration_secs as _dur
    ffmpeg_path = get_setting("ffmpeg_path", "") or ""

    conn = get_db()
    rows = conn.execute(
        "SELECT id, file_path FROM lessons WHERE COALESCE(duration_secs, 0) = 0"
    ).fetchall()

    updated = 0
    failed  = 0
    for row in rows:
        dur = _dur(row["file_path"], ffmpeg_path)
        if dur > 0:
            conn.execute("UPDATE lessons SET duration_secs=? WHERE id=?", (dur, row["id"]))
            updated += 1
        else:
            failed += 1

    conn.commit()
    conn.close()
    return jsonify({"ok": True, "updated": updated, "failed": failed,
                    "total": len(rows)})


# ── GET /api/courses/<id> ─────────────────────────────────────────────────────

@courses_bp.route("/courses/<int:course_id>", methods=["GET"])
def get_course(course_id):
    conn   = get_db()
    course = conn.execute("SELECT * FROM courses WHERE id=?", (course_id,)).fetchone()
    if not course:
        conn.close()
        return jsonify({"error": "Course not found"}), 404

    sections_raw = conn.execute(
        "SELECT * FROM sections WHERE course_id=? ORDER BY depth, sort_order, title",
        (course_id,)
    ).fetchall()

    lessons_raw = conn.execute(
        "SELECT * FROM lessons WHERE course_id=? ORDER BY sort_order, title",
        (course_id,)
    ).fetchall()

    prog_map = {
        row["lesson_id"]: {
            "position_secs":   row["position_secs"],
            "percent_watched": row["percent_watched"],
            "is_completed":    bool(row["is_completed"]),
            "last_watched":    row["last_watched"],
        }
        for row in conn.execute(
            "SELECT * FROM progress WHERE lesson_id IN "
            "(SELECT id FROM lessons WHERE course_id=?)", (course_id,)
        ).fetchall()
    }

    nested = _build_nested_sections(
        [dict(s) for s in sections_raw],
        [dict(l) for l in lessons_raw],
        prog_map
    )

    prog = _course_progress(conn, course_id)
    try: tags = json.loads(course["tags"] or "[]")
    except Exception: tags = []
    conn.close()

    return jsonify({
        "id":            course["id"],
        "title":         course["title"],
        "folder_path":   course["folder_path"],
        "has_thumbnail": bool(course["thumbnail_path"]),
        "description":   course["description"],
        "total_lessons": course["total_lessons"],
        "date_added":    course["date_added"],
        "last_accessed": course["last_accessed"],
        "is_favorite":   bool(course["is_favorite"]),
        "tags":          tags,
        "progress":      prog,
        "sections":      nested,
    })


# ── GET /api/courses/<id>/thumbnail ──────────────────────────────────────────

@courses_bp.route("/courses/<int:course_id>/thumbnail", methods=["GET"])
def course_thumbnail(course_id):
    conn = get_db()
    row  = conn.execute("SELECT thumbnail_path FROM courses WHERE id=?", (course_id,)).fetchone()
    conn.close()
    if not row or not row["thumbnail_path"]: abort(404)
    thumb = Path(row["thumbnail_path"])
    if not thumb.exists(): abort(404)
    return send_file(str(thumb))


# ── POST /api/courses/<id>/favorite ──────────────────────────────────────────

@courses_bp.route("/courses/<int:course_id>/favorite", methods=["POST"])
def toggle_favorite(course_id):
    conn = get_db()
    conn.execute(
        "UPDATE courses SET is_favorite = CASE WHEN is_favorite=1 THEN 0 ELSE 1 END WHERE id=?",
        (course_id,)
    )
    conn.commit()
    row = conn.execute("SELECT is_favorite FROM courses WHERE id=?", (course_id,)).fetchone()
    conn.close()
    return jsonify({"ok": True, "is_favorite": bool(row["is_favorite"])})


# ── POST /api/courses/<id>/touch ──────────────────────────────────────────────

@courses_bp.route("/courses/<int:course_id>/touch", methods=["POST"])
def touch_course(course_id):
    conn = get_db()
    conn.execute("UPDATE courses SET last_accessed=? WHERE id=?", (_now(), course_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── GET /api/courses/<id>/completion ─────────────────────────────────────────

@courses_bp.route("/courses/<int:course_id>/completion", methods=["GET"])
def course_completion(course_id):
    """Return completion stats for a course (used by the congrats overlay)."""
    conn = get_db()
    row = conn.execute(
        """
        SELECT
            COUNT(l.id)                                          AS total,
            SUM(CASE WHEN p.is_completed = 1 THEN 1 ELSE 0 END) AS done,
            SUM(COALESCE(l.duration_secs, 0))                    AS total_secs
        FROM lessons l
        LEFT JOIN progress p ON p.lesson_id = l.id
        WHERE l.course_id = ?
        """,
        (course_id,)
    ).fetchone()
    conn.close()

    total      = row["total"] or 0
    done       = row["done"]  or 0
    total_secs = row["total_secs"] or 0
    complete   = total > 0 and done >= total
    total_hours = f"{total_secs / 3600:.1f}"

    return jsonify({
        "complete":    complete,
        "total":       total,
        "done":        done,
        "total_hours": total_hours,
    })


# ── DELETE /api/courses/<id> ──────────────────────────────────────────────────

@courses_bp.route("/courses/<int:course_id>", methods=["DELETE"])
def delete_course(course_id):
    conn = get_db()
    conn.execute("DELETE FROM courses WHERE id=?", (course_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── POST /api/scan ────────────────────────────────────────────────────────────

@courses_bp.route("/scan", methods=["POST"])
def trigger_scan():
    result = scan_all_folders()
    return jsonify({"ok": True, **result})


# ── POST /api/scan/folder ─────────────────────────────────────────────────────

@courses_bp.route("/scan/folder", methods=["POST"])
def scan_folder():
    """Scan a single course folder without touching the rest of the library."""
    body   = request.get_json(force=True, silent=True) or {}
    folder = (body.get("folder") or "").strip()
    if not folder:
        return jsonify({"ok": False, "error": "No folder provided"}), 400

    from pathlib import Path
    if not Path(folder).exists():
        return jsonify({"ok": False, "error": "Folder not found"}), 400

    result = scan_single_course(folder)
    if "error" in result:
        return jsonify({"ok": False, "error": result["error"]}), 400

    # Return course details for the UI
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, title, total_lessons FROM courses WHERE folder_path=?", (folder,)
        ).fetchone()
        if row:
            modules  = conn.execute(
                "SELECT COUNT(*) FROM sections WHERE course_id=? AND parent_id IS NULL",
                (row["id"],)
            ).fetchone()[0]
            lessons  = conn.execute(
                "SELECT COUNT(*) FROM sections WHERE course_id=? AND parent_id IS NOT NULL",
                (row["id"],)
            ).fetchone()[0]
            return jsonify({
                "ok": True,
                "title":    row["title"],
                "modules":  modules,
                "lessons":  lessons,
                "lectures": row["total_lessons"],
            })
    finally:
        conn.close()

    return jsonify({"ok": True, "lectures": result.get("lessons", 0)})


# ── POST /api/library/clear ───────────────────────────────────────────────────

@courses_bp.route("/library/clear", methods=["POST"])
def clear_library():
    """Wipe all courses (and their cascaded sections/lessons/progress) from the DB."""
    conn = get_db()
    conn.execute("DELETE FROM courses")
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── POST /api/courses/import ──────────────────────────────────────────────────

@courses_bp.route("/courses/import", methods=["POST"])
def import_course():
    """
    Scan a single folder directly as a course (no parent-root indirection).
    Accepts: {"folder_path": "D:\\path\\to\\My Course"}
    """
    body        = request.get_json(force=True, silent=True) or {}
    folder_path = body.get("folder_path", "").strip()
    if not folder_path:
        return jsonify({"error": "folder_path required"}), 400

    p = Path(folder_path)
    if not p.exists() or not p.is_dir():
        return jsonify({"error": "Folder not found or not a directory"}), 400

    result = scan_single_course(folder_path)
    if "error" in result:
        return jsonify(result), 400

    # Persist folder into course_folders so future Rescans include it
    import json as _json
    from database import get_setting, set_settings
    try:
        existing = _json.loads(get_setting("course_folders", "[]") or "[]")
    except Exception:
        existing = []
    if folder_path not in existing:
        existing.append(folder_path)
        set_settings({"course_folders": _json.dumps(existing)})

    conn   = get_db()
    course = conn.execute(
        "SELECT id, title FROM courses WHERE folder_path=?", (folder_path,)
    ).fetchone()
    conn.close()

    return jsonify({
        "ok":        True,
        "lessons":   result["lessons"],
        "course_id": course["id"]    if course else None,
        "title":     course["title"] if course else p.name,
    })


# ── POST /api/courses/manual ─────────────────────────────────────────────────

@courses_bp.route("/courses/manual", methods=["POST"])
def create_manual_course():
    """
    Create a course from a user-supplied structure (no folder scanning).

    Body:
      {
        "title":       "My Course",
        "description": "Optional.",
        "modules": [
          {
            "title": "Introduction",
            "lectures": [
              { "title": "Welcome",  "file_path": "D:/vids/01.mp4" },
              { "title": "Overview", "file_path": "D:/vids/02.mkv" }
            ]
          }
        ]
      }

    The course is stored with is_manual=1 so the scanner never removes it on Rescan.
    """
    body        = request.get_json(force=True, silent=True) or {}
    title       = (body.get("title") or "").strip()
    description = (body.get("description") or "").strip() or None
    modules     = body.get("modules") or []

    if not title:
        return jsonify({"error": "Course title is required."}), 400

    # Flatten to validate we have at least one lecture with a file path
    all_lecs = [
        lec for mod in modules
        for lec in (mod.get("lectures") or [])
        if (lec.get("file_path") or "").strip()
    ]
    if not all_lecs:
        return jsonify({"error": "Add at least one lecture with a video file selected."}), 400

    # Validate all selected files exist on disk
    for lec in all_lecs:
        fp = Path(lec["file_path"].strip())
        if not fp.exists():
            return jsonify({"error": f"File not found: {fp}"}), 400

    ffmpeg_path  = get_setting("ffmpeg_path", "") or ""
    # Unique virtual path — never matches a real directory, never scanned
    virtual_path = f"__manual__:{int(_time.time())}:{title[:60]}"

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO courses (title, folder_path, description, is_manual, total_lessons)
               VALUES (?, ?, ?, 1, 0)""",
            (title, virtual_path, description)
        )
        course_id = conn.execute(
            "SELECT id FROM courses WHERE folder_path=?", (virtual_path,)
        ).fetchone()["id"]

        total_lessons = 0

        for mod_idx, mod in enumerate(modules):
            mod_title = (mod.get("title") or f"Module {mod_idx + 1}").strip()
            lectures  = [
                l for l in (mod.get("lectures") or [])
                if (l.get("file_path") or "").strip()
            ]
            if not lectures:
                continue

            # Virtual folder path — unique per section within this course
            sec_path = f"__manual__:{course_id}:s{mod_idx}"
            conn.execute(
                """INSERT INTO sections
                       (course_id, title, folder_path, sort_order, depth)
                   VALUES (?, ?, ?, ?, 0)""",
                (course_id, mod_title, sec_path, mod_idx)
            )
            section_id = conn.execute(
                "SELECT id FROM sections WHERE course_id=? AND folder_path=?",
                (course_id, sec_path)
            ).fetchone()["id"]

            for lec_idx, lec in enumerate(lectures):
                fp        = Path(lec["file_path"].strip())
                ext       = fp.suffix.lower()
                lec_title = (lec.get("title") or "").strip() or fp.stem
                needs_remux = 1 if ext in REMUX_EXTENSIONS else 0
                duration    = get_duration_secs(str(fp), ffmpeg_path)
                try:
                    size = fp.stat().st_size
                except OSError:
                    size = 0

                conn.execute(
                    """INSERT OR IGNORE INTO lessons
                           (section_id, course_id, title, file_path, file_ext,
                            sort_order, duration_secs, file_size_bytes, needs_remux)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (section_id, course_id, lec_title, str(fp),
                     ext.lstrip("."), lec_idx, duration, size, needs_remux)
                )
                total_lessons += 1

        conn.execute(
            "UPDATE courses SET total_lessons=? WHERE id=?", (total_lessons, course_id)
        )
        conn.commit()
        return jsonify({"ok": True, "course_id": course_id,
                        "title": title, "lessons": total_lessons})

    except Exception as exc:
        conn.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        conn.close()


# ── GET /api/lessons/<id> ─────────────────────────────────────────────────────

@courses_bp.route("/lessons/<int:lesson_id>", methods=["GET"])
def get_lesson(lesson_id):
    conn   = get_db()
    lesson = conn.execute("SELECT * FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    if not lesson:
        conn.close()
        return jsonify({"error": "Lesson not found"}), 404

    course = conn.execute(
        "SELECT id, title FROM courses WHERE id=?", (lesson["course_id"],)
    ).fetchone()

    prog = _lesson_progress(conn, lesson_id)

    all_lessons = _ordered_lessons(conn, lesson["course_id"])
    ids = [r["id"] for r in all_lessons]
    try:
        idx = ids.index(lesson_id)
    except ValueError:
        idx = -1

    prev_id = ids[idx - 1] if idx > 0      else None
    next_id = ids[idx + 1] if 0 <= idx < len(ids) - 1 else None

    conn.close()
    return jsonify({
        "id":            lesson["id"],
        "title":         lesson["title"],
        "file_ext":      lesson["file_ext"],
        "duration_secs": lesson["duration_secs"],
        "needs_remux":   bool(lesson["needs_remux"]),
        "has_subtitle":  bool(lesson["subtitle_path"]),
        "sort_order":    lesson["sort_order"],
        "course_id":     lesson["course_id"],
        "course_title":  course["title"] if course else "",
        "section_id":    lesson["section_id"],
        "prev_id":       prev_id,
        "next_id":       next_id,
        "progress":      prog,
    })


# ── GET /api/lessons/<id>/next  /prev ────────────────────────────────────────

# ── GET /api/lessons/<id>/subtitle ───────────────────────────────────────────

@courses_bp.route("/lessons/<int:lesson_id>/subtitle", methods=["GET"])
def lesson_subtitle(lesson_id):
    """Serve the subtitle file (.srt or .vtt) for a lesson."""
    conn = get_db()
    row  = conn.execute(
        "SELECT subtitle_path FROM lessons WHERE id=?", (lesson_id,)
    ).fetchone()
    conn.close()

    if not row or not row["subtitle_path"]:
        return jsonify({"error": "No subtitle available"}), 404

    sub = Path(row["subtitle_path"])
    if not sub.exists():
        return jsonify({"error": "Subtitle file not found on disk"}), 404

    # Browsers need text/vtt for <track>; serve .srt as plain text (Chrome accepts it)
    mime = "text/vtt" if sub.suffix.lower() == ".vtt" else "text/plain"
    return send_file(str(sub), mimetype=mime)


@courses_bp.route("/lessons/<int:lesson_id>/next", methods=["GET"])
def next_lesson(lesson_id):
    conn   = get_db()
    lesson = conn.execute("SELECT course_id FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    if not lesson:
        conn.close(); return jsonify({"next": None})
    ids = [r["id"] for r in _ordered_lessons(conn, lesson["course_id"])]
    conn.close()
    try:
        idx = ids.index(lesson_id)
        return jsonify({"next": ids[idx + 1] if idx < len(ids) - 1 else None})
    except ValueError:
        return jsonify({"next": None})


@courses_bp.route("/lessons/<int:lesson_id>/prev", methods=["GET"])
def prev_lesson(lesson_id):
    conn   = get_db()
    lesson = conn.execute("SELECT course_id FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    if not lesson:
        conn.close(); return jsonify({"prev": None})
    ids = [r["id"] for r in _ordered_lessons(conn, lesson["course_id"])]
    conn.close()
    try:
        idx = ids.index(lesson_id)
        return jsonify({"prev": ids[idx - 1] if idx > 0 else None})
    except ValueError:
        return jsonify({"prev": None})
