/*
 * This publishable key is intended for browser use.
 * Never put a service_role key, secret key, or database password here.
 * Data access is enforced by the RLS policies in supabase-security.sql.
 */
window.SMART_BUILDING_CONFIG = Object.freeze({
    SUPABASE_URL: "https://rarytoivpexnqfdtebsx.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_Mv7kzCdhAytHLGszxBDpeA_zEoexIiC",
    ENVIRONMENT_TABLE: "environment_readings",
    DEVICE_ID: "ENV_ROOM_01",
    DISPLAY_TIME_ZONE: "Asia/Tehran",
    REFRESH_INTERVAL_MS: 30000,
    PAGE_SIZE: 1000,
    MAX_HISTORY_ROWS: 10000
});
