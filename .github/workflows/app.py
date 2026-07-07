"""
app.py — CourseVault desktop app entry point.

Architecture:
  Main thread   → pywebview window (native OS web engine)
  Background    → Flask (127.0.0.1:<auto port>)
  Background    → Watchdog file-system watcher
"""

import sys
import os
import traceback
import pathlib

# Write crash log beside the exe (or beside app.py in dev mode) so errors
# are visible even when console=False hides stdout/stderr.
def _crash_log_path():
    if getattr(sys, 'frozen', False):
        return pathlib.Path(sys.executable).parent / "coursevault_crash.log"
    return pathlib.Path(__file__).parent / "coursevault_crash.log"

def _write_crash(exc_text: str):
    try:
        p = _crash_log_path()
        with open(p, 'w', encoding='utf-8') as f:
            f.write(exc_text)
    except Exception:
        pass

def _excepthook(exc_type, exc_value, exc_tb):
    _write_crash("".join(traceback.format_exception(exc_type, exc_value, exc_tb)))

sys.excepthook = _excepthook

import logging
import socket
import threading
import time
import urllib.request

from flask import Flask

import config
from database import init_db
from routes   import register_routes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("werkzeug").setLevel(logging.ERROR)
log = logging.getLogger("CourseVault")


def _setup_debug_logging() -> None:
    """If debug_mode is enabled in settings, tee all logs to a timestamped file."""
    try:
        from database import get_setting
        if get_setting("debug_mode", "false") != "true":
            return

        import datetime
        config.DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        stamp    = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        log_path = config.DEBUG_DIR / f"coursevault_{stamp}.log"

        fmt     = logging.Formatter("%(asctime)s [%(name)s] %(levelname)s — %(message)s",
                                    datefmt="%H:%M:%S")
        handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(fmt)
        handler.setLevel(logging.DEBUG)

        root = logging.getLogger()
        root.setLevel(logging.DEBUG)
        root.addHandler(handler)

        # Capture werkzeug in debug mode but disable propagation to root
        # to prevent every request appearing twice in the log.
        wz = logging.getLogger("werkzeug")
        wz.setLevel(logging.DEBUG)
        wz.addHandler(handler)
        wz.propagate = False

        log.info(f"Debug logging active → {log_path}")
    except Exception as exc:
        log.warning(f"Could not set up debug logging: {exc}")


# ── Free-port detection ───────────────────────────────────────────────────────

def _find_free_port(preferred: int = 7070) -> int:
    """
    Try the preferred port first.
    If Windows has it blocked/reserved, ask the OS for any free port.
    """
    for port in [preferred, 0]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((config.HOST, port))
                chosen = s.getsockname()[1]
                log.info(f"Port {chosen} is available")
                return chosen
        except OSError:
            if port != 0:
                log.warning(f"Port {port} is blocked - trying OS-assigned port")
    raise RuntimeError("Could not find any free port on 127.0.0.1")


# ── Flask ─────────────────────────────────────────────────────────────────────

def _create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(config.BASE_DIR / "templates"),
        static_folder=str(config.BASE_DIR / "static"),
    )
    app.secret_key = "coursevault-local-secret"
    register_routes(app)
    return app


def _run_flask(app: Flask, port: int) -> None:
    app.run(
        host=config.HOST,
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )


def _wait_for_flask(port: int, timeout: float = 10.0) -> bool:
    url      = f"http://{config.HOST}:{port}/"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.2)
    return False


# ── Watchdog ──────────────────────────────────────────────────────────────────

def _start_watchdog() -> None:
    try:
        from watcher import start_watcher
        if not start_watcher():
            log.info("Watchdog: add course folders in Settings to enable auto-detection.")
    except Exception as exc:
        log.warning(f"Watchdog could not start: {exc}")


# ── Main ──────────────────────────────────────────────────────────────────────

class _PyWebViewApi:
    """Minimal JS API exposed to the frontend via window.pywebview.api."""

    def pick_folder(self):
        import webview
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else None

    def pick_file(self, file_types=None):
        """Open a native file picker. file_types is a tuple of filter strings."""
        import webview
        types = tuple(file_types) if file_types else (
            "Image files (*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp)",
        )
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=types,
        )
        return result[0] if result else None


def main() -> None:
    import webview

    print("=" * 52)
    print("  CourseVault - Offline Course Manager")
    print("=" * 52)

    init_db()
    _setup_debug_logging()

    # Pick a port before Flask starts
    port = _find_free_port(preferred=7070)

    flask_app    = _create_app()
    flask_thread = threading.Thread(
        target=_run_flask,
        args=(flask_app, port),
        daemon=True,
        name="flask",
    )
    flask_thread.start()

    log.info("Waiting for Flask...")
    if not _wait_for_flask(port):
        log.error("Flask failed to start - giving up.")
        return
    log.info(f"Flask ready at http://{config.HOST}:{port}")

    threading.Thread(target=_start_watchdog, daemon=True, name="watchdog").start()

    window = webview.create_window(
        title="CourseVault",
        url=f"http://{config.HOST}:{port}",
        width=1280,
        height=820,
        min_size=(960, 600),
        resizable=True,
        text_select=False,
        confirm_close=False,
        js_api=_PyWebViewApi(),
    )

    webview.start(debug=False)
    log.info("Window closed - shutting down.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        _write_crash(traceback.format_exc())
        raise
