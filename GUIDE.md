# CourseVault — User Guide

CourseVault is an offline desktop app for watching and organizing your downloaded video courses. Everything stays on your machine — no internet connection required after setup.

---

## Getting Started

### 1. Add a course folder

Open **Settings → Course Folders** and add the root folder of each course you want to watch.

Example — if your course lives at:
```
D:\Videos\IELTS Advantage\
    Section 1 - Listening\
        01. Introduction.mp4
        02. Strategies.mkv
    Section 2 - Reading\
        ...
```
Add `D:\Videos\IELTS Advantage` — not its parent folder.

Click **Rescan Now** after adding folders to import the courses.

---

### 2. Watch a lesson

From the Library, click any course card to open it. Click a lesson to start playing. CourseVault remembers where you left off and resumes from that point next time.

A lesson is marked **complete** once you watch past 90% of it (adjustable in Settings → Player).

---

### 3. MKV / AVI / TS files

CourseVault plays MP4 and WebM directly. For MKV, AVI, TS, and similar formats it does a fast **remux** — converting the container to MP4 without re-encoding the video. This only happens once per file and takes a few seconds.

To enable remux, set your FFmpeg path in **Settings → FFmpeg**. If you have PotPlayer installed, its bundled ffmpeg.exe works perfectly:
```
C:\Program Files\DAUM\PotPlayer\ffmpeg.exe
```

Converted files are saved in the app cache by default. You can switch to saving them next to the original video in **Settings → Cache → Store conversions next to source**.

---

## Where Your Data Is Stored

All app data is saved in your Windows user folder — completely separate from the app install location. This means your progress and settings survive app updates.

| What | Location |
|---|---|
| Database (progress, notes, settings) | `%APPDATA%\CourseVault\data\coursevault.db` |
| Remuxed video cache | `%APPDATA%\CourseVault\cache\` |
| Debug logs | `%APPDATA%\CourseVault\debug\` |

To find this folder quickly, open File Explorer and paste `%APPDATA%\CourseVault` into the address bar.

### Backing up your progress

Copy `%APPDATA%\CourseVault\data\coursevault.db` to a safe location. That single file contains everything — your courses, watch progress, notes, and settings.

To restore on a new machine, place the `.db` file back in the same location before launching the app.

---

## Settings Reference

| Setting | What it does |
|---|---|
| **Course Folders** | Root folders CourseVault scans for courses |
| **Rescan Now** | Re-imports any new or changed lessons |
| **Fix Durations** | Re-reads video lengths for lessons showing 0:00 |
| **FFmpeg path** | Path to ffmpeg.exe, needed for MKV/AVI/TS playback |
| **Folder depth limit** | How many subfolder levels become sections (Auto recommended) |
| **Default volume** | Starting volume for every video |
| **Skip seconds** | How many seconds the ← → arrow keys skip |
| **Mark complete at** | Watch percentage that marks a lesson done (default 90%) |
| **Auto-play next** | Automatically advance to the next lesson when one ends |
| **Store conversions next to source** | Save remuxed MP4s beside the original file instead of in the cache |
| **Clear Cache** | Delete all remuxed files (they will be re-created on next play) |
| **Debug mode** | Write detailed logs to the debug folder on next launch |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` `→` | Skip backward / forward |
| `↑` `↓` | Volume up / down |
| `F` | Toggle fullscreen |
| `M` | Mute / unmute |

---

## Supported Video Formats

**Plays directly:** MP4, WebM, MOV, M4V, MPEG, MPG, 3GP

**Remuxed via FFmpeg:** MKV, AVI, FLV, WMV, TS, M2TS, VOB, DIVX, RM

---

## Troubleshooting

**Video won't play / shows blank**
- Check that the file isn't corrupted by opening it in another player.
- For MKV/AVI files, make sure FFmpeg is set up in Settings → FFmpeg.

**Lessons showing 0:00 duration**
- Go to Settings → Course Folders → Fix Durations.

**Course not appearing after adding folder**
- Make sure you added the course's own root folder, not a parent folder containing multiple courses.
- Click Rescan Now in Settings.

**App is slow to start after adding many courses**
- This is normal on first launch after a rescan — the database is being built. Subsequent launches are fast.

**Something else is wrong**
- Enable Debug mode in Settings, restart the app, reproduce the issue, then open the debug folder to find the log file.

---

*CourseVault v1.0 — Built by Zahidul Haque Tipu*
