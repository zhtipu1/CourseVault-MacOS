"""
routes/api_settings.py — Settings API endpoints.

GET  /api/settings          → return all settings as JSON
POST /api/settings          → update one or more settings keys
POST /api/settings/verify-ffmpeg  → test that the given ffmpeg path works
POST /api/settings/verify-folder  → check that a folder path exists
"""

import os
import sys
import json
import threading
import subprocess
from pathlib import Path
from flask   import Blueprint, jsonify, request
from database import get_all_settings, set_settings, get_setting

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

settings_bp = Blueprint("api_settings", __name__, url_prefix="/api")

# ── FFmpeg download state (module-level, shared across requests) ──────────────

_dl = {
    "status":   "idle",   # idle | downloading | extracting | done | error
    "total":    0,
    "received": 0,
    "speed":    0,        # bytes/sec
    "error":    None,
    "path":     None,
}
_dl_lock = threading.Lock()


def _dl_set(**kw):
    with _dl_lock:
        _dl.update(kw)


def _run_ffmpeg_download():
    """Background thread: download ffmpeg/ffprobe/ffplay from ffmpeg.martin-riedl.de."""
    import urllib.request
    import urllib.error
    import zipfile
    import io
    import time
    import stat
    import ssl
    import platform as _platform
    from config import DATA_DIR

    # macOS bundled Python doesn't carry system CA certs; use unverified context
    # for this hardcoded trusted domain.
    _ssl_ctx = ssl.create_default_context()
    _ssl_ctx.check_hostname = False
    _ssl_ctx.verify_mode = ssl.CERT_NONE

    _dl_set(status="downloading", received=0, total=0, speed=0, error=None, path=None)

    try:
        # 1. Detect CPU architecture
        arch     = _platform.machine().lower()
        arch_tag = "arm64" if arch == "arm64" else "amd64"
        base_url = f"https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch_tag}/release"

        # ffplay is optional — martin-riedl.de may not always carry it
        binaries = ["ffmpeg", "ffprobe", "ffplay"]

        # 2. Probe sizes via HEAD so the progress bar can show a real percentage
        total_size = 0
        for binary in binaries:
            try:
                req = urllib.request.Request(
                    f"{base_url}/{binary}.zip",
                    method="HEAD",
                    headers={"User-Agent": "CourseVault/1.3"},
                )
                with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as resp:
                    cl = resp.headers.get("Content-Length")
                    if cl:
                        total_size += int(cl)
            except Exception:
                pass  # size unknown for this binary — progress will still work, just no %
        _dl_set(total=total_size)

        # 3. Download + extract each binary sequentially
        dest_dir = DATA_DIR / "ffmpeg"
        dest_dir.mkdir(parents=True, exist_ok=True)

        chunk_size  = 65536
        received    = 0
        speed_bytes = 0
        t_last      = time.monotonic()

        for binary in binaries:
            url = f"{base_url}/{binary}.zip"
            req = urllib.request.Request(url, headers={"User-Agent": "CourseVault/1.3"})
            zip_buf = io.BytesIO()

            try:
                with urllib.request.urlopen(req, timeout=120, context=_ssl_ctx) as resp:
                    while True:
                        chunk = resp.read(chunk_size)
                        if not chunk:
                            break
                        zip_buf.write(chunk)
                        received    += len(chunk)
                        speed_bytes += len(chunk)
                        now  = time.monotonic()
                        diff = now - t_last
                        if diff >= 0.5:
                            _dl_set(received=received, speed=int(speed_bytes / diff))
                            speed_bytes = 0
                            t_last      = now
            except urllib.error.HTTPError as e:
                if binary == "ffplay":
                    continue   # ffplay is optional — skip if not available
                _dl_set(status="error", error=f"Download failed for {binary}: HTTP {e.code}")
                return

            # Extract the binary from its zip (file named just "ffmpeg", "ffprobe", etc.)
            zip_buf.seek(0)
            with zipfile.ZipFile(zip_buf) as zf:
                entry = next(
                    (n for n in zf.namelist() if n.split("/")[-1].lower() == binary),
                    None,
                )
                if not entry:
                    if binary == "ffplay":
                        continue
                    _dl_set(status="error", error=f"{binary} not found inside zip")
                    return
                dest = dest_dir / binary
                with zf.open(entry) as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                cur_mode = os.stat(dest).st_mode
                os.chmod(dest, cur_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        _dl_set(received=received, speed=0, status="extracting")

        dest_path = dest_dir / "ffmpeg"
        if not dest_path.exists():
            _dl_set(status="error", error="ffmpeg binary missing after extraction")
            return

        # 4. Persist the path in settings
        set_settings({"ffmpeg_path": str(dest_path)})
        _dl_set(status="done", path=str(dest_path), error=None)

    except Exception as exc:
        _dl_set(status="error", error=str(exc))


@settings_bp.route("/settings", methods=["GET"])
def get_settings():
    data = get_all_settings()
    # Parse JSON fields so the frontend gets proper arrays/booleans
    try:
        data["course_folders"] = json.loads(data.get("course_folders", "[]"))
    except (json.JSONDecodeError, TypeError):
        data["course_folders"] = []
    # Inject debug folder path so the UI can display it
    from config import DEBUG_DIR
    data["debug_folder_path"] = str(DEBUG_DIR)
    return jsonify(data)


@settings_bp.route("/settings", methods=["POST"])
def save_settings():
    payload = request.get_json(force=True, silent=True) or {}
    if not payload:
        return jsonify({"error": "No data received"}), 400

    updates = {}
    for key, value in payload.items():
        if isinstance(value, list):
            updates[key] = json.dumps(value)
        elif isinstance(value, bool):
            updates[key] = "true" if value else "false"
        else:
            updates[key] = str(value)

    set_settings(updates)

    # When course_folders changes, immediately remove courses that are no longer listed
    if "course_folders" in updates:
        _cleanup_removed_courses(updates["course_folders"])

    return jsonify({"ok": True})


def _cleanup_removed_courses(course_folders_json: str) -> None:
    """Delete courses from the DB whose folder_path is not in the active folder list."""
    from database import get_db
    try:
        folders = json.loads(course_folders_json)
        active  = [str(Path(f)) for f in folders]
        conn    = get_db()
        # Manual courses (is_manual=1) have virtual paths — never delete them here.
        if active:
            placeholders = ",".join("?" * len(active))
            conn.execute(
                f"DELETE FROM courses WHERE folder_path NOT IN ({placeholders}) "
                "AND COALESCE(is_manual,0)=0", active
            )
        else:
            conn.execute("DELETE FROM courses WHERE COALESCE(is_manual,0)=0")
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[settings] cleanup error: {e}")


@settings_bp.route("/settings/open-debug-folder", methods=["POST"])
def open_debug_folder():
    """Open the debug log folder in Explorer/Finder."""
    import subprocess, sys
    from config import DEBUG_DIR
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", str(DEBUG_DIR)], creationflags=_NO_WINDOW)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(DEBUG_DIR)])
        else:
            subprocess.Popen(["xdg-open", str(DEBUG_DIR)])
        return jsonify({"ok": True, "path": str(DEBUG_DIR)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@settings_bp.route("/settings/ffmpeg-default-path", methods=["GET"])
def ffmpeg_default_path():
    """Return the default ffmpeg path — checks where the in-app downloader saves it."""
    from config import DATA_DIR
    path = str(DATA_DIR / "ffmpeg" / "ffmpeg")
    return jsonify({"path": path, "exists": Path(path).exists()})


@settings_bp.route("/settings/verify-ffmpeg", methods=["POST"])
def verify_ffmpeg():
    """
    Test whether the provided ffmpeg path is a working executable.
    Returns version string on success.
    """
    payload = request.get_json(force=True, silent=True) or {}
    path    = payload.get("path", "").strip()

    if not path:
        # Try 'ffmpeg' from system PATH as fallback
        path = "ffmpeg"

    try:
        result = subprocess.run(
            [path, "-version"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=_NO_WINDOW,
        )
        if result.returncode == 0:
            # Parse version from first line: "ffmpeg version 6.1 ..."
            first_line = result.stdout.splitlines()[0] if result.stdout else ""
            version    = first_line.replace("ffmpeg version", "").split(" ")[1] if first_line else "unknown"
            return jsonify({"ok": True, "version": version})
        else:
            return jsonify({"ok": False, "error": "FFmpeg returned an error"}), 200
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "Executable not found at that path"}), 200
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "Process timed out"}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200


@settings_bp.route("/settings/verify-folder", methods=["POST"])
def verify_folder():
    """Check whether a given folder path exists and is a directory."""
    payload = request.get_json(force=True, silent=True) or {}
    path    = payload.get("path", "").strip()

    if not path:
        return jsonify({"ok": False, "error": "No path provided"}), 200

    p = Path(path)
    if p.exists() and p.is_dir():
        # Count immediate subfolders as a quick preview of what's inside
        subfolders = [x for x in p.iterdir() if x.is_dir()]
        return jsonify({
            "ok":         True,
            "subfolders": len(subfolders),
            "preview":    [x.name for x in subfolders[:5]]
        })
    elif not p.exists():
        return jsonify({"ok": False, "error": "Path does not exist"}), 200
    else:
        return jsonify({"ok": False, "error": "Path is not a directory"}), 200


# ── POST /api/settings/download-ffmpeg ───────────────────────────────────────

@settings_bp.route("/settings/download-ffmpeg", methods=["POST"])
def download_ffmpeg():
    """Kick off a background FFmpeg download from GyanD/codexffmpeg latest release."""
    with _dl_lock:
        if _dl["status"] in ("downloading", "extracting"):
            return jsonify({"ok": False, "error": "Download already in progress"}), 409
    threading.Thread(target=_run_ffmpeg_download, daemon=True, name="ffmpeg-dl").start()
    return jsonify({"ok": True})


# ── GET /api/settings/download-ffmpeg/progress ───────────────────────────────

@settings_bp.route("/settings/download-ffmpeg/progress", methods=["GET"])
def download_ffmpeg_progress():
    with _dl_lock:
        snap = dict(_dl)
    pct = round(snap["received"] / snap["total"] * 100, 1) if snap["total"] else 0
    return jsonify({**snap, "percent": pct})
