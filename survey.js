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

const allSteps = Array.from(document.querySelectorAll(".survey-step"));
const previousButton = document.getElementById("previous-button");
const nextButton = document.getElementById("next-button");
const submitButton = document.getElementById("submit-button");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const formError = document.getElementById("form-error");
let currentStepIndex = 0;
let loadedSurvey = null;

function showView(name) {
    Object.values(views).forEach(view => view?.classList.remove("active"));
    views[name]?.classList.add("active");
}

function setBusy(button, busy) {
    if (!button) return;
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
    return new Date(value).toLocaleString("fa-IR", {
        timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
    });
}

function updateOtherField() {
    const selected = document.querySelector('input[name="opening_reason"]:checked');
    const wrapper = document.getElementById("opening-reason-other-wrap");
    const input = document.getElementById("opening_reason_other");
    const show = selected?.value === "other";
    wrapper?.classList.toggle("hidden", !show);
    if (input) {
        input.required = show;
        if (!show) input.value = "";
    }
}

document.querySelectorAll('input[name="opening_reason"]').forEach(input => {
    input.addEventListener("change", updateOtherField);
});

function shouldShowAirSourceStep() {
    return document.querySelector('input[name="air_movement"]:checked')?.value === "1";
}

function getVisibleSteps() {
    return allSteps.filter(step => {
        if (step.dataset.conditional === "air-source") {
            return shouldShowAirSourceStep();
        }
        return true;
    });
}

function updateAirSourceRequirement() {
    const movement = document.querySelector('input[name="air_movement"]:checked')?.value;
    const sourceInputs = Array.from(document.querySelectorAll('input[name="air_source"]'));
    const sourceStep = document.getElementById("air-source-step");

    if (movement === "0") {
        sourceInputs.forEach(input => {
            input.required = false;
            input.checked = false;
        });
        sourceStep?.classList.remove("active");
    } else if (movement === "1") {
        sourceInputs.forEach((input, index) => {
            input.required = index === 0;
        });
    } else {
        sourceInputs.forEach(input => {
            input.required = false;
            input.checked = false;
        });
    }
}


document.querySelectorAll('input[name="air_movement"]').forEach(input => {
    input.addEventListener("change", () => {
        updateAirSourceRequirement();
        if (views.survey?.classList.contains("active")) updateWizard();
    });
});

function updateWizard() {
    const visibleSteps = getVisibleSteps();
    currentStepIndex = Math.min(currentStepIndex, Math.max(visibleSteps.length - 1, 0));
    allSteps.forEach(step => step.classList.remove("active"));
    visibleSteps[currentStepIndex]?.classList.add("active");
    const number = currentStepIndex + 1;
    progressLabel.textContent = `سؤال ${number} از ${visibleSteps.length}`;
    progressBar.style.width = `${(number / visibleSteps.length) * 100}%`;
    previousButton?.classList.toggle("hidden", currentStepIndex === 0);
    nextButton?.classList.toggle("hidden", currentStepIndex === visibleSteps.length - 1);
    submitButton?.classList.toggle("hidden", currentStepIndex !== visibleSteps.length - 1);
    formError.textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateCurrentStep() {
    const currentStep = getVisibleSteps()[currentStepIndex];
    const requiredGroups = new Set(
        Array.from(currentStep.querySelectorAll('input[type="radio"][required]')).map(input => input.name)
    );
    for (const name of requiredGroups) {
        if (!currentStep.querySelector(`input[name="${name}"]:checked`)) {
            formError.textContent = "لطفاً یک گزینه انتخاب کنید.";
            return false;
        }
    }
    for (const field of currentStep.querySelectorAll('textarea[required], input[type="text"][required]')) {
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
    if (!accessToken) return showError("توکن پرسشنامه در لینک وجود ندارد.");
    try {
        const loaded = await window.CloudSurveyApi.load(accessToken, eventId);
        loadedSurvey = loaded.event;
    } catch (error) {
        console.error(error);
        return showError("پرسشنامه هنوز روی این گوشی ذخیره نشده و ارتباط اینترنتی برقرار نیست.");
    }
    if (!loadedSurvey) return showError("این لینک معتبر نیست یا پرسشنامه منقضی شده است.");

    document.getElementById("event-time").textContent = formatDateTime(
        loadedSurvey.scheduled_for || loadedSurvey.window_opened_at || loadedSurvey.created_at
    );
    document.getElementById("occupant-code").textContent = `کد ناشناس شما: ${loadedSurvey.occupant_code || "---"}`;

    if (loadedSurvey.status === "COMPLETED") return showView("success");
    if (["EXPIRED", "UNANSWERED", "CLOSED"].includes(loadedSurvey.status)) return showView("closed");
    showView("intro");
}

function getTehranTimestamp() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+03:30`;
}

function numericValue(formData, key) {
    const value = formData.get(key);
    return value === null || value === "" ? null : Number(value);
}

async function submitSurvey(event) {
    event.preventDefault();
    if (!validateCurrentStep()) return;
    const formData = new FormData(event.currentTarget);
    const answers = {
        questionnaire_version: loadedSurvey?.questionnaire_version || "EMA_WINDOW_OPEN_GRAPHIC_V1",
        opening_reason: formData.get("opening_reason"),
        opening_reason_other: formData.get("opening_reason") === "other"
            ? String(formData.get("opening_reason_other") || "").trim() : null,
        activity: formData.get("activity"),
        activity_other: null,
        thermal_sensation: numericValue(formData, "thermal_sensation"),
        thermal_preference: numericValue(formData, "thermal_preference"),
        air_freshness: numericValue(formData, "air_freshness"),
        air_movement: numericValue(formData, "air_movement"),
        hvac_mode: null,
        hvac_speed: null,
        air_source: formData.get("air_movement") === "0" ? "none" : formData.get("air_source"),
        overall_comfort: numericValue(formData, "overall_comfort"),
        answer_client_submitted_at: getTehranTimestamp(),
        answer_client_submitted_at_utc: new Date().toISOString(),
        answer_client_timezone: "Asia/Tehran",
    };

    setBusy(submitButton, true);
    try {
        const submitted = await window.CloudSurveyApi.submit(accessToken, eventId, answers);
        setBusy(submitButton, false);
        if (submitted.queued) {
            document.querySelector("#success-view p").textContent =
                "پاسخ روی گوشی ذخیره شد و به‌محض اتصال اینترنت خودکار ارسال می‌شود.";
        }
        showView("success");
    } catch (error) {
        console.error(error);
        setBusy(submitButton, false);
        formError.textContent = error?.data?.message || "این پرسشنامه بسته یا منقضی شده است.";
    }
}

function safeOn(element, event, callback) { element?.addEventListener(event, callback); }
function startQuestionnaire() { currentStepIndex = 0; showView("survey"); updateWizard(); }

safeOn(document.getElementById("claim-button"), "click", startQuestionnaire);
safeOn(document.getElementById("decline-button"), "click", () => showView("success"));
safeOn(document.getElementById("unsure-button"), "click", () => showView("success"));
safeOn(previousButton, "click", () => {
    if (currentStepIndex > 0) {
        currentStepIndex--;
        updateWizard();
    }
});
safeOn(nextButton, "click", () => {
    const visibleSteps = getVisibleSteps();
    if (validateCurrentStep() && currentStepIndex < visibleSteps.length - 1) {
        currentStepIndex++;
        updateWizard();
    }
});
safeOn(document.getElementById("survey-form"), "submit", submitSurvey);

updateOtherField();
updateAirSourceRequirement();
loadSurvey();
