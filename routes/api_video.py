"""
routes/api_video.py — Video streaming + remux endpoints.

GET  /video/<lesson_id>
    Stream the video file with range-request support.
    - Native formats (mp4/webm/mov): served directly.
    - MKV/AVI (needs_remux=1): served from cache if ready, else 423.

GET  /api/video/<lesson_id>/status
    Returns playback readiness: ready | needs_remux | in_progress | not_found

POST /api/video/<lesson_id>/remux
    Start (or report status of) a background FFmpeg remux job.

POST /api/video/<lesson_id>/open-external
    Open the source video file in the OS default player (VLC, MPV, Windows Media, etc.).
    Falls back gracefully if called outside a pywebview desktop context.

GET  /api/cache/info
    Returns cache size on disk and number of remuxed files.

POST /api/cache/clear
    Deletes all cached remux files.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from flask import Blueprint, jsonify

from config       import CACHE_DIR, REMUX_EXTENSIONS
from database     import get_db, get_setting
from video_stream import stream_file

video_bp = Blueprint("api_video", __name__)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _get_lesson(lesson_id: int):
    conn   = get_db()
    lesson = conn.execute(
        "SELECT * FROM lessons WHERE id=?", (lesson_id,)
    ).fetchone()
    conn.close()
    return lesson


# ── GET /video/<lesson_id> ────────────────────────────────────────────────────

@video_bp.route("/video/<int:lesson_id>")
def stream_video(lesson_id):
    lesson = _get_lesson(lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404

    file_path   = lesson["file_path"]
    needs_remux = bool(lesson["needs_remux"])

    if needs_remux:
        from ffmpeg_utils import find_cached
        cached = find_cached(lesson_id, file_path)
        if cached:
            return stream_file(str(cached), forced_ext=".mp4")
        return jsonify({
            "status":    "needs_remux",
            "lesson_id": lesson_id,
            "message":   "This video requires FFmpeg conversion before playback.",
        }), 423

    if not Path(file_path).exists():
        return jsonify({"error": f"File not found: {file_path}"}), 404

    return stream_file(file_path)


# ── GET /api/video/<lesson_id>/status ────────────────────────────────────────

@video_bp.route("/api/video/<int:lesson_id>/status")
def video_status(lesson_id):
    lesson = _get_lesson(lesson_id)
    if not lesson:
        return jsonify({"status": "not_found"}), 404

    if not lesson["needs_remux"]:
        exists = Path(lesson["file_path"]).exists()
        return jsonify({"status": "ready" if exists else "not_found", "lesson_id": lesson_id})

    # ── IMPORTANT: check the live job table FIRST ─────────────────────────────
    # FFmpeg creates the output file the moment it starts writing, so
    # cached.exists() can return True while the file is still incomplete.
    # Only trust the file once the job explicitly marks itself "done".
    from ffmpeg_utils import remux_jobs
    job = remux_jobs.get(lesson_id)
    if job:
        if job["status"] == "in_progress":
            return jsonify({
                "status":    "in_progress",
                "percent":   job.get("percent", 0),
                "mode":      job.get("mode", "copy"),
                "lesson_id": lesson_id,
            })
        if job["status"] == "error":
            return jsonify({
                "status":    "error",
                "error":     job.get("error", "Unknown error"),
                "lesson_id": lesson_id,
            })
        if job["status"] == "done":
            return jsonify({"status": "ready", "from_cache": True, "lesson_id": lesson_id})

    # No active job in memory — safe to check the cache file directly.
    # This covers the case where the app was restarted after a successful conversion.
    from ffmpeg_utils import find_cached
    if find_cached(lesson_id, lesson["file_path"]):
        return jsonify({"status": "ready", "from_cache": True, "lesson_id": lesson_id})

    return jsonify({"status": "needs_remux", "lesson_id": lesson_id})


# ── POST /api/video/<lesson_id>/remux ────────────────────────────────────────

@video_bp.route("/api/video/<int:lesson_id>/remux", methods=["POST"])
def remux_video(lesson_id):
    """Start (or report status of) a background remux job for a lesson."""
    lesson = _get_lesson(lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404

    if not lesson["needs_remux"]:
        return jsonify({"ok": True, "status": "ready",
                        "message": "This video does not need conversion."}), 200

    # Already cached (either location) — nothing to do
    from ffmpeg_utils import start_remux, remux_jobs, find_cached
    if find_cached(lesson_id, lesson["file_path"]):
        return jsonify({"ok": True, "status": "ready"})

    ffmpeg_path  = get_setting("ffmpeg_path", "") or ""
    duration     = lesson["duration_secs"] or 0

    # Already running?
    job = remux_jobs.get(lesson_id)
    if job and job.get("status") == "in_progress":
        return jsonify({"ok": True, "status": "in_progress",
                        "percent": job.get("percent", 0)})

    started = start_remux(lesson_id, lesson["file_path"], ffmpeg_path, duration)
    return jsonify({
        "ok":      True,
        "status":  "in_progress",
        "started": started,
        "percent": 0,
    })


# ── POST /api/video/<lesson_id>/open-external ────────────────────────────────

@video_bp.route("/api/video/<int:lesson_id>/open-external", methods=["POST"])
def open_external(lesson_id):
    """
    Open the source video file with the OS default application.

    This is a fallback path for when the built-in browser player cannot play
    the format (unsupported codec, failed remux, missing FFmpeg, etc.).
    On Windows uses os.startfile(); on macOS/Linux uses open/xdg-open.
    Safe to call even outside a desktop context — returns an error dict.
    """
    lesson = _get_lesson(lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404

    file_path = lesson["file_path"]
    if not Path(file_path).exists():
        return jsonify({"error": f"File not found on disk: {file_path}"}), 404

    try:
        if sys.platform == "win32":
            os.startfile(file_path)                         # opens with associated app
        elif sys.platform == "darwin":
            subprocess.Popen(["open", file_path])
        else:
            subprocess.Popen(["xdg-open", file_path])
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


# ── GET /api/cache/info ───────────────────────────────────────────────────────

@video_bp.route("/api/cache/info")
def cache_info():
    """Return total size and file count of the remux cache."""
    total_bytes = 0
    file_count  = 0
    try:
        for f in CACHE_DIR.rglob("*"):
            if f.is_file():
                total_bytes += f.stat().st_size
                if f.name == "video.mp4":
                    file_count += 1
    except OSError:
        pass

    mb = round(total_bytes / (1024 * 1024), 1)
    return jsonify({
        "ok":         True,
        "size_bytes": total_bytes,
        "size_mb":    mb,
        "files":      file_count,
        "label":      f"{mb} MB ({file_count} file{'s' if file_count != 1 else ''})",
    })


# ── POST /api/cache/clear ─────────────────────────────────────────────────────

@video_bp.route("/api/cache/clear", methods=["POST"])
def cache_clear():
    """Delete all cached remux files. Original source files are NOT touched."""
    removed = 0
    errors  = []
    try:
        for entry in CACHE_DIR.iterdir():
            if entry.is_dir():
                try:
                    shutil.rmtree(entry)
                    removed += 1
                except OSError as e:
                    errors.append(str(e))
    except OSError as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({
        "ok":      True,
        "removed": removed,
        "errors":  errors,
    })
