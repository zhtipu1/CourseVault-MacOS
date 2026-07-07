"""
ffmpeg_utils.py — Background MKV → MP4 conversion via FFmpeg.

Codec-aware: probes the source video codec first.
  - Browser-safe codecs (H.264 / VP9 / AV1) → stream copy (fast, no re-encode)
  - Anything else (MPEG-2, HEVC, MPEG-4 ASP, …) → re-encode to H.264 (slower,
    one-time cost, then plays natively in the built-in player)

Public API
----------
start_remux(lesson_id, file_path, ffmpeg_path, duration_secs) -> bool
    Kicks off a daemon thread. Returns False if that lesson is already converting.

get_cache_path(lesson_id) -> Path
    Where the remuxed MP4 will be written.

remux_jobs: dict[int, dict]
    Live job table.  Each entry:
        {"status": "in_progress"|"done"|"error", "percent": int,
         "error": str|None, "mode": "copy"|"transcode"}
"""

import re
import sys
import json
import subprocess
import threading
from pathlib import Path

from config import CACHE_DIR

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# Video codecs WebView2/Chromium can decode natively — safe to stream copy.
# Everything else (mpeg2video, hevc, mpeg4, vc1, …) must be re-encoded.
_COPY_SAFE_VCODECS = {"h264", "vp9", "av1"}

# ── Job registry ──────────────────────────────────────────────────────────────

remux_jobs: dict[int, dict] = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

CACHE_SUFFIX = ".cv.mp4"   # marker suffix for beside-source conversions
                           # (scanner skips files ending with this)


def get_cache_path(lesson_id: int) -> Path:
    """App-cache location of the converted MP4 for a given lesson."""
    return CACHE_DIR / str(lesson_id) / "video.mp4"


def beside_cache_path(file_path: str) -> Path:
    """Beside-source location: <source dir>/<source stem>.cv.mp4"""
    p = Path(file_path)
    return p.parent / (p.stem + CACHE_SUFFIX)


def find_cached(lesson_id: int, file_path: str) -> Path | None:
    """
    Return the converted MP4 for this lesson if one exists, checking both
    possible locations (beside the source first, then the app cache).
    Both are checked regardless of the current setting, so toggling the
    setting never orphans previously converted files.
    """
    beside = beside_cache_path(file_path)
    if beside.exists():
        return beside
    cached = get_cache_path(lesson_id)
    if cached.exists():
        return cached
    return None


def target_cache_path(lesson_id: int, file_path: str) -> Path:
    """Where a NEW conversion should be written, per the user's setting."""
    from database import get_setting
    if (get_setting("cache_beside_source", "false") or "false") == "true":
        return beside_cache_path(file_path)
    return get_cache_path(lesson_id)


def _resolve_ffmpeg(ffmpeg_path: str) -> str:
    """Return a usable ffmpeg executable path."""
    if ffmpeg_path:
        p = Path(ffmpeg_path)
        if p.exists():
            return str(p)
    return "ffmpeg"   # fall back to PATH


def _resolve_ffprobe(ffmpeg_exe: str) -> str:
    """Derive the ffprobe executable from the ffmpeg path."""
    p = Path(ffmpeg_exe)
    if p.name.lower().startswith("ffmpeg"):
        probe = p.parent / p.name.lower().replace("ffmpeg", "ffprobe")
        if probe.exists():
            return str(probe)
    return "ffprobe"   # fall back to PATH


def _probe_video_codec(input_path: str, ffmpeg_exe: str) -> str | None:
    """Return the codec_name of the first video stream, or None if probing fails."""
    import subprocess
    try:
        result = subprocess.run(
            [_resolve_ffprobe(ffmpeg_exe),
             "-v", "error",
             "-select_streams", "v:0",
             "-show_entries", "stream=codec_name",
             "-of", "json",
             input_path],
            capture_output=True, text=True, timeout=20,
            creationflags=_NO_WINDOW,
        )
        if result.returncode == 0:
            streams = json.loads(result.stdout).get("streams", [])
            if streams:
                return (streams[0].get("codec_name") or "").lower() or None
    except Exception:
        pass
    return None


_TIME_RE = re.compile(r"out_time=(\d+):(\d+):(\d+\.\d+)")


def _parse_progress_secs(line: str) -> float | None:
    """Parse an 'out_time=HH:MM:SS.xx' line from ffmpeg -progress output."""
    m = _TIME_RE.search(line)
    if m:
        h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        return h * 3600 + mn * 60 + s
    return None


# ── Worker ────────────────────────────────────────────────────────────────────

def _remux_worker(lesson_id: int, input_path: str,
                  output_path: str, ffmpeg_exe: str,
                  duration_secs: int) -> None:
    import subprocess

    try:
        # ── Decide copy vs transcode based on the source video codec ─────────
        vcodec    = _probe_video_codec(input_path, ffmpeg_exe)
        can_copy  = vcodec in _COPY_SAFE_VCODECS
        # Probe failure (None) → optimistically try stream copy; if the result
        # is unplayable the player's error fallback handles it.
        if vcodec is None:
            can_copy = True

        if can_copy:
            video_args = ["-c:v", "copy"]
            remux_jobs[lesson_id]["mode"] = "copy"
        else:
            # MPEG-2 / HEVC / other → re-encode to H.264 (browser-safe)
            video_args = [
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "22",
                "-pix_fmt", "yuv420p",   # broadest decoder compatibility
            ]
            remux_jobs[lesson_id]["mode"] = "transcode"

        cmd = [
            ffmpeg_exe,
            "-y",                     # overwrite output if exists
            "-i", input_path,
            *video_args,
            "-c:a", "aac",            # transcode audio to AAC (required for MP4/browser;
                                      # .ts often carries AC3/EAC3 which MP4 won't accept)
            "-movflags", "+faststart", # MP4 fast-start for streaming
            "-progress", "pipe:1",    # write progress key=value to stdout
            "-nostats",
            output_path,
        ]

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            creationflags=_NO_WINDOW,
        )

        for line in proc.stdout:
            line = line.strip()
            elapsed = _parse_progress_secs(line)
            if elapsed is not None and duration_secs > 0:
                pct = min(99, int((elapsed / duration_secs) * 100))
                remux_jobs[lesson_id]["percent"] = pct

        proc.wait()

        out = Path(output_path)
        if proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
            remux_jobs[lesson_id] = {"status": "done", "percent": 100, "error": None}
        else:
            _fail(lesson_id, output_path, f"FFmpeg exited with code {proc.returncode}")

    except FileNotFoundError:
        _fail(lesson_id, output_path,
              "FFmpeg not found. Set the FFmpeg path in Settings > FFmpeg Path.")
    except Exception as exc:
        _fail(lesson_id, output_path, str(exc))


def _fail(lesson_id: int, output_path: str, msg: str) -> None:
    remux_jobs[lesson_id] = {"status": "error", "percent": 0, "error": msg}
    # Remove partial output file so a retry starts clean
    try:
        Path(output_path).unlink(missing_ok=True)
    except OSError:
        pass


# ── Public API ────────────────────────────────────────────────────────────────

def start_remux(lesson_id: int, file_path: str,
                ffmpeg_path: str, duration_secs: int = 0) -> bool:
    """
    Start a background remux job.

    Returns True  if the job was queued.
    Returns False if a job is already in progress for this lesson.
    """
    existing = remux_jobs.get(lesson_id)
    if existing and existing.get("status") == "in_progress":
        return False

    cache = target_cache_path(lesson_id, file_path)
    cache.parent.mkdir(parents=True, exist_ok=True)

    remux_jobs[lesson_id] = {"status": "in_progress", "percent": 0, "error": None}

    ffmpeg_exe = _resolve_ffmpeg(ffmpeg_path)
    t = threading.Thread(
        target=_remux_worker,
        args=(lesson_id, file_path, str(cache), ffmpeg_exe, duration_secs),
        daemon=True,
        name=f"remux-{lesson_id}",
    )
    t.start()
    return True
