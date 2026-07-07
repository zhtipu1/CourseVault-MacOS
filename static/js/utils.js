/**
 * utils.js — Shared helper functions used across all pages.
 */

const utils = (() => {

    /** Format seconds → "1h 23m" or "45m 30s" */
    function formatDuration(secs) {
        if (!secs || secs <= 0) return "--";
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    /** Format seconds → "1:23:45" or "45:30" */
    function formatTime(secs) {
        if (!secs || secs < 0) return "0:00";
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        const mm = String(m).padStart(2, "0");
        const ss = String(s).padStart(2, "0");
        return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
    }

    /** Format a datetime string → "2 days ago", "just now", etc. */
    function timeAgo(isoString) {
        if (!isoString) return "";
        const diff  = Date.now() - new Date(isoString).getTime();
        const mins  = Math.floor(diff / 60000);
        const hours = Math.floor(mins / 60);
        const days  = Math.floor(hours / 24);
        if (mins < 1)   return "just now";
        if (mins < 60)  return `${mins}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7)   return `${days}d ago`;
        return new Date(isoString).toLocaleDateString();
    }

    /** Clamp a number between min and max */
    function clamp(val, min, max) {
        return Math.min(Math.max(val, min), max);
    }

    /** Show a toast notification */
    function toast(message, type = "info", duration = 3000) {
        const existing = document.getElementById("cv-toast-container");
        const container = existing || (() => {
            const el = document.createElement("div");
            el.id = "cv-toast-container";
            el.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;";
            document.body.appendChild(el);
            return el;
        })();

        const colors = {
            info:    "var(--accent)",
            success: "var(--green)",
            error:   "var(--red)",
            warning: "var(--amber)",
        };

        const el = document.createElement("div");
        el.style.cssText = `
            background: var(--surface-2);
            border: 1px solid var(--border-2);
            border-left: 3px solid ${colors[type] || colors.info};
            color: var(--text);
            padding: 10px 16px;
            border-radius: 8px;
            font-size: 13px;
            max-width: 320px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            animation: slideInToast 0.2s ease;
        `;
        el.textContent = message;
        container.appendChild(el);

        setTimeout(() => {
            el.style.opacity = "0";
            el.style.transition = "opacity 0.3s";
            setTimeout(() => el.remove(), 300);
        }, duration);
    }

    /** Debounce a function call */
    function debounce(fn, delay = 300) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    /** Escape HTML to prevent XSS in dynamic content */
    function escHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    return { formatDuration, formatTime, timeAgo, clamp, toast, debounce, escHtml };
})();
