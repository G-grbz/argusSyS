import { KEYS, lsGet, lsSet, lsGetJson, lsSetJson } from "./storage.js";
import { getParam } from "./util.js";

export const HISTORY_MINUTES_ALLOWED = [1, 5, 10, 15, 30, 60, 90, 120];

// Resolve poll interval (ms) from query or storage
export function resolveInitialPollMs() {
  const q = Number((getParam("poll") || "").trim());
  if (Number.isFinite(q) && q >= 100 && q <= 15000) return Math.floor(q);

  const saved = Number((lsGet(KEYS.POLL_CFG_KEY, "") || "").trim());
  if (Number.isFinite(saved) && saved >= 100 && saved <= 15000) return Math.floor(saved);

  return 1000;
}

// Resolve history window (minutes) from query or storage
export function resolveInitialHistoryMinutes() {
  const embed = (getParam("embed") || "").trim() === "1";
  const q = Number((getParam("history") || "").trim());
  if (HISTORY_MINUTES_ALLOWED.includes(q)) return q;
  if (embed) return 5;

  const saved = Number((lsGet(KEYS.HISTORY_CFG_KEY, "") || "").trim());
  if (HISTORY_MINUTES_ALLOWED.includes(saved)) return saved;

  return 15;
}

// Persist history window (minutes)
export function saveHistoryCfg(minutes) {
  lsSet(KEYS.HISTORY_CFG_KEY, String(minutes));
}

// Extract server history payload into normalized shape
export function getServerHistory(data) {
  const h = data?.history;
  if (!h || typeof h !== "object") return null;
  const ts = Array.isArray(h.ts) ? h.ts : [];
  if (!ts.length) return null;
  return {
    sampleMs: Number(h.sample_ms || h.sampleMs || 1000) || 1000,
    maxMin: Number(h.max_min || h.maxMin || 60) || 60,
    ts,
    cpu1: Array.isArray(h.cpu1) ? h.cpu1 : [],
    cpu5: Array.isArray(h.cpu5) ? h.cpu5 : [],
    cpu15: Array.isArray(h.cpu15) ? h.cpu15 : [],
    cpu_util: Array.isArray(h.cpu_util) ? h.cpu_util : [],
    gpu: Array.isArray(h.gpu_util) ? h.gpu_util : [],
    vram: Array.isArray(h.vram_used_b) ? h.vram_used_b : [],
    ram_used: Array.isArray(h.ram_used_b) ? h.ram_used_b : [],
    ram_free: Array.isArray(h.ram_free_b) ? h.ram_free_b : [],
    swap_used: Array.isArray(h.swap_used_b) ? h.swap_used_b : [],
    down: Array.isArray(h.net_down_bps) ? h.net_down_bps : [],
    up: Array.isArray(h.net_up_bps) ? h.net_up_bps : [],
  };
}

// Check if server history is active
export function usingServerHistory(lastServerHistory) {
  return !!(lastServerHistory && Array.isArray(lastServerHistory.ts) && lastServerHistory.ts.length);
}

// Load persisted history state payload
export function loadHistoryState() {
  const st = lsGetJson(KEYS.HISTORY_STATE_KEY, null);
  if (!st || st.v !== 1) return null;
  return st;
}

// Save persisted history state payload
export function saveHistoryState(payload) {
  lsSetJson(KEYS.HISTORY_STATE_KEY, payload);
}

// Clamp UI history minutes by server max if needed
export function setHistoryMinutesFromServerIfNeeded(h, state, onChange) {
  const mm = Number(h?.maxMin);
  if (!Number.isFinite(mm) || mm <= 0) return;

  if (Number(state.historyMinutes) > mm) {
    state.historyMinutes = mm;
    saveHistoryCfg(state.historyMinutes);
    onChange?.(state.historyMinutes);
  }
}
