"""
watcher.py — Watchdog file-system watcher.

Watches all configured course root folders for new video files.
When new content appears, schedules a debounced rescan (3 s delay)
so rapid file copies don't trigger a storm of scans.

Usage (called once from app.py on startup):
    from watcher import start_watcher
    start_watcher()
"""

import json
import threading
import logging
from pathlib  import Path

from watchdog.observers import Observer
from watchdog.events    import FileSystemEventHandler

from config   import ALL_VIDEO_EXTENSIONS
from database import get_setting

log = logging.getLogger("CourseVault.watcher")

# Module-level observer so we can stop/restart it if settings change
_observer: Observer | None = None


class _VideoEventHandler(FileSystemEventHandler):
    """Fires a debounced rescan when video files appear or are moved/renamed."""

    def __init__(self, rescan_callback, debounce_secs: float = 3.0):
        super().__init__()
        self._callback     = rescan_callback
        self._debounce     = debounce_secs
        self._pending: threading.Timer | None = None
        self._lock         = threading.Lock()

    def _schedule(self):
        with self._lock:
            if self._pending:
                self._pending.cancel()
            self._pending = threading.Timer(self._debounce, self._fire)
            self._pending.daemon = True
            self._pending.start()

    def _fire(self):
        log.info("Watchdog detected new content - triggering rescan")
        try:
            self._callback()
        except Exception as e:
            log.error(f"Rescan error: {e}")

    def _is_video(self, path: str) -> bool:
        return Path(path).suffix.lower() in ALL_VIDEO_EXTENSIONS

    def on_created(self, event):
        if not event.is_directory and self._is_video(event.src_path):
            log.debug(f"New file detected: {event.src_path}")
            self._schedule()

    def on_moved(self, event):
        # A file moved/renamed into the watched folder
        dest = getattr(event, 'dest_path', '')
        if dest and self._is_video(dest):
            log.debug(f"File moved in: {dest}")
            self._schedule()

    def on_deleted(self, event):
        # A video was deleted — rescan to clean up orphaned DB records
        # (Phase 5 will handle DB cleanup; for now just log)
        if not event.is_directory and self._is_video(event.src_path):
            log.debug(f"File deleted: {event.src_path}")


def start_watcher(rescan_callback=None) -> bool:
    """
    Start watching all configured course root folders.
    Returns True if at least one folder is being watched.

    rescan_callback: callable that runs scan_all_folders().
                     Defaults to importing and calling scanner.scan_all_folders.
    """
    global _observer

    # Default callback
    if rescan_callback is None:
        from scanner import scan_all_folders
        rescan_callback = scan_all_folders

    # Read folders from DB
    raw = get_setting('course_folders', '[]')
    try:
        folders = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        folders = []

    valid = [Path(f) for f in folders if Path(f).exists() and Path(f).is_dir()]

    if not valid:
        log.info("Watchdog: no valid course folders configured - not starting")
        return False

    # Stop any existing observer first
    stop_watcher()

    handler  = _VideoEventHandler(rescan_callback)
    observer = Observer()

    for folder in valid:
        observer.schedule(handler, str(folder), recursive=True)
        log.info(f"Watchdog: watching {folder}")

    observer.daemon = True
    observer.start()
    _observer = observer
    log.info(f"Watchdog started - watching {len(valid)} folder(s)")
    return True


def stop_watcher():
    """Stop the running observer if active."""
    global _observer
    if _observer and _observer.is_alive():
        _observer.stop()
        _observer.join(timeout=3)
        log.info("Watchdog stopped")
    _observer = None


def restart_watcher(rescan_callback=None):
    """Restart the watcher (call after settings change adds/removes folders)."""
    stop_watcher()
    start_watcher(rescan_callback)
