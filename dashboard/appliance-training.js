(() => {
  "use strict";

  const cloudConfig = window.SMART_BUILDING_CONFIG || {};
  const API = String(cloudConfig.APPLIANCE_TRAINING_API_URL || "").replace(/\/$/, "");
  const cloudKey = cloudConfig.SUPABASE_PUBLISHABLE_KEY || "";

  if (!API || !cloudKey) {
    throw new Error("Cloud appliance-training configuration is missing.");
  }

  function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("apikey", cloudKey);
    headers.set("Authorization", `Bearer ${cloudKey}`);
    return window.fetch(url, { ...options, headers });
  }
  const applianceLabels = {
    FRIDGE: "یخچال",
    MAIN_ROOM_LIGHT: "چراغ اتاق اصلی",
    PORTABLE_AC: "کولر پرتابل",
    DUCTED_AC: "کولر کانالی",
    UNKNOWN_LOAD: "بار دیگر / نامشخص",
  };
  const actionLabels = {
    ON: "روشن شد",
    OFF: "خاموش شد",
    INCREASE: "مصرف افزایش یافت",
    DECREASE: "مصرف کاهش یافت",
  };
  const sessionPhaseLabels = {
    STARTUP: "شروع چرخه",
    STEP_INCREASE: "ادامه افزایش",
    STEP_DECREASE: "ادامه کاهش",
    SHUTDOWN: "پایان چرخه",
    STANDALONE: "رویداد مستقل",
  };

  const modeLabels = {
    DAY: "روز",
    NIGHT: "شب",
    SLEEP: "خواب",
    WAKE: "بیداری",
  };
  const commonUnknownAppliances = [
    "Laptop Charger", "Laptop Fan", "Phone Charger", "Monitor", "TV",
    "Printer", "Fan", "Vacuum Cleaner", "Microwave", "Air Fryer",
    "Coffee Maker", "Tea Maker", "Tea Maker Kettle", "Corridor Light",
    "W.C Light", "Bedroom Light", "Refrigerator Water Dispenser",
  ];

  const state = {
    todayEvents: [],
    pendingEvents: [],
    unansweredEvents: [],
    current: null,
    currentSource: "today",
    busy: false,
    soundEnabled: localStorage.getItem("applianceEventSoundEnabled") === "true",
    audioContext: null,
    pollTimer: null,
    newestSeenEventId: null,
    initialEventsLoaded: false,
    pendingUnknownAction: null,
    editingLabel: null,
    historyLoaded: false,
    pendingLoaded: false,
    unansweredLoaded: false,
    openSessions: [],
    cycleVisualSessions: [],
    activeDatasetVersion: null,
    datasetVersions: [],
    allocationRowCounter: 0,
    historyLabels: [],
    editingCombinedEventId: null,
  };

  const $ = (id) => document.getElementById(id);

  function number(value, digits = 3, unit = "") {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return `${Number(value).toFixed(digits)}${unit}`;
  }

  function parseEventDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(value) {
    const date = parseEventDate(value);
    if (!date) return value ? String(value) : "—";
    return new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "medium", timeStyle: "medium",
    }).format(date);
  }

  function formatEventDate(value) {
    const date = parseEventDate(value);
    if (!date) return "—";
    return new Intl.DateTimeFormat("fa-IR", {
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  }

  function formatEventClock(value) {
    const date = parseEventDate(value);
    if (!date) return "—";
    return new Intl.DateTimeFormat("fa-IR", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date);
  }

  function modeText(value) {
    const normalized = String(value || "").toUpperCase();
    return modeLabels[normalized] || value || "نامشخص";
  }

  function modeClass(value) {
    const normalized = String(value || "UNKNOWN").toLowerCase();
    return `mode-${normalized.replace(/[^a-z0-9_-]/g, "")}`;
  }

  function firstPresent(...values) {
    return values.find((value) =>
      value !== null && value !== undefined && String(value).trim() !== ""
    ) ?? null;
  }

  // Compatibility layer for the currently deployed Edge Function.  It keeps
  // all writes unchanged and only translates legacy/cloud response names into
  // the names used by this dashboard.
  function normalizeEvent(event = {}) {
    const evidence = event.evidence && typeof event.evidence === "object"
      ? event.evidence
      : {};
    return {
      ...event,
      day_night_mode: firstPresent(
        event.day_night_mode,
        event.final_operating_mode,
        event.operating_mode,
        event.solar_mode,
        event.ac_status,
        evidence.final_operating_mode,
        evidence.day_night_mode,
        evidence.operating_mode,
        evidence.solar_mode,
        evidence.ac_status,
      ),
      operation_session_id: firstPresent(
        event.cloud_operation_session_id,
        event.operation_session_id,
        evidence.operation_session_id,
      ),
      session_phase: firstPresent(
        event.cloud_session_phase,
        event.operation_session_phase,
        event.session_phase === "STANDALONE" && firstPresent(
          event.cloud_operation_session_id,
          event.operation_session_id,
          evidence.operation_session_id,
        ) ? null : event.session_phase,
        evidence.operation_session_phase,
      ),
      session_event_index: firstPresent(
        event.cloud_session_event_index,
        event.operation_session_event_index,
        event.session_event_index,
        evidence.operation_session_event_index,
      ),
      session_net_delta_a: firstPresent(
        event.cloud_session_net_delta_a,
        event.operation_session_net_delta_a,
        event.session_net_delta_a,
        evidence.operation_session_net_delta_a,
      ),
      selected_session_mode: firstPresent(
        event.selected_session_mode,
        event.session_mode,
        evidence.selected_session_mode,
        evidence.session_mode,
      ),
    };
  }

  function normalizeEvents(events) {
    return (events || []).map(normalizeEvent);
  }

  function numericValue(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function normalizeSession(session = {}) {
    let previousCumulative = 0;
    const events = normalizeEvents(session.events || []).map((event) => {
      const suppliedCumulative = numericValue(
        event.cumulative_delta_a,
        event.session_net_delta_a,
        event.cloud_session_net_delta_a,
        event.operation_session_net_delta_a,
      );
      let delta = numericValue(
        event.allocated_current_delta_a,
        event.allocated_delta_a,
        event.signed_delta_a,
        event.current_delta_a,
        event.event_delta_a,
        event.delta_a,
      );
      const derivedDelta = suppliedCumulative === null
        ? null
        : suppliedCumulative - previousCumulative;
      if (
        delta === null ||
        (delta === 0 && derivedDelta !== null && Math.abs(derivedDelta) > 1e-9)
      ) {
        delta = derivedDelta;
      }
      delta = delta ?? 0;
      const cumulative = suppliedCumulative ?? (previousCumulative + delta);
      previousCumulative = cumulative;
      return {
        ...event,
        current_delta_a: delta,
        cumulative_delta_a: cumulative,
      };
    });

    const lastEvent = events[events.length - 1] || {};
    const lastPhase = String(firstPresent(
      lastEvent.session_phase,
      session.last_session_phase,
      session.session_phase,
    ) || "").toUpperCase();
    const explicitlyClosed = ["SHUTDOWN", "END", "CLOSE", "CLOSED"]
      .includes(lastPhase);
    const explicitlyOpen = session.is_open === true ||
      String(session.status || "").toUpperCase() === "OPEN";
    const isOpen = explicitlyClosed ? false : explicitlyOpen;

    const cumulative = events.length
      ? events[events.length - 1].cumulative_delta_a
      : numericValue(session.cumulative_delta_a, session.net_delta_a) ?? 0;
    return {
      ...session,
      id: firstPresent(session.id, session.operation_session_id),
      status: isOpen ? "OPEN" : "CLOSED",
      is_open: isOpen,
      event_count: numericValue(session.event_count, events.length) ?? events.length,
      cumulative_delta_a: cumulative,
      net_delta_a: cumulative,
      net_return_error_a: numericValue(
        session.net_return_error_a,
        Math.abs(cumulative),
      ),
      positive_delta_a: numericValue(
        session.positive_delta_a,
        events.reduce((sum, event) =>
          sum + Math.max(0, event.current_delta_a), 0),
      ),
      negative_delta_a: numericValue(
        session.negative_delta_a,
        events.reduce((sum, event) =>
          sum + Math.min(0, event.current_delta_a), 0),
      ),
      events,
    };
  }

  function normalizeSessions(sessions, openOnly = false) {
    const unique = new Map();
    (sessions || []).map(normalizeSession).forEach((session) => {
      if (session.id == null) return;
      unique.set(String(session.id), session);
    });
    return [...unique.values()].filter((session) =>
      !openOnly || session.is_open
    );
  }

  function labelFor(appliance, action) {
    return `${applianceLabels[appliance] || appliance} — ${actionLabels[action] || action}`;
  }

  function suggestedAction(event, appliance) {
    if (appliance === "MAIN_ROOM_LIGHT" || appliance === "UNKNOWN_LOAD") {
      return Number(event.current_delta_a) >= 0 ? "INCREASE" : "DECREASE";
    }
    return Number(event.current_delta_a) >= 0 ? "ON" : "OFF";
  }

  function setMessage(text, kind = "") {
    const el = $("message");
    el.textContent = text || "";
    el.className = `message ${kind}`.trim();
  }

  function setHistoryMessage(text, kind = "") {
    const el = $("history-message");
    el.textContent = text || "";
    el.className = `message ${kind}`.trim();
  }

  function renderSummary(summary) {
    const totalLabeled = Number(summary.total_labeled ?? 0);
    const pendingCount = Number(summary.pending_review ?? 0);
    const unresolvedCount = Number(summary.unresolved_review ?? 0);
    const totalEvents = Number(summary.total_detection_events ?? 0);
    const correctCount = Number(
      summary.original_predictions_correct ?? 0
    );
    const correctedCount = Number(
      summary.original_predictions_corrected ?? 0
    );
    const accuracyValue =
      summary.original_accuracy_percent == null
        ? "—"
        : `${summary.original_accuracy_percent}%`;

    $("total-labeled").textContent = totalLabeled;
    $("correct-count").textContent = correctCount;
    $("corrected-count").textContent = correctedCount;
    $("accuracy").textContent = accuracyValue;

    $("pending-count-badge").textContent = pendingCount;
    $("pending-summary-count").textContent = pendingCount;
    $("unresolved-summary-count").textContent = unresolvedCount;
    $("total-events-count").textContent = totalEvents;
  }

  async function loadSummary() {
    const response = await apiFetch(`${API}/summary`, { cache: "no-store" });
    if (response.ok) renderSummary(await response.json());
  }

  function setDatasetMessage(text, kind = "") {
    const element = $("dataset-message");
    element.textContent = text || "";
    element.className = `message ${kind}`.trim();
  }

  function renderDatasetVersions(payload) {
    const activeVersion = Number(payload.active_dataset_version || 1);
    const versions = payload.versions || [];

    state.activeDatasetVersion = activeVersion;
    state.datasetVersions = versions;

    $("active-dataset-version").textContent =
      `v${activeVersion.toLocaleString("fa-IR")}`;

    const activeLabels = versions
      .filter(
        (item) =>
          Number(item.dataset_version) === activeVersion
          && item.dataset_status === "ACTIVE"
      )
      .reduce(
        (sum, item) => sum + Number(item.label_count || 0),
        0,
      );

    const archivedVersions = new Set(
      versions
        .filter((item) => item.dataset_status === "ARCHIVED")
        .map((item) => Number(item.dataset_version))
    );

    $("active-dataset-label-count").textContent =
      activeLabels.toLocaleString("fa-IR");
    $("archived-dataset-count").textContent =
      archivedVersions.size.toLocaleString("fa-IR");

    const select = $("dataset-version-select");
    const activateButton = $("activate-dataset-button");
    const uniqueVersions = [...new Set(
      versions.map((item) => Number(item.dataset_version))
    )].sort((a, b) => b - a);

    select.replaceChildren();
    uniqueVersions.forEach((version) => {
      const option = document.createElement("option");
      option.value = String(version);
      option.textContent =
        `Dataset v${version.toLocaleString("fa-IR")}` +
        (version === activeVersion ? " — فعال" : " — آرشیوشده");
      select.appendChild(option);
    });

    if (uniqueVersions.length) {
      select.value = String(activeVersion);
      activateButton.disabled = true;
    } else {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "نسخه‌ای وجود ندارد";
      select.appendChild(option);
      activateButton.disabled = true;
    }

    const list = $("dataset-version-list");
    list.replaceChildren();

    const grouped = new Map();
    versions.forEach((item) => {
      const version = Number(item.dataset_version);
      const existing = grouped.get(version) || {
        version,
        active: 0,
        archived: 0,
      };
      if (item.dataset_status === "ACTIVE") {
        existing.active += Number(item.label_count || 0);
      } else {
        existing.archived += Number(item.label_count || 0);
      }
      grouped.set(version, existing);
    });

    [...grouped.values()]
      .sort((a, b) => b.version - a.version)
      .forEach((item) => {
        const row = document.createElement("div");
        row.className = item.version === activeVersion
          ? "dataset-version-item is-active"
          : "dataset-version-item";
        row.innerHTML = `
          <strong>Dataset v${item.version.toLocaleString("fa-IR")}</strong>
          <span>
            ${item.version === activeVersion ? "فعال" : "آرشیوشده"}
          </span>
          <small>
            ${(item.active + item.archived).toLocaleString("fa-IR")}
            پاسخ ثبت‌شده
          </small>
        `;
        list.appendChild(row);
      });
  }

  async function loadDatasetVersions() {
    const response = await apiFetch(`${API}/datasets`, {
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload.detail || "دریافت نسخه دیتاست ناموفق بود"
      );
    }
    renderDatasetVersions(payload);
  }

  async function activateSelectedDataset() {
    const select = $("dataset-version-select");
    const button = $("activate-dataset-button");
    const selectedVersion = Number(select.value);

    if (!selectedVersion) {
      setDatasetMessage("یک نسخه دیتاست را انتخاب کن.", "error");
      return;
    }

    if (selectedVersion === state.activeDatasetVersion) {
      setDatasetMessage("این Dataset همین حالا فعال است.");
      return;
    }

    const confirmed = window.confirm(
      `Dataset v${selectedVersion} فعال شود؟\n\n` +
      "دیتاست فعال فعلی آرشیو می‌شود، اما هیچ داده‌ای حذف نخواهد شد."
    );
    if (!confirmed) return;

    button.disabled = true;
    select.disabled = true;
    setDatasetMessage(
      `در حال فعال‌کردن Dataset v${selectedVersion}…`
    );

    try {
      const response = await apiFetch(
        `${API}/datasets/${selectedVersion}/activate`,
        { method: "POST" },
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(
          payload.detail || "فعال‌کردن Dataset ناموفق بود"
        );
      }

      setDatasetMessage(
        `Dataset v${selectedVersion} فعال شد.`,
        "success",
      );

      state.current = null;
      state.currentSource = "today";

      await Promise.all([
        loadDatasetVersions(),
        loadSummary(),
        loadSampleCounts(),
        loadFridgeProfile(),
        loadOpenSessions(),
        loadCycleVisuals(),
        loadTodayEvents(),
        loadUnansweredCount(),
        $("pending-details").open
          ? loadPendingEvents()
          : Promise.resolve(),
        state.historyLoaded
          ? loadHistory()
          : Promise.resolve(),
      ]);
    } catch (error) {
      setDatasetMessage(
        error.message || "خطا در فعال‌کردن Dataset",
        "error",
      );
    } finally {
      select.disabled = false;
      button.disabled =
        Number(select.value) === state.activeDatasetVersion;
    }
  }

  async function startNewDataset() {
    const confirmed = window.confirm(
      "دیتاست فعال فعلی آرشیو شود و یک دیتاست جدید از صفر شروع شود؟\n\n" +
      "هیچ رویداد یا پاسخی حذف نخواهد شد. چرخه‌های باز فعلی نیز بسته و آرشیو می‌شوند."
    );
    if (!confirmed) return;

    const button = $("start-new-dataset-button");
    button.disabled = true;
    setDatasetMessage("در حال آرشیو دیتاست قبلی…");

    try {
      const response = await apiFetch(
        `${API}/datasets/start-new`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload.detail || "شروع دیتاست جدید ناموفق بود"
        );
      }

      setDatasetMessage(
        `Dataset v${payload.active_dataset_version} شروع شد؛ ` +
        `${Number(payload.archived_label_count || 0).toLocaleString("fa-IR")} پاسخ قبلی آرشیو شد.`,
        "success",
      );

      await Promise.all([
        loadDatasetVersions(),
        loadSummary(),
        loadSampleCounts(),
        loadFridgeProfile(),
        loadOpenSessions(),
        loadTodayEvents(),
        loadUnansweredCount(),
        state.historyLoaded ? loadHistory() : Promise.resolve(),
      ]);
    } catch (error) {
      setDatasetMessage(
        error.message || "خطا در شروع دیتاست جدید",
        "error",
      );
    } finally {
      button.disabled = false;
    }
  }

  function phaseLabel(value) {
    return sessionPhaseLabels[value] || value || "بدون مرحله";
  }

  function durationText(seconds) {
    const value = Number(seconds || 0);
    if (value < 60) {
      return `${Math.round(value).toLocaleString("fa-IR")} ثانیه`;
    }
    const minutes = Math.round(value / 60);
    if (minutes < 60) {
      return `${minutes.toLocaleString("fa-IR")} دقیقه`;
    }
    const hours = Math.floor(minutes / 60);
    const remain = minutes % 60;
    return remain
      ? `${hours.toLocaleString("fa-IR")} ساعت و ${remain.toLocaleString("fa-IR")} دقیقه`
      : `${hours.toLocaleString("fa-IR")} ساعت`;
  }

  function sessionsFromHistory(labels, limit = 200, openOnly = false) {
    const groups = new Map();
    normalizeEvents(labels).forEach((label) => {
      if (
        label.review_status !== "CONFIRMED" ||
        label.operation_session_id == null
      ) return;
      const key = String(label.operation_session_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(label);
    });

    return [...groups.entries()].map(([id, group]) => {
      group.sort((a, b) => {
        const indexDelta = Number(a.session_event_index || 0) -
          Number(b.session_event_index || 0);
        if (indexDelta) return indexDelta;
        return new Date(a.event_started_at || a.created_at || 0) -
          new Date(b.event_started_at || b.created_at || 0);
      });
      const first = group[0];
      const last = group[group.length - 1];
      let cumulative = 0;
      const events = group.map((item) => {
        const delta = Number(
          item.allocated_current_delta_a ??
          item.allocated_delta_a ??
          item.current_delta_a ?? 0
        );
        cumulative += delta;
        return {
          ...item,
          current_delta_a: delta,
          cumulative_delta_a: cumulative,
        };
      });
      const lastPhase = String(last.session_phase || "").toUpperCase();
      const closed = ["SHUTDOWN", "END", "CLOSE", "CLOSED"].includes(lastPhase);
      const startedAt = first.event_started_at || first.created_at;
      const lastAt = last.event_started_at || last.updated_at || last.created_at;
      const startDate = parseEventDate(startedAt);
      const lastDate = parseEventDate(lastAt);
      return {
        id,
        operation_session_id: id,
        appliance_type: first.appliance_type,
        custom_appliance_name: first.custom_appliance_name || null,
        status: closed ? "CLOSED" : "OPEN",
        is_open: !closed,
        started_at: startedAt,
        ended_at: closed ? lastAt : null,
        last_event_at: lastAt,
        duration_seconds: startDate && lastDate
          ? Math.max(0, (lastDate - startDate) / 1000)
          : 0,
        event_count: events.length,
        cumulative_delta_a: cumulative,
        net_delta_a: cumulative,
        net_return_error_a: Math.abs(cumulative),
        positive_delta_a: events.reduce(
          (sum, event) => sum + Math.max(0, Number(event.current_delta_a)), 0
        ),
        negative_delta_a: events.reduce(
          (sum, event) => sum + Math.min(0, Number(event.current_delta_a)), 0
        ),
        events,
      };
    }).filter((session) => !openOnly || session.is_open)
      .sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))
      .slice(0, limit);
  }

  async function historySessionsFallback(limit = 200, openOnly = false) {
    const response = await apiFetch(`${API}/history?limit=1000`, {
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "دریافت تاریخچه چرخه‌ها ناموفق بود");
    }
    return sessionsFromHistory(payload.labels || [], limit, openOnly);
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(
      "http://www.w3.org/2000/svg",
      name,
    );
    Object.entries(attributes).forEach(([key, value]) => {
      element.setAttribute(key, String(value));
    });
    return element;
  }

  function buildTimelineSvg(events) {
    const width = 760;
    const height = 170;
    const paddingX = 38;
    const baselineY = 78;
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "Timeline مراحل چرخه",
      class: "cycle-timeline-svg",
    });

    const line = svgElement("line", {
      x1: paddingX,
      y1: baselineY,
      x2: width - paddingX,
      y2: baselineY,
      class: "timeline-base-line",
    });
    svg.appendChild(line);

    const n = Math.max(events.length, 1);
    events.forEach((event, index) => {
      const x = n === 1
        ? width / 2
        : paddingX + index * ((width - paddingX * 2) / (n - 1));

      const positive = Number(event.current_delta_a || 0) >= 0;
      const group = svgElement("g", {
        class: positive
          ? "timeline-point timeline-positive"
          : "timeline-point timeline-negative",
      });

      const stem = svgElement("line", {
        x1: x,
        y1: baselineY,
        x2: x,
        y2: positive ? 38 : 120,
        class: "timeline-stem",
      });

      const circle = svgElement("circle", {
        cx: x,
        cy: baselineY,
        r: 8,
        class: "timeline-dot",
      });

      const deltaText = svgElement("text", {
        x,
        y: positive ? 28 : 142,
        "text-anchor": "middle",
        class: "timeline-delta-label",
      });
      deltaText.textContent =
        `${Number(event.current_delta_a || 0) >= 0 ? "+" : ""}` +
        `${Number(event.current_delta_a || 0).toFixed(3)} A`;

      const phaseText = svgElement("text", {
        x,
        y: positive ? 51 : 113,
        "text-anchor": "middle",
        class: "timeline-phase-label",
      });
      phaseText.textContent = phaseLabel(event.session_phase);

      group.append(stem, circle, deltaText, phaseText);
      svg.appendChild(group);
    });

    return svg;
  }

  function buildCumulativeSvg(events) {
    const width = 760;
    const height = 180;
    const padding = { left: 46, right: 24, top: 22, bottom: 34 };
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "نمودار تجمعی تغییر جریان چرخه",
      class: "cycle-cumulative-svg",
    });

    const values = [0, ...events.map(
      (event) => Number(event.cumulative_delta_a || 0)
    )];

    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const range = Math.max(maxValue - minValue, 0.1);

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const x = (index) =>
      padding.left + index * (chartWidth / Math.max(values.length - 1, 1));

    const y = (value) =>
      padding.top + (maxValue - value) * (chartHeight / range);

    const zeroLine = svgElement("line", {
      x1: padding.left,
      x2: width - padding.right,
      y1: y(0),
      y2: y(0),
      class: "cumulative-zero-line",
    });
    svg.appendChild(zeroLine);

    let pathData = "";
    values.forEach((value, index) => {
      pathData += `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)} `;
    });

    const path = svgElement("path", {
      d: pathData.trim(),
      class: "cumulative-path",
      fill: "none",
    });
    svg.appendChild(path);

    values.forEach((value, index) => {
      const dot = svgElement("circle", {
        cx: x(index),
        cy: y(value),
        r: index === 0 ? 4 : 5,
        class: "cumulative-dot",
      });
      svg.appendChild(dot);
    });

    const maxLabel = svgElement("text", {
      x: 6,
      y: y(maxValue) + 4,
      class: "cumulative-axis-label",
    });
    maxLabel.textContent = `${maxValue.toFixed(2)} A`;

    const zeroLabel = svgElement("text", {
      x: 10,
      y: y(0) + 4,
      class: "cumulative-axis-label",
    });
    zeroLabel.textContent = "0 A";

    const minLabel = svgElement("text", {
      x: 6,
      y: y(minValue) + 4,
      class: "cumulative-axis-label",
    });
    minLabel.textContent = `${minValue.toFixed(2)} A`;

    svg.append(maxLabel, zeroLabel, minLabel);
    return svg;
  }

  function buildSparklineSvg(events) {
    const width = 180;
    const height = 48;
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "نمای کوچک تغییرات جریان",
      class: "cycle-sparkline-svg",
    });

    const values = events.map(
      (event) => Number(event.current_delta_a || 0)
    );
    if (!values.length) return svg;

    const maxAbs = Math.max(
      ...values.map((value) => Math.abs(value)),
      0.1,
    );
    const midY = height / 2;
    const step = width / Math.max(values.length, 1);

    values.forEach((value, index) => {
      const barWidth = Math.max(step - 4, 3);
      const magnitude = Math.max(
        2,
        Math.abs(value) / maxAbs * (height / 2 - 5),
      );
      const rect = svgElement("rect", {
        x: index * step + 2,
        y: value >= 0 ? midY - magnitude : midY,
        width: barWidth,
        height: magnitude,
        rx: 2,
        class: value >= 0
          ? "sparkline-bar sparkline-positive"
          : "sparkline-bar sparkline-negative",
      });
      svg.appendChild(rect);
    });

    const baseline = svgElement("line", {
      x1: 0,
      x2: width,
      y1: midY,
      y2: midY,
      class: "sparkline-baseline",
    });
    svg.appendChild(baseline);
    return svg;
  }

  function renderCycleVisuals(payload) {
    const sessions = normalizeSessions(payload.sessions || []);
    state.cycleVisualSessions = sessions;

    const filter = $("cycle-visual-filter").value;
    const filtered = sessions.filter((session) => {
      if (filter === "OPEN") return session.status === "OPEN";
      if (filter === "CLOSED") return session.status === "CLOSED";
      return true;
    });

    const list = $("cycle-visual-list");
    const empty = $("cycle-visual-empty");
    list.replaceChildren();
    empty.hidden = filtered.length > 0;
    list.hidden = filtered.length === 0;

    filtered.forEach((session) => {
      const article = document.createElement("article");
      article.className =
        `cycle-visual-item ${session.status === "OPEN"
          ? "is-open"
          : "is-closed"}`;

      const header = document.createElement("div");
      header.className = "cycle-visual-header";

      const titleBlock = document.createElement("div");
      titleBlock.className = "cycle-visual-title";
      titleBlock.innerHTML = `
        <strong>${operationSessionDisplayName(session)}</strong>
        <span>چرخه ${session.id}</span>
      `;

      const statusBadge = document.createElement("span");
      statusBadge.className =
        `cycle-status-badge ${session.status === "OPEN"
          ? "cycle-status-open"
          : "cycle-status-closed"}`;
      statusBadge.textContent =
        session.status === "OPEN" ? "چرخه باز" : "چرخه بسته";

      header.append(titleBlock, statusBadge);

      const metrics = document.createElement("div");
      metrics.className = "cycle-visual-metrics";
      metrics.innerHTML = `
        <div>
          <span>مدت چرخه</span>
          <strong>${durationText(session.duration_seconds)}</strong>
        </div>
        <div>
          <span>تعداد مراحل</span>
          <strong>${Number(session.event_count || 0).toLocaleString("fa-IR")}</strong>
        </div>
        <div>
          <span>جمع نهایی جریان</span>
          <strong dir="ltr">${number(session.cumulative_delta_a, 3, " A")}</strong>
        </div>
        <div>
          <span>خطای بازگشت به صفر</span>
          <strong dir="ltr">${number(session.net_return_error_a, 3, " A")}</strong>
        </div>
      `;

      const sparklineWrap = document.createElement("div");
      sparklineWrap.className = "cycle-sparkline-wrap";
      sparklineWrap.appendChild(buildSparklineSvg(session.events || []));

      const timelineSection = document.createElement("section");
      timelineSection.className = "cycle-chart-section";
      timelineSection.innerHTML = "<h3>Timeline مراحل چرخه</h3>";
      timelineSection.appendChild(buildTimelineSvg(session.events || []));

      const cumulativeSection = document.createElement("section");
      cumulativeSection.className = "cycle-chart-section";
      cumulativeSection.innerHTML =
        "<h3>روند تجمعی تغییر جریان</h3>";
      cumulativeSection.appendChild(
        buildCumulativeSvg(session.events || [])
      );

      const eventsList = document.createElement("div");
      eventsList.className = "cycle-event-legend";
      (session.events || []).forEach((event) => {
        const item = document.createElement("div");
        item.className =
          Number(event.current_delta_a || 0) >= 0
            ? "cycle-event-chip event-positive"
            : "cycle-event-chip event-negative";
        item.innerHTML = `
          <strong>${phaseLabel(event.session_phase)}</strong>
          <span dir="ltr">
            ${Number(event.current_delta_a || 0) >= 0 ? "+" : ""}
            ${Number(event.current_delta_a || 0).toFixed(3)} A
          </span>
          <small>${formatTime(event.event_started_at)}</small>
        `;
        eventsList.appendChild(item);
      });

      article.append(
        header,
        metrics,
        sparklineWrap,
        timelineSection,
        cumulativeSection,
        eventsList,
      );
      list.appendChild(article);
    });
  }

  async function loadCycleVisuals() {
    const response = await apiFetch(
      `${API}/sessions/recent?limit=30&include_archived=false`,
      { cache: "no-store" },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload.detail || "دریافت نمودار چرخه‌ها ناموفق بود"
      );
    }
    if (!(payload.sessions || []).length) {
      payload.sessions = await historySessionsFallback(30, false);
    }
    renderCycleVisuals(payload);
  }

  function operationSessionDisplayName(session) {
    if (session.appliance_type === "UNKNOWN_LOAD") {
      return session.custom_appliance_name || "بار نامشخص بدون نام";
    }
    return applianceLabels[session.appliance_type]
      || session.appliance_type
      || "وسیله نامشخص";
  }

  function elapsedText(value) {
    const date = parseEventDate(value);
    if (!date) return "زمان نامشخص";

    const seconds = Math.max(
      0,
      Math.floor((Date.now() - date.getTime()) / 1000),
    );

    if (seconds < 60) return `${seconds.toLocaleString("fa-IR")} ثانیه قبل`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes.toLocaleString("fa-IR")} دقیقه قبل`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes
        ? `${hours.toLocaleString("fa-IR")} ساعت و ${remainingMinutes.toLocaleString("fa-IR")} دقیقه قبل`
        : `${hours.toLocaleString("fa-IR")} ساعت قبل`;
    }

    const days = Math.floor(hours / 24);
    return `${days.toLocaleString("fa-IR")} روز قبل`;
  }

  function openSessionAgeClass(session) {
    const lastEvent = parseEventDate(session.last_event_at);
    if (!lastEvent) return "open-cycle-stale";

    const ageMinutes = (Date.now() - lastEvent.getTime()) / 60000;
    if (ageMinutes >= 180) return "open-cycle-stale";
    if (ageMinutes >= 45) return "open-cycle-warning";
    return "open-cycle-recent";
  }

  function renderOpenSessions(payload) {
    const sessions = normalizeSessions(payload.sessions || [], true);
    state.openSessions = sessions;

    const list = $("open-cycles-list");
    const empty = $("open-cycles-empty");
    const status = $("open-cycles-status");
    const badge = $("open-cycles-count-badge");

    badge.textContent = sessions.length.toLocaleString("fa-IR");
    list.replaceChildren();
    empty.hidden = sessions.length > 0;
    list.hidden = sessions.length === 0;

    if (!sessions.length) {
      status.textContent =
        "اکنون هیچ وسیله‌ای چرخه باز ندارد.";
      return;
    }

    status.textContent =
      `${sessions.length.toLocaleString("fa-IR")} چرخه باز وجود دارد؛ ` +
      "پس از خاموش‌شدن واقعی هر وسیله، پایان چرخه آن را ثبت کن.";

    sessions.forEach((session) => {
      const card = document.createElement("article");
      card.className =
        `open-cycle-item ${openSessionAgeClass(session)}`;

      const title = document.createElement("div");
      title.className = "open-cycle-item-heading";

      const name = document.createElement("strong");
      name.textContent = operationSessionDisplayName(session);

      const idBadge = document.createElement("span");
      idBadge.className = "open-cycle-id";
      idBadge.textContent = `چرخه ${session.id}`;

      title.append(name, idBadge);

      const metrics = document.createElement("dl");
      metrics.className = "open-cycle-metrics";
      metrics.innerHTML = `
        <div>
          <dt>شروع چرخه</dt>
          <dd>${formatTime(session.started_at)}</dd>
        </div>
        <div>
          <dt>آخرین تغییر</dt>
          <dd>
            ${formatTime(session.last_event_at)}
            <small>${elapsedText(session.last_event_at)}</small>
          </dd>
        </div>
        <div>
          <dt>تعداد مراحل ثبت‌شده</dt>
          <dd>${Number(session.event_count || 0).toLocaleString("fa-IR")}</dd>
        </div>
        <div>
          <dt>جمع تغییر جریان چرخه</dt>
          <dd dir="ltr">${number(session.cumulative_delta_a, 3, " A")}</dd>
        </div>
        <div>
          <dt>مجموع افزایش‌ها</dt>
          <dd dir="ltr">${number(session.positive_delta_a, 3, " A")}</dd>
        </div>
        <div>
          <dt>مجموع کاهش‌ها</dt>
          <dd dir="ltr">${number(session.negative_delta_a, 3, " A")}</dd>
        </div>
      `;

      const warning = document.createElement("p");
      warning.className = "open-cycle-item-note";
      const className = openSessionAgeClass(session);
      warning.textContent = className === "open-cycle-stale"
        ? "این چرخه مدت زیادی باز مانده است؛ بررسی کن آیا پایان آن فراموش شده."
        : className === "open-cycle-warning"
          ? "این چرخه مدتی است تغییری نداشته؛ وضعیت وسیله را بررسی کن."
          : "چرخه فعال است و می‌تواند مراحل ادامه بیشتری دریافت کند.";

      card.append(title, metrics, warning);
      list.appendChild(card);
    });
  }

  async function loadOpenSessions() {
    const response = await apiFetch(`${API}/sessions/open?limit=200`, {
      cache: "no-store",
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload.detail || "دریافت چرخه‌های باز ناموفق بود"
      );
    }

    if (!(payload.sessions || []).length) {
      payload.sessions = await historySessionsFallback(200, true);
    }
    renderOpenSessions(payload);
  }

  function sampleDisplayName(item) {
    return item.appliance_type === "UNKNOWN_LOAD"
      ? (item.custom_appliance_name || "بار نامشخص بدون نام")
      : (applianceLabels[item.appliance_type] || item.appliance_type);
  }

  function sampleStatus(item, threshold) {
    if (item.ready) return { text: "آماده آموزش مدل", className: "ready" };
    const minDirection = Math.min(Number(item.on_samples || 0), Number(item.off_samples || 0));
    if (minDirection < Math.max(3, Math.ceil(threshold * 0.25))) {
      return { text: "داده کم", className: "low" };
    }
    return { text: "در حال یادگیری", className: "learning" };
  }

  function renderSampleCounts(payload) {
    const body = $("sample-count-body");
    body.replaceChildren();
    const items = payload.items || [];
    const threshold = Number(payload.ready_per_direction || 20);
    $("sample-count-readiness").textContent = items.length
      ? `${payload.ready_appliances || 0} وسیله از ${payload.total_appliances || items.length} وسیله آماده‌اند؛ معیار فعلی حداقل ${threshold} نمونه در هر جهت است.`
      : "هنوز داده آموزشی ثبت نشده است.";

    if (!items.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">هنوز داده آموزشی ثبت نشده است.</td></tr>';
      return;
    }

    items.forEach((item) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.className = "appliance-name-cell";
      nameCell.innerHTML = `<strong>${sampleDisplayName(item)}</strong>`;
      row.appendChild(nameCell);

      [item.on_samples, item.off_samples, item.total_samples].forEach((value) => {
        const cell = document.createElement("td");
        cell.className = "count-cell";
        cell.textContent = Number(value || 0).toLocaleString("fa-IR");
        row.appendChild(cell);
      });

      const statusCell = document.createElement("td");
      const status = sampleStatus(item, threshold);
      statusCell.innerHTML = `<span class="readiness-badge ${status.className}">${status.text}</span>`;
      if (!item.ready) {
        const progress = document.createElement("div");
        progress.className = "sample-progress";
        progress.textContent = `نیاز: ${Number(item.needed_on || 0).toLocaleString("fa-IR")} روشن و ${Number(item.needed_off || 0).toLocaleString("fa-IR")} خاموش دیگر`;
        statusCell.appendChild(progress);
      }
      row.appendChild(statusCell);
      body.appendChild(row);
    });
  }

  async function loadSampleCounts() {
    const response = await apiFetch(`${API}/sample-counts?ready_per_direction=20`, { cache: "no-store" });
    if (response.ok) renderSampleCounts(await response.json());
  }

  function renderFridgeProfile(profile) {
    $("fridge-on-count").textContent = profile.on_sample_count ?? 0;
    $("fridge-off-count").textContent = profile.off_sample_count ?? 0;
    $("fridge-cycle-count").textContent = profile.complete_cycle_count ?? 0;
    $("fridge-on-delta").textContent = number(profile.on_delta_mean_a, 3, " A");
    $("fridge-off-delta").textContent = number(profile.off_delta_mean_a, 3, " A");
    $("fridge-runtime").textContent = number(profile.runtime_median_minutes, 1, " min");
    $("fridge-off-period").textContent = number(profile.off_period_median_minutes, 1, " min");
    const ready = Boolean(profile.minimum_samples_ready);
    $("fridge-ready").textContent = ready ? "آماده استفاده" : "در حال یادگیری";
    $("fridge-ready").className = ready ? "ready-yes" : "ready-no";
    $("profile-readiness").textContent = ready
      ? "نمونه کافی برای ورود کنترل‌شده به الگوریتم جمع شده است."
      : "حداقل ۴ روشن‌شدن، ۴ خاموش‌شدن و ۲ چرخه کامل لازم است.";
  }

  async function loadFridgeProfile() {
    const response = await apiFetch(`${API}/fridge-profile`, { cache: "no-store" });
    if (response.ok) renderFridgeProfile(await response.json());
  }

  async function rebuildFridgeProfile() {
    const button = $("rebuild-profile-button");
    button.disabled = true;
    try {
      const response = await apiFetch(`${API}/fridge-profile/rebuild`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "محاسبه پروفایل ناموفق بود");
      renderFridgeProfile(payload.profile);
    } catch (error) {
      setMessage(error.message || "خطا در محاسبه پروفایل", "error");
    } finally {
      button.disabled = false;
    }
  }

  function updateSoundButton() {
    const button = $("sound-button");
    button.textContent = state.soundEnabled ? "صدا روشن است" : "فعال‌کردن صدا";
    button.classList.toggle("enabled", state.soundEnabled);
  }

  async function ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("مرورگر پخش هشدار را پشتیبانی نمی‌کند.");
    if (!state.audioContext) state.audioContext = new AudioContextClass();
    if (state.audioContext.state === "suspended") await state.audioContext.resume();
    return state.audioContext;
  }

  async function playNewEventSound() {
    if (!state.soundEnabled) return;
    const context = await ensureAudioContext();
    const start = context.currentTime;
    [0, 0.22].forEach((offset) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(880, start + offset);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.18);
    });
  }

  function hideUnknownLoadPanel() {
    state.pendingUnknownAction = null;
    $("unknown-load-panel").hidden = true;
    $("custom-appliance-name").value = "";
  }

  function showUnknownLoadPanel(action) {
    state.pendingUnknownAction = action;
    $("unknown-load-panel").hidden = false;
    $("custom-appliance-name").focus();
  }

  function renderUnknownPresets() {
    const container = $("unknown-preset-buttons");
    const datalist = $("unknown-appliance-suggestions");
    container.replaceChildren();
    datalist.replaceChildren();
    commonUnknownAppliances.forEach((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "unknown-preset-button";
      button.textContent = name;
      button.addEventListener("click", () => {
        $("custom-appliance-name").value = name;
      });
      container.appendChild(button);
      const option = document.createElement("option");
      option.value = name;
      datalist.appendChild(option);
    });
  }

  function renderEvent(event = null, source = "today") {
    state.current = event;
    state.currentSource = source;

    const backButton = $("back-to-today-button");
    if (backButton) {
      backButton.hidden = !event || source === "today";
    }

    $("empty-state").hidden = Boolean(event);
    $("event-panel").hidden = !event;
    if (!event) {
      $("queue-status").textContent = "رویداد بدون پاسخ امروز وجود ندارد.";
      return;
    }

    const sourceText = source === "pending"
      ? "در حال بررسی از فهرست پندینگ"
      : source === "unanswered"
        ? "در حال بررسی از فهرست پاسخ‌داده‌نشده‌ها"
        : "رویداد امروز";
    $("queue-status").textContent = `${sourceText} · ${state.todayEvents.length} رویداد بدون پاسخ امروز`;
    $("event-id").textContent = `رویداد ${event.id}`;
    $("prediction-title").textContent = `تشخیص فعلی: ${labelFor(event.appliance_type, event.action)}`;
    $("event-status").textContent = `${event.status} · ${number(event.confidence, 3)}`;
    $("current-before").textContent = number(event.current_before_a, 3, " A");
    $("current-after").textContent = number(event.current_after_a, 3, " A");
    $("current-delta").textContent = number(event.current_delta_a, 3, " A");
    $("temperature-delta").textContent = number(event.temperature_delta_c, 3, " °C");
    $("humidity-delta").textContent = number(event.humidity_delta_rh, 3, " %RH");
    $("lux-delta").textContent = number(event.illuminance_delta_lux, 1, " lux");
    $("operating-mode").textContent = modeText(event.day_night_mode);
    $("operating-mode").className = `mode-badge ${modeClass(event.day_night_mode)}`;
    $("event-time").textContent = formatTime(event.event_started_at);
    $("event-date-prominent").textContent = formatEventDate(event.event_started_at);
    $("event-clock-prominent").textContent = formatEventClock(event.event_started_at);
    $("notes").value = "";
    $("session-mode").value = "AUTO";
    resetCombinedPanel();
    $("session-suggestion").textContent =
      "برای بستن قطعی چرخه، گزینه «پایان چرخه باز» را انتخاب کن.";
    hideUnknownLoadPanel();
    setMessage("");

    const container = $("answer-buttons");
    container.replaceChildren();
    const choices = [
      [event.appliance_type, event.action, "درست بود"],
      ["FRIDGE", suggestedAction(event, "FRIDGE")],
      ["MAIN_ROOM_LIGHT", suggestedAction(event, "MAIN_ROOM_LIGHT")],
      ["PORTABLE_AC", suggestedAction(event, "PORTABLE_AC")],
      ["DUCTED_AC", suggestedAction(event, "DUCTED_AC")],
      ["UNKNOWN_LOAD", suggestedAction(event, "UNKNOWN_LOAD")],
    ];

    const unique = new Set();
    choices.forEach(([appliance, action, special]) => {
      const key = `${appliance}:${action}`;
      if (unique.has(key)) return;
      unique.add(key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = special ? "answer-button correct" : "answer-button";
      button.textContent = special || labelFor(appliance, action);
      button.addEventListener("click", () => {
        if (appliance === "UNKNOWN_LOAD") return showUnknownLoadPanel(action);
        submitLabel(appliance, action, null);
      });
      container.appendChild(button);
    });

    const pendingButton = document.createElement("button");
    pendingButton.type = "button";
    pendingButton.className = "answer-button do-not-know";
    pendingButton.textContent = "نمی‌دانم؛ به پندینگ منتقل کن";
    pendingButton.addEventListener("click", submitUnknownPending);
    container.appendChild(pendingButton);

    const finalButton = document.createElement("button");
    finalButton.type = "button";
    finalButton.className = "answer-button final-unknown";
    finalButton.textContent = "منشأ قابل تشخیص نیست؛ نهایی کن";
    finalButton.addEventListener("click", submitUnknownFinal);
    container.appendChild(finalButton);
  }

  async function loadTodayEvents({ silent = false } = {}) {
    const response = await apiFetch(`${API}/today?limit=100`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "دریافت رویدادهای امروز ناموفق بود");

    const incoming = normalizeEvents(payload.events);
    const newestId = incoming.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0);
    if (state.initialEventsLoaded && newestId > (state.newestSeenEventId || 0)) {
      await playNewEventSound();
    }
    state.newestSeenEventId = Math.max(state.newestSeenEventId || 0, newestId);
    state.initialEventsLoaded = true;
    state.todayEvents = incoming;
    $("today-count-badge").textContent = incoming.length;

    // A manually opened event from either the PENDING list or the complete
    // unanswered list must stay on screen until the user answers it or
    // explicitly selects another event. The five-second poll may update
    // counters in the background, but it must not replace this event.
    if (state.current && state.currentSource !== "today") {
      const sourceTitle = state.currentSource === "pending"
        ? "فهرست پندینگ"
        : "فهرست پاسخ‌داده‌نشده‌ها";
      $("queue-status").textContent =
        `در حال بررسی از ${sourceTitle} · ${incoming.length} رویداد بدون پاسخ امروز`;
      return;
    }

    const currentId = state.current ? Number(state.current.id) : null;
    const stillExists = incoming.find((item) => Number(item.id) === currentId);
    if (silent && stillExists) return;
    renderEvent(incoming[0] || null, "today");
  }

  function renderUnansweredList(events) {
    const body = $("unanswered-body");
    body.replaceChildren();
    $("unanswered-count-badge").textContent = events.length;
    $("unanswered-summary-count").textContent = events.length;

    if (!events.length) {
      body.innerHTML = '<tr><td colspan="7" class="table-empty">در Dataset فعال رویداد پاسخ‌داده‌نشده‌ای وجود ندارد.</td></tr>';
      return;
    }

    events.forEach((event) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatTime(event.event_started_at)}</td>
        <td><span class="mode-badge ${modeClass(event.day_night_mode)}">${modeText(event.day_night_mode)}</span></td>
        <td>${labelFor(event.appliance_type, event.action)}</td>
        <td dir="ltr">${number(event.current_delta_a, 3, " A")}</td>
        <td dir="ltr">${number(event.illuminance_delta_lux, 1, " lux")}</td>
        <td>${event.status || "—"}</td>
      `;
      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-edit-button";
      button.textContent = "بررسی این رویداد";
      button.addEventListener("click", () => {
        renderEvent(event, "unanswered");
        window.scrollTo({
          top: $("event-panel").offsetTop - 30,
          behavior: "smooth",
        });
      });
      actionCell.appendChild(button);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
  }

  async function loadUnansweredEvents() {
    const response = await apiFetch(`${API}/unanswered?limit=1000`, {
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload.detail || "دریافت رویدادهای پاسخ‌داده‌نشده ناموفق بود"
      );
    }
    state.unansweredEvents = normalizeEvents(payload.events);
    state.unansweredLoaded = true;
    renderUnansweredList(state.unansweredEvents);
  }

  function renderPendingList(events) {
    const body = $("pending-body");
    body.replaceChildren();
    $("pending-count-badge").textContent = events.length;

    if (!events.length) {
      body.innerHTML = '<tr><td colspan="7" class="table-empty">رویداد پندینگ وجود ندارد.</td></tr>';
      return;
    }

    events.forEach((event) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatTime(event.event_started_at)}</td>
        <td><span class="mode-badge ${modeClass(event.day_night_mode)}">${modeText(event.day_night_mode)}</span></td>
        <td>${labelFor(event.appliance_type, event.action)}</td>
        <td dir="ltr">${number(event.current_delta_a, 3, " A")}</td>
        <td dir="ltr">${number(event.illuminance_delta_lux, 1, " lux")}</td>
        <td>${event.status || "—"}</td>
      `;
      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-edit-button";
      button.textContent = "بررسی این رویداد";
      button.addEventListener("click", () => {
        renderEvent(event, "pending");
        window.scrollTo({ top: $("event-panel").offsetTop - 30, behavior: "smooth" });
      });
      actionCell.appendChild(button);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
  }

  async function loadPendingEvents() {
    const body = $("pending-body");

    try {
      const response = await apiFetch(`${API}/pending?limit=500`, {
        cache: "no-store",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(
          payload.detail || "دریافت پندینگ‌ها ناموفق بود"
        );
      }

      state.pendingEvents = normalizeEvents(payload.events);
      state.pendingLoaded = true;
      renderPendingList(state.pendingEvents);
    } catch (error) {
      state.pendingLoaded = false;
      body.innerHTML = `
        <tr>
          <td colspan="7" class="table-empty table-error">
            ${error.message || "خطا در دریافت رویدادهای پندینگ"}
          </td>
        </tr>
      `;
      throw error;
    }
  }

  function historyDeviceName(label) {
    return label.appliance_type === "UNKNOWN_LOAD"
      ? (label.custom_appliance_name || "بار نامشخص بدون نام")
      : (applianceLabels[label.appliance_type] || label.appliance_type);
  }

  function renderHistory(payload) {
    const body = $("history-body");
    body.replaceChildren();
    const labels = normalizeEvents(payload.labels).sort((a, b) => {
      const timeA = new Date(
        a.event_started_at || a.updated_at || a.created_at || 0
      ).getTime();
      const timeB = new Date(
        b.event_started_at || b.updated_at || b.created_at || 0
      ).getTime();
      if (timeB !== timeA) return timeB - timeA;
      return Number(b.id || 0) - Number(a.id || 0);
    });
    state.historyLabels = labels;
    if (!labels.length) {
      body.innerHTML = '<tr><td colspan="8" class="table-empty">هنوز پاسخی ثبت نشده است.</td></tr>';
      return;
    }

    labels.forEach((label) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatTime(label.event_started_at || label.updated_at)}</td>
        <td><span class="mode-badge ${modeClass(label.day_night_mode)}">${modeText(label.day_night_mode)}</span></td>
        <td class="history-device-name">
          <strong>${historyDeviceName(label)}</strong>
          ${label.is_combined_allocation
            ? `<small class="combined-history-tag">سهم رویداد ترکیبی · ${number(label.allocated_current_delta_a, 3, " A")}</small>`
            : ""}
          <small>
            Dataset v${Number(label.dataset_version || 1).toLocaleString("fa-IR")}
            · ${label.dataset_status === "ACTIVE" ? "فعال" : "آرشیوشده"}
          </small>
        </td>
        <td>
          <span class="session-phase-badge">
            ${
              label.review_status === "PENDING" || label.review_status === "UNRESOLVED"
                ? "بدون چرخه"
                : (sessionPhaseLabels[label.session_phase] || label.session_phase || "قدیمی / بدون چرخه")
            }
          </span>
          ${label.operation_session_id
            ? `<small class="session-id-text">چرخه ${label.operation_session_id} · مرحله ${label.session_event_index || "—"}</small>`
            : ""}
        </td>
        <td>${actionLabels[label.action] || label.action}</td>
        <td dir="ltr">${number(label.current_delta_a, 3, " A")}</td>
        <td>${label.notes || "—"}</td>
      `;
      const actionsCell = document.createElement("td");
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "history-edit-button";
      editButton.textContent = "✏️ ویرایش";
      editButton.addEventListener("click", () => {
        if (label.is_combined_allocation) {
          openCombinedEdit(label);
        } else {
          openEditDialog(label);
        }
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "history-delete-button";
      deleteButton.textContent = "🗑 حذف";
      deleteButton.addEventListener("click", () => deleteTrainingLabel(label));
      actionsCell.append(editButton, deleteButton);
      row.appendChild(actionsCell);
      body.appendChild(row);
    });
  }

  async function loadHistory() {
    const response = await apiFetch(`${API}/history?limit=100`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "دریافت تاریخچه ناموفق بود");
    state.historyLoaded = true;
    renderHistory(payload);
  }

  function updateEditReviewTargetVisibility() {
    const target = $("edit-review-target").value;
    const applianceSelect = $("edit-appliance-type");
    const actionSelect = $("edit-action");
    const customInput = $("edit-custom-appliance-name");

    if (target === "PENDING_UNKNOWN") {
      applianceSelect.value = "UNKNOWN_LOAD";
      actionSelect.value = state.editingLabel?.action || "INCREASE";
      customInput.value = "نمی‌دانم";
      $("edit-apply-correction").checked = false;
    } else if (target === "FINAL_UNKNOWN") {
      applianceSelect.value = "UNKNOWN_LOAD";
      actionSelect.value = state.editingLabel?.action || "INCREASE";
      customInput.value = "بار کوچک با منشأ نامشخص";
      $("edit-apply-correction").checked = false;
    }

    updateEditCustomNameVisibility();
  }

  function updateEditCustomNameVisibility() {
    const isUnknown = $("edit-appliance-type").value === "UNKNOWN_LOAD";
    $("edit-custom-name-field").hidden = !isUnknown;
    $("edit-custom-appliance-name").required = isUnknown;
    if (!isUnknown) $("edit-custom-appliance-name").value = "";
  }

  function openEditDialog(label) {
    state.editingLabel = label;
    $("edit-label-event-id").textContent = `رویداد ${label.event_id}`;
    $("edit-review-target").value =
      label.review_status === "PENDING"
        ? "PENDING_UNKNOWN"
        : label.review_status === "UNRESOLVED"
          ? "FINAL_UNKNOWN"
          : "CONFIRMED";
    $("edit-appliance-type").value = label.appliance_type;
    $("edit-action").value = label.action;
    $("edit-session-mode").value =
      label.selected_session_mode || "AUTO";
    $("edit-custom-appliance-name").value = label.custom_appliance_name || "";
    $("edit-notes").value = label.notes || "";
    $("edit-apply-correction").checked = true;
    $("edit-message").textContent = "";
    updateEditReviewTargetVisibility();
    $("edit-label-dialog").showModal();
  }

  function apiErrorMessage(payload, fallback) {
    const detail = payload?.detail ?? payload?.message ?? payload?.error;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object") {
      return detail.message || detail.details || JSON.stringify(detail);
    }
    return fallback;
  }

  function closeEditDialog() {
    state.editingLabel = null;
    $("edit-label-dialog").close();
  }

  async function saveEditedLabel(event) {
    event.preventDefault();
    if (!state.editingLabel) return;
    const button = $("save-edit-button");
    button.disabled = true;
    try {
      const applianceType = $("edit-appliance-type").value;
      const customName = $("edit-custom-appliance-name").value.trim();
      const response = await apiFetch(`${API}/labels/${state.editingLabel.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appliance_type: $("edit-review-target").value === "CONFIRMED"
            ? applianceType
            : "UNKNOWN_LOAD",
          action: $("edit-action").value,
          custom_appliance_name:
            $("edit-review-target").value === "PENDING_UNKNOWN"
              ? "نمی‌دانم"
              : $("edit-review-target").value === "FINAL_UNKNOWN"
                ? "بار کوچک با منشأ نامشخص"
                : applianceType === "UNKNOWN_LOAD"
                  ? customName
                  : null,
          notes:
            $("edit-review-target").value === "PENDING_UNKNOWN"
              ? "نمی‌دانم"
              : $("edit-review-target").value === "FINAL_UNKNOWN"
                ? "منشأ قابل تشخیص نیست"
                : $("edit-notes").value.trim() || null,
          apply_correction_to_event:
            $("edit-review-target").value === "CONFIRMED"
              ? $("edit-apply-correction").checked
              : false,
          session_mode: $("edit-session-mode").value,
          review_target: $("edit-review-target").value,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, "ویرایش پاسخ ناموفق بود"));
      }
      closeEditDialog();
      await Promise.all([loadSummary(), loadSampleCounts(), loadFridgeProfile(), loadHistory(), loadPendingEvents(), loadUnansweredEvents(), loadTodayEvents(), loadOpenSessions(), loadCycleVisuals()]);
    } catch (error) {
      $("edit-message").textContent = error.message || "خطا در ویرایش";
      $("edit-message").className = "message error";
    } finally {
      button.disabled = false;
    }
  }

  async function deleteTrainingLabel(label) {
    if (!window.confirm(`پاسخ «${historyDeviceName(label)}» حذف شود؟`)) return;
    const response = await apiFetch(`${API}/labels/${label.id}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) return setHistoryMessage(payload.detail || "حذف ناموفق بود", "error");
    await Promise.all([loadHistory(), loadSummary(), loadSampleCounts(), loadFridgeProfile(), loadPendingEvents(), loadUnansweredEvents(), loadTodayEvents(), loadOpenSessions(), loadCycleVisuals()]);
  }


  function allocationApplianceOptions() {
    return [
      ["FRIDGE", "یخچال"],
      ["MAIN_ROOM_LIGHT", "چراغ اتاق اصلی"],
      ["PORTABLE_AC", "کولر پرتابل"],
      ["DUCTED_AC", "کولر کانالی"],
      ["UNKNOWN_LOAD", "بار دیگر / وسیله سفارشی"],
    ];
  }

  function createAllocationRow(initial = {}) {
    state.allocationRowCounter += 1;
    const row = document.createElement("div");
    row.className = "allocation-row";
    row.dataset.rowId = String(state.allocationRowCounter);

    const appliance = document.createElement("select");
    appliance.className = "allocation-appliance";
    allocationApplianceOptions().forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      appliance.appendChild(option);
    });
    appliance.value = initial.appliance_type || "PORTABLE_AC";

    const custom = document.createElement("input");
    custom.className = "allocation-custom-name";
    custom.type = "text";
    custom.maxLength = 100;
    custom.placeholder = "نام وسیله سفارشی";
    custom.value = initial.custom_appliance_name || "";

    const delta = document.createElement("input");
    delta.className = "allocation-delta";
    delta.type = "number";
    delta.step = "0.001";
    delta.min = "0";
    delta.inputMode = "decimal";
    delta.placeholder = "مقدار سهم بدون علامت (A)";
    delta.value = initial.allocated_delta_a ?? "";

    const direction = document.createElement("select");
    direction.className = "allocation-direction";
    [
      ["INCREASE", "+ روشن / افزایش"],
      ["DECREASE", "− خاموش / کاهش"],
    ].forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      direction.appendChild(option);
    });
    direction.value = initial.direction
      || (Number(initial.signed_delta_a ?? initial.allocated_delta_a ?? 0) < 0
        ? "DECREASE"
        : "INCREASE");

    const session = document.createElement("select");
    session.className = "allocation-session-mode";
    [
      ["AUTO", "هوشمند و خودکار"],
      ["START_NEW", "شروع چرخه جدید"],
      ["CONTINUE", "ادامه چرخه باز"],
      ["END", "پایان چرخه باز"],
    ].forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      session.appendChild(option);
    });
    session.value = initial.session_mode || "AUTO";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "allocation-remove";
    remove.textContent = "حذف";
    remove.addEventListener("click", () => {
      row.remove();
      updateAllocationSummary();
    });

    appliance.addEventListener("change", () => {
      custom.hidden = appliance.value !== "UNKNOWN_LOAD";
      if (custom.hidden) custom.value = "";
    });
    custom.hidden = appliance.value !== "UNKNOWN_LOAD";
    delta.addEventListener("input", updateAllocationSummary);
    direction.addEventListener("change", updateAllocationSummary);

    row.append(appliance, custom, direction, delta, session, remove);
    $("allocation-rows").appendChild(row);
    updateAllocationSummary();
  }

  function resetCombinedPanel() {
    $("combined-event-toggle").checked = false;
    $("combined-event-panel").hidden = true;
    $("answer-buttons").closest(".question-block").hidden = false;
    $("session-mode").closest(".session-control").hidden = false;
    $("allocation-rows").replaceChildren();
    state.allocationRowCounter = 0;
    state.editingCombinedEventId = null;
    $("save-combined-event").textContent = "ثبت رویداد ترکیبی";
  }

  function prepareCombinedPanel() {
    $("allocation-rows").replaceChildren();
    state.allocationRowCounter = 0;
    const total = Number(state.current?.current_delta_a || 0);
    createAllocationRow({
      appliance_type: "PORTABLE_AC",
      allocated_delta_a: "",
      session_mode: total >= 0 ? "START_NEW" : "END",
    });
    createAllocationRow({
      appliance_type: "UNKNOWN_LOAD",
      custom_appliance_name: "Laptop Charger",
      allocated_delta_a: "",
      session_mode: total >= 0 ? "START_NEW" : "END",
    });
    updateAllocationSummary();
  }

  function normalizeAllocationDelta(rawValue, directionValue) {
    const magnitude = Math.abs(Number(rawValue || 0));
    if (!Number.isFinite(magnitude) || magnitude === 0) return 0;
    return directionValue === "DECREASE" ? -magnitude : magnitude;
  }

  function updateAllocationSummary() {
    const total = Number(state.current?.current_delta_a || 0);
    const assigned = [...document.querySelectorAll(".allocation-delta")]
      .reduce(
        (sum, input) => sum + normalizeAllocationDelta(
          input.value,
          input.closest(".allocation-row")
            .querySelector(".allocation-direction").value,
        ),
        0,
      );
    const remaining = total - assigned;
    $("allocation-event-total").textContent = `${total.toFixed(3)} A`;
    $("allocation-assigned-total").textContent = `${assigned.toFixed(3)} A`;
    $("allocation-remaining").textContent = `${remaining.toFixed(3)} A`;
    $("allocation-remaining").classList.toggle(
      "allocation-ok",
      Math.abs(remaining) <= 0.05,
    );
  }

  function collectAllocations() {
    return [...document.querySelectorAll(".allocation-row")].map((row) => {
      const applianceType = row.querySelector(
        ".allocation-appliance"
      ).value;
      const customName = row.querySelector(
        ".allocation-custom-name"
      ).value.trim();
      return {
        appliance_type: applianceType,
        custom_appliance_name:
          applianceType === "UNKNOWN_LOAD" ? customName : null,
        allocated_delta_a: normalizeAllocationDelta(
          row.querySelector(".allocation-delta").value,
          row.querySelector(".allocation-direction").value,
        ),
        session_mode: row.querySelector(
          ".allocation-session-mode"
        ).value,
        notes: $("notes").value.trim() || null,
      };
    });
  }

  function openCombinedEdit(label) {
    const siblings = state.historyLabels.filter((item) =>
      item.is_combined_allocation
      && Number(item.event_id) === Number(label.event_id)
      && item.allocation_group_id === label.allocation_group_id
    );
    if (siblings.length < 2) {
      return setHistoryMessage(
        "همه سهم‌های این رویداد در تاریخچه فعلی موجود نیستند؛ ابتدا تاریخچه را تازه‌سازی کن.",
        "error",
      );
    }

    const total = Number(label.event_total_delta_a ?? 0);
    state.current = {
      id: Number(label.event_id),
      current_delta_a: total,
      event_started_at: label.event_started_at,
      day_night_mode: label.day_night_mode,
    };
    state.currentSource = "history-combined";
    state.editingCombinedEventId = Number(label.event_id);
    $("combined-event-toggle").checked = true;
    $("combined-event-panel").hidden = false;
    $("answer-buttons").closest(".question-block").hidden = true;
    $("session-mode").closest(".session-control").hidden = true;
    $("allocation-rows").replaceChildren();
    state.allocationRowCounter = 0;
    siblings.forEach((item) => createAllocationRow({
      appliance_type: item.appliance_type,
      custom_appliance_name: item.custom_appliance_name,
      allocated_delta_a: Math.abs(Number(item.allocated_current_delta_a || 0)),
      signed_delta_a: Number(item.allocated_current_delta_a || 0),
      session_mode: item.selected_session_mode || "AUTO",
    }));
    $("notes").value = label.notes || "";
    $("save-combined-event").textContent = "ذخیره و بازسازی رویداد ترکیبی";
    updateAllocationSummary();
    setMessage(
      `ویرایش رویداد ترکیبی ${label.event_id}: علامت هر سهم را مستقل انتخاب کن.`,
      "",
    );
    window.scrollTo({
      top: $("event-panel").offsetTop - 30,
      behavior: "smooth",
    });
  }

  async function submitCombinedEvent() {
    if (!state.current || state.busy) return;
    const allocations = collectAllocations();
    if (allocations.length < 2) {
      return setMessage(
        "برای رویداد ترکیبی حداقل دو وسیله لازم است.",
        "error",
      );
    }
    if (allocations.some((item) =>
      !Number.isFinite(item.allocated_delta_a)
      || item.allocated_delta_a === 0
      || (
        item.appliance_type === "UNKNOWN_LOAD"
        && !item.custom_appliance_name
      )
    )) {
      return setMessage(
        "نام و سهم جریان همه وسیله‌ها را کامل وارد کن.",
        "error",
      );
    }

    const eventTotal = Number(state.current.current_delta_a || 0);
    const assigned = allocations.reduce(
      (sum, item) => sum + item.allocated_delta_a,
      0,
    );
    if (Math.abs(eventTotal - assigned) > 0.05) {
      return setMessage(
        `جمع سهم‌ها باید با تغییر کل برابر باشد. باقی‌مانده: ${(eventTotal - assigned).toFixed(3)} A`,
        "error",
      );
    }

    state.busy = true;
    $("save-combined-event").disabled = true;
    try {
      const response = await apiFetch(
        `${API}/events/${state.current.id}/combined-label`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allocations,
            notes: $("notes").value.trim() || null,
            apply_correction_to_event: false,
            tolerance_a: 0.05,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload.detail || "ثبت رویداد ترکیبی ناموفق بود"
        );
      }
      setMessage(
        `${payload.count} سهم جریان و چرخه با موفقیت ${state.editingCombinedEventId ? "بازسازی" : "ثبت"} شد.`,
        "success",
      );
      const combinedEventId = Number(state.current.id);
      state.todayEvents = state.todayEvents.filter(
        (event) => Number(event.id) !== combinedEventId,
      );
      state.unansweredEvents = state.unansweredEvents.filter(
        (event) => Number(event.id) !== combinedEventId,
      );
      state.pendingEvents = state.pendingEvents.filter(
        (event) => Number(event.id) !== combinedEventId,
      );
      state.current = null;
      state.currentSource = "today";
      resetCombinedPanel();
      await Promise.all([
        loadSummary(),
        loadSampleCounts(),
        loadFridgeProfile(),
        loadTodayEvents(),
        loadPendingEvents(),
        loadUnansweredEvents(),
        loadOpenSessions(),
        loadCycleVisuals(),
        state.historyLoaded ? loadHistory() : Promise.resolve(),
      ]);
    } catch (error) {
      setMessage(error.message || "خطا در ثبت ترکیبی", "error");
    } finally {
      state.busy = false;
      $("save-combined-event").disabled = false;
    }
  }

  async function submitUnknownFinal() {
    if (!state.current || state.busy) return;
    if (!window.confirm("این رویداد نهایی و برای همیشه از صف خارج شود؟")) return;
    $("apply-correction").checked = false;
    $("notes").value = "منشأ قابل تشخیص نیست";
    await submitLabel("UNKNOWN_LOAD", suggestedAction(state.current, "UNKNOWN_LOAD"), "بار کوچک با منشأ نامشخص", { finalUnknown: true });
  }

  async function submitUnknownPending() {
    if (!state.current || state.busy) return;
    $("apply-correction").checked = false;
    $("notes").value = "نمی‌دانم";
    await submitLabel("UNKNOWN_LOAD", suggestedAction(state.current, "UNKNOWN_LOAD"), "نمی‌دانم", { pendingUnknown: true });
  }

  async function submitLabel(applianceType, action, customApplianceName = null, options = {}) {
    if (!state.current || state.busy) return;
    state.busy = true;
    document.querySelectorAll(".answer-button").forEach((button) => button.disabled = true);
    try {
      const response = await apiFetch(`${API}/events/${state.current.id}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appliance_type: applianceType,
          action,
          notes: $("notes").value.trim() || null,
          custom_appliance_name: customApplianceName,
          apply_correction_to_event: options.pendingUnknown || options.finalUnknown
            ? false : $("apply-correction").checked,
          session_mode: $("session-mode").value,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "ذخیره پاسخ ناموفق بود");

      const phaseText = payload.session_phase
        ? (sessionPhaseLabels[payload.session_phase] || payload.session_phase)
        : null;
      const trainingText = payload.counts_as_training_sample === false
        ? " این تغییر، مرحله میانی همان چرخه است و نمونه مستقل آموزش محسوب نشد."
        : "";

      setMessage(
        options.pendingUnknown
          ? "رویداد به فهرست پندینگ منتقل شد."
          : options.finalUnknown
            ? "رویداد به‌عنوان منشأ نامشخص نهایی شد."
            : `پاسخ ثبت شد${phaseText ? `؛ مرحله: ${phaseText}` : ""}.${trainingText}`,
        "success",
      );

      state.current = null;
      state.currentSource = "today";
      await Promise.all([
        loadSummary(), loadSampleCounts(), loadFridgeProfile(),
        loadTodayEvents(), loadPendingEvents(), loadUnansweredEvents(),
        loadOpenSessions(),
        state.historyLoaded ? loadHistory() : Promise.resolve(),
      ]);
    } catch (error) {
      setMessage(error.message || "خطا در ذخیره پاسخ", "error");
    } finally {
      state.busy = false;
      document.querySelectorAll(".answer-button").forEach((button) => button.disabled = false);
    }
  }

  async function returnToTodayEvents() {
    if (state.busy) return;

    state.current = null;
    state.currentSource = "today";
    hideUnknownLoadPanel();
    setMessage("");

    const button = $("back-to-today-button");
    if (button) {
      button.disabled = true;
    }

    try {
      await loadTodayEvents({ silent: false });
      window.scrollTo({
        top: $("event-panel").offsetTop - 30,
        behavior: "smooth",
      });
    } catch (error) {
      setMessage(
        error.message || "بازگشت به رویدادهای امروز ناموفق بود",
        "error",
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.hidden = true;
      }
    }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.busy) {
        try {
          await loadTodayEvents({ silent: true });
          await loadOpenSessions();
          await loadCycleVisuals();
          if ($("unanswered-details").open) {
            await loadUnansweredEvents();
          }
          if ($("pending-details").open) {
            await loadPendingEvents();
          }
        } catch (_) {}
      }
    }, 5000);
  }

  $("combined-event-toggle").addEventListener(
    "change",
    () => {
      const enabled = $("combined-event-toggle").checked;
      $("combined-event-panel").hidden = !enabled;
      $("answer-buttons").closest(".question-block").hidden = enabled;
      $("session-mode").closest(".session-control").hidden = enabled;
      if (enabled) prepareCombinedPanel();
    },
  );
  $("add-allocation-row").addEventListener(
    "click",
    () => createAllocationRow({
      session_mode:
        Number(state.current?.current_delta_a || 0) >= 0
          ? "START_NEW"
          : "END",
    }),
  );
  $("save-combined-event").addEventListener(
    "click",
    submitCombinedEvent,
  );

  $("session-mode").addEventListener("change", () => {
    const messages = {
      AUTO: "سیستم فقط اتصال رویداد به چرخه باز را پیشنهاد می‌دهد؛ بستن قطعی چرخه نیازمند END است.",
      START_NEW: "این رویداد اولین مرحله یک چرخه جدید خواهد بود.",
      CONTINUE: "این رویداد به آخرین چرخه باز همین وسیله متصل می‌شود.",
      END: "این رویداد چرخه باز همین وسیله را می‌بندد.",
    };
    $("session-suggestion").textContent =
      messages[$("session-mode").value] || messages.AUTO;
  });

  $("save-unknown-button").addEventListener("click", () => {
    const customName = $("custom-appliance-name").value.trim();
    if (!customName) return setMessage("نام وسیله را وارد کن.", "error");
    submitLabel("UNKNOWN_LOAD", state.pendingUnknownAction, customName);
  });
  $("cancel-unknown-button").addEventListener("click", hideUnknownLoadPanel);
  $("custom-appliance-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("save-unknown-button").click();
    }
  });

  $("unanswered-details").addEventListener("toggle", () => {
    if ($("unanswered-details").open) loadUnansweredEvents();
  });
  $("pending-details").addEventListener("toggle", () => {
    if ($("pending-details").open) {
      loadPendingEvents().catch(() => {});
    }
  });
  $("history-details").addEventListener("toggle", () => {
    if ($("history-details").open && !state.historyLoaded) loadHistory();
  });
  $("back-to-today-button").addEventListener(
    "click",
    returnToTodayEvents,
  );
  $("refresh-cycle-visuals-button").addEventListener(
    "click",
    loadCycleVisuals,
  );
  $("cycle-visual-filter").addEventListener(
    "change",
    () => renderCycleVisuals({
      sessions: state.cycleVisualSessions,
    }),
  );

  $("dataset-version-select").addEventListener(
    "change",
    () => {
      const selected = Number($("dataset-version-select").value);
      $("activate-dataset-button").disabled =
        !selected || selected === state.activeDatasetVersion;
      setDatasetMessage("");
    },
  );

  $("activate-dataset-button").addEventListener(
    "click",
    activateSelectedDataset,
  );

  $("start-new-dataset-button").addEventListener(
    "click",
    startNewDataset,
  );
  $("refresh-open-cycles-button").addEventListener(
    "click",
    loadOpenSessions,
  );
  $("refresh-unanswered-button").addEventListener("click", loadUnansweredEvents);
  $("refresh-pending-button").addEventListener("click", loadPendingEvents);
  $("refresh-history-button").addEventListener("click", loadHistory);
  $("refresh-button").addEventListener("click", () => Promise.all([
    loadSummary(), loadSampleCounts(), loadFridgeProfile(),
    loadTodayEvents(), loadOpenSessions(), loadCycleVisuals(),
    $("unanswered-details").open ? loadUnansweredEvents() : Promise.resolve(),
    $("pending-details").open ? loadPendingEvents() : Promise.resolve(),
  ]));
  $("refresh-sample-counts-button").addEventListener("click", loadSampleCounts);
  $("rebuild-profile-button").addEventListener("click", rebuildFridgeProfile);
  $("sound-button").addEventListener("click", async () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem("applianceEventSoundEnabled", String(state.soundEnabled));
    if (state.soundEnabled) await playNewEventSound();
    updateSoundButton();
  });

  $("edit-review-target").addEventListener(
    "change",
    updateEditReviewTargetVisibility,
  );
  $("edit-appliance-type").addEventListener(
    "change",
    updateEditCustomNameVisibility,
  );
  $("edit-label-form").addEventListener("submit", saveEditedLabel);
  $("close-edit-dialog").addEventListener("click", closeEditDialog);
  $("cancel-edit-button").addEventListener("click", closeEditDialog);

  async function loadUnansweredCount() {
    const response = await apiFetch(`${API}/unanswered?limit=2000`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = await response.json();
    const count = Number(payload.count || 0);
    $("unanswered-count-badge").textContent = count;
    $("unanswered-summary-count").textContent = count;
  }

  renderUnknownPresets();
  updateSoundButton();
  Promise.all([
    loadSummary(),
    loadDatasetVersions(),
    loadSampleCounts(),
    loadFridgeProfile(),
    loadTodayEvents(),
    loadOpenSessions(),
    loadCycleVisuals(),
    loadUnansweredCount(),
  ]).then(startPolling);
})();
