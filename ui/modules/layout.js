import { KEYS, lsGetJson, lsSetJson, lsGet, lsSet } from "./storage.js";
import { $ } from "./dom.js";
import { t } from "./i18n.js";

// System rows visibility (System card)
export function getDefaultSysRowsVisibility() {
  return {
    firmware: true,
    biosversion: true,
    biosdate: true,

    manufacturer: true,
    product: true,
    systemversion: true,
    serial: true,

    battery: true,
    ac: true,
    os: true,
    kernel: true,
    arch: true,
    desktop: true,
    session: true,
  };
}

// Load system row visibility from storage.
export function loadSysRowsVisibility() {
  const obj = lsGetJson(KEYS.SYSROWS_CFG_KEY, null);
  if (!obj || typeof obj !== "object") return getDefaultSysRowsVisibility();
  const norm = {};
  for (const [k, v] of Object.entries(obj)) norm[String(k).toLowerCase()] = !!v;
  return { ...getDefaultSysRowsVisibility(), ...norm };
}

// Save system row visibility to storage.
export function saveSysRowsVisibility(vis) {
  lsSetJson(KEYS.SYSROWS_CFG_KEY, vis || {});
}

// Apply system row visibility to the DOM.
export function applySysRowsVisibility(vis, notifyHeight) {
  const rows = document.querySelectorAll('[data-sys-row]');
  rows.forEach((el) => {
    const key = String(el.getAttribute("data-sys-row") || "").toLowerCase();
    if (!key) return;
    const on = vis[key] !== false;
    el.classList.toggle("is-hidden", !on);
  });
  setTimeout(() => notifyHeight?.(), 30);
}

// Wire up the System rows panel.
export function initSysRowsPanel(sysRowsVis, notifyHeight) {
  const host = $("sysHost");
  const panel = $("sysRowsPanel");
  if (!host || !panel) return;

  const positionPanel = () => {
    const wasHidden = panel.classList.contains("is-hidden");
    if (wasHidden) panel.classList.remove("is-hidden");

    const r = host.getBoundingClientRect();
    const gap = 8;

    let x = r.left;
    let y = r.bottom + gap;

    const pr = panel.getBoundingClientRect();
    let pw = pr.width || panel.offsetWidth || 320;
    let ph = pr.height || panel.offsetHeight || 240;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (x + pw > vw - 8) x = r.right - pw;
    x = Math.min(Math.max(8, x), vw - pw - 8);

    if (y + ph > vh - 8) y = r.top - ph - gap;
    y = Math.min(Math.max(8, y), vh - ph - 8);

    panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;

    if (wasHidden) panel.classList.add("is-hidden");
  };

  // init checkbox states + handlers
  panel.querySelectorAll("input[data-sys-toggle]").forEach((cb) => {
    const key = String(cb.getAttribute("data-sys-toggle") || "").toLowerCase();
    if (!key) return;
    cb.checked = sysRowsVis[key] !== false;
    cb.addEventListener("change", () => {
      sysRowsVis[key] = !!cb.checked;
      saveSysRowsVisibility(sysRowsVis);
      applySysRowsVisibility(sysRowsVis, notifyHeight);
    });
  });

  const allBtn = $("sysRowsAllBtn");
  const noneBtn = $("sysRowsNoneBtn");
  allBtn?.addEventListener("click", () => {
    Object.keys(sysRowsVis).forEach((k) => (sysRowsVis[k] = true));
    panel.querySelectorAll("input[data-sys-toggle]").forEach((cb) => (cb.checked = true));
    saveSysRowsVisibility(sysRowsVis);
    applySysRowsVisibility(sysRowsVis, notifyHeight);
  });
  noneBtn?.addEventListener("click", () => {
    Object.keys(sysRowsVis).forEach((k) => (sysRowsVis[k] = false));
    panel.querySelectorAll("input[data-sys-toggle]").forEach((cb) => (cb.checked = false));
    saveSysRowsVisibility(sysRowsVis);
    applySysRowsVisibility(sysRowsVis, notifyHeight);
  });

  const openPanel = () => {
    panel.classList.remove("is-hidden");
    positionPanel();
    setTimeout(() => notifyHeight?.(), 30);
  };
  const closePanel = () => { panel.classList.add("is-hidden"); setTimeout(() => notifyHeight?.(), 30); };
  const togglePanel = () => panel.classList.contains("is-hidden") ? openPanel() : closePanel();

  host.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
  host.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") togglePanel(); });

  window.addEventListener("resize", () => {
    if (!panel.classList.contains("is-hidden")) positionPanel();
  });
  window.addEventListener("scroll", () => {
    if (!panel.classList.contains("is-hidden")) positionPanel();
  }, true);

  document.addEventListener("click", (e) => {
    if (panel.classList.contains("is-hidden")) return;
    if (panel.contains(e.target) || host.contains(e.target)) return;
    closePanel();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
}

// Detect coarse pointer (touch)
export function isCoarsePointer() {
  return window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
}

// Default visibility map for dashboard cards
export function getDefaultCardsVisibility() {
  return { summary:true, system:true, cpu:true, gpu:true, ram:true, net:true, speedtest:true, disks:true, raw:true };
}

// Load card visibility map from storage
export function loadCardsVisibility() {
  const obj = lsGetJson(KEYS.CARDS_CFG_KEY, null);
  if (!obj || typeof obj !== "object") return getDefaultCardsVisibility();
  return { ...getDefaultCardsVisibility(), ...obj };
}

// Save card visibility map to storage
export function saveCardsVisibility(vis) {
  lsSetJson(KEYS.CARDS_CFG_KEY, vis || {});
}

// Apply visibility map to DOM cards
export function applyCardsVisibility(cardsVis, ONLY_WANTED, notifyHeight) {
  const cards = document.querySelectorAll("[data-card]");
  cards.forEach((el) => {
    const key = (el.getAttribute("data-card") || "").toLowerCase();
    if (!key) return;

    if (ONLY_WANTED && !ONLY_WANTED.has(key)) {
      el.classList.add("is-hidden");
      return;
    }
    const on = cardsVis[key] !== false;
    el.classList.toggle("is-hidden", !on);
  });
  setTimeout(() => notifyHeight?.(), 30);
}

// Wire up cards panel toggles and actions
export function initCardsPanel(cardsVis, ONLY_WANTED, notifyHeight) {
  const btn = $("cardsBtn");
  const panel = $("cardsPanel");
  if (!btn || !panel) return;

  panel.querySelectorAll("input[data-card-toggle]").forEach((cb) => {
    const key = (cb.getAttribute("data-card-toggle") || "").toLowerCase();
    if (!key) return;
    cb.checked = cardsVis[key] !== false;
    cb.addEventListener("change", () => {
      cardsVis[key] = !!cb.checked;
      saveCardsVisibility(cardsVis);
      applyCardsVisibility(cardsVis, ONLY_WANTED, notifyHeight);
    });
  });

  const allBtn = $("cardsAllBtn");
  const noneBtn = $("cardsNoneBtn");

  allBtn?.addEventListener("click", () => {
    Object.keys(cardsVis).forEach((k) => (cardsVis[k] = true));
    panel.querySelectorAll("input[data-card-toggle]").forEach((cb) => (cb.checked = true));
    saveCardsVisibility(cardsVis);
    applyCardsVisibility(cardsVis, ONLY_WANTED, notifyHeight);
  });

  noneBtn?.addEventListener("click", () => {
    Object.keys(cardsVis).forEach((k) => (cardsVis[k] = false));
    panel.querySelectorAll("input[data-card-toggle]").forEach((cb) => (cb.checked = false));
    saveCardsVisibility(cardsVis);
    applyCardsVisibility(cardsVis, ONLY_WANTED, notifyHeight);
  });

  const openPanel = () => { panel.classList.remove("is-hidden"); btn.setAttribute("aria-expanded", "true"); setTimeout(() => notifyHeight?.(), 30); };
  const closePanel = () => { panel.classList.add("is-hidden"); btn.setAttribute("aria-expanded", "false"); setTimeout(() => notifyHeight?.(), 30); };
  const togglePanel = () => panel.classList.contains("is-hidden") ? openPanel() : closePanel();

  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
  document.addEventListener("click", (e) => {
    if (panel.classList.contains("is-hidden")) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    closePanel();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
}

// Get card elements in dashboard grid (excluding disks anchor)
export function getCardElsInGrid() {
  const grid = document.querySelector(".dashboard-grid");
  if (!grid) return [];
  return Array.from(grid.querySelectorAll('.card[data-card]:not(#disksAnchor)'));
}

// Get the disks anchor element
export function getAnchorEl() {
  return document.getElementById("disksAnchor");
}

// Save current card order from DOM
export function saveCardOrder() {
  try {
    const order = getCardElsInGrid()
      .map((el) => (el.getAttribute("data-card-id") || el.getAttribute("data-card") || "").toLowerCase())
      .filter(Boolean);
    localStorage.setItem(KEYS.CARDS_ORDER_KEY, JSON.stringify(order));
  } catch {}
}

// Load saved card order
export function loadCardOrder() {
  try {
    const raw = localStorage.getItem(KEYS.CARDS_ORDER_KEY);
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}

// Apply saved card order to DOM
export function applyCardOrder() {
  const grid = document.querySelector(".dashboard-grid");
  if (!grid) return;
  const anchor = getAnchorEl();

  const order = loadCardOrder();
  if (!order.length) return;

  const els = getCardElsInGrid();
  const byKey = new Map(
    els.map((el) => [
      (el.getAttribute("data-card-id") || el.getAttribute("data-card") || "").toLowerCase(),
      el,
    ])
  );

  const place = (el) => {
    if (anchor && anchor.parentElement === grid) grid.insertBefore(el, anchor);
    else grid.appendChild(el);
  };

  for (const key of order) {
    const el = byKey.get(key);
    if (el) place(el);
  }

  for (const el of els) {
    const key = (el.getAttribute("data-card-id") || el.getAttribute("data-card") || "").toLowerCase();
    if (!order.includes(key)) place(el);
  }
}

// Load layout edit mode flag
export function loadLayoutEdit() {
  try { return lsGet(KEYS.LAYOUT_EDIT_KEY, "0") === "1"; } catch { return false; }
}

// Save layout edit mode flag
export function saveLayoutEdit(on) {
  lsSet(KEYS.LAYOUT_EDIT_KEY, on ? "1" : "0");
}

// Apply layout edit UI state
export function applyLayoutEditUI(on, iconLockOpen, iconLockClosed) {
  document.documentElement.classList.toggle("layout-editing", !!on);
  const btn = $("layoutBtn");
  const icon = $("layoutBtnIcon");

  if (icon) icon.innerHTML = on ? iconLockOpen() : iconLockClosed();
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const state = on ? t("layout.on") : t("layout.off");
    btn.title = t("layout.titleLine", { state });
  }
}
