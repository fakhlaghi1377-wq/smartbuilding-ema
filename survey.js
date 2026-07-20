// Replace these two values with your Supabase project settings.
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

function showView(name) {
    Object.values(views).forEach((view) => {
        view.classList.remove("active");
    });
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

async function loadSurvey() {
    if (!eventId || !accessToken) {
        showError("شناسه رویداد یا توکن ساکن در لینک وجود ندارد.");
        return;
    }

    if (
        SUPABASE_URL.includes("YOUR_PROJECT") ||
        SUPABASE_PUBLISHABLE_KEY.includes("YOUR_PUBLISHABLE")
    ) {
        showError("تنظیمات اتصال Supabase هنوز در فایل survey.js وارد نشده است.");
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
        showView("survey");
    } else {
        showView("closed");
    }
}

async function recordNonClaim(responseType, button) {
    setBusy(button, true);

    const { data, error } = await client.rpc("decline_window_survey", {
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

async function submitSurvey(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const formError = document.getElementById("form-error");
    const submitButton = document.getElementById("submit-button");

    if (!form.reportValidity()) {
        formError.textContent = "لطفاً برای همه سؤال‌ها یک گزینه انتخاب کنید.";
        return;
    }

    formError.textContent = "";
    setBusy(submitButton, true);

    const formData = new FormData(form);
    const answers = {
        opening_reason: formData.get("opening_reason"),
        thermal_sensation: Number(formData.get("thermal_sensation")),
        air_quality: Number(formData.get("air_quality")),
        expected_duration: formData.get("expected_duration"),
        client_submitted_at: new Date().toISOString(),
    };

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
        formError.textContent =
            result?.message || "امکان ثبت پاسخ وجود ندارد.";
    }
}

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
