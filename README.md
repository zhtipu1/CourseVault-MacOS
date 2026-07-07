# CourseVault

**CourseVault** is a fully offline desktop application for organizing and watching your downloaded video courses. No accounts, no cloud, no tracking — everything lives on your machine.

![CourseVault](static/icons/screenshot-placeholder.png)

---

## Features

- **Automatic course scanning** — point CourseVault at a folder and it builds the full module/lesson hierarchy automatically, supporting up to 4 levels of nesting
- **Progress tracking** — lessons are marked complete as you watch; pick up exactly where you left off
- **Wide format support** — plays MP4, WebM, MOV natively; remuxes MKV, AVI, TS, FLV and more to MP4 on the fly via FFmpeg (no re-encoding, just a container swap)
- **Manual course builder** — create and structure courses by hand when auto-scan isn't what you need
- **Timestamped notes & bookmarks** — attach notes to any moment in a video, exportable to Markdown
- **Subtitle support** — load `.srt` or `.vtt` files alongside any lesson
- **Watchdog auto-detection** — new video files dropped into watched folders are picked up without a manual rescan
- **Course completion celebration** — animated confetti popup when you finish a course
- **Debug mode** — optional timestamped log files for diagnosing issues

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI shell | [pywebview](https://pywebview.flowrl.com/) (WebView2 on Windows, WKWebView on macOS) |
| Backend | [Flask](https://flask.palletsprojects.com/) (local HTTP server, 127.0.0.1) |
| Database | SQLite via Python `sqlite3` (WAL mode) |
| Video remux | [FFmpeg](https://ffmpeg.org/) (optional, user-supplied) |
| File watching | [Watchdog](https://github.com/gorakhargosh/watchdog) |
| Frontend | Vanilla JS + CSS (no frameworks) |

---

## Requirements

- Python 3.10+
- Windows 10/11 (WebView2 runtime, included in Win11) or macOS 11+
- FFmpeg — only needed for MKV/AVI/TS playback; MP4 and WebM work without it

---

## Running from Source

```bash
# 1. Clone the repo
git clone https://github.com/your-username/coursevault.git
cd coursevault

# 2. Create a virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

# 3. Install dependencies
pip install flask pywebview watchdog

# 4. Run
python app.py
```

---

## Building a Standalone Executable

CourseVault uses [PyInstaller](https://pyinstaller.org/) to produce a self-contained `.exe` (Windows) or `.app` (macOS).

```bash
pip install pyinstaller
pyinstaller coursevault.spec
```

Output lands in `dist/CourseVault/CourseVault.exe`. Copy the entire `dist/CourseVault/` folder to distribute — the exe is not standalone without its `_internal/` directory.

> **FFmpeg** is not bundled. Place `ffmpeg.exe` anywhere on your machine and set the path in Settings → FFmpeg.

---

## Data Storage

When running as a compiled app, all user data is stored outside the install directory so it survives updates:

| Platform | Location |
|---|---|
| Windows | `%APPDATA%\CourseVault\` |
| macOS | `~/Library/Application Support/CourseVault/` |
| Linux | `~/.coursevault/` |

Contents:

```
CourseVault/
├── data/
│   └── coursevault.db     ← SQLite database (courses, progress, notes)
├── cache/
│   └── *.mp4              ← Remuxed video cache
└── debug/
    └── coursevault_*.log  ← Debug logs (when debug mode is on)
```

---

## Supported Video Formats

| Type | Formats |
|---|---|
| Native (no FFmpeg needed) | `.mp4` `.webm` `.mov` `.m4v` `.mpeg` `.mpg` `.3gp` |
| Remux via FFmpeg | `.mkv` `.avi` `.flv` `.wmv` `.ts` `.m2ts` `.vob` `.divx` `.rm` |

---

## Project Structure

```
coursevault/
├── app.py                 ← Entry point, Flask + pywebview setup
├── config.py              ← Paths, constants, default settings
├── database.py            ← SQLite schema and helpers
├── scanner.py             ← Course folder scanning logic
├── watcher.py             ← Watchdog file-system observer
├── ffmpeg_utils.py        ← MKV → MP4 remux helpers
├── video_stream.py        ← HTTP range-request video streaming
├── routes/
│   ├── pages.py           ← HTML page routes
│   ├── api_courses.py     ← Course CRUD + progress API
│   ├── api_progress.py    ← Lesson progress saves
│   ├── api_notes.py       ← Notes and bookmarks API
│   ├── api_manage.py      ← Manual course management
│   ├── api_settings.py    ← Settings API
│   └── api_video.py       ← Video status + remux trigger
├── templates/             ← Jinja2 HTML templates
├── static/
│   ├── css/               ← App stylesheets
│   └── js/                ← Frontend JavaScript
└── coursevault.spec       ← PyInstaller build spec
```

---

## License

MIT — do whatever you want with it.

---

*Built by [Zahidul Haque Tipu](mailto:shaque@eightpoint.io)*
