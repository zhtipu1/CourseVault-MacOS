"""
routes/api_notes.py — Notes, bookmarks, and full-text search.

Notes (per-lesson, optionally timestamped):
    GET    /api/lessons/<id>/notes          list
    POST   /api/lessons/<id>/notes          create  {content, timestamp_secs?}
    PATCH  /api/notes/<id>                  update  {content}
    DELETE /api/notes/<id>                  delete

Bookmarks (per-lesson timestamped):
    GET    /api/lessons/<id>/bookmarks      list
    POST   /api/lessons/<id>/bookmarks      create  {timestamp_secs, label?}
    DELETE /api/bookmarks/<id>              delete

Search:
    GET    /api/search?q=<query>            search courses + lessons (min 2 chars)
"""

from datetime import datetime

from flask import Blueprint, jsonify, request, Response

from database import get_db

notes_bp = Blueprint("api_notes", __name__, url_prefix="/api")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


# ── Notes ─────────────────────────────────────────────────────────────────────

@notes_bp.route("/lessons/<int:lesson_id>/notes", methods=["GET"])
def list_notes(lesson_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM notes WHERE lesson_id=? ORDER BY created_at DESC",
        (lesson_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@notes_bp.route("/lessons/<int:lesson_id>/notes", methods=["POST"])
def create_note(lesson_id):
    body    = request.get_json(force=True, silent=True) or {}
    content = (body.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content required"}), 400

    ts   = body.get("timestamp_secs")
    conn = get_db()
    cur  = conn.execute(
        "INSERT INTO notes (lesson_id, timestamp_secs, content) VALUES (?, ?, ?)",
        (lesson_id, ts, content)
    )
    note_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@notes_bp.route("/notes/<int:note_id>", methods=["PATCH"])
def update_note(note_id):
    body    = request.get_json(force=True, silent=True) or {}
    content = (body.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content required"}), 400

    conn = get_db()
    conn.execute(
        "UPDATE notes SET content=?, updated_at=? WHERE id=?",
        (content, _now(), note_id)
    )
    conn.commit()
    row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(row))


@notes_bp.route("/notes/<int:note_id>", methods=["DELETE"])
def delete_note(note_id):
    conn = get_db()
    conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── Bookmarks ─────────────────────────────────────────────────────────────────

@notes_bp.route("/lessons/<int:lesson_id>/bookmarks", methods=["GET"])
def list_bookmarks(lesson_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM bookmarks WHERE lesson_id=? ORDER BY timestamp_secs",
        (lesson_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@notes_bp.route("/lessons/<int:lesson_id>/bookmarks", methods=["POST"])
def create_bookmark(lesson_id):
    body = request.get_json(force=True, silent=True) or {}
    ts   = body.get("timestamp_secs")
    if ts is None:
        return jsonify({"error": "timestamp_secs required"}), 400

    label = (body.get("label") or "").strip() or None
    conn  = get_db()
    cur   = conn.execute(
        "INSERT INTO bookmarks (lesson_id, timestamp_secs, label) VALUES (?, ?, ?)",
        (lesson_id, float(ts), label)
    )
    bm_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM bookmarks WHERE id=?", (bm_id,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@notes_bp.route("/bookmarks/<int:bm_id>", methods=["DELETE"])
def delete_bookmark(bm_id):
    conn = get_db()
    conn.execute("DELETE FROM bookmarks WHERE id=?", (bm_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── Notes export ─────────────────────────────────────────────────────────────

def _secs_to_ts(secs) -> str:
    """Convert float seconds to HH:MM:SS string."""
    if secs is None:
        return ""
    s   = int(secs)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _build_lesson_md(lesson_title: str, notes: list) -> str:
    lines = [f"## {lesson_title}", ""]
    for n in notes:
        ts_str = f" *(at {_secs_to_ts(n['timestamp_secs'])})*" if n.get("timestamp_secs") is not None else ""
        lines.append(f"- {n['content']}{ts_str}")
    lines.append("")
    return "\n".join(lines)


@notes_bp.route("/lessons/<int:lesson_id>/notes/export")
def export_lesson_notes(lesson_id):
    """Download notes for one lesson as Markdown or plain text."""
    fmt  = request.args.get("format", "md").lower()
    conn = get_db()
    lesson = conn.execute("SELECT title FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    if not lesson:
        conn.close()
        return jsonify({"error": "Lesson not found"}), 404
    notes = conn.execute(
        "SELECT * FROM notes WHERE lesson_id=? ORDER BY timestamp_secs, created_at",
        (lesson_id,)
    ).fetchall()
    conn.close()

    if not notes:
        return jsonify({"error": "No notes to export"}), 404

    if fmt == "md":
        content  = f"# Notes — {lesson['title']}\n\n"
        content += _build_lesson_md(lesson["title"], [dict(n) for n in notes])
        mime     = "text/markdown; charset=utf-8"
        filename = f"notes-lesson-{lesson_id}.md"
    else:
        lines = [f"Notes — {lesson['title']}", ""]
        for n in notes:
            ts_str = f" (at {_secs_to_ts(n['timestamp_secs'])})" if n.get("timestamp_secs") is not None else ""
            lines.append(f"- {n['content']}{ts_str}")
        content  = "\n".join(lines)
        mime     = "text/plain; charset=utf-8"
        filename = f"notes-lesson-{lesson_id}.txt"

    return Response(
        content,
        mimetype=mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@notes_bp.route("/courses/<int:course_id>/notes/export")
def export_course_notes(course_id):
    """Download all notes for every lesson in a course as Markdown."""
    fmt  = request.args.get("format", "md").lower()
    conn = get_db()
    course = conn.execute("SELECT title FROM courses WHERE id=?", (course_id,)).fetchone()
    if not course:
        conn.close()
        return jsonify({"error": "Course not found"}), 404

    rows = conn.execute("""
        SELECT n.*, l.title AS lesson_title
        FROM   notes n
        JOIN   lessons l ON l.id = n.lesson_id
        WHERE  l.course_id = ?
        ORDER  BY l.sort_order, l.title, n.timestamp_secs, n.created_at
    """, (course_id,)).fetchall()
    conn.close()

    if not rows:
        return jsonify({"error": "No notes to export"}), 404

    # Group by lesson
    from collections import defaultdict
    grouped: dict[str, list] = defaultdict(list)
    for r in rows:
        grouped[r["lesson_title"]].append(dict(r))

    if fmt == "md":
        parts = [f"# Notes — {course['title']}\n"]
        for lesson_title, notes in grouped.items():
            parts.append(_build_lesson_md(lesson_title, notes))
        content  = "\n".join(parts)
        mime     = "text/markdown; charset=utf-8"
        filename = f"notes-course-{course_id}.md"
    else:
        lines = [f"Notes — {course['title']}", ""]
        for lesson_title, notes in grouped.items():
            lines.append(f"\n{lesson_title}")
            lines.append("-" * len(lesson_title))
            for n in notes:
                ts_str = f" (at {_secs_to_ts(n['timestamp_secs'])})" if n.get("timestamp_secs") is not None else ""
                lines.append(f"  - {n['content']}{ts_str}")
        content  = "\n".join(lines)
        mime     = "text/plain; charset=utf-8"
        filename = f"notes-course-{course_id}.txt"

    return Response(
        content,
        mimetype=mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Search ────────────────────────────────────────────────────────────────────

@notes_bp.route("/search", methods=["GET"])
def search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"courses": [], "lessons": [], "query": q})

    like = f"%{q}%"
    conn = get_db()

    courses = conn.execute(
        """SELECT id, title, total_lessons
           FROM   courses
           WHERE  title LIKE ?
           ORDER  BY title
           LIMIT  20""",
        (like,)
    ).fetchall()

    lessons = conn.execute(
        """SELECT l.id, l.title, l.course_id, l.duration_secs,
                  c.title AS course_title
           FROM   lessons  l
           JOIN   courses  c ON c.id = l.course_id
           WHERE  l.title LIKE ?
           ORDER  BY c.title, l.title
           LIMIT  40""",
        (like,)
    ).fetchall()

    conn.close()
    return jsonify({
        "query":   q,
        "courses": [dict(r) for r in courses],
        "lessons": [dict(r) for r in lessons],
    })
