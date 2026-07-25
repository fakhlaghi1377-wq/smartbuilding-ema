(function () {
    "use strict";

    const CACHE_PREFIX = "smartbuilding-survey-event:";
    const QUEUE_KEY = "smartbuilding-survey-outbox-v1";

    function config() {
        const value = window.SURVEY_CLOUD_CONFIG || {};
        const url = String(value.SUPABASE_URL || "").replace(/\/+$/, "");
        const key = String(value.SUPABASE_ANON_KEY || "");
        if (!url || url.includes("YOUR_PROJECT") || !key || key.includes("YOUR_PUBLIC")) {
            throw new Error("Survey cloud configuration is missing.");
        }
        return {url, key};
    }

    async function rpc(name, body) {
        const {url, key} = config();
        const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
            method: "POST",
            headers: {
                "apikey": key,
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            data = null;
        }
        if (!response.ok) {
            const error = new Error(data?.message || `Cloud request failed (${response.status})`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return Array.isArray(data) ? data[0] : data;
    }

    function eventCacheKey(token) {
        return `${CACHE_PREFIX}${token}`;
    }

    function cacheEvent(token, event) {
        localStorage.setItem(eventCacheKey(token), JSON.stringify(event));
    }

    function cachedEvent(token) {
        try {
            return JSON.parse(localStorage.getItem(eventCacheKey(token)) || "null");
        } catch (_) {
            return null;
        }
    }

    function readQueue() {
        try {
            return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
        } catch (_) {
            return [];
        }
    }

    function writeQueue(items) {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    }

    function enqueue(token, eventId, answers) {
        const items = readQueue();
        const existing = items.find((item) => item.token === token);
        const item = {
            token,
            event_id: eventId || null,
            answers,
            queued_at: new Date().toISOString(),
        };
        if (existing) {
            Object.assign(existing, item);
        } else {
            items.push(item);
        }
        writeQueue(items);
    }

    async function load(token, eventId) {
        try {
            const event = await rpc("get_survey_by_token", {
                p_token: token,
                p_event_id: eventId || null,
            });
            if (event) cacheEvent(token, event);
            return {event, offline: false};
        } catch (error) {
            const event = cachedEvent(token);
            if (event) return {event, offline: true};
            throw error;
        }
    }

    async function submit(token, eventId, answers) {
        try {
            const result = await rpc("submit_survey_by_token", {
                p_token: token,
                p_event_id: eventId || null,
                p_answers: answers,
            });
            localStorage.removeItem(eventCacheKey(token));
            return {result, queued: false};
        } catch (error) {
            // Queue only connection failures. A real cloud rejection must be shown.
            if (error.status) throw error;
            enqueue(token, eventId, answers);
            return {result: null, queued: true};
        }
    }

    async function flushQueue() {
        const pending = readQueue();
        if (!pending.length) return 0;
        const remaining = [];
        let sent = 0;
        for (const item of pending) {
            try {
                await rpc("submit_survey_by_token", {
                    p_token: item.token,
                    p_event_id: item.event_id || null,
                    p_answers: item.answers,
                });
                localStorage.removeItem(eventCacheKey(item.token));
                sent += 1;
            } catch (error) {
                // A duplicate/completed response no longer needs retrying.
                if (error.status && error.status < 500) continue;
                remaining.push(item);
            }
        }
        writeQueue(remaining);
        return sent;
    }

    window.CloudSurveyApi = {load, submit, flushQueue};

    window.addEventListener("online", () => {
        flushQueue().catch(console.error);
    });
    if (navigator.onLine) {
        flushQueue().catch(console.error);
    }

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
        navigator.serviceWorker.register("../service-worker.js", {scope: "../"})
            .catch(console.error);
    }
})();
