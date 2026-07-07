"""
config.py — App-wide constants for CourseVault.
"""

import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    # sys._MEIPASS is where PyInstaller unpacks bundled data (templates/, static/).
    # In PyInstaller 6+ this is an _internal/ subdirectory beside the exe,
    # not the exe's folder itself — so we must use _MEIPASS, not sys.executable.parent.
    SRC_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
else:
    SRC_DIR = Path(__file__).parent.resolve()

if getattr(sys, "frozen", False):
    if sys.platform == "darwin":
        _data_base = Path.home() / "Library" / "Application Support" / "CourseVault"
    elif sys.platform == "win32":
        _appdata = os.environ.get("APPDATA") or str(Path.home())
        _data_base = Path(_appdata) / "CourseVault"
    else:
        _data_base = Path.home() / ".coursevault"
else:
    _data_base = SRC_DIR

BASE_DIR  = SRC_DIR
DATA_DIR  = _data_base / "data"
CACHE_DIR = _data_base / "cache"
DEBUG_DIR = _data_base / "debug"
DB_PATH   = DATA_DIR / "coursevault.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HOST = "127.0.0.1"
PORT = 7070

NATIVE_EXTENSIONS    = {".mp4", ".webm", ".mov", ".m4v", ".mp2", ".mpeg", ".mpg", ".3gp"}
REMUX_EXTENSIONS     = {".mkv", ".avi", ".flv", ".wmv", ".vob", ".rm", ".rmvb", ".divx", ".ts", ".m2ts", ".mts"}
ALL_VIDEO_EXTENSIONS = NATIVE_EXTENSIONS | REMUX_EXTENSIONS

DEFAULT_COMPLETE_THRESHOLD = 90
DEFAULT_SAVE_INTERVAL      = 5
DEFAULT_SKIP_SECONDS       = 10

DEFAULT_SETTINGS = {
    "ffmpeg_path":        "",
    "course_folders":     "[]",
    "theme":              "dark",
    "player_volume":      "0.8",
    "auto_play_next":     "true",
    "skip_seconds":       str(DEFAULT_SKIP_SECONDS),
    "complete_threshold": str(DEFAULT_COMPLETE_THRESHOLD),
    "cache_dir":          str(CACHE_DIR),
    # "true"  = write converted MP4s next to the source file (<name>.cv.mp4)
    # "false" = keep them in the app cache directory
    "cache_beside_source": "false",
    # 0 = auto (unlimited depth), 1-5 = max section nesting levels
    "scan_max_depth":     "0",
    "debug_mode":         "false",
}
