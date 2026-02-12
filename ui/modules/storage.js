export const KEYS = {
  LANG_KEY: "stats_ui_lang",
  SYSROWS_CFG_KEY: "stats_ui_sysrows",
  POLL_CFG_KEY: "stats_ui_poll_sec",
  HISTORY_CFG_KEY: "stats_ui_history_minutes",
  HISTORY_STATE_KEY: "stats_ui_history_state_v1",
  CARDS_CFG_KEY: "stats_ui_cards_visible_v1",
  SPARK_VIS_KEY: "stats_ui_spark_vis_v1",
  RAW_OPEN_KEY: "stats_ui_raw_open",
  THEME_KEY: "stats-ui-theme",
  LAYOUT_EDIT_KEY: "stats_ui_layout_edit_v1",
  CARDS_ORDER_KEY: "stats_ui_cards_order_v1",
  DISK_COLS_KEY: "stats_ui_disk_cols",
  DISK_LAYOUT_KEY_PREFIX: "stats_ui_disks_layout_v1_cols_",
};

// Read a string value from localStorage with fallback
export function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Write a string value to localStorage
export function lsSet(key, val) {
  try {
    localStorage.setItem(key, String(val));
  } catch {}
}

// Read a JSON value from localStorage with fallback
export function lsGetJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Write a JSON value to localStorage
export function lsSetJson(key, obj) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {}
}
