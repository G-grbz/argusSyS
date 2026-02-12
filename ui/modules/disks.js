import { $, setText } from "./dom.js";
import { clamp, formatBytes, formatRate, pctColorCss, setBar, escHtml, getParam } from "./util.js";
import { KEYS, lsGetJson, lsSetJson, lsSet } from "./storage.js";
import { t } from "./i18n.js";
import { isCoarsePointer, loadLayoutEdit } from "./layout.js";

// Calculate used percentage
export function calcDiskPct(d) {
  const used = Number(d?.used), total = Number(d?.total);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return (used / total) * 100;
}

// Map disk columns to a grid span
function diskSpanForCols(cols) {
  if (cols === 4) return 9;
  if (cols === 3) return 10;
  if (cols === 2) return 11;
  return 8;
}

// Format disk IO line
function fmtDiskIo(d) {
  const r = Number(d?.read_bps);
  const w = Number(d?.write_bps);
  const rr = Number.isFinite(r) ? formatRate(r) : "—";
  const ww = Number.isFinite(w) ? formatRate(w) : "—";
  return t("disk.ioLine", { read: rr, write: ww });
}

// Format disk metadata line
function fmtDiskMeta(d) {
  const model = (d?.blk_model || "").trim();
  const label = (d?.blk_label || "").trim();
  const parts = [];
  if (model) parts.push(model);
  if (label) parts.push(label);
  return parts.join(" · ");
}

// Hero disk carousel state
export const heroDisk = { items: [], idx: 0, lastTs: 0, intervalMs: 10000 };

// Update hero disk UI
export function setHeroDisk(d, setBarFn = setBar) {
  if (!d) {
    setText("fullestDisk", "—");
    setText("fullestPct", "—");
    setText("fullestFree", "—");
    setText("fullestLine", "—");
    setBarFn($("fullestBar"), 0);
    return;
  }
  setText("fullestDisk", d.mount || d.label || "—");
  setText("fullestPct", Number.isFinite(d.pct) ? d.pct.toFixed(1) + "%" : "—");
  setText("fullestFree", formatBytes(d.free));
  setText("fullestLine", t("disk.usedOverTotal", { used: formatBytes(d.used), total: formatBytes(d.total) }));
  setBarFn($("fullestBar"), d.pct ?? 0);
}

// Resolve disk columns from query/storage
export function resolveDiskCols() {
  const q = Number((getParam("diskcols") || "").trim());
  if ([1, 2, 3, 4].includes(q)) return q;

  const embed = (getParam("embed") || "").trim() === "1";
  if (embed) return 2;

  const saved = Number((localStorage.getItem("stats_ui_disk_cols") || "").trim());
  if ([1, 2, 3, 4].includes(saved)) return saved;

  return 1;
}

// Resolve disk group index from query
export function resolveDiskGroup() {
  const g = Number((getParam("diskgroup") || "").trim());
  if (Number.isFinite(g) && g >= 1) return Math.floor(g);
  return null;
}

// Disk layout key for a column count
function diskLayoutKey(cols) {
  return KEYS.DISK_LAYOUT_KEY_PREFIX + String(cols);
}

// Load disk layout lists for column count
function loadDiskLayout(cols) {
  const st = lsGetJson(diskLayoutKey(cols), null);
  if (!st || st.v !== 1 || !Array.isArray(st.lists)) return null;
  const lists = st.lists.slice(0, cols).map((a) => (Array.isArray(a) ? a.map(String) : []));
  while (lists.length < cols) lists.push([]);
  return lists;
}

// Save disk layout lists for column count
function saveDiskLayout(cols, lists) {
  lsSetJson(diskLayoutKey(cols), {
    v: 1,
    cols,
    savedAt: Date.now(),
    lists: (lists || []).slice(0, cols).map((a) => (Array.isArray(a) ? a.map(String) : [])),
  });
}

// Chunk array into groups
function chunk(arr, n) {
  n = Math.max(1, Math.floor(n || 1));
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Build a default layout from sorted entries
function defaultDiskLayoutFromSorted(sortedEntries, cols) {
  const perGroup = Math.ceil(sortedEntries.length / cols);
  const groups = chunk(sortedEntries, perGroup);
  const lists = [];
  for (let i = 0; i < cols; i++) lists[i] = (groups[i] || []).map(([k, d]) => String(d.key || k));
  while (lists.length < cols) lists.push([]);
  return lists;
}

function sameLists(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = Array.isArray(a[i]) ? a[i] : [];
    const bi = Array.isArray(b[i]) ? b[i] : [];
    if (ai.length !== bi.length) return false;
    for (let j = 0; j < ai.length; j++) {
      if (String(ai[j]) !== String(bi[j])) return false;
    }
  }
  return true;
}

// Group entries based on persisted layout
function groupsByLayout(sortedEntries, cols) {
  const map = new Map(sortedEntries.map(([k, d]) => [String(d.key || k), [String(d.key || k), d]]));
  let lists = loadDiskLayout(cols);
  let dirty = false;
 if (!lists) { lists = defaultDiskLayoutFromSorted(sortedEntries, cols); dirty = true; }

  const used = new Set();
  const groups = Array.from({ length: cols }, () => []);

  for (let i = 0; i < cols; i++) {
    const want = Array.isArray(lists[i]) ? lists[i] : [];
    for (const k0 of want) {
      const k = String(k0);
      if (used.has(k)) continue;
      const pair = map.get(k);
      if (!pair) continue;
      groups[i].push(pair);
      used.add(k);
    }
  }

  for (const [k, d] of sortedEntries) {
    const ks = String(d.key || k);
    if (used.has(ks)) continue;
    let best = 0;
    for (let i = 1; i < cols; i++) if (groups[i].length < groups[best].length) best = i;
    groups[best].push([ks, d]);
    used.add(ks);
  }

  const outLists = groups.map((g) => g.map(([k]) => String(k)));
 if (dirty || !sameLists(lists, outLists)) {
   saveDiskLayout(cols, outLists);
 }
  return groups;
}

// Disk cards build state
let diskCardEls = [];
let diskLastBuiltCols = 0;
let diskItemSortables = [];
let diskDragging = false;

// Destroy disk cards and sortables
function clearDiskCards() {
  destroyDiskItemSortables();
  for (const x of diskCardEls) x.card.remove();
  diskCardEls = [];
  diskLastBuiltCols = 0;
}

// Ensure group chip element exists
function ensureGroupChip(el) {
  if (!el) return null;
  let chip = el.querySelector(".group-chip");
  if (chip) return chip;
  chip = document.createElement("span");
  chip.className = "badge mono badge-soft group-chip";
  el.appendChild(chip);
  return chip;
}

// Set disk card title + group chip
function setDiskCardTitle(cardObj, groupIndex, groupCount, titleText) {
  if (!cardObj?.titleEl) return;
  cardObj.titleEl.textContent = titleText;
  const chip = ensureGroupChip(cardObj.titleEl);
  if (!chip) return;
  chip.textContent = groupCount > 1 ? t("disk.groupChip", { idx: groupIndex, total: groupCount }) : "";
}

// Destroy Sortable instances for disk items
export function destroyDiskItemSortables() {
  for (const s of diskItemSortables) { try { s.destroy(); } catch {} }
  diskItemSortables = [];
}

// Save disk layout from current DOM lists
function saveDiskLayoutFromDOM(cols) {
  const lists = [];
  for (let i = 0; i < cols; i++) {
    const el = document.getElementById(`diskList_${i}`);
    if (!el) { lists.push([]); continue; }
    const keys = Array.from(el.querySelectorAll('.disk-item[data-disk-key]'))
      .map((x) => x.getAttribute("data-disk-key"))
      .filter(Boolean);
    lists.push(keys);
  }
  saveDiskLayout(cols, lists);
}

// Bind Sortable to disk item lists
let diskSortSig = "";

export function initDiskItemSortables(cols, notifyHeight) {
  if (!window.Sortable) return;

  const mobile = isCoarsePointer();
  const editOn = loadLayoutEdit();
  const sig = `${cols}|${mobile ? 1 : 0}|${editOn ? 1 : 0}`;
 if (sig === diskSortSig && diskItemSortables.length === cols) {
   for (const s of diskItemSortables) s.option("disabled", !editOn);
   return;
 }
 diskSortSig = sig;
 destroyDiskItemSortables();

  for (let i = 0; i < cols; i++) {
    const listEl = document.getElementById(`diskList_${i}`);
    if (!listEl) continue;

    const s = window.Sortable.create(listEl, {
      group: {
        name: "disk-items",
        pull: (to, from, dragEl) => dragEl?.classList?.contains("disk-item"),
        put:  (to, from, dragEl) => dragEl?.classList?.contains("disk-item"),
      },
      animation: 150,
      draggable: ".disk-item",
      handle: ".disk-drag-handle",
      ghostClass: "is-sort-ghost",
      chosenClass: "is-sort-chosen",
      dragClass: "is-sort-drag",

      delay: mobile ? 250 : 0,
      delayOnTouchOnly: true,
      touchStartThreshold: mobile ? 8 : 0,
      fallbackTolerance: mobile ? 8 : 0,
      forceFallback: mobile,
      scroll: true,
      scrollSensitivity: mobile ? 60 : 30,
      scrollSpeed: mobile ? 12 : 8,

      onStart: () => { diskDragging = true; },
      onEnd: () => {
        diskDragging = false;
        saveDiskLayoutFromDOM(cols);
        setTimeout(() => notifyHeight?.(), 30);
      },
    });

    s.option("disabled", !editOn);
    diskItemSortables.push(s);
  }
}

// Create disk cards for given column count
function ensureDiskCards(cols, spanColsHint, applyOnlyToCardEl, iconGripGrid6, notifyHeight, initSortable, applyCardOrder) {
  cols = clamp(Number(cols) || 1, 1, 4);
  spanColsHint = clamp(Number(spanColsHint) || cols, 1, 4);

  const anchor = $("disksAnchor");
  if (!anchor) return [];

  const grid = anchor.closest(".dashboard-grid");
  if (!grid) return [];

  if (diskLastBuiltCols === cols && diskCardEls.length === cols) return diskCardEls;

  clearDiskCards();
  const span = diskSpanForCols(spanColsHint);

  for (let i = 0; i < cols; i++) {
    const card = document.createElement("div");
    card.className = `card span-${span}`;
    card.setAttribute("data-card", "disks");
    card.setAttribute("data-card-id", `disks-${i + 1}`);
    card.setAttribute("data-diskcols", String(spanColsHint));
    applyOnlyToCardEl?.(card);

    const header = document.createElement("div");
    header.className = "card-header";

    const handle = document.createElement("button");
    handle.className = "drag-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", t("spark.options.dragReorder"));
    handle.title = t("spark.options.dragReorder");
    handle.innerHTML = iconGripGrid6();

    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = t("disks.title");

    const badge = document.createElement("span");
    badge.className = "badge mono";
    badge.textContent = "—";

    header.appendChild(handle);
    header.appendChild(title);
    header.appendChild(badge);

    if (i === 0) {
      const group = document.createElement("div");
      group.className = "input-group history-group";

      const sel = document.createElement("select");
      sel.id = "diskColsSelect";
      sel.setAttribute("aria-label", t("spark.options.diskGroups"));

      sel.innerHTML = `
        <option value="1">${t("num.1")}</option>
        <option value="2">${t("num.2")}</option>
        <option value="3">${t("num.3")}</option>
        <option value="4">${t("num.4")}</option>
      `;
      sel.value = String(cols);

      const isEmbed = (getParam("embed") || "").trim() === "1";
      if (isEmbed) group.style.display = "none";

      sel.addEventListener("change", () => {
        const v = Number(sel.value);
        if (![1, 2, 3, 4].includes(v)) return;

        lsSet(KEYS.DISK_COLS_KEY, String(v));
        window.dispatchEvent(new CustomEvent("stats-ui:disk-cols", { detail: { cols: v } }));
        setTimeout(() => notifyHeight?.(), 60);
      });

      group.appendChild(sel);
      header.appendChild(group);
    }

    const body = document.createElement("div");
    body.className = "disk-list";
    body.id = `diskList_${i}`;

    card.appendChild(header);
    card.appendChild(body);

    grid.insertBefore(card, anchor);
    diskCardEls.push({ card, listEl: body, badgeEl: badge, titleEl: title });
  }

  diskLastBuiltCols = cols;
  setTimeout(() => notifyHeight?.(), 30);
  setTimeout(() => {
    applyCardOrder?.();
    initSortable?.();
    initDiskItemSortables(diskCardEls.length, notifyHeight);
  }, 10);

  return diskCardEls;
}

// Render disks cards and return fullest disk info
export function renderDisks(data, ctx) {
  const {
    diskCols,
    DISK_GROUP,
    applyOnlyToCardEl,
    iconGripGrid6,
    notifyHeight,
    initSortable,
    applyCardOrder,
  } = ctx;

  const disks = data.disks || {};
  const entriesAll = Object.entries(disks);
  const entries = entriesAll.filter(([_, d]) => {
    const total = Number(d?.total);
    return d && !d.error && Number.isFinite(total) && total > 0;
  });

  const wantCols = (DISK_GROUP != null) ? 1 : diskCols;

  const groupCount = clamp(
    Number((getParam("diskcols") || "").trim()) || diskCols || 2,
    1,
    4
  );

  const cards = ensureDiskCards(
    wantCols,
    (DISK_GROUP != null ? groupCount : wantCols),
    applyOnlyToCardEl,
    iconGripGrid6,
    notifyHeight,
    initSortable,
    applyCardOrder
  );

  if (!cards.length) return { fullest: null };

  if (DISK_GROUP != null) {
    const gi = Math.max(1, Math.floor(DISK_GROUP));
    setDiskCardTitle(cards[0], gi, groupCount, t("disks.title"));
  } else {
    for (let i = 0; i < cards.length; i++) setDiskCardTitle(cards[i], i + 1, cards.length, t("disks.title"));
  }

  if (diskDragging) {
    let fullest = null;
    for (const [key, d] of entries) {
      const mount = d?.label_key ? t(d.label_key) : (d?.label || d?.mount || d?.path || key);
      const pct = calcDiskPct(d);
      if (pct != null) if (!fullest || pct > fullest.pct) fullest = { mount, pct, d };
    }
    return { fullest };
  }

  cards.forEach((c) => {
    c.listEl.innerHTML = "";
    c.badgeEl.textContent = "—";
    c.card.classList.remove("is-empty-hidden");
  });

  if (!entries.length) {
    cards.forEach((c) => {
      c.badgeEl.textContent = t("disks.count", { n: 0 });
      c.card.classList.add("is-empty-hidden");
    });
    heroDisk.items = [];
    heroDisk.idx = 0;
    heroDisk.lastTs = 0;
    setTimeout(() => notifyHeight?.(), 30);
    return { fullest: null };
  }

  const heroItems = entries.map(([key, d]) => {
    const mount = d?.label_key ? t(d.label_key) : (d?.label || d?.mount || d?.path || key);
    const total = Number(d.total);
    const used = Number(d.used);
    const free = Number(d.free);
    const pct = (used / total) * 100;
    return { mount, label: d.label, total, used, free, pct };
  });

  const prevSig = heroDisk.items.map((i) => i.mount).join("|");
  const nextSig = heroItems.map((i) => i.mount).join("|");
  if (prevSig !== nextSig) {
    heroDisk.items = heroItems;
    heroDisk.idx = 0;
    heroDisk.lastTs = 0;
  }

  const fallbackSorted = entries.slice().sort((a, b) => {
    const da = a[1], db = b[1];
    const ma = (da?.label || da?.mount || da?.path || a[0] || "").toString();
    const mb = (db?.label || db?.mount || db?.path || b[0] || "").toString();
    return ma.localeCompare(mb);
  });

  const cols = clamp(Number(wantCols) || 1, 1, 4);
  const editOn = document.documentElement.classList.contains("layout-editing");

  let groups;
  if (DISK_GROUP != null) {
    groups = groupsByLayout(fallbackSorted, groupCount);
    while (groups.length < groupCount) groups.push([]);
  } else {
    groups = groupsByLayout(fallbackSorted, cols);
  }

  let fullest = null;

  const renderRow = (c, key, d, showDrag) => {
    const mount = d?.label_key ? t(d.label_key) : (d?.label || d?.mount || d?.path || key);
    const meta = fmtDiskMeta(d);
    const metaHtml = meta ? `<div class="disk-meta-row mono">${escHtml(meta)}</div>` : "";
    const pct = calcDiskPct(d);

    if (pct != null) if (!fullest || pct > fullest.pct) fullest = { mount, pct, d };

    const row = document.createElement("div");
    row.className = "disk-item";
    row.setAttribute("data-disk-key", String(d.key || key));
    if (pct != null) {
      if (pct >= 90) row.classList.add("disk-hot");
      else if (pct >= 70) row.classList.add("disk-warn");
    }

    row.innerHTML = `
      <div class="disk-header">
        ${showDrag ? `<button class="disk-drag-handle" type="button" aria-label="${escHtml(t("spark.options.drag"))}">${iconGripGrid6()}</button>` : ""}
        <div class="disk-name">
          ${escHtml(mount)}
          ${d?.fstype ? `<span class="badge mono badge-soft">${escHtml(d.fstype)}</span>` : ""}
        </div>
        <div class="disk-io-row mono">${escHtml(fmtDiskIo(d))}</div>
      </div>
      ${metaHtml}
    `;

    const progress = document.createElement("div");
    progress.className = "progress-container";
    progress.innerHTML = `
      <div class="progress-info">
        <div class="progress-info__top">
          <span class="disk-pct">${pct != null ? pct.toFixed(1) + "%" : t("misc.na")}</span>
          <span class="mono">${formatBytes(d.total)}</span>
        </div>
        <div class="progress-info__sub mono">
          <span class="disk-free">${t("disk.freeLine", { val: formatBytes(d.free) })}</span>
          <span class="disk-used">${t("disk.usedLine", { val: formatBytes(d.used) })}</span>
        </div>
      </div>
      <div class="progress"><div class="progress-bar"></div></div>
    `;

    const bar = progress.querySelector(".progress-bar");
    const pctEl = progress.querySelector(".disk-pct");
    const color = pctColorCss(pct ?? 0);
    setBar(bar, pct ?? 0, color);
    if (pctEl) pctEl.style.color = color;

    row.appendChild(progress);
    c.listEl.appendChild(row);
  };

  if (DISK_GROUP != null) {
    const gi = Math.max(0, Math.floor(DISK_GROUP - 1));
    const groupEntries = (gi >= 0 && gi < groups.length) ? (groups[gi] || []) : [];
    const c = cards[0];
    c.badgeEl.textContent = t("disks.count", { n: groupEntries.length });

    if (!groupEntries.length) {
      c.card.classList.add("is-empty-hidden");
      return { fullest: null };
    }

    for (const [key, d] of groupEntries) renderRow(c, key, d, false);
    setTimeout(() => initDiskItemSortables(1, notifyHeight), 0);
    setTimeout(() => notifyHeight?.(), 30);
    return { fullest };
  }

  groups.forEach((groupEntries, gi) => {
    if (!groupEntries?.length) return;
    const c = cards[gi];
    if (!c) return;
    c.badgeEl.textContent = t("disks.count", { n: groupEntries.length });
    for (const [key, d] of groupEntries) renderRow(c, key, d, editOn);
  });

  cards.forEach((c) => c.card.classList.toggle("is-empty-hidden", !c.listEl.children.length));
  setTimeout(() => initDiskItemSortables(cards.length, notifyHeight), 0);
  setTimeout(() => notifyHeight?.(), 30);
  return { fullest };
}

// Advance hero disk carousel
export function tickHeroDisk(now, notifyHeight) {
  if (!heroDisk.items?.length) return;
  if (!heroDisk.lastTs) heroDisk.lastTs = now;
  if (now - heroDisk.lastTs >= heroDisk.intervalMs) {
    heroDisk.idx = (heroDisk.idx + 1) % heroDisk.items.length;
    heroDisk.lastTs = now;
    setHeroDisk(heroDisk.items[heroDisk.idx]);
    setTimeout(() => notifyHeight?.(), 10);
  }
}
