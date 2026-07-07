"""database.py — SQLite schema + helpers."""

import sqlite3
import json
from config import DB_PATH, DEFAULT_SETTINGS


def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db():
    conn = get_db()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT
        )""")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS courses (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            title           TEXT    NOT NULL,
            folder_path     TEXT    NOT NULL UNIQUE,
            thumbnail_path  TEXT,
            description     TEXT,
            total_lessons   INTEGER DEFAULT 0,
            date_added      TEXT    DEFAULT (datetime('now')),
            last_accessed   TEXT,
            is_favorite     INTEGER DEFAULT 0,
            tags            TEXT    DEFAULT '[]',
            scan_depth      INTEGER DEFAULT NULL
        )""")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sections (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id   INTEGER NOT NULL REFERENCES courses(id)  ON DELETE CASCADE,
            parent_id   INTEGER          REFERENCES sections(id) ON DELETE CASCADE,
            title       TEXT    NOT NULL,
            folder_path TEXT    NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            depth       INTEGER DEFAULT 0,
            UNIQUE(course_id, folder_path)
        )""")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS lessons (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            section_id      INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
            course_id       INTEGER NOT NULL REFERENCES courses(id)  ON DELETE CASCADE,
            title           TEXT    NOT NULL,
            file_path       TEXT    NOT NULL UNIQUE,
            file_ext        TEXT,
            duration_secs   INTEGER DEFAULT 0,
            file_size_bytes INTEGER DEFAULT 0,
            sort_order      INTEGER DEFAULT 0,
            needs_remux     INTEGER DEFAULT 0
        )""")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS progress (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id       INTEGER NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
            position_secs   REAL    DEFAULT 0,
            duration_secs   REAL    DEFAULT 0,
            percent_watched REAL    DEFAULT 0,
            is_completed    INTEGER DEFAULT 0,
            watch_count     INTEGER DEFAULT 0,
            last_watched    TEXT,
            date_completed  TEXT
        )""")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id      INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
            timestamp_secs REAL,
            content        TEXT    NOT NULL,
            created_at     TEXT    DEFAULT (datetime('now')),
            updated_at     TEXT    DEFAULT (datetime('now'))
        )""")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS bookmarks (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id      INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
            label          TEXT,
            timestamp_secs REAL    NOT NULL,
            created_at     TEXT    DEFAULT (datetime('now'))
        )""")

    conn.commit()
    _migrate(conn)

    for key, value in DEFAULT_SETTINGS.items():
        cur.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value)
        )
    conn.commit()
    conn.close()
    print(f"[CourseVault] Database ready: {DB_PATH}")


def _migrate(conn):
    """Safe column additions for databases created before this version."""
    for sql in [
        "ALTER TABLE sections ADD COLUMN parent_id INTEGER REFERENCES sections(id) ON DELETE CASCADE",
        "ALTER TABLE sections ADD COLUMN depth INTEGER DEFAULT 0",
        "ALTER TABLE courses  ADD COLUMN scan_depth INTEGER DEFAULT NULL",
        "ALTER TABLE lessons  ADD COLUMN subtitle_path TEXT",
        # is_manual=1 marks courses built via the manual builder — scanner never deletes them
        "ALTER TABLE courses  ADD COLUMN is_manual INTEGER DEFAULT 0",
    ]:
        try:
            conn.execute(sql)
            conn.commit()
        except Exception:
            pass


def get_all_settings():
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


def get_setting(key, default=None):
    conn = get_db()
    row  = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def set_setting(key, value):
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value)
    )
    conn.commit()
    conn.close()


def set_settings(updates: dict):
    conn = get_db()
    for key, value in updates.items():
        conn.execute(
            "INSERT INTO settings (key,value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value))
        )
    conn.commit()
    conn.close()
