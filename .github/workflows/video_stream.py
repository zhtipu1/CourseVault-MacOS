"""
video_stream.py — HTTP range-request video streaming.

The browser sends Range headers when seeking. Without proper range support,
the <video> scrubber won't work — the browser can't jump to an arbitrary position.

This module handles:
  - Full file delivery (no Range header)
  - Partial content delivery (Range: bytes=start-end)
  - Correct MIME types per extension
  - Chunked streaming so large files aren't loaded into RAM
"""

import os
from pathlib import Path
from flask   import request, Response

CHUNK_SIZE = 1024 * 512   # 512 KB per chunk — good balance for video

MIME_TYPES = {
    ".mp4":  "video/mp4",
    ".m4v":  "video/mp4",
    ".webm": "video/webm",
    ".mov":  "video/quicktime",
    ".avi":  "video/x-msvideo",
    ".mkv":  "video/mp4",     # served from cache as remuxed mp4
    ".flv":  "video/mp4",
    ".wmv":  "video/mp4",
}

BASE_HEADERS = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
}


def _mime(path: str, forced_ext: str | None = None) -> str:
    ext = forced_ext or Path(path).suffix.lower()
    return MIME_TYPES.get(ext, "video/mp4")


def stream_file(file_path: str, forced_ext: str | None = None) -> Response:
    """
    Stream a video file with proper HTTP Range support.

    file_path   — absolute path to the video file on disk
    forced_ext  — override extension for MIME detection (e.g. cached MKV→MP4)
    """
    path = Path(file_path)

    if not path.exists():
        return Response("Video file not found", status=404)

    file_size = path.stat().st_size
    mime      = _mime(file_path, forced_ext)
    range_hdr = request.headers.get("Range")

    # ── No range header: stream the whole file ────────────────────────────────
    if not range_hdr:
        def full_stream():
            with open(path, "rb") as f:
                while chunk := f.read(CHUNK_SIZE):
                    yield chunk

        headers = {
            **BASE_HEADERS,
            "Content-Type":   mime,
            "Content-Length": str(file_size),
        }
        return Response(full_stream(), status=200, headers=headers)

    # ── Parse Range header ────────────────────────────────────────────────────
    # Format: "bytes=start-end"  or  "bytes=start-"  or  "bytes=-suffix"
    try:
        unit, rng  = range_hdr.strip().split("=", 1)
        parts      = rng.split(",")[0].strip().split("-")
        raw_start  = parts[0].strip()
        raw_end    = parts[1].strip() if len(parts) > 1 else ""

        if not raw_start:                       # suffix range: bytes=-N
            start = max(0, file_size - int(raw_end))
            end   = file_size - 1
        else:
            start = int(raw_start)
            end   = int(raw_end) if raw_end else file_size - 1

    except (ValueError, IndexError):
        return Response(
            "Invalid Range header",
            status=416,
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    # Clamp and validate
    start = max(0, min(start, file_size - 1))
    end   = max(start, min(end, file_size - 1))

    if start > end:
        return Response(
            "Range not satisfiable",
            status=416,
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    length = end - start + 1

    # ── Stream the requested byte range ──────────────────────────────────────
    def range_stream():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        **BASE_HEADERS,
        "Content-Type":   mime,
        "Content-Length": str(length),
        "Content-Range":  f"bytes {start}-{end}/{file_size}",
    }
    return Response(range_stream(), status=206, headers=headers)
