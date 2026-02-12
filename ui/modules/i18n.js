import { KEYS, lsGet, lsSet } from "./storage.js";
import { getParam } from "./util.js";

export const I18N = { lang: "en", dict: {}, locale: "en-US" };

// Map app language -> Intl locale (BCP-47)
const LOCALE_MAP = {
  en: "en-US",
  tr: "tr-TR",
  de: "de-DE",
};

// Get Intl locale for app language (BCP-47)
export function getLocale(lang = I18N.lang) {
  const base = String(lang || "en").toLowerCase().split("-")[0];
  return LOCALE_MAP[base] || LOCALE_MAP.en || "en-US";
}

// Format datetime using current locale
export function formatDateTime(d, options) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleString(I18N.locale, options);
}

// Format date using current locale
export function formatDate(d, options) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString(I18N.locale, options);
}

// Format time using current locale
export function formatTime(d, options) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleTimeString(I18N.locale, options);
}

// localized short unit labels via dict (fallback)
function unitShort(unit, n) {
  const key =
    unit === "second" ? "time.sec" :
    unit === "minute" ? "time.min" :
    unit === "hour"   ? "time.hour" :
    unit === "day"    ? "time.day" :
    unit === "month"  ? "time.month" :
    "time.year";

  const raw = (I18N.dict && I18N.dict[key]) || null;

  if (raw) return String(raw).replace(/\{n\}/g, String(n));

  if ((I18N.lang || "en").startsWith("tr")) {
    const m = { second: "sn", minute: "dk", hour: "sa", day: "gün", month: "ay", year: "yıl" };
    return `${n} ${m[unit] || unit}`;
  }

  if ((I18N.lang || "en").startsWith("de")) {
    const m = { second: "s", minute: "min", hour: "Std", day: "Tg", month: "Mon", year: "J" };
    return `${n} ${m[unit] || unit}`;
  }

  const m = { second: "s", minute: "min", hour: "h", day: "d", month: "mo", year: "y" };
  return `${n} ${m[unit] || unit}`;
}

// Format relative age string (e.g., "1h 10m ago"), localized
export function formatAge(tsMs, nowMs = Date.now(), { maxParts = 2 } = {}) {
  const ts = tsMs instanceof Date ? tsMs.getTime() : Number(tsMs);
  const now = Number(nowMs);
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(now) || now <= 0) return "—";

  let diffSec = Math.floor((now - ts) / 1000);
  const inFuture = diffSec < 0;
  diffSec = Math.abs(diffSec);

  const sec = diffSec;
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  const day = Math.floor(hour / 24);
  const month = Math.floor(day / 30);
  const year = Math.floor(day / 365);

  const parts = [];

  function push(unit, n) {
    if (n > 0 && parts.length < maxParts) parts.push(unitShort(unit, n));
  }

  if (sec < 60) {
    push("second", sec);
  } else if (min < 60) {
    push("minute", min);
  } else if (hour < 24) {
    push("hour", hour);
    push("minute", min % 60);
  } else if (day < 30) {
    push("day", day);
    push("hour", hour % 24);
  } else if (day < 365) {
    push("month", month);
    push("day", day % 30);
  } else {
    push("year", year);
    push("month", month % 12);
  }

  if (!parts.length) return "—";

  const lang = (I18N.lang || "en").split("-")[0];
  if (lang === "tr") return inFuture ? `${parts.join(" ")} sonra` : `${parts.join(" ")} önce`;
  if (lang === "de") return inFuture ? `in ${parts.join(" ")}` : `vor ${parts.join(" ")}`;
  return inFuture ? `in ${parts.join(" ")}` : `${parts.join(" ")} ago`;
}


// Translate key with optional vars
export function t(key, vars) {
  const raw = (I18N.dict && I18N.dict[key]) || key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

// Resolve language from query, storage, or browser prefs
export function resolveInitialLang() {
  const q = (getParam("lang") || "").trim().toLowerCase();
  if (q === "en" || q === "tr" || q === "de") return q;

  const saved = (lsGet(KEYS.LANG_KEY, "") || "").trim().toLowerCase();
  if (saved === "en" || saved === "tr" || saved === "de") return saved;

  const prefs = []
    .concat(navigator.languages || [])
    .concat(navigator.language || [])
    .map((x) => String(x || "").toLowerCase())
    .filter(Boolean);

  for (const p of prefs) {
    const base = p.split("-")[0];
    if (base === "en" || base === "tr" || base === "de") return base;
  }
  return "en";
}

// Load i18n dictionaries (en base + requested overlay)
export async function loadLang(lang) {
  async function loadOne(code) {
    const r = await fetch(`./locales/${code}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`i18n ${code} HTTP ${r.status}`);
    return r.json();
  }

  const requested = lang;
  let enDict = {};
  try { enDict = await loadOne("en"); } catch { enDict = {}; }

  let dict = enDict;
  let loadedOk = (requested === "en");

  if (requested !== "en") {
    try {
      const target = await loadOne(requested);
      dict = { ...enDict, ...target };
      loadedOk = true;
    } catch (e) {
      console.warn("i18n load failed:", requested, e);
      dict = enDict;
      loadedOk = false;
    }
  }

  I18N.lang = requested;
  I18N.locale = getLocale(requested);
  I18N.dict = dict;

  if (loadedOk) lsSet(KEYS.LANG_KEY, requested);
}

// Apply translations for static DOM attributes
export function applyStaticI18n(dom) {
  document.documentElement.lang = I18N.lang;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", t(key));
  });

  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.setAttribute("title", t(key));
  });

  const applyBtn = dom.$("applyBtn");
  const pauseBtn = dom.$("pauseBtn");
  if (applyBtn) applyBtn.innerHTML = `${dom.iconRefresh()}<span>${t("controls.apply")}</span>`;
  if (pauseBtn) {
    pauseBtn.innerHTML = dom.paused()
      ? `${dom.iconPlay()}<span>${t("controls.resume")}</span>`
      : `${dom.iconPause()}<span>${t("controls.pause")}</span>`;
  }

  const rawDetails = dom.$("rawDetails");
  if (rawDetails) dom.$("rawHint").textContent = rawDetails.open ? t("raw.open") : t("raw.closed");

  const sel = dom.$("langSelect");
  if (sel) sel.value = I18N.lang;
}

// Format uptime string using i18n labels
export function formatUptimeI18n(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(seconds / 86400);
  seconds %= 86400;
  const h = Math.floor(seconds / 3600);
  seconds %= 3600;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;

  const parts = [];
  if (d) parts.push(t("uptime.d", { n: d }));
  if (h || d) parts.push(t("uptime.h", { n: h }));
  if (m || h || d) parts.push(t("uptime.m", { n: m }));
  parts.push(t("uptime.s", { n: s }));
  return parts.join(" ");
}
