// Supabase Dashboard -> Project Settings -> API
const SUPABASE_URL = "https://rarytoivpexnqfdtebsx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Mv7kzCdhAytHLGszxBDpeA_zEoexIiC";

const client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
);

const params = new URLSearchParams(window.location.search);
const eventId = params.get("event");
const accessToken = params.get("token");

const views = {
    loading: document.getElementById("loading-view"),
    error: document.getElementById("error-view"),
    intro: document.getElementById("intro-view"),
    survey: document.getElementById("survey-form"),
    success: document.getElementById("success-view"),
    closed: document.getElementById("closed-view"),
};

const steps = Array.from(document.querySelectorAll(".survey-step"));
const previousButton = document.getElementById("previous-button");
const nextButton = document.getElementById("next-button");
const submitButton = document.getElementById("submit-button");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const formError = document.getElementById("form-error");

let currentStepIndex = 0;
let loadedSurvey = null;

function showView(name) {
    Object.values(views).forEach((view) => view.classList.remove("active"));
    views[name].classList.add("active");
}

function setBusy(button, busy) {
    button.disabled = busy;
    button.dataset.originalText ||= button.textContent;
    button.textContent = busy ? "در حال ثبت..." : button.dataset.originalText;
}

function showError(message) {
    document.getElementById("error-message").textContent = message;
    showView("error");
}

function formatDateTime(value) {
    if (!value) return "زمان نامشخص";
    const date = new Date(value);
    return date.toLocaleString("fa-IR", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function slotLabel(slot) {
    const labels = {
        morning: "نوبت صبح؛ ساعت ۹",
        afternoon: "نوبت بعدازظهر؛ ساعت ۱۴",
        evening: "نوبت شب؛ ساعت ۲۰",
    };
    return labels[slot] || "پرسشنامه روزانه";
}

function updateOtherField(groupName, wrapperId, inputName) {
    const selected = document.querySelector(`input[name="${groupName}"]:checked`);
    const wrapper = document.getElementById(wrapperId);
    const input = document.querySelector(`[name="${inputName}"]`);
    if (!wrapper || !input) return;

    const shouldShow = selected?.value === "other";
    wrapper.classList.toggle("hidden", !shouldShow);
    input.required = shouldShow;
    if (!shouldShow) input.value = "";
}

function initializeOtherFields() {
    const configs = [
        ["current_room", "current-room-other-wrap", "current_room_other"],
        ["airflow_source", "airflow-source-other-wrap", "airflow_source_other"],
        ["window_closing_reason", "window-closing-reason-other-wrap", "window_closing_reason_other"],
    ];

    configs.forEach(([groupName, wrapperId, inputName]) => {
        document.querySelectorAll(`input[name="${groupName}"]`).forEach((input) => {
            input.addEventListener("change", () =>
                updateOtherField(groupName, wrapperId, inputName)
            );
        });
        updateOtherField(groupName, wrapperId, inputName);
    });
}

function updateOdorDescription() {
    const selected = document.querySelector('input[name="odor_level"]:checked');
    const wrapper = document.getElementById("odor-description-wrap");
    const shouldShow = selected && selected.value !== "none";
    wrapper.classList.toggle("hidden", !shouldShow);
    if (!shouldShow) {
        document.getElementById("odor_description").value = "";
    }
}

function initializeOdorField() {
    document.querySelectorAll('input[name="odor_level"]').forEach((input) => {
        input.addEventListener("change", updateOdorDescription);
    });
    updateOdorDescription();
}

function updateHvacSpeedField() {
    const selectedMode = document.querySelector('input[name="hvac_mode"]:checked');
    const speedWrapper = document.getElementById("hvac-speed-wrap");
    const speedInputs = Array.from(document.querySelectorAll('input[name="hvac_speed"]'));
    const needsSpeed = ["fan", "cooling", "heating"].includes(selectedMode?.value);

    speedWrapper.classList.toggle("hidden", !needsSpeed);
    speedInputs.forEach((input, index) => {
        input.required = needsSpeed && index === 0;
        if (!needsSpeed) input.checked = false;
    });
}

function initializeHvacFields() {
    document.querySelectorAll('input[name="hvac_mode"]').forEach((input) => {
        input.addEventListener("change", updateHvacSpeedField);
    });
    updateHvacSpeedField();
}

function updateClosingReasonField() {
    const selected = document.querySelector(
        'input[name="window_closed_since_previous"]:checked'
    );
    const wrapper = document.getElementById("closing-reason-wrap");
    const reasonInputs = Array.from(
        document.querySelectorAll('input[name="window_closing_reason"]')
    );
    const needsReason = selected?.value === "yes";

    wrapper.classList.toggle("hidden", !needsReason);
    reasonInputs.forEach((input, index) => {
        input.required = needsReason && index === 0;
        if (!needsReason) input.checked = false;
    });

    if (!needsReason) {
        document.getElementById("window_closing_reason_other").value = "";
        document.getElementById("window-closing-reason-other-wrap")
            .classList.add("hidden");
    }
}

function initializeClosingReasonField() {
    document.querySelectorAll(
        'input[name="window_closed_since_previous"]'
    ).forEach((input) => {
        input.addEventListener("change", updateClosingReasonField);
    });
    updateClosingReasonField();
}

function updateWizard() {
    steps.forEach((step, index) => {
        step.classList.toggle("active", index === currentStepIndex);
    });

    const stepNumber = currentStepIndex + 1;
    progressLabel.textContent = `سؤال ${stepNumber} از ${steps.length}`;
    progressBar.style.width = `${(stepNumber / steps.length) * 100}%`;

    previousButton.classList.toggle("hidden", currentStepIndex === 0);
    nextButton.classList.toggle("hidden", currentStepIndex === steps.length - 1);
    submitButton.classList.toggle("hidden", currentStepIndex !== steps.length - 1);
    formError.textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateCurrentStep() {
    const currentStep = steps[currentStepIndex];
    const requiredGroups = new Set(
        Array.from(currentStep.querySelectorAll('input[type="radio"][required]'))
            .map((input) => input.name)
    );

    for (const groupName of requiredGroups) {
        const selected = currentStep.querySelector(`input[name="${groupName}"]:checked`);
        if (!selected) {
            formError.textContent = "لطفاً یک گزینه انتخاب کنید.";
            return false;
        }
    }

    const requiredTextFields = currentStep.querySelectorAll(
        'textarea[required], input[type="text"][required]'
    );

    for (const field of requiredTextFields) {
        if (!field.value.trim()) {
            formError.textContent = "لطفاً گزینه «سایر» را توضیح دهید.";
            field.focus();
            return false;
        }
    }

    formError.textContent = "";
    return true;
}

async function loadSurvey() {
    if (!eventId || !accessToken) {
        showError("شناسه پرسشنامه یا توکن ساکن در لینک وجود ندارد.");
        return;
    }

    const { data, error } = await client.rpc("get_daily_survey", {
        p_event_id: eventId,
        p_access_token: accessToken,
    });

    if (error) {
        console.error(error);
        showError("ارتباط با سرور ابری برقرار نشد. اتصال اینترنت را بررسی کنید.");
        return;
    }

    const survey = Array.isArray(data) ? data[0] : data;

    if (!survey) {
        showError("این لینک معتبر نیست یا پرسشنامه منقضی شده است.");
        return;
    }

    loadedSurvey = survey;
    document.getElementById("scheduled-time").textContent =
        formatDateTime(survey.scheduled_at);
    document.getElementById("occupant-code").textContent =
        `کد ناشناس شما: ${survey.occupant_code}`;

    const badge = document.getElementById("survey-slot-badge");
    badge.textContent = slotLabel(survey.survey_slot);
    badge.classList.remove("hidden");

    if (survey.survey_status === "COMPLETED") {
        showView("success");
        return;
    }

    if (["EXPIRED", "UNANSWERED", "CLOSED"].includes(survey.survey_status)) {
        showView("closed");
        return;
    }

    showView("intro");
}

function getTehranTimestamp() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(now);

    const values = Object.fromEntries(
        parts.filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}` +
        `T${values.hour}:${values.minute}:${values.second}+03:30`;
}

function numericValue(formData, key) {
    const value = formData.get(key);
    return value === null || value === "" ? null : Number(value);
}

async function submitSurvey(event) {
    event.preventDefault();
    if (!validateCurrentStep()) return;

    const formData = new FormData(event.currentTarget);
    const hvacMode = formData.get("hvac_mode");
    const closedWindow = formData.get("window_closed_since_previous");
    const closingReason = closedWindow === "yes"
        ? formData.get("window_closing_reason")
        : null;

    const answers = {
        questionnaire_version: "DAILY_SURVEY_V1",
        survey_slot: loadedSurvey?.survey_slot || null,
        survey_date: loadedSurvey?.survey_date || null,

        current_room: formData.get("current_room"),
        current_room_other: formData.get("current_room") === "other"
            ? String(formData.get("current_room_other") || "").trim()
            : null,
        occupancy_count: formData.get("occupancy_count"),
        clothing_level: formData.get("clothing_level"),

        thermal_sensation: numericValue(formData, "thermal_sensation"),
        thermal_preference: numericValue(formData, "thermal_preference"),
        temperature_satisfaction: numericValue(formData, "temperature_satisfaction"),
        air_freshness: numericValue(formData, "air_freshness"),
        air_movement: numericValue(formData, "air_movement"),
        humidity_perception: numericValue(formData, "humidity_perception"),

        odor_level: formData.get("odor_level"),
        odor_description: formData.get("odor_level") !== "none"
            ? String(formData.get("odor_description") || "").trim() || null
            : null,

        light_level: numericValue(formData, "light_level"),
        glare_level: numericValue(formData, "glare_level"),
        noise_level: numericValue(formData, "noise_level"),

        hvac_mode: hvacMode,
        hvac_speed: ["fan", "cooling", "heating"].includes(hvacMode)
            ? formData.get("hvac_speed")
            : null,
        hvac_status: ["fan", "cooling", "heating"].includes(hvacMode)
            ? `${hvacMode}_${formData.get("hvac_speed")}`
            : hvacMode,

        airflow_source: formData.get("airflow_source"),
        airflow_source_other: formData.get("airflow_source") === "other"
            ? String(formData.get("airflow_source_other") || "").trim()
            : null,

        sleepiness: numericValue(formData, "sleepiness"),
        overall_comfort: numericValue(formData, "overall_comfort"),

        window_closed_since_previous: closedWindow,
        window_closing_reason: closingReason,
        window_closing_reason_other: closingReason === "other"
            ? String(formData.get("window_closing_reason_other") || "").trim()
            : null,

        answer_client_submitted_at: getTehranTimestamp(),
        answer_client_submitted_at_utc: new Date().toISOString(),
        answer_client_timezone: "Asia/Tehran",
    };

    setBusy(submitButton, true);

    const { data, error } = await client.rpc("submit_daily_survey", {
        p_event_id: eventId,
        p_access_token: accessToken,
        p_answers: answers,
    });

    setBusy(submitButton, false);

    if (error) {
        console.error(error);
        formError.textContent =
            "پاسخ ذخیره نشد. اینترنت را بررسی کرده و دوباره تلاش کنید.";
        return;
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (result?.success === false) {
        formError.textContent = result.message || "امکان ثبت پاسخ وجود ندارد.";
        return;
    }

    showView("success");
}

document.getElementById("start-button").addEventListener("click", () => {
    currentStepIndex = 0;
    showView("survey");
    updateWizard();
});

previousButton.addEventListener("click", () => {
    if (currentStepIndex > 0) {
        currentStepIndex -= 1;
        updateWizard();
    }
});

nextButton.addEventListener("click", () => {
    if (!validateCurrentStep()) return;
    if (currentStepIndex < steps.length - 1) {
        currentStepIndex += 1;
        updateWizard();
    }
});

document.getElementById("survey-form")
    .addEventListener("submit", submitSurvey);

initializeOtherFields();
initializeOdorField();
initializeHvacFields();
initializeClosingReasonField();
loadSurvey();
