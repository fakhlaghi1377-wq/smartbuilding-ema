const params = new URLSearchParams(window.location.search);
const eventId = params.get("event");
const accessToken = params.get("token");

const views = {
    loading: document.getElementById("loading-view"),
    error: document.getElementById("error-view"),
    intro: document.getElementById("intro-view"),
    survey: document.getElementById("survey-form"),
    success: document.getElementById("success-view"),
    closed: document.getElementById("closed-view")
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
    Object.values(views).forEach(function (view) {
        if (view) view.classList.remove("active");
    });
    if (views[name]) views[name].classList.add("active");
}

function setBusy(button, busy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? "در حال ثبت..." : button.dataset.originalText;
}

function showError(message) {
    document.getElementById("error-message").textContent = message;
    showView("error");
}

function formatDateTime(value) {
    if (!value) return "زمان نامشخص";
    return new Date(value).toLocaleString("fa-IR", {
        timeZone: "Asia/Tehran",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    });
}

function slotLabel(slot) {
    const labels = {
        morning: "نوبت صبح؛ ساعت ۹",
        afternoon: "نوبت بعدازظهر؛ ساعت ۱۴",
        evening: "نوبت شب؛ ساعت ۲۰"
    };
    return labels[slot] || "پرسشنامه روزانه";
}

function selectedValue(name) {
    const input = document.querySelector(`input[name="${name}"]:checked`);
    return input ? input.value : null;
}

function visibleSteps() {
    return allSteps.filter(function (step) {
        if (step.dataset.condition === "air-source") {
            return selectedValue("air_movement") === "1";
        }
        if (step.dataset.condition === "closing-reason") {
            return selectedValue("window_closed_since_previous") === "yes";
        }
        return true;
    });
}

function currentStepElement() {
    const steps = visibleSteps();
    return steps[currentStepIndex] || null;
}

function syncCurrentStep(previousStepElement) {
    const steps = visibleSteps();

    if (previousStepElement) {
        const preservedIndex = steps.indexOf(previousStepElement);
        if (preservedIndex !== -1) {
            currentStepIndex = preservedIndex;
        }
    }

    if (currentStepIndex >= steps.length) {
        currentStepIndex = Math.max(0, steps.length - 1);
    }
}

function clearRadioGroup(name) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(function (input) {
        input.checked = false;
    });
}

function updateConditionalAnswers() {
    const feelsAir = selectedValue("air_movement") === "1";
    const airflowInputs = Array.from(document.querySelectorAll('input[name="airflow_source"]'));
    airflowInputs.forEach(function (input, index) {
        input.required = feelsAir && index === 0;
    });
    if (!feelsAir) clearRadioGroup("airflow_source");

    const closedByUser = selectedValue("window_closed_since_previous") === "yes";
    const reasonInputs = Array.from(document.querySelectorAll('input[name="window_closing_reason"]'));
    reasonInputs.forEach(function (input, index) {
        input.required = closedByUser && index === 0;
    });
    if (!closedByUser) {
        clearRadioGroup("window_closing_reason");
        document.getElementById("window_closing_reason_other").value = "";
        document.getElementById("window-closing-reason-other-wrap").classList.add("hidden");
    }
}

function updateOtherField(groupName, wrapperId, inputName) {
    const wrapper = document.getElementById(wrapperId);
    const input = document.querySelector(`[name="${inputName}"]`);
    if (!wrapper || !input) return;
    const show = selectedValue(groupName) === "other";
    wrapper.classList.toggle("hidden", !show);
    input.required = show;
    if (!show) input.value = "";
}

function initializeOtherFields() {
    [
        ["current_room", "current-room-other-wrap", "current_room_other"],
        ["window_closing_reason", "window-closing-reason-other-wrap", "window_closing_reason_other"]
    ].forEach(function (config) {
        const groupName = config[0], wrapperId = config[1], inputName = config[2];
        document.querySelectorAll(`input[name="${groupName}"]`).forEach(function (input) {
            input.addEventListener("change", function () {
                updateOtherField(groupName, wrapperId, inputName);
            });
        });
        updateOtherField(groupName, wrapperId, inputName);
    });
}

function updateWizard(previousStepElement) {
    updateConditionalAnswers();
    syncCurrentStep(previousStepElement);

    const steps = visibleSteps();
    const activeStep = steps[currentStepIndex];

    allSteps.forEach(function (step) {
        step.classList.remove("active");
    });

    if (!activeStep) {
        formError.textContent = "خطا در نمایش مرحله پرسشنامه.";
        return;
    }

    activeStep.classList.add("active");

    const number = currentStepIndex + 1;
    progressLabel.textContent = `سؤال ${number} از ${steps.length}`;
    progressBar.style.width = `${(number / steps.length) * 100}%`;

    const isLastStep = currentStepIndex === steps.length - 1;
    previousButton.classList.toggle("hidden", currentStepIndex === 0);
    nextButton.classList.toggle("hidden", isLastStep);
    submitButton.classList.toggle("hidden", !isLastStep);

    formError.textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateCurrentStep() {
    const step = visibleSteps()[currentStepIndex];

    const requiredGroups = new Set(
        Array.from(step.querySelectorAll('input[type="radio"][required]'))
            .map(function (input) { return input.name; })
    );

    for (const groupName of requiredGroups) {
        if (!step.querySelector(`input[name="${groupName}"]:checked`)) {
            formError.textContent = "لطفاً یک گزینه انتخاب کنید.";
            return false;
        }
    }

    const textFields = step.querySelectorAll('textarea[required], input[type="text"][required]');
    for (const field of textFields) {
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
    if (!window.CloudSurveyApi || typeof window.CloudSurveyApi.load !== "function") {
        showError("فایل cloud-survey.js بارگذاری نشده است.");
        return;
    }

    try {
        const loaded = await window.CloudSurveyApi.load(accessToken, eventId);
        loadedSurvey = loaded.event;
    } catch (error) {
        console.error(error);
        showError("پرسشنامه بارگذاری نشد. اتصال اینترنت را بررسی کنید.");
        return;
    }

    if (!loadedSurvey) {
        showError("این لینک معتبر نیست یا پرسشنامه منقضی شده است.");
        return;
    }

    document.getElementById("scheduled-time").textContent =
        formatDateTime(loadedSurvey.scheduled_for || loadedSurvey.created_at);
    document.getElementById("occupant-code").textContent =
        `کد ناشناس شما: ${loadedSurvey.occupant_code || "ناشناس"}`;

    const badge = document.getElementById("survey-slot-badge");
    badge.textContent = slotLabel(loadedSurvey.survey_slot);
    badge.classList.remove("hidden");

    if (loadedSurvey.status === "COMPLETED") {
        showView("success");
        return;
    }

    if (["EXPIRED", "UNANSWERED", "CLOSED"].includes(loadedSurvey.status)) {
        showView("closed");
        return;
    }

    showView("intro");
}

function getTehranTimestamp() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tehran",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(now);

    const values = Object.fromEntries(
        parts.filter(function (part) { return part.type !== "literal"; })
            .map(function (part) { return [part.type, part.value]; })
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

    const activeStep = currentStepElement();
    const windowAnswer = selectedValue("window_closed_since_previous");

    if (
        activeStep &&
        activeStep.dataset.question === "13" &&
        windowAnswer === "yes"
    ) {
        const steps = visibleSteps();
        const question14Index = steps.findIndex(function (step) {
            return step.dataset.question === "14";
        });

        if (question14Index !== -1) {
            currentStepIndex = question14Index;
            updateWizard();
            formError.textContent = "لطفاً دلیل اصلی بستن پنجره را انتخاب کنید.";
        }
        return;
    }

    if (!validateCurrentStep()) return;

    const formData = new FormData(event.currentTarget);
    const feelsAir = formData.get("air_movement") === "1";
    const closedWindow = formData.get("window_closed_since_previous");
    const closingReason = closedWindow === "yes"
        ? formData.get("window_closing_reason")
        : null;

    const answers = {
        questionnaire_version: "DAILY_SURVEY_V4_ICONS_Q13_TWO_OPTIONS",
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
        airflow_source: feelsAir ? formData.get("airflow_source") : "none",
        airflow_source_other: null,

        light_level: numericValue(formData, "light_level"),
        sleepiness: numericValue(formData, "sleepiness"),
        overall_comfort: numericValue(formData, "overall_comfort"),

        window_closed_since_previous: closedWindow,
        window_closing_reason: closingReason,
        window_closing_reason_other: closingReason === "other"
            ? String(formData.get("window_closing_reason_other") || "").trim()
            : null,

        answer_client_submitted_at: getTehranTimestamp(),
        answer_client_submitted_at_utc: new Date().toISOString(),
        answer_client_timezone: "Asia/Tehran"
    };

    if (closedWindow === "yes" && !closingReason) {
        const steps = visibleSteps();
        const question14Index = steps.findIndex(function (step) {
            return step.dataset.question === "14";
        });

        if (question14Index !== -1) {
            currentStepIndex = question14Index;
            updateWizard();
        }

        formError.textContent = "لطفاً دلیل اصلی بستن پنجره را انتخاب کنید.";
        return;
    }

    setBusy(submitButton, true);

    try {
        const submitted = await window.CloudSurveyApi.submit(accessToken, eventId, answers);
        setBusy(submitButton, false);
        if (submitted.queued) {
            document.querySelector("#success-view p").textContent =
                "پاسخ روی گوشی ذخیره شد و پس از اتصال اینترنت خودکار ارسال می‌شود.";
        }
        showView("success");
    } catch (error) {
        console.error(error);
        setBusy(submitButton, false);
        formError.textContent =
            (error && error.data && error.data.message) ||
            "ثبت پاسخ انجام نشد. دوباره تلاش کنید.";
    }
}

function safeAddEventListener(element, eventName, callback) {
    if (element) element.addEventListener(eventName, callback);
}

safeAddEventListener(document.getElementById("start-button"), "click", function () {
    currentStepIndex = 0;
    showView("survey");
    updateWizard();
});

safeAddEventListener(previousButton, "click", function () {
    if (currentStepIndex > 0) {
        currentStepIndex -= 1;
        updateWizard();
    }
});

safeAddEventListener(nextButton, "click", function () {
    if (!validateCurrentStep()) return;
    const steps = visibleSteps();
    if (currentStepIndex < steps.length - 1) {
        currentStepIndex += 1;
        updateWizard();
    }
});

document.querySelectorAll('input[name="air_movement"], input[name="window_closed_since_previous"]')
    .forEach(function (input) {
        input.addEventListener("change", function () {
            const activeStepBeforeChange = allSteps.find(function (step) {
                return step.classList.contains("active");
            });

            updateConditionalAnswers();
            updateWizard(activeStepBeforeChange);
        });
    });

safeAddEventListener(document.getElementById("survey-form"), "submit", submitSurvey);

initializeOtherFields();
updateConditionalAnswers();
loadSurvey();
