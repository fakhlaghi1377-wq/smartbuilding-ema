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
    Object.values(views).forEach((view) => {
        if (view) {
            view.classList.remove("active");
        }
    });

    if (views[name]) {
        views[name].classList.add("active");
    }
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
        ["opening_reason", "opening-reason-other-wrap", "opening_reason_other"],
        ["activity", "activity-other-wrap", "activity_other"],
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

    const selected = document.querySelector(
        'input[name="odor_level"]:checked'
    );

    const wrapper = document.getElementById(
        "odor-description-wrap"
    );

    const descriptionInput = document.getElementById(
        "odor_description"
    );

    if (!wrapper) {
        return;
    }

    const shouldShow =
        selected && selected.value !== "none";

    wrapper.classList.toggle(
        "hidden",
        !shouldShow
    );

    if (!shouldShow && descriptionInput) {
        descriptionInput.value = "";
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

    const wrapper = document.getElementById(
        "closing-reason-wrap"
    );

    const reasonInputs = Array.from(
        document.querySelectorAll(
            'input[name="window_closing_reason"]'
        )
    );

    const needsReason = selected?.value === "yes";

    if (wrapper) {
        wrapper.classList.toggle(
            "hidden",
            !needsReason
        );
    }

    reasonInputs.forEach((input, index) => {
        input.required = needsReason && index === 0;

        if (!needsReason) {
            input.checked = false;
        }
    });

    const otherInput = document.getElementById(
        "window_closing_reason_other"
    );

    const otherWrap = document.getElementById(
        "window-closing-reason-other-wrap"
    );

    if (!needsReason) {
        if (otherInput) {
            otherInput.value = "";
        }

        if (otherWrap) {
            otherWrap.classList.add("hidden");
        }
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

    if (previousButton) {
        previousButton.classList.toggle("hidden", currentStepIndex === 0);
    }

    if (nextButton) {
        nextButton.classList.toggle("hidden", currentStepIndex === steps.length - 1);
    }

    if (submitButton) {
        submitButton.classList.toggle("hidden", currentStepIndex !== steps.length - 1);
    }

    if (formError) {
        formError.textContent = "";
    }
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
    if (!accessToken) {
        showError("توکن پرسشنامه در لینک وجود ندارد.");
        return;
    }

    let survey;
    try {
        const loaded = await window.CloudSurveyApi.load(accessToken, eventId);
        survey = loaded.event;
    } catch (error) {
        console.error(error);
        showError("پرسشنامه هنوز روی این گوشی ذخیره نشده و ارتباط اینترنتی برقرار نیست.");
        return;
    }

    if (!survey) {
        showError("این لینک معتبر نیست یا پرسشنامه منقضی شده است.");
        return;
    }

    loadedSurvey = survey;
    const scheduledTime = document.getElementById("event-time");
    if (scheduledTime) {
        scheduledTime.textContent =
            formatDateTime(
                survey.scheduled_for ||
                survey.window_opened_at ||
                survey.created_at
            );
    }

    const occupantCode = document.getElementById("occupant-code");
    if (occupantCode) {
        occupantCode.textContent =
            `کد ناشناس شما: ${survey.occupant_code || '---'}`;
    }

    const badge = document.getElementById("survey-slot-badge");
    if (badge) {
        badge.textContent = slotLabel(survey.survey_slot);
        badge.classList.remove("hidden");
    }

    if ((survey.status === "COMPLETED" || survey.status === "COMPLETED")) {
        showView("success");
        return;
    }

    if (["EXPIRED", "UNANSWERED", "CLOSED"].includes(survey.status)) {
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
    const answers = {
        questionnaire_version:
            loadedSurvey?.questionnaire_version || "EMA_WINDOW_OPEN_V2_3",

        opening_reason: formData.get("opening_reason"),
        opening_reason_other: formData.get("opening_reason") === "other"
            ? String(formData.get("opening_reason_other") || "").trim()
            : null,

        activity: formData.get("activity"),
        activity_other: formData.get("activity") === "other"
            ? String(formData.get("activity_other") || "").trim()
            : null,

        thermal_sensation: numericValue(formData, "thermal_sensation"),
        thermal_preference: numericValue(formData, "thermal_preference"),
        air_freshness: numericValue(formData, "air_freshness"),
        air_movement: numericValue(formData, "air_movement"),

        hvac_mode: hvacMode,
        hvac_speed: ["fan", "cooling", "heating"].includes(hvacMode)
            ? formData.get("hvac_speed")
            : null,

        air_source: formData.get("air_source"),
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
        formError.textContent =
            error?.data?.message || "این پرسشنامه بسته یا منقضی شده است.";
    }
}

function safeAddEventListener(element, event, callback) {
    if (element) {
        element.addEventListener(event, callback);
    }
}

const startButton = document.getElementById("start-button");
const claimButton = document.getElementById("claim-button");
const declineButton = document.getElementById("decline-button");
const unsureButton = document.getElementById("unsure-button");

function startQuestionnaire() {
    currentStepIndex = 0;
    showView("survey");
    updateWizard();
}

safeAddEventListener(startButton, "click", startQuestionnaire);
safeAddEventListener(claimButton, "click", startQuestionnaire);

safeAddEventListener(declineButton, "click", () => {
    showView("success");
});

safeAddEventListener(unsureButton, "click", () => {
    showView("success");
});

safeAddEventListener(previousButton, "click", () => {
    if (currentStepIndex > 0) {
        currentStepIndex -= 1;
        updateWizard();
    }
});

safeAddEventListener(nextButton, "click", () => {
    if (!validateCurrentStep()) return;
    if (currentStepIndex < steps.length - 1) {
        currentStepIndex += 1;
        updateWizard();
    }
});

const surveyForm = document.getElementById("survey-form");

safeAddEventListener(surveyForm, "submit", submitSurvey);

initializeOtherFields();
initializeHvacFields();
loadSurvey();
