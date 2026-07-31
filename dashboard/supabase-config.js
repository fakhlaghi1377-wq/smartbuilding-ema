/*
 * This publishable key is intended for browser use.
 * Never put a service_role key, secret key, or database password here.
 * Data access is enforced by the RLS policies in supabase-security.sql.
 */
window.SMART_BUILDING_CONFIG = Object.freeze({
    SUPABASE_URL: "https://rarytoivpexnqfdtebsx.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_Mv7kzCdhAytHLGszxBDpeA_zEoexIiC",
    ENVIRONMENT_TABLE: "environment_readings",
    ENVIRONMENT_DEVICE_ID: "ENV_ROOM_01",
    ENERGY_TABLE: "energy_measurements",
    ENERGY_DEVICE_ID: "ESP32_CT_01",
    WINDOW_TABLE: "window_events",
    WINDOW_DEVICE_ID: "ESP32_CAM_01",
    WINDOW_IMAGE_BUCKET: "window-images",
    SURVEY_EVENTS_TABLE: "survey_events",
    OCCUPANTS_TABLE: "occupants",
    EMA_SURVEY_BASE_URL: "https://fakhlaghi1377-wq.github.io/smartbuilding-ema",
    DAILY_SURVEY_BASE_URL: "https://fakhlaghi1377-wq.github.io/smartbuilding-ema/daily.html",
    DISPLAY_TIME_ZONE: "Asia/Tehran",
    REFRESH_INTERVAL_MS: 30000,
    PAGE_SIZE: 1000,
    MAX_HISTORY_ROWS: 10000
});
