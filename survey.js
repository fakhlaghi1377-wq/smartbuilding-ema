const DASHBOARD_ENDPOINT = "/api/dashboard/latest";
const ENVIRONMENT_HISTORY_ENDPOINT =
    "/api/dashboard/environment-history?limit=100";
const ENERGY_HISTORY_ENDPOINT =
    "/api/dashboard/energy-history?limit=100";
const WINDOW_HISTORY_ENDPOINT =
    "/api/dashboard/window-history?limit=100";
const OUTDOOR_LATEST_ENDPOINT = "/api/outdoor-weather/latest";
const EMA_HISTORY_ENDPOINT = "/api/dashboard/ema-history?limit=100";
const OUTDOOR_HISTORY_ENDPOINT =
    "/api/outdoor-weather/history?limit=100";

const REFRESH_INTERVAL_MS = 10000;

let co2Chart = null;
let temperatureChart = null;
let humidityChart = null;
let illuminanceChart = null;
let occupancyChart = null;
let windowChart = null;
let currentChart = null;
let powerChart = null;
let energyChart = null;
let outdoorTemperatureChart = null;
let outdoorHumidityChart = null;
let outdoorWindSpeedChart = null;
let outdoorWindDirectionChart = null;
let outdoorAqiChart = null;
let outdoorPmChart = null;

function setText(elementId, value) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = value;
    }
}

function formatNumber(value, digits = 1) {
    if (
        value === null ||
        value === undefined ||
        Number.isNaN(Number(value))
    ) {
        return "--";
    }

    return Number(value).toFixed(digits);
}

function formatDateTime(value) {
    if (!value) {
        return "No timestamp available";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function formatChartTime(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function formatDuration(value) {
    if (
        value === null ||
        value === undefined ||
        Number.isNaN(Number(value))
    ) {
        return "--";
    }

    let seconds = Math.max(0, Math.floor(Number(value)));
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;

    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;

    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    const parts = [];

    if (days) {
        parts.push(`${days} d`);
    }

    if (hours) {
        parts.push(`${hours} h`);
    }

    if (minutes) {
        parts.push(`${minutes} min`);
    }

    parts.push(`${seconds} sec`);
    return parts.join(" ");
}

function updateConnectionStatus(isOnline) {
    const dot = document.getElementById("connection-dot");
    const text = document.getElementById("connection-text");

    if (!dot || !text) {
        return;
    }

    if (isOnline) {
        dot.className = "status-dot online";
        text.textContent = "Server connected";
    } else {
        dot.className = "status-dot offline";
        text.textContent = "Server disconnected";
    }
}

function updateCo2Status(co2Value) {
    const statusElement = document.getElementById("co2-status");

    if (!statusElement) {
        return;
    }

    if (
        co2Value === null ||
        co2Value === undefined ||
        Number.isNaN(Number(co2Value))
    ) {
        statusElement.textContent = "No data";
        statusElement.style.color = "#64748b";
        return;
    }

    const value = Number(co2Value);

    if (value < 800) {
        statusElement.textContent = "Good indoor air quality";
        statusElement.style.color = "#166534";
    } else if (value < 1000) {
        statusElement.textContent = "Moderate CO₂ concentration";
        statusElement.style.color = "#92400e";
    } else {
        statusElement.textContent = "Elevated CO₂ concentration";
        statusElement.style.color = "#991b1b";
    }
}

function resetEnvironment() {
    setText("co2-value", "--");
    setText("sht31-temperature", "--");
    setText("sht31-humidity", "--");
    setText("scd40-temperature", "--");
    setText("scd40-humidity", "--");
    setText("illuminance-value", "--");
    setText("environment-device", "--");
    setText("environment-time", "No environmental data available");

    const motionBadge = document.getElementById("motion-badge");
    if (motionBadge) {
        motionBadge.textContent = "Unknown";
        motionBadge.className = "large-badge neutral";
    }

    updateCo2Status(null);
}

function updateEnvironment(environment) {
    if (!environment) {
        resetEnvironment();
        return;
    }

    setText("co2-value", formatNumber(environment.co2_ppm, 0));
    setText(
        "sht31-temperature",
        formatNumber(environment.sht31_temperature_c, 1)
    );
    setText(
        "sht31-humidity",
        formatNumber(environment.sht31_humidity_rh, 1)
    );
    setText(
        "scd40-temperature",
        formatNumber(environment.scd40_temperature_c, 1)
    );
    setText(
        "scd40-humidity",
        formatNumber(environment.scd40_humidity_rh, 1)
    );
    setText(
        "illuminance-value",
        formatNumber(environment.illuminance_lux, 0)
    );
    setText("environment-device", environment.device_id || "--");
    setText(
        "environment-time",
        `Last environmental reading: ${formatDateTime(
            environment.recorded_at
        )}`
    );

    updateCo2Status(environment.co2_ppm);

    const motionBadge = document.getElementById("motion-badge");

    if (!motionBadge) {
        return;
    }

    if (environment.motion_detected === true) {
        motionBadge.textContent = "Motion detected";
        motionBadge.className = "large-badge success";
    } else if (environment.motion_detected === false) {
        motionBadge.textContent = "No motion";
        motionBadge.className = "large-badge neutral";
    } else {
        motionBadge.textContent = "Unknown";
        motionBadge.className = "large-badge neutral";
    }
}


function windDirectionToCardinal(value) {
    const degrees = Number(value);

    if (!Number.isFinite(degrees)) {
        return "Direction unavailable";
    }

    const normalized = ((degrees % 360) + 360) % 360;
    const directions = [
        "N", "NE", "E", "SE",
        "S", "SW", "W", "NW",
    ];
    const index = Math.round(normalized / 45) % 8;

    return directions[index];
}

function updateOutdoorAqiStatus(aqiValue) {
    const statusElement =
        document.getElementById("outdoor-aqi-status");

    if (!statusElement) {
        return;
    }

    const labels = {
        1: ["Good", "#166534"],
        2: ["Fair", "#3f6212"],
        3: ["Moderate", "#92400e"],
        4: ["Poor", "#9a3412"],
        5: ["Very poor", "#991b1b"],
    };

    const aqi = Number(aqiValue);

    if (!Number.isFinite(aqi) || !labels[aqi]) {
        statusElement.textContent = "No data";
        statusElement.style.color = "#64748b";
        return;
    }

    statusElement.textContent = labels[aqi][0];
    statusElement.style.color = labels[aqi][1];
}

function resetOutdoorWeather() {
    setText("outdoor-temperature", "--");
    setText("outdoor-humidity", "--");
    setText("outdoor-wind-speed", "--");
    setText("outdoor-wind-direction", "--");
    setText("outdoor-wind-cardinal", "Direction unavailable");
    setText("outdoor-aqi", "--");
    setText("outdoor-pm25", "--");
    setText("outdoor-pm10", "--");
    setText("outdoor-description", "--");
    setText("outdoor-time", "No outdoor data available");
    updateOutdoorAqiStatus(null);
}

function updateOutdoorWeather(weather) {
    if (!weather) {
        resetOutdoorWeather();
        return;
    }

    setText(
        "outdoor-temperature",
        formatNumber(weather.temperature_c, 1)
    );
    setText(
        "outdoor-humidity",
        formatNumber(weather.humidity_percent, 0)
    );
    setText(
        "outdoor-wind-speed",
        formatNumber(weather.wind_speed_mps, 1)
    );
    setText(
        "outdoor-wind-direction",
        formatNumber(weather.wind_direction_deg, 0)
    );
    setText(
        "outdoor-wind-cardinal",
        windDirectionToCardinal(weather.wind_direction_deg)
    );
    setText("outdoor-aqi", formatNumber(weather.aqi, 0));
    setText(
        "outdoor-pm25",
        formatNumber(weather.pm25_ug_m3, 1)
    );
    setText(
        "outdoor-pm10",
        formatNumber(weather.pm10_ug_m3, 1)
    );
    setText(
        "outdoor-description",
        weather.weather_description || "--"
    );
    setText(
        "outdoor-time",
        `Last outdoor reading: ${formatDateTime(
            weather.recorded_at
        )}`
    );

    updateOutdoorAqiStatus(weather.aqi);
}

function resetWindow() {
    const badge = document.getElementById("window-state");

    if (badge) {
        badge.textContent = "Unknown";
        badge.className = "large-badge neutral";
    }

    setText("window-device", "--");
    setText("battery-voltage", "--");
    setText("window-duration", "--");
    setText("window-event-type", "--");
    setText("window-image-count", "--");
    setText("window-time", "No window data available");

    const imageElement = document.getElementById("window-image");
    const noImageMessage = document.getElementById("no-image-message");

    if (imageElement) {
        imageElement.hidden = true;
        imageElement.removeAttribute("src");
    }

    if (noImageMessage) {
        noImageMessage.hidden = false;
    }
}

function updateWindow(windowData) {
    if (!windowData) {
        resetWindow();
        return;
    }

    const windowBadge = document.getElementById("window-state");

    if (windowBadge) {
        if (windowData.window_state === "OPEN") {
            windowBadge.textContent = "OPEN";
            windowBadge.className = "large-badge warning";
        } else if (windowData.window_state === "CLOSED") {
            windowBadge.textContent = "CLOSED";
            windowBadge.className = "large-badge success";
        } else {
            windowBadge.textContent = "Unknown";
            windowBadge.className = "large-badge neutral";
        }
    }

    setText("window-device", windowData.device_id || "--");
    setText(
        "battery-voltage",
        formatNumber(windowData.battery_voltage, 2)
    );
    setText(
        "window-event-type",
        windowData.is_transition === true
            ? "Transition"
            : windowData.is_transition === false
                ? "Periodic"
                : "--"
    );
    setText(
        "window-duration",
        formatDuration(windowData.open_duration_seconds)
    );
    setText(
        "window-image-count",
        windowData.image_count ?? "--"
    );
    setText(
        "window-time",
        `Last window event: ${formatDateTime(windowData.recorded_at)}`
    );

    const imageElement = document.getElementById("window-image");
    const noImageMessage = document.getElementById("no-image-message");

    if (!imageElement || !noImageMessage) {
        return;
    }

    if (windowData.image_path) {
        const imageVersion =
            windowData.image_recorded_at || windowData.recorded_at || "";
        imageElement.src =
            `${windowData.image_path}?v=${encodeURIComponent(imageVersion)}`;
        imageElement.title = windowData.image_recorded_at
            ? `Captured: ${formatDateTime(windowData.image_recorded_at)}`
            : "Latest window image";
        imageElement.hidden = false;
        noImageMessage.hidden = true;
    } else {
        imageElement.hidden = true;
        imageElement.removeAttribute("src");
        imageElement.removeAttribute("title");
        noImageMessage.hidden = false;
    }
}

function updateAlert(alertData) {
    const alertBadge = document.getElementById("alert-badge");
    const alertMessage = document.getElementById("alert-message");

    if (!alertBadge || !alertMessage) {
        return;
    }

    if (!alertData) {
        alertBadge.textContent = "No Alert";
        alertBadge.className = "alert-badge normal";
        alertMessage.textContent = "System is operating normally.";
        alertMessage.className =
            "sensor-label alert-message-normal";
        return;
    }

    alertBadge.textContent =
        alertData.alert_type || "System Alert";
    alertBadge.className = "alert-badge critical";
    alertMessage.textContent =
        alertData.message || "A system alert has been recorded.";
    alertMessage.className =
        "sensor-label alert-message-critical";
}

function resetEnergy() {
    setText("energy-current", "--");
    setText("energy-real-power", "--");
    setText("energy-apparent-power", "--");
    setText("energy-interval-wh", "--");
    setText("energy-total-kwh", "--");
    setText("energy-device", "--");
    setText("energy-record-id", "--");
    setText("energy-sample-count", "--");
    setText("energy-time", "No energy data available");
}

function updateEnergy(energy) {
    if (!energy) {
        resetEnergy();
        return;
    }

    setText("energy-current", formatNumber(energy.current_a, 3));
    setText(
        "energy-real-power",
        formatNumber(energy.real_power_w, 1)
    );
    setText(
        "energy-apparent-power",
        formatNumber(energy.apparent_power_va, 1)
    );
    setText(
        "energy-interval-wh",
        formatNumber(energy.interval_energy_wh, 4)
    );
    setText(
        "energy-total-kwh",
        formatNumber(energy.total_energy_kwh, 6)
    );
    setText("energy-device", energy.device_id || "--");
    setText("energy-record-id", energy.record_id || "--");
    setText("energy-sample-count", energy.sample_count ?? "--");
    setText(
        "energy-time",
        `Last energy reading: ${formatDateTime(energy.recorded_at)}`
    );
}

function createLineChart(canvasId, labels, datasets, yAxisTitle) {
    const canvas = document.getElementById(canvasId);

    if (!canvas || typeof Chart === "undefined") {
        return null;
    }

    return new Chart(canvas, {
        type: "line",
        data: {
            labels,
            datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: "index",
                intersect: false,
            },
            elements: {
                point: {
                    radius: 2,
                },
                line: {
                    tension: 0.2,
                },
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                },
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: "Time",
                    },
                },
                y: {
                    title: {
                        display: true,
                        text: yAxisTitle,
                    },
                },
            },
        },
    });
}


function createBinaryStateChart(
    canvasId,
    labels,
    values,
    datasetLabel,
    zeroLabel,
    oneLabel
) {
    const canvas = document.getElementById(canvasId);

    if (!canvas || typeof Chart === "undefined") {
        return null;
    }

    return new Chart(canvas, {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: datasetLabel,
                data: values,
                stepped: true,
                borderWidth: 2,
                fill: true,
                spanGaps: true,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: "index",
                intersect: false,
            },
            elements: {
                point: {
                    radius: 2,
                },
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                },
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: "Time",
                    },
                },
                y: {
                    min: -0.1,
                    max: 1.1,
                    title: {
                        display: true,
                        text: "Binary State",
                    },
                    ticks: {
                        stepSize: 1,
                        callback: (value) => {
                            if (value === 1) {
                                return `1 - ${oneLabel}`;
                            }

                            if (value === 0) {
                                return `0 - ${zeroLabel}`;
                            }

                            return "";
                        },
                    },
                },
            },
        },
    });
}

function createOccupancyChart(canvasId, labels, values) {
    return createBinaryStateChart(
        canvasId,
        labels,
        values,
        "PIR Occupancy",
        "No motion",
        "Motion"
    );
}

function createWindowChart(canvasId, labels, values) {
    return createBinaryStateChart(
        canvasId,
        labels,
        values,
        "Window State",
        "Closed",
        "Open"
    );
}

function destroyChart(chart) {
    if (chart) {
        chart.destroy();
    }
}

function updateEnvironmentCharts(history) {
    if (!Array.isArray(history)) {
        return;
    }

    const ordered = [...history].reverse();
    const labels = ordered.map((item) =>
        formatChartTime(item.recorded_at)
    );

    destroyChart(co2Chart);
    destroyChart(temperatureChart);
    destroyChart(humidityChart);
    destroyChart(illuminanceChart);
    destroyChart(occupancyChart);

    co2Chart = createLineChart(
        "co2-chart",
        labels,
        [{
            label: "CO₂",
            data: ordered.map((item) => item.co2_ppm),
            borderWidth: 2,
            fill: false,
        }],
        "ppm"
    );

    temperatureChart = createLineChart(
        "temperature-chart",
        labels,
        [
            {
                label: "SHT31",
                data: ordered.map(
                    (item) => item.sht31_temperature_c
                ),
                borderWidth: 2,
                fill: false,
            },
            {
                label: "SCD40",
                data: ordered.map(
                    (item) => item.scd40_temperature_c
                ),
                borderWidth: 2,
                fill: false,
            },
        ],
        "°C"
    );

    humidityChart = createLineChart(
        "humidity-chart",
        labels,
        [
            {
                label: "SHT31",
                data: ordered.map(
                    (item) => item.sht31_humidity_rh
                ),
                borderWidth: 2,
                fill: false,
            },
            {
                label: "SCD40",
                data: ordered.map(
                    (item) => item.scd40_humidity_rh
                ),
                borderWidth: 2,
                fill: false,
            },
        ],
        "%RH"
    );

    illuminanceChart = createLineChart(
        "illuminance-chart",
        labels,
        [{
            label: "Illuminance",
            data: ordered.map(
                (item) => item.illuminance_lux
            ),
            borderWidth: 2,
            fill: false,
        }],
        "Lux"
    );

    occupancyChart = createOccupancyChart(
        "occupancy-chart",
        labels,
        ordered.map(item =>
            item.motion_detected === true ? 1 :
            item.motion_detected === false ? 0 : null
        )
    );
}

function updateWindowChart(history) {
    if (!Array.isArray(history)) {
        return;
    }

    const ordered = [...history].reverse();
    const labels = ordered.map((item) =>
        formatChartTime(item.recorded_at)
    );

    destroyChart(windowChart);

    windowChart = createWindowChart(
        "window-chart",
        labels,
        ordered.map((item) => {
            if (item.window_state === "OPEN") {
                return 1;
            }

            if (item.window_state === "CLOSED") {
                return 0;
            }

            return null;
        })
    );
}

function updateEnergyCharts(history) {
    if (!Array.isArray(history)) {
        return;
    }

    const ordered = [...history].reverse();
    const labels = ordered.map((item) =>
        formatChartTime(item.recorded_at)
    );

    const cumulativeEnergyValues = ordered.map((item) => {
        const totalEnergyKwh = Number(item.total_energy_kwh);
        return Number.isFinite(totalEnergyKwh)
            ? totalEnergyKwh
            : null;
    });

    destroyChart(powerChart);
    destroyChart(energyChart);

    powerChart = createLineChart(
        "power-chart",
        labels,
        [{
            label: "Real Power",
            data: ordered.map((item) => item.real_power_w),
            borderWidth: 2,
            fill: false,
        }],
        "W"
    );

    energyChart = createLineChart(
        "energy-chart",
        labels,
        [{
            label: "Cumulative Energy",
            data: cumulativeEnergyValues,
            borderWidth: 2,
            fill: true,
        }],
        "kWh"
    );
}


function updateOutdoorCharts(history) {
    if (!Array.isArray(history)) {
        return;
    }

    const ordered = [...history].reverse();
    const labels = ordered.map((item) =>
        formatChartTime(item.recorded_at)
    );

    destroyChart(outdoorTemperatureChart);
    destroyChart(outdoorHumidityChart);
    destroyChart(outdoorWindSpeedChart);
    destroyChart(outdoorWindDirectionChart);
    destroyChart(outdoorAqiChart);
    destroyChart(outdoorPmChart);

    outdoorTemperatureChart = createLineChart(
        "outdoor-temperature-chart",
        labels,
        [{
            label: "Outdoor Temperature",
            data: ordered.map((item) => item.temperature_c),
            borderWidth: 2,
            fill: false,
        }],
        "°C"
    );

    outdoorHumidityChart = createLineChart(
        "outdoor-humidity-chart",
        labels,
        [{
            label: "Outdoor Humidity",
            data: ordered.map((item) => item.humidity_percent),
            borderWidth: 2,
            fill: false,
        }],
        "%RH"
    );

    outdoorWindSpeedChart = createLineChart(
        "outdoor-wind-speed-chart",
        labels,
        [{
            label: "Wind Speed",
            data: ordered.map((item) => item.wind_speed_mps),
            borderWidth: 2,
            fill: false,
        }],
        "m/s"
    );

    outdoorWindDirectionChart = createLineChart(
        "outdoor-wind-direction-chart",
        labels,
        [{
            label: "Wind Direction",
            data: ordered.map(
                (item) => item.wind_direction_deg
            ),
            borderWidth: 2,
            fill: false,
        }],
        "Degrees"
    );

    outdoorAqiChart = createLineChart(
        "outdoor-aqi-chart",
        labels,
        [{
            label: "AQI",
            data: ordered.map((item) => item.aqi),
            borderWidth: 2,
            fill: true,
        }],
        "AQI (1–5)"
    );

    outdoorPmChart = createLineChart(
        "outdoor-pm-chart",
        labels,
        [
            {
                label: "PM2.5",
                data: ordered.map(
                    (item) => item.pm25_ug_m3
                ),
                borderWidth: 2,
                fill: false,
            },
            {
                label: "PM10",
                data: ordered.map(
                    (item) => item.pm10_ug_m3
                ),
                borderWidth: 2,
                fill: false,
            },
        ],
        "µg/m³"
    );
}


function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatAnswers(answers) {
    if (!answers) return "--";
    if (typeof answers === "string") return answers;
    if (Array.isArray(answers)) return answers.join(", ");
    return Object.entries(answers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\n");
}

function updateEmaHistory(history) {
    const body = document.getElementById("ema-table-body");
    if (!body) return;
    if (!Array.isArray(history) || history.length === 0) {
        body.innerHTML = '<tr><td colspan="7">No EMA events found.</td></tr>';
        setText("ema-pending-count", "0"); setText("ema-completed-count", "0"); setText("ema-expired-count", "0");
        return;
    }
    const counts = {PENDING:0, COMPLETED:0, EXPIRED:0};
    history.forEach(item => { if (counts[item.status] !== undefined) counts[item.status] += 1; });
    setText("ema-pending-count", counts.PENDING);
    setText("ema-completed-count", counts.COMPLETED);
    setText("ema-expired-count", counts.EXPIRED);

    body.innerHTML = history.map(item => {
        const status = String(item.status || "PENDING").toUpperCase();
        const statusClass = status.toLowerCase();
        const action = item.survey_url
            ? `<a class="ema-action" href="${escapeHtml(item.survey_url)}" target="_blank" rel="noopener">Open</a>`
            : '<span class="ema-action disabled">Unavailable</span>';
        return `<tr>
            <td>${escapeHtml(formatDateTime(item.window_opened_at || item.scheduled_for))}</td>
            <td>${escapeHtml(item.device_id || "--")}</td>
            <td>${escapeHtml(item.local_window_event_id ?? "--")}</td>
            <td><span class="ema-status ${statusClass}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(item.submitted_at ? formatDateTime(item.submitted_at) : "--")}</td>
            <td><div class="ema-answers">${escapeHtml(formatAnswers(item.answers))}</div></td>
            <td>${action}</td>
        </tr>`;
    }).join("");
}

async function loadEmaHistory() {
    const history = await fetchJson(EMA_HISTORY_ENDPOINT);
    updateEmaHistory(history);
}

async function fetchJson(endpoint) {
    const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
    });

    if (!response.ok) {
        throw new Error(
            `${endpoint} returned HTTP ${response.status}`
        );
    }

    return response.json();
}

async function loadDashboardData() {
    const data = await fetchJson(DASHBOARD_ENDPOINT);

    updateEnvironment(data.environment);
    updateWindow(data.window);
    updateAlert(data.alert);
    updateEnergy(data.energy);

    setText(
        "last-refresh",
        new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
    );
}

async function loadOutdoorLatest() {
    const weather = await fetchJson(OUTDOOR_LATEST_ENDPOINT);
    updateOutdoorWeather(weather);
}

async function loadOutdoorHistory() {
    const history = await fetchJson(OUTDOOR_HISTORY_ENDPOINT);
    updateOutdoorCharts(history);
}

async function loadEnvironmentHistory() {
    const history = await fetchJson(
        ENVIRONMENT_HISTORY_ENDPOINT
    );
    updateEnvironmentCharts(history);
}

async function loadEnergyHistory() {
    const history = await fetchJson(ENERGY_HISTORY_ENDPOINT);
    updateEnergyCharts(history);
}

async function loadWindowHistory() {
    const history = await fetchJson(WINDOW_HISTORY_ENDPOINT);
    updateWindowChart(history);
}

async function refreshDashboard() {
    try {
        const results = await Promise.allSettled([
            loadDashboardData(),
            loadEnvironmentHistory(),
            loadEnergyHistory(),
            loadWindowHistory(),
            loadOutdoorLatest(),
            loadOutdoorHistory(),
            loadEmaHistory(),
        ]);

        const dashboardSucceeded =
            results[0].status === "fulfilled";

        updateConnectionStatus(dashboardSucceeded);

        results.forEach((result, index) => {
            if (result.status === "rejected") {
                const labels = [
                    "dashboard",
                    "environment history",
                    "energy history",
                    "window history",
                    "outdoor latest",
                    "outdoor history",
                    "EMA history",
                ];

                console.error(
                    `Could not load ${labels[index]}:`,
                    result.reason
                );
            }
        });
    } catch (error) {
        console.error("Dashboard refresh failed:", error);
        updateConnectionStatus(false);
    }
}

refreshDashboard();

setInterval(refreshDashboard, REFRESH_INTERVAL_MS);
