import { clamp, toGiB, escHtml } from "./util.js";
import { t } from "./i18n.js";

// In-memory spark buffers
export const spark = {
  cpu1: [],
  cpu5: [],
  cpu15: [],
  cpu_util: [],
  gpu: [],
  vram: [],
  ram_used: [],
  ram_free: [],
  swap_pct: [],
  down: [],
  up: [],
};

export const sparkTs = {
  cpu1: [],
  cpu5: [],
  cpu15: [],
  cpu_util: [],
  gpu: [],
  vram: [],
  ram_used: [],
  ram_free: [],
  swap_pct: [],
  down: [],
  up: [],
};

// Compute spark window length from history minutes
export function maxSparkLen(historyMinutes) {
  const historySec = historyMinutes * 60;
  return clamp(historySec, 60, 60 * 60);
}

// Push a value+timestamp pair into spark buffers
export function pushSparkPair(key, v, maxLen) {
  const arr = spark[key];
  const tsA = sparkTs[key];
  const now = Date.now();
  arr.push(v);
  tsA.push(now);
  if (arr.length > maxLen) arr.shift();
  if (tsA.length > maxLen) tsA.shift();
}

// Normalize array into 0..1 range
export function normalize01(arr) {
  if (!arr.length) return [];
  const max = Math.max(...arr, 1e-9);
  const min = Math.min(...arr, 0);
  const den = max - min || 1;
  return arr.map((x) => (x - min) / den);
}

// Downsample array to target length
export function downsample(arr, target = 120) {
  if (!arr || arr.length <= target) return arr || [];
  const out = [];
  const step = arr.length / target;
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Build a smooth-ish SVG path from values
export function sparkPath(arr, H) {
  if (!arr || arr.length < 2) return "";
  const max = Math.max(...arr, 1e-9);
  const min = Math.min(...arr, 0);
  const n = arr.length;
  const W = 100;

  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1 || 1)) * W;
    const y = H - ((arr[i] - min) / (max - min || 1)) * H;
    pts[i] = [x, y];
  }

  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < n - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    d += ` Q${x1.toFixed(2)} ${y1.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = pts[n - 1];
  d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  return d;
}

// Build an SVG path scaled by an explicit max value
export function sparkPathScaled(arr, H, maxVal) {
  if (!arr || arr.length < 2) return "";
  const n = arr.length;
  const W = 100;
  const max = Number.isFinite(maxVal) && maxVal > 0 ? maxVal : 1;

  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1 || 1)) * W;
    const v = Number(arr[i]);
    const vv = Number.isFinite(v) ? v : 0;
    const y = H - clamp(vv / max, 0, 1) * H;
    pts[i] = [x, y];
  }

  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < n - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    d += ` Q${x1.toFixed(2)} ${y1.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = pts[n - 1];
  d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  return d;
}

// Detect whether server timestamps are ms or seconds
export function detectTsUnit(tsArr) {
  const last = Number(tsArr?.[tsArr.length - 1] || 0);
  return last > 1e12 ? "ms" : "sec";
}

// Slice server history arrays to a minute window
export function sliceServerHistoryToMinutes(h, minutes) {
  if (!h || !Array.isArray(h.ts) || !h.ts.length) return null;

  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return h;

  const ts = h.ts;
  const unit = detectTsUnit(ts);

  const now = Date.now();
  const cutoff = unit === "ms" ? (now - m * 60 * 1000) : (Math.floor(now / 1000) - m * 60);

  let i0 = 0;
  for (; i0 < ts.length; i0++) {
    const t0 = Number(ts[i0] || 0);
    if (Number.isFinite(t0) && t0 >= cutoff) break;
  }
  if (i0 >= ts.length) i0 = Math.max(0, ts.length - 1);

  const cut = (arr) => (Array.isArray(arr) ? arr.slice(i0) : []);
  return {
    ...h,
    ts: cut(h.ts),
    cpu1: cut(h.cpu1), cpu5: cut(h.cpu5), cpu15: cut(h.cpu15), cpu_util: cut(h.cpu_util),
    gpu: cut(h.gpu), vram: cut(h.vram),
    ram_used: cut(h.ram_used), ram_free: cut(h.ram_free),
    swap_used: cut(h.swap_used),
    down: cut(h.down), up: cut(h.up),
  };
}

// swap % helper (0..100)
export function swapPctFromBytes(usedBytes, totalBytes) {
  const used = Number(usedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((used / total) * 100, 0, 100);
}

// Apply server history arrays into spark buffers
export function applyServerHistoryToSparks(h, historyMinutes) {
  if (!h) return false;
  const hh = sliceServerHistoryToMinutes(h, historyMinutes);
  if (!hh) return false;

  const ts = Array.isArray(hh.ts) ? hh.ts : [];
  if (!ts.length) return false;

  spark.cpu1 = (hh.cpu1 || []).slice();
  spark.cpu5 = (hh.cpu5 || []).slice();
  spark.cpu15 = (hh.cpu15 || []).slice();
  spark.cpu_util = (hh.cpu_util || []).slice();

  spark.gpu = (hh.gpu || []).slice();
  spark.vram = (hh.vram || []).slice();

  spark.ram_used = (hh.ram_used || []).map((b) => toGiB(b));
  spark.ram_free = (hh.ram_free || []).map((b) => toGiB(b));

  spark._swap_used_raw = (hh.swap_used || []).slice();

  const swapTotal = Number(h?.mem?.swap_total || 0);
  if (Number.isFinite(swapTotal) && swapTotal > 0) {
    spark.swap_pct = spark._swap_used_raw.map((b) => swapPctFromBytes(b, swapTotal));
  } else {
    spark.swap_pct = [];
  }

  spark.down = (hh.down || []).slice();
  spark.up = (hh.up || []).slice();

  const L = Math.max(
    spark.cpu1.length, spark.cpu5.length, spark.cpu15.length, spark.cpu_util.length,
    spark.gpu.length, spark.vram.length,
    spark.ram_used.length, spark.ram_free.length,
    spark._swap_used_raw.length, spark.swap_pct.length,
    spark.down.length, spark.up.length
  );

  const tt = ts.slice(-L);
  for (const k of Object.keys(sparkTs)) sparkTs[k] = tt.slice();
  return true;
}

// Trim spark buffers to current window length
export function trimSparksToWindow(historyMinutes) {
  const L = maxSparkLen(historyMinutes);
  for (const k of Object.keys(spark)) {
    if (!Array.isArray(spark[k])) spark[k] = [];
    if (spark[k].length > L) spark[k] = spark[k].slice(-L);
  }
}

// Spark series visibility key
const SPARK_VIS_KEY = "stats_ui_spark_vis_v1";

let sparkModal = null;

// Create (once) and reuse the spark modal
function ensureSparkModal() {
  if (sparkModal) return sparkModal;

  const wrap = document.createElement("div");
  wrap.className = "spark-modal is-hidden";
  wrap.innerHTML = `
    <div class="spark-modal__backdrop" data-close="1"></div>
    <div class="spark-modal__panel" role="dialog" aria-modal="true" aria-label="${escHtml(t("spark.options.aria"))}">
      <div class="spark-modal__head">
        <div class="spark-modal__title">—</div>
        <button class="spark-modal__close" type="button" aria-label="${escHtml(t("spark.options.close"))}" data-close="1">${escHtml(t("ui.closeX"))}</button>
      </div>

      <div class="spark-modal__body">
        <div class="spark-modal__toggles"></div>
        <div class="spark-modal__preview"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  function close() {
    wrap.classList.add("is-hidden");
    document.body.classList.remove("modal-open");
  }

  wrap.addEventListener("click", (e) => {
    const t0 = e.target;
    if (t0 && t0.getAttribute && t0.getAttribute("data-close") === "1") close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !wrap.classList.contains("is-hidden")) close();
  });

  sparkModal = {
    el: wrap,
    titleEl: wrap.querySelector(".spark-modal__title"),
    togglesEl: wrap.querySelector(".spark-modal__toggles"),
    previewEl: wrap.querySelector(".spark-modal__preview"),
    close,
  };
  return sparkModal;
}

// Load spark visibility map from localStorage
function loadSparkVis() {
  try {
    const raw = localStorage.getItem(SPARK_VIS_KEY);
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// Save spark visibility map to localStorage
function saveSparkVis(state) {
  try {
    localStorage.setItem(SPARK_VIS_KEY, JSON.stringify(state || {}));
  } catch {}
}

// Check if a series is visible
function isSeriesVisible(el) {
  if (!el) return false;
  return window.getComputedStyle(el).display !== "none";
}

// Toggle a series visibility
function setSeriesVisible(pathEl, on) {
  if (!pathEl) return;
  pathEl.style.display = on ? "" : "none";
}

// Register modal-controlled series by card
function getSparkRegistry() {
    return {
        cpu: {
            title: () => t("cards.cpu"),
            series: [
                { id: "cpu1", label: () => t("tip.cpu.m1.show"), sel: () => document.getElementById("cpuSpark"), color: "var(--chart-cpu)" },
                { id: "cpu5", label: () => t("tip.cpu.m5.show"), sel: () => document.getElementById("cpuSpark5"), color: "var(--chart-cpu2)" },
                { id: "cpu15", label: () => t("tip.cpu.m15.show"), sel: () => document.getElementById("cpuSpark15"), color: "var(--chart-cpu3)" },
                { id: "cpuutil", label: () => t("tip.cpu.util.show"), sel: () => document.getElementById("cpuUtilSpark"), color: "var(--chart-cpu4)" },
            ],
            clickTarget: () => document.querySelector('[data-card="cpu"] .sparkline svg'),
            openTarget: () => document.getElementById("cpuBadge"),
        },

        gpu: {
            title: () => t("cards.gpu"),
            series: [
                { id: "gpuutil", label: () => t("tip.gpu.util.show"), sel: () => document.getElementById("gpuSpark"), color: "var(--chart-gpu)" },
                { id: "vram", label: () => t("tip.gpu.vram.show"), sel: () => document.getElementById("gpuVramSpark"), color: "var(--chart-vram)" },
            ],
            clickTarget: () => document.querySelector('[data-card="gpu"] .sparkline svg'),
            openTarget: () => document.getElementById("gpuBadge"),
        },

        ram: {
            title: () => t("cards.ram"),
            series: [
                { id: "ramused", label: () => t("tip.ram.used.show"), sel: () => document.getElementById("ramUsedSpark"), color: "var(--chart-ram-used)" },
                { id: "ramfree", label: () => t("tip.ram.free.show"), sel: () => document.getElementById("ramFreeSpark"), color: "var(--chart-ram-free)" },
                { id: "swaputil", label: () => t("tip.swap.util.show"), sel: () => document.getElementById("swapSpark"), color: "var(--chart-swap)" },
            ],
            clickTarget: () => document.querySelector('[data-card="ram"] .sparkline svg'),
            openTarget: () => document.getElementById("ramBadge"),
        },

        net: {
            title: () => t("cards.net"),
            series: [
                { id: "netdown", label: () => t("tip.net.down.show"), sel: () => document.getElementById("netDownSpark"), color: "var(--chart-net-down)" },
                { id: "netup", label: () => t("tip.net.up.show"), sel: () => document.getElementById("netUpSpark"), color: "var(--chart-net-up)" },
            ],
            clickTarget: () => document.querySelector('[data-card="net"] .sparkline svg'),
            openTarget: () => document.getElementById("netBadge"),
        },
    };
}

// Apply saved series visibility to main DOM
function applySavedSparkVisToDOM() {
  const visState = loadSparkVis();
  const regAll = getSparkRegistry();

  for (const cardKey of Object.keys(regAll)) {
    const reg = regAll[cardKey];
    const cardVis = (visState && visState[cardKey]) ? visState[cardKey] : null;

    for (const s of reg.series || []) {
      const el = s.sel?.();
      if (!el) continue;

      const saved = cardVis ? cardVis[s.id] : null;
      const on = (saved == null) ? true : !!saved;
      setSeriesVisible(el, on);
    }
      updateCardSparklineVisibility(cardKey);
  }
}

// Find sparkline container for a card (hide/show whole block)
function getSparklineContainer(cardKey) {
  return document.querySelector(`[data-card="${CSS.escape(cardKey)}"] .sparkline`);
}

// If all series in a card are hidden -> hide sparkline container
function updateCardSparklineVisibility(cardKey) {
  const regAll = getSparkRegistry();
  const reg = regAll?.[cardKey];
  if (!reg) return;

  const container = getSparklineContainer(cardKey);
  if (!container) return;

  let anyVisible = false;
  for (const s of reg.series || []) {
    const el = s.sel?.();
    if (el && isSeriesVisible(el)) {
      anyVisible = true;
      break;
    }
  }

  container.style.display = anyVisible ? "" : "none";
}

// Open modal for a card key
function openSparkModal(cardKey) {
  const modal = ensureSparkModal();
  const regAll = getSparkRegistry();
  const reg = regAll[cardKey];
  if (!reg) return;

  const mainSvg = reg.clickTarget();
  const visState = loadSparkVis();
  if (!visState[cardKey]) visState[cardKey] = {};
  const cardVis = visState[cardKey];

  modal.titleEl.textContent = reg.title();
  modal.previewEl.innerHTML = "";
  modal._previewSvg = null;
  modal._idMap = new Map();

  if (mainSvg) {
    const clone = mainSvg.cloneNode(true);

    clone.querySelectorAll("[id]").forEach((el) => {
      const oldId = el.id;
      const newId = "p_" + oldId;
      modal._idMap.set(oldId, newId);
      el.id = newId;
    });

    clone.removeAttribute("style");
    clone.style.width = "100%";
    clone.style.height = "auto";
    modal.previewEl.appendChild(clone);
    modal._previewSvg = clone;
  }

  // Toggle a series in preview SVG (by original DOM id)
  function setPreviewSeriesVisibleById(domId, on, pulse = false, pulseColor = "") {
    if (!modal._previewSvg || !domId) return;

    const mapped = modal._idMap?.get(domId) || domId;
    const el = modal._previewSvg.querySelector(`#${CSS.escape(mapped)}`);
    if (!el) return;

    if (pulseColor) el.style.setProperty("--pulse-color", pulseColor);
    else el.style.removeProperty("--pulse-color");

    if (el._hideT) {
      clearTimeout(el._hideT);
      el._hideT = null;
    }

    if (on) el.style.display = "";

    if (pulse) {
      el.classList.remove("spark-pulse");
      void el.getBoundingClientRect();
      el.classList.add("spark-pulse");
    }

    if (!on) {
      el._hideT = setTimeout(() => {
        el.style.display = "none";
        el.classList.remove("spark-pulse");
        el._hideT = null;
      }, pulse ? 220 : 0);
    } else {
      setTimeout(() => el.classList.remove("spark-pulse"), 950);
    }
  }

  modal.togglesEl.innerHTML = "";

  if (!mainSvg) {
    modal.el.classList.remove("is-hidden");
    document.body.classList.add("modal-open");
    return;
  }

  for (const s of reg.series || []) {
    const domId = String(s?.sel?.()?.id || "");
    if (!domId) continue;

    const key = s.id;
    const dotCss = (s.color || "currentColor").trim();
    const getMainPath = () => mainSvg.querySelector(`#${CSS.escape(domId)}`);
    const path = getMainPath();
    if (!path) continue;

    const saved = cardVis[key];
    const initialOn = (saved == null) ? isSeriesVisible(path) : !!saved;

    setSeriesVisible(path, initialOn);
    setPreviewSeriesVisibleById(domId, initialOn, false, dotCss);

    const row = document.createElement("label");
    row.className = "spark-modal__row";
    row.innerHTML = `
      <input type="checkbox">
      <span class="spark-modal__dot" style="--dot:${escHtml(dotCss)}"></span>
      <span>${escHtml(s.label())}</span>
    `;

    const cb = row.querySelector("input");
    cb.checked = initialOn;

    cb.addEventListener("change", () => {
      const on = !!cb.checked;
      const livePath = getMainPath();
      if (livePath) setSeriesVisible(livePath, on);

      setPreviewSeriesVisibleById(domId, on, true, dotCss);

      cardVis[key] = on;
      saveSparkVis(visState);

      updateCardSparklineVisibility(cardKey);
    });

    modal.togglesEl.appendChild(row);
  }

  modal.el.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
}

// Bind spark modal open behavior to badges + card sparklines
export function initSparkModal() {
  applySavedSparkVisToDOM();

  const regAll = getSparkRegistry();

  function bindOpen(el, cardKey) {
    if (!el) return;
    if (el._sparkModalBound) return;
    el._sparkModalBound = true;

    try {
      el.style.cursor = "pointer";
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", t("spark.options.open"));
    } catch {}

    el.addEventListener("click", (e) => {
      e.preventDefault();
      openSparkModal(cardKey);
    });

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openSparkModal(cardKey);
      }
    });
  }

  for (const cardKey of Object.keys(regAll)) {
    const reg = regAll[cardKey];

    bindOpen(reg?.openTarget?.(), cardKey);

    bindOpen(reg?.clickTarget?.(), cardKey);
  }
}
