"""routes/api_manage.py — Manual management + scan-depth override."""

import json
from pathlib import Path
from flask   import Blueprint, jsonify, request
from database import get_db
from config   import ALL_VIDEO_EXTENSIONS, REMUX_EXTENSIONS

manage_bp = Blueprint("api_manage", __name__, url_prefix="/api")

@manage_bp.route("/courses/<int:course_id>/scan-depth", methods=["GET"])
def get_course_scan_depth(course_id):
    conn = get_db()
    row  = conn.execute("SELECT scan_depth FROM courses WHERE id=?", (course_id,)).fetchone()
    conn.close()
    if not row: return jsonify({"error": "Not found"}), 404
    return jsonify({"depth": row["scan_depth"]})

@manage_bp.route("/courses/<int:course_id>/scan-depth", methods=["PUT"])
def set_course_scan_depth(course_id):
    body  = request.get_json(force=True, silent=True) or {}
    depth = body.get("depth")
    conn  = get_db()
    if depth is None or int(depth) == 0:
        conn.execute("UPDATE courses SET scan_depth=NULL WHERE id=?", (course_id,))
    else:
        conn.execute("UPDATE courses SET scan_depth=? WHERE id=?", (max(1, int(depth)), course_id))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

@manage_bp.route("/courses/<int:course_id>/title", methods=["PUT"])
def rename_course(course_id):
    body  = request.get_json(force=True, silent=True) or {}
    title = body.get("title", "").strip()
    if not title: return jsonify({"error": "title required"}), 400
    conn = get_db()
    conn.execute("UPDATE courses SET title=? WHERE id=?", (title, course_id))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

@manage_bp.route("/courses/<int:course_id>/rescan", methods=["POST"])
def rescan_course(course_id):
    body      = request.get_json(force=True, silent=True) or {}
    max_depth = body.get("depth")
    conn      = get_db()
    course    = conn.execute("SELECT folder_path FROM courses WHERE id=?", (course_id,)).fetchone()
    conn.close()
    if not course: return jsonify({"error": "Not found"}), 404
    from scanner import scan_single_course
    result = scan_single_course(course["folder_path"],
                                max_depth=int(max_depth) if max_depth is not None else None)
    return jsonify({"ok": True, **result})

@manage_bp.route("/courses/<int:course_id>/sections", methods=["POST"])
def add_section(course_id):
    body  = request.get_json(force=True, silent=True) or {}
    title = body.get("title", "").strip()
    if not title: return jsonify({"error": "title required"}), 400
    conn    = get_db()
    max_ord = conn.execute("SELECT COALESCE(MAX(sort_order),0) FROM sections WHERE course_id=? AND parent_id IS NULL", (course_id,)).fetchone()[0]
    cur = conn.execute("INSERT INTO sections (course_id,parent_id,title,folder_path,sort_order,depth) VALUES (?,NULL,?,?,?,0)",
                       (course_id, title, f"__manual__/{course_id}/{title}", max_ord+10))
    conn.commit(); sec_id = cur.lastrowid; conn.close()
    return jsonify({"ok": True, "id": sec_id})

@manage_bp.route("/sections/<int:section_id>/subsection", methods=["POST"])
def add_subsection(section_id):
    body  = request.get_json(force=True, silent=True) or {}
    title = body.get("title", "").strip()
    if not title: return jsonify({"error": "title required"}), 400
    conn   = get_db()
    parent = conn.execute("SELECT * FROM sections WHERE id=?", (section_id,)).fetchone()
    if not parent: conn.close(); return jsonify({"error": "Parent not found"}), 404
    max_ord = conn.execute("SELECT COALESCE(MAX(sort_order),0) FROM sections WHERE parent_id=?", (section_id,)).fetchone()[0]
    depth   = (parent['depth'] or 0) + 1
    cur = conn.execute("INSERT INTO sections (course_id,parent_id,title,folder_path,sort_order,depth) VALUES (?,?,?,?,?,?)",
                       (parent['course_id'], section_id, title, f"__manual__/{parent['course_id']}/{section_id}/{title}", max_ord+10, depth))
    conn.commit(); sec_id = cur.lastrowid; conn.close()
    return jsonify({"ok": True, "id": sec_id})

@manage_bp.route("/sections/<int:section_id>", methods=["PUT"])
def update_section(section_id):
    body = request.get_json(force=True, silent=True) or {}
    conn = get_db()
    if "title" in body and body["title"].strip():
        conn.execute("UPDATE sections SET title=? WHERE id=?", (body["title"].strip(), section_id))
    if "sort_order" in body:
        conn.execute("UPDATE sections SET sort_order=? WHERE id=?", (int(body["sort_order"]), section_id))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

@manage_bp.route("/sections/<int:section_id>", methods=["DELETE"])
def delete_section(section_id):
    conn = get_db()
    def collect(sid):
        r = [sid]
        for c in conn.execute("SELECT id FROM sections WHERE parent_id=?", (sid,)).fetchall():
            r.extend(collect(c['id']))
        return r
    for sid in collect(section_id):
        conn.execute("DELETE FROM lessons  WHERE section_id=?", (sid,))
        conn.execute("DELETE FROM sections WHERE id=?", (sid,))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

@manage_bp.route("/lessons/add", methods=["POST"])
def add_lesson_manual():
    body       = request.get_json(force=True, silent=True) or {}
    section_id = body.get("section_id")
    file_path  = body.get("file_path", "").strip()
    if not section_id or not file_path: return jsonify({"error": "section_id and file_path required"}), 400
    p = Path(file_path)
    if not p.exists(): return jsonify({"error": f"File not found: {file_path}"}), 400
    if p.suffix.lower() not in ALL_VIDEO_EXTENSIONS: return jsonify({"error": "Not a supported video file"}), 400
    conn    = get_db()
    section = conn.execute("SELECT * FROM sections WHERE id=?", (section_id,)).fetchone()
    if not section: conn.close(); return jsonify({"error": "Section not found"}), 404
    from scanner import clean_title
    needs_remux = 1 if p.suffix.lower() in REMUX_EXTENSIONS else 0
    title       = body.get("title", "").strip() or clean_title(p.name)
    max_ord     = conn.execute("SELECT COALESCE(MAX(sort_order),0) FROM lessons WHERE section_id=?", (section_id,)).fetchone()[0]
    try:
        cur = conn.execute("INSERT INTO lessons (section_id,course_id,title,file_path,file_ext,sort_order,file_size_bytes,needs_remux) VALUES (?,?,?,?,?,?,?,?)",
                           (section_id, section['course_id'], title, str(p), p.suffix.lower().lstrip('.'), max_ord+10, p.stat().st_size, needs_remux))
        conn.execute("UPDATE courses SET total_lessons=(SELECT COUNT(*) FROM lessons WHERE course_id=?) WHERE id=?", (section['course_id'], section['course_id']))
        conn.commit(); lesson_id = cur.lastrowid; conn.close()
        return jsonify({"ok": True, "id": lesson_id})
    except Exception as e:
        conn.close()
        return jsonify({"error": "File already in library" if "UNIQUE" in str(e) else str(e)}), (409 if "UNIQUE" in str(e) else 500)

@manage_bp.route("/lessons/<int:lesson_id>/meta", methods=["PUT"])
def update_lesson(lesson_id):
    body   = request.get_json(force=True, silent=True) or {}
    conn   = get_db()
    lesson = conn.execute("SELECT * FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    if not lesson: conn.close(); return jsonify({"error": "Not found"}), 404
    if "title" in body and body["title"].strip():
        conn.execute("UPDATE lessons SET title=? WHERE id=?", (body["title"].strip(), lesson_id))
    if "sort_order" in body:
        conn.execute("UPDATE lessons SET sort_order=? WHERE id=?", (int(body["sort_order"]), lesson_id))
    if "section_id" in body:
        t = conn.execute("SELECT course_id FROM sections WHERE id=?", (body["section_id"],)).fetchone()
        if t and t['course_id'] == lesson['course_id']:
            conn.execute("UPDATE lessons SET section_id=? WHERE id=?", (body["section_id"], lesson_id))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

@manage_bp.route("/lessons/<int:lesson_id>", methods=["DELETE"])
def delete_lesson(lesson_id):
    conn = get_db()
    for tbl in ["progress","notes","bookmarks"]:
        conn.execute(f"DELETE FROM {tbl} WHERE lesson_id=?", (lesson_id,))
    conn.execute("DELETE FROM lessons WHERE id=?", (lesson_id,))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

# ── PUT /api/courses/<id>/thumbnail ──────────────────────────────────────────

_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'}

@manage_bp.route("/courses/<int:course_id>/thumbnail", methods=["PUT"])
def set_thumbnail(course_id):
    """
    Set or clear the course thumbnail.
    Body: {"file_path": "D:\\path\\to\\image.jpg"}
    To clear: {"file_path": ""}
    """
    body      = request.get_json(force=True, silent=True) or {}
    file_path = (body.get("file_path") or "").strip()

    if not file_path:
        # Clear thumbnail
        conn = get_db()
        conn.execute("UPDATE courses SET thumbnail_path=NULL WHERE id=?", (course_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True, "thumbnail_path": None})

    p = Path(file_path)
    if not p.exists():
        return jsonify({"error": f"File not found: {file_path}"}), 400
    if p.suffix.lower() not in _IMAGE_EXTS:
        return jsonify({"error": "Not a supported image type (jpg, png, webp, gif)"}), 400

    conn = get_db()
    conn.execute("UPDATE courses SET thumbnail_path=? WHERE id=?", (str(p), course_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "thumbnail_path": str(p)})


# ── PUT /api/courses/<id>/tags ────────────────────────────────────────────────

@manage_bp.route("/courses/<int:course_id>/tags", methods=["PUT"])
def set_course_tags(course_id):
    """Replace the tag list for a course. Body: {"tags": ["tag1", "tag2"]}"""
    body = request.get_json(force=True, silent=True) or {}
    tags = body.get("tags", [])
    if not isinstance(tags, list):
        return jsonify({"error": "tags must be an array"}), 400
    # Sanitise: strip whitespace, remove blanks, deduplicate
    tags = list(dict.fromkeys(t.strip() for t in tags if str(t).strip()))
    conn = get_db()
    conn.execute("UPDATE courses SET tags=? WHERE id=?", (json.dumps(tags), course_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "tags": tags})


# ── PUT /api/courses/<id>/description ────────────────────────────────────────

@manage_bp.route("/courses/<int:course_id>/description", methods=["PUT"])
def set_course_description(course_id):
    """Set or clear the course description. Body: {"description": "..."}"""
    body = request.get_json(force=True, silent=True) or {}
    desc = (body.get("description") or "").strip()
    conn = get_db()
    conn.execute("UPDATE courses SET description=? WHERE id=?",
                 (desc if desc else None, course_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "description": desc})


# ── DELETE /api/courses/<id>/progress ────────────────────────────────────────

@manage_bp.route("/courses/<int:course_id>/progress", methods=["DELETE"])
def reset_course_progress(course_id):
    """Wipe all progress rows for every lesson in the course."""
    conn = get_db()
    conn.execute("""
        DELETE FROM progress
        WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id=?)
    """, (course_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@manage_bp.route("/courses/<int:course_id>/structure", methods=["GET"])
def get_structure(course_id):
    conn   = get_db()
    course = conn.execute("SELECT * FROM courses WHERE id=?", (course_id,)).fetchone()
    if not course: conn.close(); return jsonify({"error": "Not found"}), 404
    secs = conn.execute("SELECT * FROM sections WHERE course_id=? ORDER BY depth,sort_order,title", (course_id,)).fetchall()
    lsns = conn.execute("SELECT * FROM lessons  WHERE course_id=? ORDER BY sort_order,title",       (course_id,)).fetchall()
    conn.close()
    from routes.api_courses import _build_nested_sections, _flat_lesson
    nested = _build_nested_sections([dict(s) for s in secs], [dict(l) for l in lsns], {})
    return jsonify({"id": course["id"], "title": course["title"],
                    "folder_path": course["folder_path"], "scan_depth": course["scan_depth"],
                    "sections": nested})
