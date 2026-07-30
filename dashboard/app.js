"use strict";

const CONFIG = window.SMART_BUILDING_CONFIG;
const requiredConfig = [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "ENVIRONMENT_TABLE",
    "ENERGY_TABLE",
    "WINDOW_TABLE",
    "WINDOW_IMAGE_BUCKET",
    "SURVEY_EVENT_TABLE",
    "SURVEY_SITE_URL"
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

function updateWindowDurationLabels(isOpen) {
    const titleText = isOpen
        ? "Current Open Duration"
        : "Last Open Duration";
    const descriptionText = isOpen
        ? "Current open session"
        : "Most recently completed open session";

    const title = byId("window-duration-title")
        || [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,.metric-label,.stat-label")]
            .find((element) => /^(current |last )?open duration$/i.test(
                element.textContent.trim()
            ));
    const description = byId("window-duration-description")
        || [...document.querySelectorAll("p,small,.metric-description,.stat-description")]
            .find((element) => /open session/i.test(element.textContent));

    if (title) title.textContent = titleText;
    if (description) description.textContent = descriptionText;
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
        .eq("is_transition", true)
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

async function updateWindowSummary(summary) {
    const latest = summary?.latest;
    const badge = byId("window-state-badge");
    const isOpen = latest?.window_state === "OPEN";
    if (!latest) {
        setText("window-time", "No window data available");
        if (badge) {
            badge.textContent = "Unknown";
            badge.className = "large-badge neutral";
        }
    } else {
        setText("window-time", `Latest event: ${formatDateTime(latest.recorded_at)}`);
        if (badge) {
            badge.textContent = isOpen ? "OPEN" : "CLOSED";
            badge.className = `large-badge ${isOpen ? "success" : "neutral"}`;
        }
    }

    let duration = null;
    if (isOpen) {
        const openedAt = new Date(latest.recorded_at).getTime();
        if (Number.isFinite(openedAt)) {
            duration = Math.max(0, (Date.now() - openedAt) / 1000);
        }
    } else {
        const lastCompletedDuration = Number(
            summary?.latestDuration?.open_duration_seconds
        );
        if (Number.isFinite(lastCompletedDuration)) {
            duration = lastCompletedDuration;
        }
    }

    setText(
        "window-duration",
        Number.isFinite(duration) ? (duration / 60).toFixed(1) : "--"
    );
    updateWindowDurationLabels(isOpen);

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

function updateWindowChart(rows, historyHours) {
    const labels = rows.map((row) =>
        formatChartTime(row.recorded_at, historyHours)
    );
    lineChart("windowState", "window-state-chart", labels, [{
        label: "Window",
        data: rows.map((row) => row.window_state === "OPEN" ? 1 : 0),
        borderColor: "#0891b2",
        backgroundColor: "#0891b222",
        spanGaps: true
    }], "0 = Closed · 1 = Open", true);
    setText(
        "window-history-summary",
        `${rows.length.toLocaleString()} transition events`
    );
}

const SURVEY_COLUMNS = [
    "id",
    "survey_type",
    "survey_slot",
    "status",
    "scheduled_for",
    "created_at",
    "expires_at",
    "access_token"
].join(",");

async function fetchActiveSurveys() {
    const now = new Date().toISOString();
    const { data, error } = await client
        .from(CONFIG.SURVEY_EVENT_TABLE)
        .select(SURVEY_COLUMNS)
        .in("status", ["PENDING", "CLAIMED"])
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order("scheduled_for", { ascending: true, nullsFirst: false })
        .limit(100);
    if (error) throw error;
    return data || [];
}

function surveyTypeLabel(row) {
    return row.survey_type === "WINDOW_OPEN" ? "EMA Window Survey" : "Daily Survey";
}

function surveySlotLabel(slot) {
    const labels = {
        morning: "Morning · 09:00",
        afternoon: "Afternoon · 14:00",
        evening: "Evening · 20:00"
    };
    return labels[slot] || "";
}

function surveyUrl(row) {
    const baseUrl = CONFIG.SURVEY_SITE_URL.replace(/\/+$/, "");
    const pageUrl = row.survey_type === "WINDOW_OPEN"
        ? `${baseUrl}/`
        : `${baseUrl}/daily.html`;
    const query = new URLSearchParams({
        event: row.id,
        token: row.access_token
    });
    return `${pageUrl}?${query.toString()}`;
}

function updateActiveSurveys(rows) {
    const container = byId("survey-list");
    if (!container) return;
    container.replaceChildren();

    if (!rows.length) {
        const empty = document.createElement("article");
        empty.className = "survey-empty-card";
        const message = document.createElement("p");
        message.textContent = "No pending surveys are available.";
        empty.append(message);
        container.append(empty);
        setText("survey-summary", "All surveys are completed or no survey is currently due.");
        return;
    }

    for (const row of rows) {
        const card = document.createElement("article");
        card.className = "survey-card";

        const badge = document.createElement("span");
        badge.className = "survey-badge";
        badge.textContent = row.survey_type === "WINDOW_OPEN" ? "EMA" : "DAILY";

        const title = document.createElement("h3");
        title.textContent = surveyTypeLabel(row);

        const time = document.createElement("p");
        time.textContent = `Scheduled: ${formatDateTime(row.scheduled_for || row.created_at)}`;

        const slot = document.createElement("p");
        slot.textContent = surveySlotLabel(row.survey_slot);
        slot.classList.toggle("hidden", !slot.textContent);

        const link = document.createElement("a");
        link.className = "survey-link";
        link.href = surveyUrl(row);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Open survey";

        card.append(badge, title, time, slot, link);
        container.append(card);
    }
    setText("survey-summary", `${rows.length} pending survey${rows.length === 1 ? "" : "s"}`);
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
            latestEnergy,
            energyHistory,
            windowSummary,
            windowHistory,
            activeSurveys
        ] = await Promise.all([
            fetchLatestReading(),
            fetchHistory(hours),
            fetchLatestEnergy(),
            fetchEnergyHistory(hours),
            fetchWindowSummary(),
            fetchWindowHistory(hours),
            fetchActiveSurveys()
        ]);
        updateLatest(latest);
        updateCharts(history, hours);
        updateLatestEnergy(latestEnergy);
        updateEnergyCharts(energyHistory, hours);
        await updateWindowSummary(windowSummary);
        updateWindowChart(windowHistory, hours);
        updateActiveSurveys(activeSurveys);
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
    const environmentChannel = client
        .channel("environment-dashboard")
        .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: CONFIG.ENVIRONMENT_TABLE,
            filter: CONFIG.ENVIRONMENT_DEVICE_ID
                ? `device_id=eq.${CONFIG.ENVIRONMENT_DEVICE_ID}`
                : undefined
        }, () => refreshDashboard())
        .subscribe();
    const energyChannel = client
        .channel("energy-dashboard")
        .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: CONFIG.ENERGY_TABLE,
            filter: CONFIG.ENERGY_DEVICE_ID
                ? `device_id=eq.${CONFIG.ENERGY_DEVICE_ID}`
                : undefined
        }, () => refreshDashboard())
        .subscribe();
    const windowChannel = client
        .channel("window-dashboard")
        .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: CONFIG.WINDOW_TABLE,
            filter: CONFIG.WINDOW_DEVICE_ID
                ? `device_id=eq.${CONFIG.WINDOW_DEVICE_ID}`
                : undefined
        }, () => refreshDashboard())
        .subscribe();
    const surveyChannel = client
        .channel("survey-dashboard")
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: CONFIG.SURVEY_EVENT_TABLE
        }, () => refreshDashboard())
        .subscribe();
    realtimeChannels = [
        environmentChannel,
        energyChannel,
        windowChannel,
        surveyChannel
    ];
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
