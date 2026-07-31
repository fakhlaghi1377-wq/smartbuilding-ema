"use strict";

const CONFIG = window.SMART_BUILDING_CONFIG;
const requiredConfig = [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "ENVIRONMENT_TABLE",
    "OUTDOOR_WEATHER_TABLE",
    "ENERGY_TABLE",
    "WINDOW_TABLE",
    "WINDOW_IMAGE_BUCKET",
    "SURVEY_EVENTS_TABLE",
    "OCCUPANTS_TABLE",
    "EMA_SURVEY_BASE_URL",
    "DAILY_SURVEY_BASE_URL"
];
for (const key of requiredConfig) {
    if (!CONFIG || !CONFIG[key]) {
        throw new Error(`Missing ${key} in supabase-config.js`);
    }
}

const client = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_PUBLISHABLE_KEY,
    {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    }
);

const ENVIRONMENT_COLUMNS = [
    "device_id",
    "record_id",
    "recorded_at",
    "co2_ppm",
    "scd40_temperature_c",
    "scd40_humidity_rh",
    "sht31_temperature_c",
    "sht31_humidity_rh",
    "illuminance_lux",
    "motion_detected"
].join(",");

const OUTDOOR_WEATHER_COLUMNS = [
    "recorded_at",
    "temperature_c",
    "humidity_percent",
    "wind_speed_mps",
    "wind_direction_deg",
    "weather_description",
    "aqi",
    "pm25_ug_m3",
    "pm10_ug_m3",
    "co_ug_m3",
    "no2_ug_m3",
    "o3_ug_m3"
].join(",");

const ENERGY_COLUMNS = [
    "recorded_at",
    "current_a",
    "apparent_power_va",
    "real_power_w",
    "interval_energy_wh",
    "total_energy_kwh"
].join(",");

const WINDOW_COLUMNS = [
    "id",
    "recorded_at",
    "record_id",
    "window_state",
    "is_transition",
    "image_path",
    "vision_window_state",
    "vision_confidence",
    "open_duration_seconds"
].join(",");

const EMA_COLUMNS = [
    "id",
    "survey_type",
    "survey_slot",
    "occupant_id",
    "claimed_by_occupant_id",
    "status",
    "access_token",
    "scheduled_for",
    "expires_at",
    "window_opened_at",
    "created_at"
].join(",");

const OCCUPANT_COLUMNS = [
    "id",
    "occupant_code"
].join(",");

let session = null;
let refreshTimer = null;
let refreshInProgress = false;
let realtimeChannels = [];
let charts = {};

const byId = (id) => document.getElementById(id);

function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
}

function setHidden(id, hidden) {
    const element = byId(id);
    if (element) element.classList.toggle("hidden", hidden);
}

function formatNumber(value, digits = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "--";
}

function formatDateTime(value) {
    if (!value) return "No timestamp available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("en-CA", {
        timeZone: CONFIG.DISPLAY_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
}

function formatChartTime(value, historyHours) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const options = {
        timeZone: CONFIG.DISPLAY_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    };
    if (historyHours > 24) {
        options.month = "2-digit";
        options.day = "2-digit";
    }
    return date.toLocaleString("en-CA", options);
}

function updateConnectionStatus(online, message) {
    const dot = byId("connection-dot");
    if (dot) dot.className = `status-dot ${online ? "online" : "offline"}`;
    setText("connection-text", message || (online ? "Cloud connected" : "Cloud disconnected"));
}

function updateCo2Status(value) {
    const element = byId("co2-status");
    const co2 = Number(value);
    if (!element || !Number.isFinite(co2)) {
        if (element) {
            element.textContent = "No data";
            element.className = "status-label neutral-text";
        }
        return;
    }
    if (co2 < 800) {
        element.textContent = "Good indoor air quality";
        element.className = "status-label success-text";
    } else if (co2 < 1000) {
        element.textContent = "Moderate CO₂ concentration";
        element.className = "status-label warning-text";
    } else {
        element.textContent = "Elevated CO₂ concentration";
        element.className = "status-label danger-text";
    }
}

function updateLatest(reading) {
    if (!reading) {
        updateConnectionStatus(true, "Cloud connected · no data");
        setText("environment-time", "No environmental data available");
        return;
    }

    setText("co2-value", formatNumber(reading.co2_ppm, 0));
    setText("sht31-temperature", formatNumber(reading.sht31_temperature_c));
    setText("sht31-humidity", formatNumber(reading.sht31_humidity_rh));
    setText("scd40-temperature", formatNumber(reading.scd40_temperature_c));
    setText("scd40-humidity", formatNumber(reading.scd40_humidity_rh));
    setText("illuminance-value", formatNumber(reading.illuminance_lux));
    setText("environment-device", reading.device_id || "--");
    setText("environment-time", `Latest measurement: ${formatDateTime(reading.recorded_at)}`);
    updateCo2Status(reading.co2_ppm);

    const badge = byId("motion-badge");
    if (badge) {
        badge.textContent = reading.motion_detected ? "Detected" : "Not detected";
        badge.className = `large-badge ${reading.motion_detected ? "success" : "neutral"}`;
    }
}

async function fetchLatestReading() {
    const query = client
        .from(CONFIG.ENVIRONMENT_TABLE)
        .select(ENVIRONMENT_COLUMNS)
        .order("recorded_at", { ascending: false })
        .limit(1);

    if (CONFIG.ENVIRONMENT_DEVICE_ID) {
        query.eq("device_id", CONFIG.ENVIRONMENT_DEVICE_ID);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data?.[0] || null;
}

async function fetchHistory(hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const pageSize = Math.min(Math.max(Number(CONFIG.PAGE_SIZE) || 1000, 1), 1000);
    const maxRows = Math.max(Number(CONFIG.MAX_HISTORY_ROWS) || 10000, pageSize);
    const rows = [];

    for (let from = 0; from < maxRows; from += pageSize) {
        let query = client
            .from(CONFIG.ENVIRONMENT_TABLE)
            .select(ENVIRONMENT_COLUMNS)
            .gte("recorded_at", since)
            .order("recorded_at", { ascending: true })
            .range(from, from + pageSize - 1);

        if (CONFIG.ENVIRONMENT_DEVICE_ID) {
            query = query.eq("device_id", CONFIG.ENVIRONMENT_DEVICE_ID);
        }
        const { data, error } = await query;
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return rows;
}

async function fetchLatestOutdoorWeather() {
    const { data, error } = await client
        .from(CONFIG.OUTDOOR_WEATHER_TABLE)
        .select(OUTDOOR_WEATHER_COLUMNS)
        .order("recorded_at", { ascending: false })
        .limit(1);
    if (error) throw error;
    return data?.[0] || null;
}

async function fetchOutdoorWeatherHistory(hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const pageSize = Math.min(Math.max(Number(CONFIG.PAGE_SIZE) || 1000, 1), 1000);
    const maxRows = Math.max(Number(CONFIG.MAX_HISTORY_ROWS) || 10000, pageSize);
    const rows = [];

    for (let from = 0; from < maxRows; from += pageSize) {
        const { data, error } = await client
            .from(CONFIG.OUTDOOR_WEATHER_TABLE)
            .select(OUTDOOR_WEATHER_COLUMNS)
            .gte("recorded_at", since)
            .order("recorded_at", { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return rows;
}

function windDirectionToCardinal(value) {
    const degrees = Number(value);
    if (!Number.isFinite(degrees)) return "Direction unavailable";
    const directions = [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
    ];
    return directions[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}

function updateOutdoorAqiStatus(value) {
    const element = byId("outdoor-aqi-status");
    if (!element) return;
    const labels = {
        1: ["Good", "success-text"],
        2: ["Fair", "success-text"],
        3: ["Moderate", "warning-text"],
        4: ["Poor", "danger-text"],
        5: ["Very poor", "danger-text"]
    };
    const match = labels[Number(value)];
    element.textContent = match?.[0] || "No data";
    element.className = `status-label ${match?.[1] || "neutral-text"}`;
}

function updateLatestOutdoorWeather(weather) {
    if (!weather) {
        setText("outdoor-time", "No outdoor data available");
        [
            "outdoor-temperature", "outdoor-humidity", "outdoor-wind-speed",
            "outdoor-wind-direction", "outdoor-aqi", "outdoor-pm25",
            "outdoor-pm10"
        ].forEach((id) => setText(id, "--"));
        setText("outdoor-wind-cardinal", "Direction unavailable");
        setText("outdoor-description", "--");
        updateOutdoorAqiStatus(null);
        return;
    }
    setText("outdoor-temperature", formatNumber(weather.temperature_c, 1));
    setText("outdoor-humidity", formatNumber(weather.humidity_percent, 0));
    setText("outdoor-wind-speed", formatNumber(weather.wind_speed_mps, 1));
    setText("outdoor-wind-direction", formatNumber(weather.wind_direction_deg, 0));
    setText("outdoor-wind-cardinal", windDirectionToCardinal(weather.wind_direction_deg));
    setText("outdoor-aqi", formatNumber(weather.aqi, 0));
    setText("outdoor-pm25", formatNumber(weather.pm25_ug_m3, 1));
    setText("outdoor-pm10", formatNumber(weather.pm10_ug_m3, 1));
    setText("outdoor-description", weather.weather_description || "--");
    setText("outdoor-time", `Latest outdoor measurement: ${formatDateTime(weather.recorded_at)}`);
    updateOutdoorAqiStatus(weather.aqi);
}

async function fetchLatestEnergy() {
    let query = client
        .from(CONFIG.ENERGY_TABLE)
        .select(ENERGY_COLUMNS)
        .order("recorded_at", { ascending: false })
        .limit(1);

    if (CONFIG.ENERGY_DEVICE_ID) {
        query = query.eq("device_id", CONFIG.ENERGY_DEVICE_ID);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data?.[0] || null;
}

async function fetchEnergyHistory(hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const pageSize = Math.min(Math.max(Number(CONFIG.PAGE_SIZE) || 1000, 1), 1000);
    const maxRows = Math.max(Number(CONFIG.MAX_HISTORY_ROWS) || 10000, pageSize);
    const rows = [];

    for (let from = 0; from < maxRows; from += pageSize) {
        let query = client
            .from(CONFIG.ENERGY_TABLE)
            .select(ENERGY_COLUMNS)
            .gte("recorded_at", since)
            .order("recorded_at", { ascending: true })
            .range(from, from + pageSize - 1);

        if (CONFIG.ENERGY_DEVICE_ID) {
            query = query.eq("device_id", CONFIG.ENERGY_DEVICE_ID);
        }
        const { data, error } = await query;
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return rows;
}

function updateLatestEnergy(reading) {
    if (!reading) {
        setText("energy-time", "No energy data available");
        return;
    }
    setText("energy-current", formatNumber(reading.current_a, 2));
    setText("energy-real-power", formatNumber(reading.real_power_w, 1));
    setText("energy-apparent-power", formatNumber(reading.apparent_power_va, 1));
    setText("energy-interval", formatNumber(reading.interval_energy_wh, 3));
    setText("energy-total", formatNumber(reading.total_energy_kwh, 3));
    setText("energy-time", `Latest measurement: ${formatDateTime(reading.recorded_at)}`);
}

async function fetchWindowSummary() {
    let latestQuery = client
        .from(CONFIG.WINDOW_TABLE)
        .select(WINDOW_COLUMNS)
        .eq("is_transition", true)
        .order("recorded_at", { ascending: false })
        .limit(1);
    let imageQuery = client
        .from(CONFIG.WINDOW_TABLE)
        .select(WINDOW_COLUMNS)
        .not("image_path", "is", null)
        .order("recorded_at", { ascending: false })
        .limit(1);
    let durationQuery = client
        .from(CONFIG.WINDOW_TABLE)
        .select("recorded_at,open_duration_seconds")
        .eq("window_state", "CLOSED")
        .not("open_duration_seconds", "is", null)
        .order("recorded_at", { ascending: false })
        .limit(1);

    if (CONFIG.WINDOW_DEVICE_ID) {
        latestQuery = latestQuery.eq("device_id", CONFIG.WINDOW_DEVICE_ID);
        imageQuery = imageQuery.eq("device_id", CONFIG.WINDOW_DEVICE_ID);
        durationQuery = durationQuery.eq("device_id", CONFIG.WINDOW_DEVICE_ID);
    }

    const [latestResult, imageResult, durationResult] = await Promise.all([
        latestQuery,
        imageQuery,
        durationQuery
    ]);
    if (latestResult.error) throw latestResult.error;
    if (imageResult.error) throw imageResult.error;
    if (durationResult.error) throw durationResult.error;
    return {
        latest: latestResult.data?.[0] || null,
        latestImage: imageResult.data?.[0] || null,
        latestDuration: durationResult.data?.[0] || null
    };
}

async function fetchWindowHistory(hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    let query = client
        .from(CONFIG.WINDOW_TABLE)
        .select("recorded_at,window_state,is_transition")
        .eq("is_transition", true)
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true })
        .limit(5000);
    if (CONFIG.WINDOW_DEVICE_ID) {
        query = query.eq("device_id", CONFIG.WINDOW_DEVICE_ID);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function fetchLatestEma() {
    const { data, error } = await client
        .from(CONFIG.SURVEY_EVENTS_TABLE)
        .select(EMA_COLUMNS)
        .eq("survey_type", "WINDOW_OPEN")
        .order("created_at", { ascending: false })
        .limit(20);
    if (error) throw error;

    const now = Date.now();
    const rows = data || [];
    return rows.find((row) => {
        const status = String(row.status || "").toUpperCase();
        const expiresAt = row.expires_at
            ? new Date(row.expires_at).getTime()
            : Number.POSITIVE_INFINITY;
        return status === "PENDING"
            && Boolean(row.access_token)
            && expiresAt > now;
    }) || rows[0] || null;
}

async function fetchLatestDaily() {
    const { data, error } = await client
        .from(CONFIG.SURVEY_EVENTS_TABLE)
        .select(EMA_COLUMNS)
        .neq("survey_type", "WINDOW_OPEN")
        .in("status", ["PENDING", "CLAIMED"])
        .order("scheduled_for", { ascending: false, nullsFirst: false })
        .limit(50);
    if (error) throw error;

    const now = Date.now();
    return (data || []).filter((row) => {
        const expiresAt = row.expires_at
            ? new Date(row.expires_at).getTime()
            : Number.POSITIVE_INFINITY;
        return Boolean(row.access_token) && expiresAt > now;
    });
}

async function attachOccupants(events) {
    const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
    if (!list.length) return Array.isArray(events) ? [] : null;

    const occupantIds = [...new Set(list
        .map((event) => event.occupant_id || event.claimed_by_occupant_id)
        .filter(Boolean))];
    if (!occupantIds.length) return Array.isArray(events) ? list : list[0];

    const { data, error } = await client
        .from(CONFIG.OCCUPANTS_TABLE)
        .select(OCCUPANT_COLUMNS)
        .in("id", occupantIds);
    if (error) throw error;

    const occupantById = new Map((data || []).map((occupant) => [
        String(occupant.id),
        occupant
    ]));
    const attached = list.map((event) => ({
        ...event,
        occupant: occupantById.get(String(
            event.occupant_id || event.claimed_by_occupant_id
        )) || null
    }));
    return Array.isArray(events) ? attached : attached[0];
}

async function attachOccupantsSafely(events) {
    try {
        return await attachOccupants(events);
    } catch (error) {
        console.error("Could not load occupant labels:", error);
        return events;
    }
}

function occupantLabel(event) {
    const raw = String(
        event?.occupant?.occupant_code
        || event?.occupant?.display_name
        || ""
    ).trim();

    const numberMatch = raw.match(/(\d+)\s*$/);
    if (numberMatch) return `User ${Number(numberMatch[1])}`;
    return raw;
}

function updateLatestEma(event) {
    const link = byId("ema-link");
    const statusBadge = byId("ema-status");
    if (!event) {
        setText("ema-time", "No window-opening EMA has been created yet.");
        setText("ema-expiry", "A link appears here after each physical window opening.");
        if (statusBadge) {
            statusBadge.textContent = "No pending EMA";
            statusBadge.className = "large-badge neutral";
        }
        if (link) {
            link.classList.add("hidden");
            link.removeAttribute("href");
        }
        return;
    }

    const storedStatus = String(event.status || "").toUpperCase();
    const expiresAtMs = event.expires_at
        ? new Date(event.expires_at).getTime()
        : Number.POSITIVE_INFINITY;
    const isPending = storedStatus === "PENDING"
        && Boolean(event.access_token)
        && expiresAtMs > Date.now();
    const effectiveStatus = (
        storedStatus === "PENDING" && expiresAtMs <= Date.now()
    ) ? "EXPIRED" : storedStatus;
    const openedAt = event.window_opened_at
        || event.scheduled_for
        || event.created_at;

    setText("ema-time", `Window opened: ${formatDateTime(openedAt)}`);
    setText(
        "ema-expiry",
        event.expires_at
            ? `Available until: ${formatDateTime(event.expires_at)}`
            : "No expiry time available"
    );
    if (statusBadge) {
        statusBadge.textContent = effectiveStatus || "UNKNOWN";
        statusBadge.className = `large-badge ${isPending ? "success" : "neutral"}`;
    }
    if (link) {
        if (isPending) {
            const query = new URLSearchParams({
                event: String(event.id),
                token: String(event.access_token)
            });
            link.href = `${CONFIG.EMA_SURVEY_BASE_URL.replace(/\/$/, "")}/?${query}`;
            link.textContent = "Open EMA questionnaire";
            link.classList.remove("hidden");
        } else {
            link.classList.add("hidden");
            link.removeAttribute("href");
        }
    }
}

function dailySlotLabel(event) {
    const slot = String(event?.survey_slot || "").toLowerCase();
    const labels = {
        morning: "Morning questionnaire",
        afternoon: "Afternoon questionnaire",
        evening: "Evening questionnaire"
    };
    if (labels[slot]) return labels[slot];

    const type = String(event?.survey_type || "").toUpperCase();
    if (type.includes("MORNING")) return labels.morning;
    if (type.includes("AFTERNOON")) return labels.afternoon;
    if (type.includes("EVENING")) return labels.evening;
    return "Daily comfort questionnaire";
}

function dailySlotTime(event) {
    const slot = String(event?.survey_slot || "").toLowerCase();
    if (slot === "morning") return "09:00";
    if (slot === "afternoon") return "14:00";
    if (slot === "evening") return "20:00";

    const type = String(event?.survey_type || "").toUpperCase();
    if (type.includes("MORNING")) return "09:00";
    if (type.includes("AFTERNOON")) return "14:00";
    if (type.includes("EVENING")) return "20:00";
    return "";
}

function updateLatestDaily(events) {
    const container = byId("daily-events");
    if (!container) return;
    container.replaceChildren();

    const activeEvents = (events || []).filter((event) => {
        const status = String(event.status || "").toUpperCase();
        const expiresAt = event.expires_at
            ? new Date(event.expires_at).getTime()
            : Number.POSITIVE_INFINITY;
        return ["PENDING", "CLAIMED"].includes(status)
            && Boolean(event.access_token)
            && expiresAt > Date.now();
    });

    if (!activeEvents.length) {
        const empty = document.createElement("p");
        empty.className = "daily-empty";
        empty.textContent = "No active daily questionnaire.";
        container.append(empty);
        return;
    }

    activeEvents
        .sort((a, b) => (occupantLabel(a) || "").localeCompare(
            occupantLabel(b) || "", undefined, { numeric: true }
        ))
        .forEach((event) => {
            const user = occupantLabel(event);
            const card = document.createElement("article");
            card.className = "daily-event-card";

            const details = document.createElement("div");
            const title = document.createElement("h3");
            title.textContent = dailySlotLabel(event);
            const schedule = document.createElement("p");
            schedule.className = "daily-meta";
            schedule.textContent = [user, dailySlotTime(event)]
                .filter(Boolean)
                .join(" · ");
            details.append(title, schedule);

            const link = document.createElement("a");
            const query = new URLSearchParams({
                event: String(event.id),
                token: String(event.access_token)
            });
            link.className = "ema-link";
            link.href = `${CONFIG.DAILY_SURVEY_BASE_URL.replace(/\/$/, "")}?${query}`;
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = "Open";
            card.append(details, link);
            container.append(card);
        });
}

async function updateWindowSummary(summary) {
    const latest = summary?.latest;
    const badge = byId("window-state-badge");
    if (!latest) {
        setText("window-time", "No window data available");
        if (badge) {
            badge.textContent = "Unknown";
            badge.className = "large-badge neutral";
        }
    } else {
        const isOpen = latest.window_state === "OPEN";
        setText("window-time", `Latest event: ${formatDateTime(latest.recorded_at)}`);
        if (badge) {
            badge.textContent = isOpen ? "OPEN" : "CLOSED";
            badge.className = `large-badge ${isOpen ? "success" : "neutral"}`;
        }
    }

    const completedDuration = Number(summary?.latestDuration?.open_duration_seconds);
    const latestRecordedAt = latest?.recorded_at
        ? new Date(latest.recorded_at).getTime()
        : Number.NaN;
    const duration = latest?.window_state === "OPEN" && Number.isFinite(latestRecordedAt)
        ? Math.max(0, (Date.now() - latestRecordedAt) / 1000)
        : completedDuration;
    setText(
        "window-duration",
        Number.isFinite(duration) ? (duration / 60).toFixed(1) : "--"
    );
    setText(
        "window-duration-label",
        latest?.window_state === "OPEN"
            ? "Current open session (updates every 30 seconds)"
            : "Most recently completed open session"
    );

    const imageRow = summary?.latestImage;
    const image = byId("window-image");
    const placeholder = byId("window-image-placeholder");
    if (!imageRow?.image_path) {
        if (image) {
            image.removeAttribute("src");
            image.classList.add("hidden");
        }
        if (placeholder) placeholder.classList.remove("hidden");
        setText("window-image-time", "No cloud image available");
        return;
    }

    const { data, error } = await client.storage
        .from(CONFIG.WINDOW_IMAGE_BUCKET)
        .createSignedUrl(imageRow.image_path, 3600);
    if (error) throw error;
    if (image) {
        image.src = data.signedUrl;
        image.classList.remove("hidden");
    }
    if (placeholder) placeholder.classList.add("hidden");
    setText(
        "window-image-time",
        `Captured: ${formatDateTime(imageRow.recorded_at)}`
    );
}

function average(items, field) {
    const values = items.map((item) => Number(item[field])).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function lastFinite(items, field) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const value = Number(items[index][field]);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function aggregateHistory(rows, historyHours) {
    const targetPoints = 288;
    const bucketMs = Math.max(
        60 * 1000,
        Math.ceil((historyHours * 60 * 60 * 1000) / targetPoints / 60000) * 60000
    );
    const buckets = new Map();

    for (const row of rows) {
        const timestamp = new Date(row.recorded_at).getTime();
        if (!Number.isFinite(timestamp)) continue;
        const key = Math.floor(timestamp / bucketMs) * bucketMs;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
    }

    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, items]) => ({
        recorded_at: new Date(time).toISOString(),
        co2_ppm: average(items, "co2_ppm"),
        sht31_temperature_c: average(items, "sht31_temperature_c"),
        scd40_temperature_c: average(items, "scd40_temperature_c"),
        sht31_humidity_rh: average(items, "sht31_humidity_rh"),
        scd40_humidity_rh: average(items, "scd40_humidity_rh"),
        illuminance_lux: average(items, "illuminance_lux"),
        motion_detected: items.some((item) => item.motion_detected === true)
    }));
}

function aggregateEnergyHistory(rows, historyHours) {
    const targetPoints = 288;
    const bucketMs = Math.max(
        60 * 1000,
        Math.ceil((historyHours * 60 * 60 * 1000) / targetPoints / 60000) * 60000
    );
    const buckets = new Map();

    for (const row of rows) {
        const timestamp = new Date(row.recorded_at).getTime();
        if (!Number.isFinite(timestamp)) continue;
        const key = Math.floor(timestamp / bucketMs) * bucketMs;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
    }

    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, items]) => ({
        recorded_at: new Date(time).toISOString(),
        real_power_w: average(items, "real_power_w"),
        total_energy_kwh: lastFinite(items, "total_energy_kwh")
    }));
}

function aggregateOutdoorHistory(rows, historyHours) {
    const targetPoints = 288;
    const bucketMs = Math.max(
        60 * 1000,
        Math.ceil((historyHours * 60 * 60 * 1000) / targetPoints / 60000) * 60000
    );
    const buckets = new Map();

    for (const row of rows) {
        const timestamp = new Date(row.recorded_at).getTime();
        if (!Number.isFinite(timestamp)) continue;
        const key = Math.floor(timestamp / bucketMs) * bucketMs;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
    }

    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, items]) => ({
        recorded_at: new Date(time).toISOString(),
        temperature_c: average(items, "temperature_c"),
        humidity_percent: average(items, "humidity_percent"),
        wind_speed_mps: average(items, "wind_speed_mps"),
        wind_direction_deg: average(items, "wind_direction_deg"),
        aqi: average(items, "aqi"),
        pm25_ug_m3: average(items, "pm25_ug_m3"),
        pm10_ug_m3: average(items, "pm10_ug_m3")
    }));
}

function destroyChart(name) {
    if (charts[name]) {
        charts[name].destroy();
        delete charts[name];
    }
}

function lineChart(name, canvasId, labels, datasets, yTitle, stepped = false) {
    destroyChart(name);
    const canvas = byId(canvasId);
    if (!canvas) return;
    charts[name] = new Chart(canvas, {
        type: "line",
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            elements: {
                point: { radius: 0, hoverRadius: 4 },
                line: { borderWidth: 2, tension: stepped ? 0 : 0.2, stepped }
            },
            plugins: { legend: { position: "bottom" } },
            scales: {
                x: { ticks: { maxTicksLimit: 10, maxRotation: 0 } },
                y: {
                    beginAtZero: false,
                    title: { display: true, text: yTitle }
                }
            }
        }
    });
}

function updateCharts(rawRows, historyHours) {
    const rows = aggregateHistory(rawRows, historyHours);
    const labels = rows.map((row) => formatChartTime(row.recorded_at, historyHours));
    const dataset = (label, field, color) => ({
        label,
        data: rows.map((row) => row[field]),
        borderColor: color,
        backgroundColor: `${color}22`,
        spanGaps: true
    });

    lineChart("co2", "co2-chart", labels, [dataset("CO₂", "co2_ppm", "#7c3aed")], "ppm");
    lineChart("temperature", "temperature-chart", labels, [
        dataset("SHT31", "sht31_temperature_c", "#dc2626"),
        dataset("SCD40", "scd40_temperature_c", "#f97316")
    ], "°C");
    lineChart("humidity", "humidity-chart", labels, [
        dataset("SHT31", "sht31_humidity_rh", "#2563eb"),
        dataset("SCD40", "scd40_humidity_rh", "#0891b2")
    ], "%RH");
    lineChart("illuminance", "illuminance-chart", labels, [
        dataset("Illuminance", "illuminance_lux", "#ca8a04")
    ], "lux");
    lineChart("motion", "motion-chart", labels, [{
        label: "Motion",
        data: rows.map((row) => row.motion_detected ? 1 : 0),
        borderColor: "#16a34a",
        backgroundColor: "#16a34a22"
    }], "0 = No · 1 = Yes", true);

    const capped = rawRows.length >= Number(CONFIG.MAX_HISTORY_ROWS);
    setText(
        "history-summary",
        `${rawRows.length.toLocaleString()} measurements · ${rows.length.toLocaleString()} chart intervals${capped ? " · maximum row limit reached" : ""}`
    );
}

function updateEnergyCharts(rawRows, historyHours) {
    const rows = aggregateEnergyHistory(rawRows, historyHours);
    const labels = rows.map((row) => formatChartTime(row.recorded_at, historyHours));
    const dataset = (label, field, color) => ({
        label,
        data: rows.map((row) => row[field]),
        borderColor: color,
        backgroundColor: `${color}22`,
        spanGaps: true
    });

    lineChart("power", "power-chart", labels, [
        dataset("Real Power", "real_power_w", "#f97316")
    ], "W");
    lineChart("energyTotal", "energy-total-chart", labels, [
        dataset("Total Energy", "total_energy_kwh", "#16a34a")
    ], "kWh");

    const capped = rawRows.length >= Number(CONFIG.MAX_HISTORY_ROWS);
    setText(
        "energy-history-summary",
        `${rawRows.length.toLocaleString()} measurements · ${rows.length.toLocaleString()} chart intervals${capped ? " · maximum row limit reached" : ""}`
    );
}

function updateOutdoorCharts(rawRows, historyHours) {
    const rows = aggregateOutdoorHistory(rawRows, historyHours);
    const labels = rows.map((row) => formatChartTime(row.recorded_at, historyHours));
    const dataset = (label, field, color) => ({
        label,
        data: rows.map((row) => row[field]),
        borderColor: color,
        backgroundColor: `${color}22`,
        spanGaps: true
    });

    lineChart("outdoorTemperature", "outdoor-temperature-chart", labels, [
        dataset("Outdoor Temperature", "temperature_c", "#dc2626")
    ], "°C");
    lineChart("outdoorHumidity", "outdoor-humidity-chart", labels, [
        dataset("Outdoor Humidity", "humidity_percent", "#2563eb")
    ], "%RH");
    lineChart("outdoorWindSpeed", "outdoor-wind-speed-chart", labels, [
        dataset("Wind Speed", "wind_speed_mps", "#0891b2")
    ], "m/s");
    lineChart("outdoorWindDirection", "outdoor-wind-direction-chart", labels, [
        dataset("Wind Direction", "wind_direction_deg", "#7c3aed")
    ], "Degrees");
    lineChart("outdoorAqi", "outdoor-aqi-chart", labels, [
        dataset("AQI", "aqi", "#f97316")
    ], "AQI (1–5)");
    lineChart("outdoorPm", "outdoor-pm-chart", labels, [
        dataset("PM2.5", "pm25_ug_m3", "#db2777"),
        dataset("PM10", "pm10_ug_m3", "#9333ea")
    ], "µg/m³");

    const capped = rawRows.length >= Number(CONFIG.MAX_HISTORY_ROWS);
    setText(
        "outdoor-history-summary",
        `${rawRows.length.toLocaleString()} measurements · ${rows.length.toLocaleString()} chart intervals${capped ? " · maximum row limit reached" : ""}`
    );
}

function updateWindowChart(rows, historyHours) {
    const chartRows = [...rows];
    const latest = chartRows[chartRows.length - 1];
    if (latest) {
        chartRows.push({
            ...latest,
            recorded_at: new Date().toISOString()
        });
    }
    const labels = chartRows.map((row) =>
        formatChartTime(row.recorded_at, historyHours)
    );
    lineChart("windowState", "window-state-chart", labels, [{
        label: "Window",
        data: chartRows.map((row) => row.window_state === "OPEN" ? 1 : 0),
        borderColor: "#0891b2",
        backgroundColor: "#0891b222",
        spanGaps: true
    }], "0 = Closed · 1 = Open", true);
    setText(
        "window-history-summary",
        `${rows.length.toLocaleString()} transition events`
    );
}

async function refreshDashboard() {
    if (!session || refreshInProgress) return;
    refreshInProgress = true;
    try {
        updateConnectionStatus(true, "Updating…");
        const hours = Number(byId("history-hours")?.value || 24);
        const [
            latest,
            history,
            latestOutdoor,
            outdoorHistory,
            latestEnergy,
            energyHistory,
            windowSummary,
            windowHistory,
            latestEma,
            latestDaily
        ] = await Promise.all([
            fetchLatestReading(),
            fetchHistory(hours),
            fetchLatestOutdoorWeather(),
            fetchOutdoorWeatherHistory(hours),
            fetchLatestEnergy(),
            fetchEnergyHistory(hours),
            fetchWindowSummary(),
            fetchWindowHistory(hours),
            fetchLatestEma(),
            fetchLatestDaily()
        ]);
        updateLatest(latest);
        updateCharts(history, hours);
        updateLatestOutdoorWeather(latestOutdoor);
        updateOutdoorCharts(outdoorHistory, hours);
        updateLatestEnergy(latestEnergy);
        updateEnergyCharts(energyHistory, hours);
        await updateWindowSummary(windowSummary);
        updateWindowChart(windowHistory, hours);
        updateLatestEma(latestEma);
        const latestDailyWithOccupants = await attachOccupantsSafely(latestDaily);
        updateLatestDaily(latestDailyWithOccupants);
        setText("last-refresh", new Date().toLocaleTimeString("en-CA", {
            timeZone: CONFIG.DISPLAY_TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }));
        updateConnectionStatus(true, "Cloud connected");
    } catch (error) {
        console.error("Dashboard refresh failed:", error);
        const message = error?.message?.includes("row-level security")
            ? "Access denied by security policy"
            : "Cloud connection failed";
        updateConnectionStatus(false, message);
    } finally {
        refreshInProgress = false;
    }
}

function stopDashboard() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    for (const channel of realtimeChannels) client.removeChannel(channel);
    realtimeChannels = [];
}

function startDashboard() {
    stopDashboard();
    refreshDashboard();
    refreshTimer = setInterval(refreshDashboard, Number(CONFIG.REFRESH_INTERVAL_MS) || 30000);
}

function renderSession(newSession) {
    session = newSession;
    const signedIn = Boolean(session?.user);
    setHidden("login-view", signedIn);
    setHidden("dashboard-view", !signedIn);
    setText("signed-in-email", session?.user?.email || "--");
    setText("login-message", "");
    if (signedIn) startDashboard();
    else stopDashboard();
}

byId("login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("login-button");
    const email = byId("email").value.trim();
    const password = byId("password").value;
    button.disabled = true;
    setText("login-message", "Signing in…");
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) setText("login-message", error.message);
    button.disabled = false;
});

byId("logout-button")?.addEventListener("click", () => client.auth.signOut());
byId("history-hours")?.addEventListener("change", refreshDashboard);
window.addEventListener("online", refreshDashboard);
window.addEventListener("offline", () => updateConnectionStatus(false, "Internet disconnected"));
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshDashboard();
});

client.auth.onAuthStateChange((_event, newSession) => renderSession(newSession));
client.auth.getSession().then(({ data }) => renderSession(data.session));
