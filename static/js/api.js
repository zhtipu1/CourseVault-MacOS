/**
 * api.js — Centralized fetch wrapper for all CourseVault API calls.
 * All requests go to localhost, so no CORS concerns.
 */

const api = (() => {

    async function request(method, url, body = null) {
        const opts = {
            method,
            headers: { "Content-Type": "application/json" },
        };
        if (body !== null) opts.body = JSON.stringify(body);

        try {
            const res  = await fetch(url, opts);
            const data = await res.json();
            if (!res.ok) {
                console.error(`[api] ${method} ${url} → ${res.status}`, data);
            }
            return data;
        } catch (err) {
            console.error(`[api] ${method} ${url} failed:`, err);
            return { error: err.message };
        }
    }

    return {
        get:    (url)          => request("GET",    url),
        post:   (url, body)    => request("POST",   url, body),
        delete: (url)          => request("DELETE", url),
        put:    (url, body)    => request("PUT",    url, body),
        patch:  (url, body)    => request("PATCH",  url, body),
    };
})();
