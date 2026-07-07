"""
scanner.py — Multi-level course folder scanner with configurable depth.

scan_max_depth (global setting, int):
    0  = Auto — scan all folder levels, no limit (default)
    1  = Only one section level (videos two folders deep become one section)
    2  = Sections + one subsection level
    3+ = Deeper nesting allowed

Per-course scan_depth (courses.scan_depth column):
    NULL = use global scan_max_depth
    int  = override for this course only
"""

import re
import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime

from config   import ALL_VIDEO_EXTENSIONS, REMUX_EXTENSIONS
from database import get_db, get_setting

# Suppress console windows for subprocesses when running as a compiled app.
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


# ── Title helpers ─────────────────────────────────────────────────────────────

_NUM_PREFIX = re.compile(r'^(?:section\s*)?(\d+)[.\-\s_]+', re.IGNORECASE)


def clean_title(name: str) -> str:
    p    = Path(name)
    stem = p.stem if p.suffix.lower() in ALL_VIDEO_EXTENSIONS else name
    cleaned = _NUM_PREFIX.sub('', stem).strip()
    cleaned = cleaned.replace('_', ' ')
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned if cleaned else stem


def extract_sort_order(name: str) -> int:
    m = re.match(r'(\d+)', name)
    return int(m.group(1)) if m else 9999


# ── FFprobe / FFmpeg duration ─────────────────────────────────────────────────

def _ffprobe_path(ffmpeg_path: str) -> str | None:
    """Return path to ffprobe beside the given ffmpeg, or from system PATH."""
    if ffmpeg_path:
        p     = Path(ffmpeg_path)
        probe = p.parent / p.name.lower().replace('ffmpeg', 'ffprobe')
        if probe.exists():
            return str(probe)
    # Try system PATH
    import shutil
    return shutil.which('ffprobe')


def _duration_via_ffmpeg(file_path: str, ffmpeg_path: str) -> int:
    """Fallback: parse duration from ffmpeg -i stderr when ffprobe isn't available."""
    if not ffmpeg_path:
        return 0
    try:
        result = subprocess.run(
            [ffmpeg_path, '-i', str(file_path)],
            capture_output=True, timeout=15,
            stderr=subprocess.PIPE, stdout=subprocess.PIPE,
            creationflags=_NO_WINDOW,
        )
        import re
        stderr = result.stderr.decode('utf-8', errors='replace')
        m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', stderr)
        if m:
            h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
            return max(0, int(h * 3600 + mn * 60 + s))
    except Exception:
        pass
    return 0


def get_duration_secs(file_path: str, ffmpeg_path: str = "") -> int:
    # Try ffprobe first (fast JSON output)
    probe = _ffprobe_path(ffmpeg_path)
    if probe:
        try:
            result = subprocess.run(
                [probe, '-v', 'quiet', '-print_format', 'json', '-show_format', str(file_path)],
                capture_output=True, timeout=15,
                creationflags=_NO_WINDOW,
            )
            if result.returncode == 0:
                stdout = result.stdout.decode('utf-8', errors='replace')
                dur = json.loads(stdout).get('format', {}).get('duration', '0')
                return max(0, int(float(dur)))
        except Exception:
            pass

    # Fall back to ffmpeg -i stderr parsing
    return _duration_via_ffmpeg(file_path, ffmpeg_path)


# ── Thumbnail ─────────────────────────────────────────────────────────────────

_THUMB_NAMES = [
    'cover.jpg', 'cover.png', 'cover.webp',
    'thumbnail.jpg', 'thumbnail.png',
    'folder.jpg', 'folder.png',
    'poster.jpg', 'poster.png',
]


def find_thumbnail(course_dir: Path) -> str | None:
    for name in _THUMB_NAMES:
        p = course_dir / name
        if p.exists():
            return str(p)
    return None


# ── Video helpers ─────────────────────────────────────────────────────────────

def _is_video(path: Path) -> bool:
    # Skip CourseVault's own beside-source conversion outputs (<name>.cv.mp4) —
    # they are cache artifacts of an existing lesson, not new lessons.
    if path.name.lower().endswith(".cv.mp4"):
        return False
    return path.is_file() and path.suffix.lower() in ALL_VIDEO_EXTENSIONS


def _direct_videos(directory: Path) -> list[Path]:
    try:
        return sorted(
            [f for f in directory.iterdir() if _is_video(f)],
            key=lambda f: (extract_sort_order(f.name), f.name.lower())
        )
    except PermissionError:
        return []


def _find_subtitle(video_path: Path) -> str | None:
    """
    Look for a subtitle file alongside the video.
    Checks (in order): <stem>.vtt, <stem>.en.vtt, <stem>.srt, <stem>.en.srt
    """
    stem = video_path.stem
    for suffix in ['.vtt', '.en.vtt', '.srt', '.en.srt']:
        candidate = video_path.parent / (stem + suffix)
        if candidate.exists():
            return str(candidate)
    return None


# ── DB upserts ────────────────────────────────────────────────────────────────

def _upsert_course(conn, folder_path: str, title: str, thumbnail: str | None) -> int:
    conn.execute(
        """INSERT INTO courses (title, folder_path, thumbnail_path)
           VALUES (?, ?, ?)
           ON CONFLICT(folder_path) DO UPDATE SET
               title          = excluded.title,
               thumbnail_path = COALESCE(excluded.thumbnail_path, thumbnail_path)""",
        (title, folder_path, thumbnail)
    )
    # Never trust lastrowid for ON CONFLICT DO UPDATE — it is unreliable in Python's
    # sqlite3 module when the UPSERT fires an UPDATE rather than an INSERT.
    # Always SELECT to get the definitive row id.
    return conn.execute(
        "SELECT id FROM courses WHERE folder_path=?", (folder_path,)
    ).fetchone()['id']


def _upsert_section(conn, course_id: int, folder_path: str,
                    title: str, sort_order: int, depth: int,
                    parent_id: int | None) -> int:
    conn.execute(
        """INSERT INTO sections (course_id, parent_id, title, folder_path, sort_order, depth)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(course_id, folder_path) DO UPDATE SET
               title      = excluded.title,
               parent_id  = excluded.parent_id,
               sort_order = excluded.sort_order,
               depth      = excluded.depth""",
        (course_id, parent_id, title, folder_path, sort_order, depth)
    )
    # Same fix: always SELECT for the definitive section id.
    # A wrong id here propagates as parent_id to child sections, breaking the tree.
    return conn.execute(
        "SELECT id FROM sections WHERE course_id=? AND folder_path=?",
        (course_id, folder_path)
    ).fetchone()['id']


def _upsert_lesson(conn, section_id: int, course_id: int,
                   vid: Path, ffmpeg_path: str) -> None:
    ext         = vid.suffix.lower().lstrip('.')
    needs_remux = 1 if vid.suffix.lower() in REMUX_EXTENSIONS else 0
    duration    = get_duration_secs(str(vid), ffmpeg_path)
    size        = vid.stat().st_size
    subtitle    = _find_subtitle(vid)
    conn.execute(
        """INSERT INTO lessons
               (section_id, course_id, title, file_path, file_ext,
                sort_order, duration_secs, file_size_bytes, needs_remux, subtitle_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET
               title           = excluded.title,
               section_id      = excluded.section_id,
               sort_order      = excluded.sort_order,
               duration_secs   = CASE WHEN excluded.duration_secs > 0
                                      THEN excluded.duration_secs
                                      ELSE duration_secs END,
               file_size_bytes = excluded.file_size_bytes,
               needs_remux     = excluded.needs_remux,
               subtitle_path   = excluded.subtitle_path""",
        (section_id, course_id, clean_title(vid.name), str(vid),
         ext, extract_sort_order(vid.name), duration, size, needs_remux, subtitle)
    )


# ── Core scanner ──────────────────────────────────────────────────────────────

def _resolve_depth(max_depth: int | None) -> int:
    """
    Normalise max_depth to an int.
    0 or None = unlimited.
    """
    if max_depth is None:
        return 0
    try:
        return max(0, int(max_depth))
    except (TypeError, ValueError):
        return 0


def _scan_course(conn, course_dir: Path, ffmpeg_path: str,
                 max_depth: int = 0) -> int:
    """
    Scan one course directory.

    max_depth:
        0 = unlimited (scan all folder levels)
        N = build section hierarchy up to N levels deep;
            videos in deeper folders attach to the Nth-level section.

    Returns number of lessons upserted.
    """
    max_depth    = _resolve_depth(max_depth)
    course_id    = _upsert_course(conn, str(course_dir),
                                  clean_title(course_dir.name),
                                  find_thumbnail(course_dir))
    lesson_count = 0
    section_id_cache: dict[str, int] = {}

    video_dirs: list[tuple[Path, list[Path]]] = []
    for dirpath, dirnames, filenames in os.walk(str(course_dir)):
        dirnames.sort(key=lambda d: (extract_sort_order(d), d.lower()))
        p = Path(dirpath)
        try:
            videos = _direct_videos(p)
        except OSError:
            continue
        if videos:
            video_dirs.append((p, videos))

    for video_dir, videos in video_dirs:
        try:
            rel_parts = video_dir.relative_to(course_dir).parts
        except ValueError:
            continue

        parent_id  = None
        section_id = None

        if not rel_parts:
            # Videos sit directly in the course root
            key = str(course_dir) + '/__root__'
            if key not in section_id_cache:
                section_id_cache[key] = _upsert_section(
                    conn, course_id, str(course_dir),
                    'Course Files', 0, 0, None
                )
            section_id = section_id_cache[key]
        else:
            # Walk down the path, creating a section at each level.
            # If max_depth > 0, stop building the hierarchy at that depth;
            # deeper folder parts are ignored and videos attach to the last
            # created section.
            parts_to_walk = rel_parts[:max_depth] if max_depth else rel_parts

            for depth, part in enumerate(parts_to_walk):
                ancestor_path = str(course_dir / Path(*rel_parts[:depth + 1]))
                if ancestor_path not in section_id_cache:
                    section_id_cache[ancestor_path] = _upsert_section(
                        conn, course_id, ancestor_path,
                        clean_title(part),
                        extract_sort_order(part),
                        depth,
                        parent_id
                    )
                parent_id  = section_id_cache[ancestor_path]
                section_id = parent_id

            # If no parts survived (e.g. max_depth=0 but rel_parts is empty)
            if section_id is None:
                key = str(course_dir) + '/__root__'
                if key not in section_id_cache:
                    section_id_cache[key] = _upsert_section(
                        conn, course_id, str(course_dir),
                        'Course Files', 0, 0, None
                    )
                section_id = section_id_cache[key]

        for vid in videos:
            _upsert_lesson(conn, section_id, course_id, vid, ffmpeg_path)
            lesson_count += 1

    total = conn.execute(
        "SELECT COUNT(*) AS n FROM lessons WHERE course_id=?", (course_id,)
    ).fetchone()['n']
    conn.execute(
        "UPDATE courses SET total_lessons=? WHERE id=?", (total, course_id)
    )
    return lesson_count


# ── Depth resolution helpers ──────────────────────────────────────────────────

def _get_global_max_depth() -> int:
    return _resolve_depth(get_setting('scan_max_depth', '0'))


def _get_course_depth(conn, folder_path: str) -> int | None:
    """Return the per-course scan_depth override, or None if not set."""
    row = conn.execute(
        "SELECT scan_depth FROM courses WHERE folder_path=?", (folder_path,)
    ).fetchone()
    if row and row['scan_depth'] is not None:
        return _resolve_depth(row['scan_depth'])
    return None


# ── Public API ────────────────────────────────────────────────────────────────

def scan_all_folders() -> dict:
    raw = get_setting('course_folders', '[]')
    try:
        folders = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        folders = []

    ffmpeg_path      = get_setting('ffmpeg_path', '') or ''
    global_max_depth = _get_global_max_depth()
    courses_found    = 0
    lessons_found    = 0
    errors           = []

    conn = get_db()
    course_details = []   # per-course scan summary
    try:
        active_paths = []

        for folder_str in folders:
            folder = Path(folder_str)
            if not folder.exists() or not folder.is_dir():
                errors.append(f"Folder not found: {folder_str}")
                continue
            try:
                course_depth = _get_course_depth(conn, str(folder))
                effective    = course_depth if course_depth is not None else global_max_depth
                n = _scan_course(conn, folder, ffmpeg_path, effective)
                courses_found += 1
                lessons_found += n
                active_paths.append(str(folder))

                # Collect per-course detail for the response
                course_row = conn.execute(
                    "SELECT id, title, total_lessons FROM courses WHERE folder_path=?",
                    (str(folder),)
                ).fetchone()
                if course_row:
                    module_count = conn.execute(
                        "SELECT COUNT(*) FROM sections WHERE course_id=? AND parent_id IS NULL",
                        (course_row["id"],)
                    ).fetchone()[0]
                    lesson_count = conn.execute(
                        "SELECT COUNT(*) FROM sections WHERE course_id=? AND parent_id IS NOT NULL",
                        (course_row["id"],)
                    ).fetchone()[0]
                    course_details.append({
                        "title":    course_row["title"],
                        "modules":  module_count,
                        "lessons":  lesson_count,
                        "lectures": course_row["total_lessons"],
                    })
            except Exception as e:
                import traceback
                errors.append(f"{folder.name}: {e}\n{traceback.format_exc()}")

        # Remove courses no longer in the configured folder list.
        # Manual courses (is_manual=1) are always preserved — they don't live on disk.
        if active_paths:
            ph = ",".join("?" * len(active_paths))
            conn.execute(
                f"DELETE FROM courses WHERE folder_path NOT IN ({ph}) AND COALESCE(is_manual,0)=0",
                active_paths
            )
        elif not folders:
            conn.execute("DELETE FROM courses WHERE COALESCE(is_manual,0)=0")

        conn.commit()
    finally:
        conn.close()

    print(f"[Scanner] {datetime.now().strftime('%H:%M:%S')} "
          f">> {courses_found} courses, {lessons_found} lectures "
          f"(depth: {'auto' if not global_max_depth else global_max_depth})")
    for d in course_details:
        print(f"  OK {d['title']}: {d['modules']} modules, "
              f"{d['lessons']} lessons, {d['lectures']} lectures")
    if errors:
        for e in errors:
            print(f"  ERR {e}")
    return {
        "courses": courses_found,
        "lessons": lessons_found,
        "errors":  errors,
        "detail":  course_details,
    }


def scan_single_course(course_folder: str, max_depth: int | None = None) -> dict:
    """
    Re-scan one course folder.
    max_depth overrides both global and per-course settings if provided.
    """
    ffmpeg_path = get_setting('ffmpeg_path', '') or ''
    path = Path(course_folder)
    if not path.exists():
        return {"error": "Path not found"}

    conn = get_db()
    try:
        if max_depth is None:
            course_depth = _get_course_depth(conn, course_folder)
            global_depth = _get_global_max_depth()
            effective    = course_depth if course_depth is not None else global_depth
        else:
            effective = _resolve_depth(max_depth)

        n = _scan_course(conn, path, ffmpeg_path, effective)
        conn.commit()
    finally:
        conn.close()

    return {"lessons": n, "depth_used": effective}
