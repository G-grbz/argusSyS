import { $, setText } from "./modules/dom.js";
import { clamp, getParam } from "./modules/util.js";
import { KEYS, lsGet, lsSet } from "./modules/storage.js";
import { I18N, t, resolveInitialLang, loadLang, applyStaticI18n } from "./modules/i18n.js";
import { resolveInitialPollMs, resolveInitialHistoryMinutes, usingServerHistory as usingSrvHist } from "./modules/history.js";
import { setupTooltips } from "./modules/tooltips.js";
import { initTheme, initThemeSync } from "./modules/theme.js";
import { loadCardsVisibility, applyCardsVisibility, initCardsPanel, applyCardOrder, saveCardOrder, isCoarsePointer, loadLayoutEdit, saveLayoutEdit, applyLayoutEditUI, loadSysRowsVisibility, applySysRowsVisibility, initSysRowsPanel } from "./modules/layout.js";
import { resolveDiskCols, resolveDiskGroup, tickHeroDisk } from "./modules/disks.js";
import { render, updateRawPanel } from "./modules/render.js";
import { ST_UI, stFetchSnapshot, stSetInterval, stRun, updateSpeedtestViews, initSpeedtestHistoryModal } from "./modules/speedtest.js";
import { initSparkModal } from "./modules/sparks.js";
import { initUpdateChecker, detectAppVersionFromDom, updateUpdateModalI18n } from "./modules/update.js";

// Detect embed mode
const EMBED = (getParam("embed") || "").trim() === "1";
if (EMBED) document.documentElement.setAttribute("data-embed", "1");
else document.documentElement.removeAttribute("data-embed");

// App state
let ONLY_WANTED = null;

const state = {
  lastServerHistory: null,
  lastStats: null,
  uiTimer: null,
  timer: null,
  paused: false,
  pollMs: resolveInitialPollMs(),
  historyMinutes: resolveInitialHistoryMinutes(),
  diskCols: resolveDiskCols(),
  DISK_GROUP: resolveDiskGroup(),
};

let cardDragging = false;
let cardsVis = loadCardsVisibility();
let sysRowsVis = loadSysRowsVisibility();

// SVG icon: refresh
function iconRefresh() {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12a9 9 0 0 1-15.3 6.4"/>
    <path d="M3 12a9 9 0 0 1 15.3-6.4"/>
    <path d="M3 3v6h6"/>
    <path d="M21 21v-6h-6"/>
  </svg>`;
}

// SVG icon: pause
function iconPause() {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="4" width="4" height="16" rx="1"/>
    <rect x="14" y="4" width="4" height="16" rx="1"/>
  </svg>`;
}

// SVG icon: play
function iconPlay() {
  return `<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}

// SVG icon: grip grid
function iconGripGrid6() {
  return `
  <svg class="icon icon-grip" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4"  y="2"  width="4" height="4" rx="0.6"></rect>
    <rect x="10.5" y="2"  width="4" height="4" rx="0.6"></rect>
    <rect x="17" y="2"  width="4" height="4" rx="0.6"></rect>
    <rect x="4"  y="9" width="4" height="4" rx="0.6"></rect>
    <rect x="10.5" y="9" width="4" height="4" rx="0.6"></rect>
    <rect x="17" y="9" width="4" height="4" rx="0.6"></rect>
    <rect x="4"  y="16" width="4" height="4" rx="0.6"></rect>
    <rect x="10.5" y="16" width="4" height="4" rx="0.6"></rect>
    <rect x="17" y="16" width="4" height="4" rx="0.6"></rect>
  </svg>`;
}

// SVG icon: lock closed
function iconLockClosed() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2"></rect>
    <path d="M8 11V8a4 4 0 0 1 8 0v3"></path>
  </svg>`;
}

// SVG icon: lock open
function iconLockOpen() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2"></rect>
    <path d="M8 11V8a4 4 0 0 1 7.5-2"></path>
  </svg>`;
}

// Check if a card should be shown
function shouldShowCard(key) {
  const k = (key || "").trim().toLowerCase();
  if (ONLY_WANTED && !ONLY_WANTED.has(k)) return false;
  if (cardsVis && cardsVis[k] === false) return false;
  return true;
}

// Apply visibility rules to a card element
function applyOnlyToCardEl(el) {
  if (!el) return;
  const key = (el.getAttribute("data-card") || "").toLowerCase();
  if (!key) return;
  el.classList.toggle("is-hidden", !shouldShowCard(key));
}

// Apply embed "only" filter from query string
function applyOnlyFilter() {
  const only = (getParam("only") || "").trim();
  if (!only) { ONLY_WANTED = null; return; }
  ONLY_WANTED = new Set(only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  document.querySelectorAll("[data-card]").forEach(applyOnlyToCardEl);
}

// Post embed height to parent
function notifyHeight() {
  try {
    if (!document.documentElement.hasAttribute("data-embed")) return;

    const cards = document.querySelectorAll(".card:not(.is-hidden):not(.is-empty-hidden)");
    let totalHeight = 0;

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      totalHeight += rect.height;
    });

    const grid = document.querySelector(".dashboard-grid");
    if (grid) {
      const style = window.getComputedStyle(grid);
      const gap = parseFloat(style.gap) || 10;
      totalHeight += (cards.length - 1) * gap;
    }

    const container = document.querySelector(".container");
    if (container) {
      const style = window.getComputedStyle(container);
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      totalHeight += paddingTop + paddingBottom;
    }

    const minHeight = 200;
    const maxHeight = 900;
    const finalHeight = Math.max(minHeight, Math.min(maxHeight, totalHeight));

    window.parent?.postMessage?.(
      { type: "stats-ui:height", height: finalHeight, cards: cards.length, calculated: totalHeight },
      "*"
    );
  } catch (e) {
    console.error("notifyHeight error:", e);
    window.parent?.postMessage?.(
      { type: "stats-ui:height", height: 420, error: String(e) },
      "*"
    );
  }
}

// Set online/offline status indicator
function setStatus(ok) {
  const dot = $("statusDot");
  if (!dot) return;

  // Update pulse aktifken online/offline renklerini ezmeyelim
  if (dot.classList.contains("has-update")) return;

  dot.style.background = ok ? "var(--color-success)" : "var(--color-danger)";
  dot.style.boxShadow = ok
    ? "0 0 0 6px rgba(16, 185, 129, .12), 0 0 22px rgba(16, 185, 129, .35)"
    : "0 0 0 6px rgba(239, 68, 68, .12), 0 0 22px rgba(239, 68, 68, .35)";
}

// Fetch JSON with timeout
async function fetchJsonWithTimeout(url, ms = 4000) {
  const ctrl = new AbortController();
  const tmo = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(t("http.errorLine", { code: r.status }));
    return await r.json();
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(t("http.timeout"));
    throw e;
  } finally {
    clearTimeout(tmo);
  }
}

// Fetch stats payload from API
async function fetchStats(api) {
  return fetchJsonWithTimeout(api, 4000);
}

// Spark sampling state
let lastSparkSampleTs = 0;
let sparkSampleEverySec = 1;

// Compute sampling cadence for sparks
function computeSampling() { sparkSampleEverySec = 1; }

// Decide whether to sample spark buffers this tick
function shouldSampleSpark() {
  const now = Date.now();
  if (!lastSparkSampleTs) { lastSparkSampleTs = now; return true; }
  if (now - lastSparkSampleTs >= sparkSampleEverySec * 1000) { lastSparkSampleTs = now; return true; }
  return false;
}

// Check if we're using server-provided history
function usingServerHistory() {
  return usingSrvHist(state.lastServerHistory);
}

// Build render context passed into render()
function getRenderCtx() {
  return {
    notifyHeight,
    shouldSampleSpark,
    usingServerHistory,
    applyOnlyToCardEl,
    iconGripGrid6,
    initSortable,
    applyCardOrder,
    lang: I18N.lang,
  };
}

let _nhRAF = 0;

// Schedule an embed height update (RAF-batched)
function notifyHeightSoon() {
  if (_nhRAF) return;
  _nhRAF = requestAnimationFrame(() => {
    _nhRAF = 0;
    notifyHeight();
  });
}

// Force a rerender using last stats
function rerenderNow(data = state.lastStats) {
  if (!data) return;
  render(data, state, getRenderCtx());
  notifyHeightSoon();
}

// Sortable init for cards
let sortable = null;

// Initialize SortableJS for card reordering
function initSortable() {
  const grid = document.querySelector(".dashboard-grid");
  if (!grid) return;
  if (!window.Sortable) { console.warn("SortableJS not loaded"); return; }
  if (sortable) { try { sortable.destroy(); } catch {} sortable = null; }

  const mobile = isCoarsePointer();
  const editOn = loadLayoutEdit();

  sortable = window.Sortable.create(grid, {
    animation: 150,
    handle: ".drag-handle",
    draggable: '.card[data-card]:not(#disksAnchor)',
    ghostClass: "is-sort-ghost",
    chosenClass: "is-sort-chosen",
    dragClass: "is-sort-drag",
    filter: ".is-hidden, .is-empty-hidden",
    onMove: (evt) => {
      const el = evt.related;
      if (!el) return true;
      if (el.classList.contains("is-hidden")) return false;
      if (el.classList.contains("is-empty-hidden")) return false;
      return true;
    },
    delay: mobile ? 250 : 0,
    delayOnTouchOnly: true,
    touchStartThreshold: mobile ? 8 : 0,
    fallbackTolerance: mobile ? 8 : 0,
    forceFallback: mobile,
    scroll: true,
    scrollSensitivity: mobile ? 60 : 30,
    scrollSpeed: mobile ? 12 : 8,
    onStart: () => {
      cardDragging = true;
    },
    onEnd: () => {
      cardDragging = false;
      saveCardOrder();
      // optional: immediately re-apply latest stats after drag
      rerenderNow(state.lastStats);
      notifyHeightSoon();
    },
  });

  // Disable sorting when not in edit mode
  sortable.option("disabled", !editOn);
}

// Toggle layout editing mode
function setLayoutEditing(on) {
  on = !!on;
  saveLayoutEdit(on);
  applyLayoutEditUI(on, iconLockOpen, iconLockClosed);
  document.documentElement.classList.toggle("layout-editing", on);

  const mobile = isCoarsePointer();
  if (sortable) sortable.option("disabled", !on);

  window.dispatchEvent(new CustomEvent("stats-ui:layout-edit", { detail: { on } }));
  setTimeout(notifyHeight, 30);
}

window.addEventListener("stats-ui:layout-edit", () => {
  rerenderNow(state.lastStats);
  notifyHeightSoon();
});

// Initialize layout edit button
function initLayoutButton() {
  const btn = $("layoutBtn");
  if (!btn) return;

  let saved = loadLayoutEdit();
  if (typeof saved !== "boolean") saved = true;
  saveLayoutEdit(saved);
  const initial = saved;

  applyLayoutEditUI(initial, iconLockOpen, iconLockClosed);
  document.documentElement.classList.toggle("layout-editing", initial);

  btn.addEventListener("click", () => {
    const on = !document.documentElement.classList.contains("layout-editing");
    setLayoutEditing(on);
  });
}

// Persist raw panel open state
function initRawPersist() {
  const rawDetails = $("rawDetails");
  const rawHint = $("rawHint");
  if (!rawDetails || !rawHint) return;

  const saved = lsGet(KEYS.RAW_OPEN_KEY, null);
  if (saved === "1") rawDetails.open = true;

  const updateRawHint = () => { rawHint.textContent = rawDetails.open ? t("raw.open") : t("raw.closed"); };
  updateRawHint();

  rawDetails.addEventListener("toggle", () => {
    lsSet(KEYS.RAW_OPEN_KEY, rawDetails.open ? "1" : "0");
    updateRawHint();
    notifyHeight();

    if (rawDetails.open) {
      try {
        if (state?.lastStats) {
          updateRawPanel(state.lastStats, { force: true, pretty: true, maxChars: 800_000 });
        }
      } catch {}
    }
  });
}

let stUiInFlight = false;
let stUiLastTs = 0;
const ST_UI_POLL_MS = 1000;

// Throttle and guard speedtest UI polling
async function tickSpeedtestUISafe() {
  const now = Date.now();
  if (stUiInFlight) return;
  if (now - stUiLastTs < ST_UI_POLL_MS) return;
  if (cardDragging) return;

  stUiInFlight = true;
  stUiLastTs = now;
  try {
    await tickSpeedtestUI();
  } finally {
    stUiInFlight = false;
  }
}

// Poll speedtest snapshot and refresh UI
async function tickSpeedtestUI() {
  const api = $("apiUrl")?.value?.trim() || "/stats";
  const base = api.endsWith("/stats") ? api : api.replace(/\/+$/, "") + "/stats";
  try {
    const snap = await stFetchSnapshot(base);
    updateSpeedtestViews(snap, notifyHeight);

    const st = snap || null;
    if (st) {
      const runner = $("stRunner"); if (runner) runner.textContent = st.runner || "—";
      const status = $("stStatus");
      if (status) {
        status.textContent =
          st.running
            ? t("st.status.running")
            : st.last_error
            ? t("st.status.error", { msg: st.last_error })
            : t("st.status.ok");
      }
    }
  } catch {}
}

initSpeedtestHistoryModal(
  () => $("apiUrl")?.value || "",
  () => {
    const sel = $("langSelect");
    return sel?.value || "en";
  }
);

// Start fast UI tick loop (animations, hero disk, speedtest)
function startUiTickLoop() {
  if (state.uiTimer) clearInterval(state.uiTimer);
  state.uiTimer = setInterval(async () => {
    if (state.paused) return;
    const now = Date.now();
    tickHeroDisk(now, notifyHeight);

    const stCard = document.querySelector('[data-card="speedtest"]');
    const stVisible = stCard && !stCard.classList.contains("is-hidden") && !stCard.classList.contains("is-empty-hidden");
    const stLikelyRunning =
      (state.lastStats?.speedtest?.running === true) ||
      (Date.now() < (ST_UI.forceUntil || 0)) ||
      (Date.now() < (ST_UI.holdUntil || 0));

    if (stVisible || stLikelyRunning) await tickSpeedtestUISafe();
  }, 200);
}

// Start main polling loop
function startLoop() {
  if (state.timer) clearInterval(state.timer);

  const intervalMs = clamp(Number(state.pollMs) || 1000, 100, 15000);
  let inFlight = false;

  const tick = async () => {
    if (state.paused) return;
    if (inFlight) return;
    inFlight = true;

    const api = $("apiUrl")?.value?.trim() || "/stats";
    try {
      const data = await fetchStats(api);
      setStatus(true);

      state.lastStats = data;

      if (!cardDragging) {
        render(data, state, getRenderCtx());
        notifyHeight();
      }
    } catch (e) {
      setStatus(false);
      $("subtitle").textContent = t("errorLine", { msg: e.message });
    } finally {
      inFlight = false;
    }
  };

  tick();
  state.timer = setInterval(tick, intervalMs);
}

// App init
async function init() {
  const initialLang = resolveInitialLang();
  await loadLang(initialLang);

  applyStaticI18n({
    $,
    iconRefresh,
    iconPlay,
    iconPause,
    paused: () => state.paused,
  });

  document.body.classList.remove("i18n-loading");

  // Update checker
  let updateHandle = null;

  try {
    const dot = $("statusDot");
    const currentVersion = detectAppVersionFromDom();
    updateHandle = initUpdateChecker({
      dotEl: dot,
      repo: "G-grbz/argusSyS",
      currentVersion,
      checkEveryMs: 30 * 60 * 1000,
      autoOpenDaily: false,
      quiet: true,
    });
  } catch (e) {
    console.warn("update checker init failed:", e);
  }

  initSparkModal();

  const sel = $("langSelect");
  if (sel) {
    sel.value = I18N.lang;
    sel.addEventListener("change", async () => {
      await loadLang(sel.value);

      applyStaticI18n({ $, iconRefresh, iconPlay, iconPause, paused: () => state.paused });
      initSparkModal();
      setupTooltips(() => state.historyMinutes);
      rerenderNow(state.lastStats);
      notifyHeightSoon();

      updateUpdateModalI18n(updateHandle);
    });
  }

  $("apiUrl").value = getParam("api") || "/stats";

  applyOnlyFilter();

  initTheme(notifyHeight);
  initThemeSync(notifyHeight);

  initRawPersist();

  initCardsPanel(cardsVis, ONLY_WANTED, notifyHeight);
  applyCardsVisibility(cardsVis, ONLY_WANTED, notifyHeight);

  initSysRowsPanel(sysRowsVis, notifyHeight);
  applySysRowsVisibility(sysRowsVis, notifyHeight);

  applyCardOrder();
  initSortable();
  initLayoutButton();

  const histSel = $("historySelect");
    if (histSel) {
      histSel.value = String(state.historyMinutes);
      histSel.addEventListener("change", () => {
        const v = Number(histSel.value);
        if (![1, 5, 10, 15, 30, 60, 90, 120].includes(v)) return;
        state.historyMinutes = v;
        lsSet(KEYS.HISTORY_CFG_KEY, String(state.historyMinutes));
        computeSampling();
        rerenderNow();
        notifyHeightSoon();
      });
    }

  const pollSel = $("pollSelect");
  if (pollSel) {
    pollSel.value = String((Number(state.pollMs) || 1000) / 1000);
    pollSel.addEventListener("change", () => {
      const v = Number(pollSel.value);
      if (!Number.isFinite(v) || v < 0.1 || v > 15) return;
      state.pollMs = Math.floor(v * 1000);
      lsSet(KEYS.POLL_CFG_KEY, String(state.pollMs));
      startLoop();
      notifyHeightSoon();
    });
  }

  $("applyBtn").onclick = () => startLoop();
  $("pauseBtn").onclick = () => {
    state.paused = !state.paused;
    applyStaticI18n({ $, iconRefresh, iconPlay, iconPause, paused: () => state.paused });
    if (!state.paused) startLoop();
  };

  const stSel = $("stInterval");
  if (stSel) {
    (async () => {
      try {
        const api = $("apiUrl").value.trim() || "/stats";
        const base = api.endsWith("/stats") ? api : api.replace(/\/+$/, "") + "/stats";
        const snap = await stFetchSnapshot(base);
        const srv = Number(snap?.interval_min);
        if (Number.isFinite(srv) && [0, 15, 30, 60, 360, 1440].includes(srv)) stSel.value = String(srv);
      } catch {}
    })();

    stSel.addEventListener("change", async () => {
      const api = $("apiUrl").value.trim() || "/stats";
      const base = api.endsWith("/stats") ? api : api.replace(/\/+$/, "") + "/stats";
      const v = Number(stSel.value);
      try {
        const snap = await stSetInterval(base, v);
        const srv = Number(snap?.interval_min);
        if (Number.isFinite(srv)) stSel.value = String(srv);
      } catch (e) {
        console.error("speedtest config error:", e);
      } finally {
        setTimeout(notifyHeight, 50);
      }
    });
  }

  const stBtn = $("stRunBtn");
  if (stBtn) {
    stBtn.addEventListener("click", async () => {
      const api = $("apiUrl").value.trim() || "/stats";
      const base = api.endsWith("/stats") ? api : api.replace(/\/+$/, "") + "/stats";

      ST_UI.forceUntil = Date.now() + 3000;
      updateSpeedtestViews({ running: true, last: null }, notifyHeight);

      stBtn.disabled = true;
      try { await stRun(base); }
      catch (e) { console.error("speedtest run error:", e); }
      finally { stBtn.disabled = false; setTimeout(notifyHeight, 50); }
    });
  }

  setupTooltips(() => state.historyMinutes);

  window.addEventListener("stats-ui:disk-cols", () => {
    state.diskCols = resolveDiskCols();
    state.DISK_GROUP = resolveDiskGroup();
    rerenderNow();
  });

  window.addEventListener("resize", () => notifyHeight());
  setTimeout(notifyHeight, 80);

  startLoop();
  startUiTickLoop();
  notifyHeight();
}

// Boot
document.addEventListener("DOMContentLoaded", init);
