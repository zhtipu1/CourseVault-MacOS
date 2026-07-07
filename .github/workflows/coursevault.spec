# coursevault.spec — PyInstaller build specification
#
# Produces:
#   Windows → dist/CourseVault/CourseVault.exe   (--onedir folder)
#   macOS   → dist/CourseVault.app               (.app bundle via BUNDLE)
#
# Usage:
#   pip install pyinstaller pywebview flask watchdog
#   pyinstaller coursevault.spec
#
# For Apple Silicon native binary:
#   pyinstaller coursevault.spec --target-arch arm64
#
# For universal2 (Intel + Apple Silicon in one binary):
#   pyinstaller coursevault.spec --target-arch universal2

import sys
from pathlib import Path

block_cipher = None

# ---------------------------------------------------------------------------
# Platform-specific pywebview hidden imports
# PyInstaller doesn't auto-discover which platform backend will be loaded.
# ---------------------------------------------------------------------------
_pyw_hidden = ["webview"]
if sys.platform == "darwin":
    _pyw_hidden += ["webview.platforms.cocoa"]
elif sys.platform == "win32":
    _pyw_hidden += [
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
    ]
else:
    _pyw_hidden += ["webview.platforms.gtk"]

# ---------------------------------------------------------------------------
a = Analysis(
    ["app.py"],
    pathex=[str(Path.cwd())],
    binaries=[],
    datas=[
        # Bundle templates and static assets into the executable directory.
        # They land at dist/CourseVault/templates/ and dist/CourseVault/static/
        ("templates", "templates"),
        ("static",    "static"),
        # NOTE: data/ and cache/ are created at runtime in a user-writable
        # location (see config.py) — do NOT bundle them here.
    ],
    hiddenimports=[
        # Flask ecosystem
        "flask",
        "flask.json.provider",
        "jinja2",
        "jinja2.ext",
        "werkzeug",
        "werkzeug.routing",
        "werkzeug.serving",
        # Watchdog platform backends
        "watchdog",
        "watchdog.observers",
        "watchdog.events",
        "watchdog.observers.polling",        # cross-platform fallback
        "watchdog.observers.inotify",        # Linux
        "watchdog.observers.fsevents",       # macOS
        "watchdog.observers.read_directory_changes",  # Windows
        # stdlib modules that PyInstaller sometimes misses
        "sqlite3",
        "pathlib",
        "json",
        "threading",
        "subprocess",
        "urllib.request",
    ] + _pyw_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim things we definitely don't use
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "PIL",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "wx",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ---------------------------------------------------------------------------
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CourseVault",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    # No icon on macOS — set via BUNDLE below using .icns
)


coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="CourseVault",
)

# ---------------------------------------------------------------------------
# macOS .app bundle — only generated on macOS
# ---------------------------------------------------------------------------
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="CourseVault.app",
        icon="Icons/icon.icns",            # convert Icons/icon.png → Icons/icon.icns first
        bundle_identifier="com.coursevault.app",
        info_plist={
            "CFBundleName":               "CourseVault",
            "CFBundleDisplayName":        "CourseVault",
            "CFBundleShortVersionString": "1.3.0",
            "CFBundleVersion":            "1.3.0",
            "NSHighResolutionCapable":    True,
            "LSBackgroundOnly":           False,
            # Required for WKWebView to load localhost URLs
            "NSAppTransportSecurity": {
                "NSAllowsLocalNetworking": True,
            },
        },
    )
