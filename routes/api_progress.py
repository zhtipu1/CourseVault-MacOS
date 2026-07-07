"""
routes/api_progress.py — Lesson progress tracking endpoints.

GET  /api/progress/<lesson_id>          → current saved progress
POST /api/progress/<lesson_id>          → save position + percent (called every 5s by player)
POST /api/progress/<lesson_id>/reset    → wipe progress back to zero
POST /api/progress/<lesson_id>/complete → force mark as completed
"""

from datetime import datetime
from flask    import Blueprint, jsonify, request
from database import get_db, get_setting

progress_bp = Blueprint("api_progress", __name__, url_prefix="/api")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _threshold() -> float:
    """Completion threshold from settings (default 90%)."""
    try:
        return float(get_setting("complete_threshold", "90"))
    except (ValueError, TypeError):
        return 90.0


# ── GET /api/progress/<lesson_id> ────────────────────────────────────────────

@progress_bp.route("/progress/<int:lesson_id>", methods=["GET"])
def get_progress(lesson_id):
    conn = get_db()
    row  = conn.execute(
        "SELECT * FROM progress WHERE lesson_id=?", (lesson_id,)
    ).fetchone()
    conn.close()

    if not row:
        return jsonify({
            "lesson_id":       lesson_id,
            "position_secs":   0.0,
            "duration_secs":   0.0,
            "percent_watched": 0.0,
            "is_completed":    False,
            "watch_count":     0,
            "last_watched":    None,
            "date_completed":  None,
        })

    return jsonify({
        "lesson_id":       lesson_id,
        "position_secs":   row["position_secs"],
        "duration_secs":   row["duration_secs"],
        "percent_watched": row["percent_watched"],
        "is_completed":    bool(row["is_completed"]),
        "watch_count":     row["watch_count"],
        "last_watched":    row["last_watched"],
        "date_completed":  row["date_completed"],
    })


# ── POST /api/progress/<lesson_id> ───────────────────────────────────────────

@progress_bp.route("/progress/<int:lesson_id>", methods=["POST"])
def save_progress(lesson_id):
    """
    Called by player.js every 5 seconds with current playback state.
    Body: { position_secs, duration_secs, percent_watched }
    """
    body             = request.get_json(force=True, silent=True) or {}
    position_secs    = float(body.get("position_secs",   0))
    duration_secs    = float(body.get("duration_secs",   0))
    percent_watched  = float(body.get("percent_watched", 0))

    # Clamp
    position_secs   = max(0.0, position_secs)
    percent_watched = max(0.0, min(100.0, percent_watched))

    threshold    = _threshold()
    is_completed = percent_watched >= threshold
    now          = _now()

    conn = get_db()

    # Fetch current watch_count and completion state
    existing = conn.execute(
        "SELECT watch_count, is_completed, date_completed FROM progress WHERE lesson_id=?",
        (lesson_id,)
    ).fetchone()

    watch_count    = (existing["watch_count"]   if existing else 0) or 0
    was_completed  = bool(existing["is_completed"] if existing else False)
    date_completed = existing["date_completed"]  if existing else None

    # Increment watch_count when newly completing
    if is_completed and not was_completed:
        watch_count   += 1
        date_completed = now

    conn.execute(
        """
        INSERT INTO progress
            (lesson_id, position_secs, duration_secs, percent_watched,
             is_completed, watch_count, last_watched, date_completed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lesson_id) DO UPDATE SET
            position_secs   = excluded.position_secs,
            duration_secs   = CASE WHEN excluded.duration_secs > 0
                                   THEN excluded.duration_secs
                                   ELSE duration_secs END,
            percent_watched = excluded.percent_watched,
            is_completed    = excluded.is_completed,
            watch_count     = excluded.watch_count,
            last_watched    = excluded.last_watched,
            date_completed  = COALESCE(excluded.date_completed, date_completed)
        """,
        (lesson_id, position_secs, duration_secs, percent_watched,
         1 if is_completed else 0, watch_count, now, date_completed)
    )

    # Update last_accessed on the parent course
    conn.execute(
        """
        UPDATE courses SET last_accessed = ?
        WHERE id = (SELECT course_id FROM lessons WHERE id = ?)
        """,
        (now, lesson_id)
    )

    conn.commit()

    # Check if this completion finishes the whole course (query before closing)
    course_complete = False
    if is_completed and not was_completed:
        row = conn.execute(
            """
            SELECT
                COUNT(l.id)                                          AS total,
                SUM(CASE WHEN p.is_completed = 1 THEN 1 ELSE 0 END) AS done
            FROM lessons l
            LEFT JOIN progress p ON p.lesson_id = l.id
            WHERE l.course_id = (SELECT course_id FROM lessons WHERE id = ?)
            """,
            (lesson_id,)
        ).fetchone()
        if row and row["total"] > 0 and row["done"] >= row["total"]:
            course_complete = True

    conn.close()

    return jsonify({
        "ok":             True,
        "is_completed":   is_completed,
        "watch_count":    watch_count,
        "course_complete": course_complete,
    })


# ── POST /api/progress/<lesson_id>/reset ─────────────────────────────────────

@progress_bp.route("/progress/<int:lesson_id>/reset", methods=["POST"])
def reset_progress(lesson_id):
    conn = get_db()
    conn.execute("DELETE FROM progress WHERE lesson_id=?", (lesson_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ── POST /api/progress/<lesson_id>/complete ───────────────────────────────────

@progress_bp.route("/progress/<int:lesson_id>/complete", methods=["POST"])
def mark_complete(lesson_id):
    now  = _now()
    conn = get_db()

    existing = conn.execute(
        "SELECT watch_count FROM progress WHERE lesson_id=?", (lesson_id,)
    ).fetchone()
    watch_count = ((existing["watch_count"] if existing else 0) or 0) + 1

    conn.execute(
        """
        INSERT INTO progress
            (lesson_id, percent_watched, is_completed, watch_count, last_watched, date_completed)
        VALUES (?, 100.0, 1, ?, ?, ?)
        ON CONFLICT(lesson_id) DO UPDATE SET
            percent_watched = 100.0,
            is_completed    = 1,
            watch_count     = excluded.watch_count,
            last_watched    = excluded.last_watched,
            date_completed  = COALESCE(date_completed, excluded.date_completed)
        """,
        (lesson_id, watch_count, now, now)
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "watch_count": watch_count})
