(() => {
"use strict";

const cfg = window.SMART_BUILDING_CONFIG || {};

if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY) {
  document.getElementById("status").textContent = "تنظیمات Supabase پیدا نشد.";
  return;
}

const db = window.supabase.createClient(
  cfg.SUPABASE_URL,
  cfg.SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false } }
);

const MODEL = "v17_hybrid";
const TZ = cfg.DISPLAY_TIME_ZONE || "Asia/Tehran";
const $ = (id) => document.getElementById(id);

const pct = (x) => x == null ? "—" : `${(Number(x) * 100).toFixed(1)}%`;

const fmtTime = (value) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: TZ,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

function applianceFa(value) {
  return {
    FRIDGE: "یخچال",
    PORTABLE_AC: "کولر پرتابل",
    MAIN_ROOM_LIGHT: "چراغ اتاق اصلی",
    UNKNOWN: "نامشخص"
  }[value] || String(value || "—").replaceAll("_", " ");
}

function actionFa(value) {
  if (value === "ON") return "روشن";
  if (value === "OFF") return "خاموش";
  return "—";
}

function renderLatest(p) {
  if (!p) return;

  $("latest-device").textContent = applianceFa(p.predicted_appliance);
  $("latest-action").textContent = actionFa(p.predicted_action);
  $("latest-confidence").textContent = pct(p.confidence);
  $("latest-time").textContent = `زمان: ${fmtTime(p.event_started_at)}`;
  $("confidence-fill").style.width = `${Math.max(0, Math.min(100, Number(p.confidence) * 100))}%`;
  $("live-dot").classList.add("on");

  $("detail-delta").textContent =
    p.current_delta_a == null ? "—" :
    `${Number(p.current_delta_a) >= 0 ? "+" : ""}${Number(p.current_delta_a).toFixed(4)} A`;

  $("detail-routing").textContent = p.routing || "—";
  $("detail-sequence").textContent = p.sequence_role || "—";
  $("detail-model").textContent = p.model_version || "—";

  const flags = [];
  if (p.uncertain) flags.push("UNCERTAIN");
  if (p.power_recovery) flags.push("POWER RECOVERY");
  if (p.backfilled) flags.push("BACKFILLED");

  $("latest-flags").innerHTML =
    flags.map((x) => `<span class="flag">${esc(x)}</span>`).join("");
}

function deriveApplianceStates(rows) {
  const appliances = ["FRIDGE", "PORTABLE_AC", "MAIN_ROOM_LIGHT"];

  for (const appliance of appliances) {
    const row = rows.find(
      (r) =>
        r.predicted_appliance === appliance &&
        r.sequence_role !== "CONTINUATION"
    );

    const stateEl = $(`state-${appliance}`);
    const timeEl = $(`time-${appliance}`);

    if (!row) {
      stateEl.textContent = "نامشخص";
      stateEl.className = "state unknown";
      timeEl.textContent = "—";
      continue;
    }

    stateEl.textContent = actionFa(row.predicted_action);
    stateEl.className =
      row.predicted_action === "ON" ? "state on" : "state off";
    timeEl.textContent = fmtTime(row.event_started_at);
  }
}

function renderRecent(rows) {
  $("recent-list").innerHTML = rows.slice(0, 12).map((r) => `
    <div class="recent-row">
      <div>${esc(fmtTime(r.event_started_at))}</div>
      <div class="recent-main">
        <strong>${esc(applianceFa(r.predicted_appliance))}</strong>
        <span>${esc(actionFa(r.predicted_action))}</span>
      </div>
      <div class="badge">${esc(pct(r.confidence))}</div>
      <div class="badge">
        ${r.uncertain ? '<span class="warning">نامطمئن</span>' :
          r.sequence_role === "CONTINUATION" ? "ادامه" : "عادی"}
      </div>
    </div>
  `).join("") || `<p class="muted">هنوز prediction ثبت نشده است.</p>`;
}

function renderEvalSummary(row) {
  if (!row) return;
  $("eval-accuracy").textContent = pct(row.accuracy);
  $("eval-f1").textContent = pct(row.macro_f1);
  $("eval-count").textContent = row.evaluated ?? 0;
  $("eval-waiting").textContent = row.waiting_ground_truth ?? 0;
}

function renderClassMetrics(rows) {
  $("class-metrics").innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(String(r.class_name).replaceAll("_", " "))}</td>
      <td>${esc(pct(r.precision))}</td>
      <td>${esc(pct(r.recall))}</td>
      <td><strong>${esc(pct(r.f1))}</strong></td>
      <td>${esc(r.support)}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">هنوز داده کافی نیست.</td></tr>`;
}

function resultClass(status) {
  if (status === "CORRECT") return "good";
  if (status === "WRONG") return "bad";
  if (status === "WAITING_GROUND_TRUTH") return "warning";
  return "";
}

function resultFa(status) {
  return {
    CORRECT: "درست",
    WRONG: "اشتباه",
    WAITING_GROUND_TRUTH: "منتظر پاسخ",
    COMBINED_EXCLUDED: "ترکیبی",
    UNMAPPABLE_GROUND_TRUTH: "غیرقابل‌ارزیابی"
  }[status] || status || "—";
}

function renderEvalHistory(rows) {
  $("evaluation-history").innerHTML = rows.slice(0, 20).map((r) => `
    <tr>
      <td>${esc(fmtTime(r.event_started_at))}</td>
      <td>${esc(String(r.prediction_class || "—").replaceAll("_", " "))}</td>
      <td>${esc(String(r.ground_truth_class || "—").replaceAll("_", " "))}</td>
      <td class="${resultClass(r.evaluation_status)}">${esc(resultFa(r.evaluation_status))}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">هنوز مقایسه‌ای وجود ندارد.</td></tr>`;
}

async function loadAll() {
  $("status").textContent = "در حال دریافت داده‌ها…";

  const since = new Date(Date.now() - 24 * 3600e3).toISOString();

  const [pRes, sRes, cRes, eRes] = await Promise.all([
    db.from("live_appliance_predictions")
      .select("event_id,event_started_at,current_delta_a,predicted_appliance,predicted_action,confidence,routing,uncertain,sequence_role,power_recovery,backfilled,model_version")
      .eq("model_version", MODEL)
      .gte("event_started_at", since)
      .order("event_started_at", { ascending: false })
      .limit(100),

    db.from("live_appliance_evaluation_summary")
      .select("model_version,waiting_ground_truth,evaluated,correct,incorrect,accuracy,macro_f1")
      .eq("model_version", MODEL)
      .maybeSingle(),

    db.from("live_appliance_evaluation_class_metrics")
      .select("class_name,precision,recall,f1,support")
      .eq("model_version", MODEL)
      .order("class_name"),

    db.from("live_appliance_prediction_evaluation")
      .select("event_started_at,prediction_class,ground_truth_class,evaluation_status")
      .eq("model_version", MODEL)
      .order("event_started_at", { ascending: false })
      .limit(30)
  ]);

  for (const r of [pRes, sRes, cRes, eRes]) {
    if (r.error) throw r.error;
  }

  const predictions = pRes.data || [];

  renderLatest(predictions[0]);
  deriveApplianceStates(predictions);
  renderRecent(predictions);
  renderEvalSummary(sRes.data);
  renderClassMetrics(cRes.data || []);
  renderEvalHistory(eRes.data || []);

  $("status").textContent =
    `آخرین به‌روزرسانی: ${fmtTime(new Date())}`;
}

function showError(error) {
  console.error(error);
  $("status").textContent = `خطا: ${error?.message || error}`;
}

$("refresh").addEventListener("click", () => {
  loadAll().catch(showError);
});

loadAll().catch(showError);

db.channel("simple-live-appliance-predictions")
  .on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "live_appliance_predictions",
      filter: `model_version=eq.${MODEL}`
    },
    () => loadAll().catch(showError)
  )
  .subscribe();

setInterval(() => {
  loadAll().catch(showError);
}, 60000);

})();
