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
    claim: document.getElementById("claim-view"),
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
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
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
        Array.from(currentStep.querySelectorAll("input[required]"))
            .map((input) => input.name)
    );

    for (const groupName of requiredGroups) {
        const selected = currentStep.querySelector(`input[name="${groupName}"]:checked`);
        if (!selected) {
            formError.textContent = "لطفاً یک گزینه انتخاب کنید.";
            return false;
        }
    }

    formError.textContent = "";
    return true;
}

async function loadSurvey() {
    if (!eventId || !accessToken) {
        showError("شناسه رویداد یا توکن ساکن در لینک وجود ندارد.");
        return;
    }

    if (!SUPABASE_URL.startsWith("https://") || !SUPABASE_PUBLISHABLE_KEY) {
        showError("تنظیمات اتصال Supabase صحیح نیست.");
        return;
    }

    const { data, error } = await client.rpc("get_window_survey", {
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
        showError("این لینک معتبر نیست یا ساکن غیرفعال شده است.");
        return;
    }

    document.getElementById("event-time").textContent =
        formatDateTime(survey.window_opened_at);
    document.getElementById("occupant-code").textContent =
        `کد ناشناس شما: ${survey.occupant_code}`;

    if (survey.survey_status === "PENDING") {
        showView("claim");
        return;
    }

    if (
        survey.survey_status === "CLAIMED" &&
        survey.already_claimed_by_this_occupant
    ) {
        showView("survey");
        updateWizard();
        return;
    }

    if (
        survey.survey_status === "COMPLETED" &&
        survey.already_claimed_by_this_occupant
    ) {
        showView("success");
        return;
    }

    showView("closed");
}

async function claimSurvey() {
    const button = document.getElementById("claim-button");
    setBusy(button, true);

    const { data, error } = await client.rpc("claim_window_survey", {
        p_event_id: eventId,
        p_access_token: accessToken,
    });

    setBusy(button, false);

    if (error) {
        console.error(error);
        showError("ثبت پذیرش پرسشنامه انجام نشد.");
        return;
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (result?.success) {
        currentStepIndex = 0;
        showView("survey");
        updateWizard();
    } else {
        showView("closed");
    }
}

async function recordNonClaim(responseType, button) {
    setBusy(button, true);

    const { error } = await client.rpc("decline_window_survey", {
        p_event_id: eventId,
        p_access_token: accessToken,
        p_response_type: responseType,
    });

    setBusy(button, false);

    if (error) {
        console.error(error);
        showError("ثبت پاسخ انجام نشد.");
        return;
    }

    showView("success");
}

function numericValue(formData, key) {
    const value = formData.get(key);
    return value === null ? null : Number(value);
}

async function submitSurvey(event) {
    event.preventDefault();

    if (!validateCurrentStep()) return;

    const form = event.currentTarget;
    const formData = new FormData(form);

    const answers = {
        questionnaire_version: "EMA_WINDOW_OPEN_V2",
        opening_reason: formData.get("opening_reason"),
        activity: formData.get("activity"),
        thermal_sensation: numericValue(formData, "thermal_sensation"),
        thermal_preference: numericValue(formData, "thermal_preference"),
        air_freshness: numericValue(formData, "air_freshness"),
        air_movement: numericValue(formData, "air_movement"),
        hvac_status: formData.get("hvac_status"),
        air_source: formData.get("air_source"),
        overall_comfort: numericValue(formData, "overall_comfort"),
        client_submitted_at: new Date().toISOString(),
    };

    setBusy(submitButton, true);

    const { data, error } = await client.rpc("submit_window_survey", {
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

    if (result?.success) {
        showView("success");
    } else {
        formError.textContent = result?.message || "امکان ثبت پاسخ وجود ندارد.";
    }
}

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

document.getElementById("claim-button")
    .addEventListener("click", claimSurvey);

document.getElementById("decline-button")
    .addEventListener("click", (event) =>
        recordNonClaim("DECLINED", event.currentTarget)
    );

document.getElementById("unsure-button")
    .addEventListener("click", (event) =>
        recordNonClaim("UNSURE", event.currentTarget)
    );

document.getElementById("survey-form")
    .addEventListener("submit", submitSurvey);

loadSurvey();
