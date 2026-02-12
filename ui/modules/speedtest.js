import { clamp } from "./util.js";
import { t, formatDateTime } from "./i18n.js";
import { $ } from "./dom.js";

// Speedtest UI state machine (client-side)
export const ST_UI = {
  wasRunning: false,
  lastTsSeen: 0,
  holdUntil: 0,
  forceUntil: 0,
  endHoldMs: 4000,
  resetAt: 0,
  resetDone: false,
  lastDown: null,
  lastUp: null,
  lastMaxDown: 0,
  lastMaxUp: 0,
  downNeedleZeroed: false,
  upNeedleZeroed: false,
  phase: "idle",
  waitDownZeroBeforeUpload: true,
};

// Choose a "nice" max value for the gauge scale
export function niceGaugeMax(mbps, fallback = 200) {
  const v = Number(mbps);
  const x = Number.isFinite(v) && v > 0 ? v : fallback;
  const steps = [25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000];
  for (const s of steps) if (x <= s) return s;
  return Math.ceil(x / 1000) * 1000;
}

// Update gauge visuals (fill/needle/max) without changing the displayed value text
function setGaugeVisual(prefix, valueMbps, maxMbps) {
  const v = Number(valueMbps);
  const max = Math.max(1, Number(maxMbps) || 1);
  const pct = Number.isFinite(v) ? clamp(v / max, 0, 1) : 0;

  const fill = $(prefix + "Fill");
  if (fill) {
    if (!fill._len) {
      try { fill._len = fill.getTotalLength(); } catch { fill._len = 1; }
    }
    const L = fill._len || 1;
    fill.style.strokeDasharray = String(L);
    fill.style.strokeDashoffset = String(L * (1 - pct));
  }

  const needle = $(prefix + "Needle");
  if (needle) {
    const deg = pct * 180;
    needle.setAttribute("transform", `rotate(${deg.toFixed(1)} 50 50)`);
  }

  const maxEl = $(prefix + "GaugeMax");
  if (maxEl) maxEl.textContent = t("st.gauge.maxLine", { max: max.toFixed(0) });
}

// Update gauge visuals (fill/needle/max) and the displayed value text
function setGauge(prefix, valueMbps, maxMbps) {
  const v = Number(valueMbps);
  const max = Math.max(1, Number(maxMbps) || 1);
  const pct = Number.isFinite(v) ? clamp(v / max, 0, 1) : 0;

  const fill = $(prefix + "Fill");
  if (fill) {
    if (!fill._len) {
      try { fill._len = fill.getTotalLength(); } catch { fill._len = 1; }
    }
    const L = fill._len || 1;
    fill.style.strokeDasharray = String(L);
    fill.style.strokeDashoffset = String(L * (1 - pct));
  }

  const needle = $(prefix + "Needle");
  if (needle) {
    const deg = pct * 180;
    needle.setAttribute("transform", `rotate(${deg.toFixed(1)} 50 50)`);
  }

  const valEl = $(prefix + "GaugeVal");
  if (valEl) valEl.textContent = Number.isFinite(v) ? t("st.gauge.valLine", { val: v.toFixed(2) }) : "—";

  const maxEl = $(prefix + "GaugeMax");
  if (maxEl) maxEl.textContent = t("st.gauge.maxLine", { max: max.toFixed(0) });
}

// Flash the last value badge using threshold-based color classes
function flashGaugeValue(side, valueMbps) {
  const el = side === "down" ? $("stDownGaugeVal") : $("stUpGaugeVal");
  if (!el) return;

  el.classList.remove("st-ok", "st-warn", "st-bad", "st-flash");

  const v = Number(valueMbps);
  let cls = null;
  if (Number.isFinite(v)) {
    if (side === "down") cls = v >= 100 ? "st-ok" : v >= 25 ? "st-warn" : "st-bad";
    else cls = v >= 20 ? "st-ok" : v >= 5 ? "st-warn" : "st-bad";
  }

  if (cls) el.classList.add(cls);
  void el.offsetWidth;
  el.classList.add("st-flash");
  setTimeout(() => el.classList.remove("st-flash"), 750);
}

// Format milliseconds as label
export function fmtMs(ms) {
  if (ms == null || ms === "") return "—";
  const n = Number(ms);
  return Number.isFinite(n) ? t("unit.msLine", { n: n.toFixed(1) }) : "—";
}

// Format Mbps as label
export function fmtMbps(m) {
  if (m == null || m === "") return "—";
  const n = Number(m);
  return Number.isFinite(n) ? t("unit.mbpsLine", { n: n.toFixed(2) }) : "—";
}

// Format unix timestamp with current UI locale (i18n.js)
export function fmtTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return formatDateTime(n);
}

// Fetch last speedtest snapshot
export async function stFetchSnapshot(apiBase) {
  const stats = apiBase.endsWith("/stats") ? apiBase : apiBase.replace(/\/+$/, "") + "/stats";
  const url = `${stats}/speedtest/last`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(t("http.errorLine", { code: r.status }));
  return r.json();
}

// Set speedtest interval (minutes)
export async function stSetInterval(apiBase, min) {
  const stats = apiBase.endsWith("/stats") ? apiBase : apiBase.replace(/\/+$/, "") + "/stats";
  const url = `${stats}/speedtest/config?interval=${encodeURIComponent(min)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(t("http.errorLine", { code: r.status }));
  return r.json();
}

// Trigger a speedtest run
export async function stRun(apiBase) {
  const stats = apiBase.endsWith("/stats") ? apiBase : apiBase.replace(/\/+$/, "") + "/stats";
  const url = `${stats}/speedtest/run`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(t("http.errorLine", { code: r.status }));
  return r.json();
}

// Fetch the last 24 hours of speedtest history
export async function stFetchHistory(apiBase) {
  const stats = apiBase.endsWith("/stats") ? apiBase : apiBase.replace(/\/+$/, "") + "/stats";
  const url = `${stats}/speedtest/history`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(t("http.errorLine", { code: r.status }));
  return r.json();
}

// Render a compact interactive sparkline inside an SVG element
function sparkline(svgEl, values, opts = {}) {
  if (!svgEl) return;

  function ensureGlowFilter(svg) {
    const id = "stGlow";
    if (svg.querySelector(`#${id}`)) return id;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    f.setAttribute("id", id);
    f.setAttribute("x", "-40%");
    f.setAttribute("y", "-40%");
    f.setAttribute("width", "180%");
    f.setAttribute("height", "180%");
    const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    blur.setAttribute("in", "SourceGraphic");
    blur.setAttribute("stdDeviation", "1.6");
    blur.setAttribute("result", "blur");
    f.appendChild(blur);
    defs.appendChild(f);
    svg.insertBefore(defs, svg.firstChild);
    return id;
  }

  const {
    times = [],
    colorClass = "",
    showLastLabel = true,
    showShortTs = true,
    fmtVal = (v) => v,
    initialBadge = null,
    fmtBadge = (p) => fmtVal(p.v),
    fmtTs = (t) => t,
    fmtShortTs = (t) => {
      if (!t) return "";
      try {
        const d = new Date(Number(t));
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      } catch { return ""; }
    },
  } = opts;

  const w = 140, h = 44, pad = 4;

  svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svgEl.innerHTML = "";

  const pairs = (values || [])
    .map((raw, i) => {
      const v = (raw == null || raw === "") ? NaN : Number(raw);
      return { v, ts: times?.[i] };
    })
    .filter(it => Number.isFinite(it.v));

  if (pairs.length < 2) return;

  const n = pairs.length;
  const arr = pairs.map(it => it.v);
  let min = Math.min(...arr);
  let max = Math.max(...arr);
  if (min === max) { min -= 1; max += 1; }
  {
    const span = Math.max(1e-9, max - min);
    const padY = Math.max(1, span * 0.10);
    min -= padY;
    max += padY;
  }

  const innerW = (w - pad * 2);
  const innerH = (h - pad * 2);

  const pts = pairs.map((it, i) => {
    const x = pad + (i / (n - 1)) * innerW;
    const y = pad + (1 - (it.v - min) / (max - min)) * innerH;
    return { x, y, v: it.v, ts: it.ts };
  });

  // polyline
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" "));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "currentColor");
  poly.setAttribute("stroke-width", "2.6");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("vector-effect", "non-scaling-stroke");
  poly.classList.add("st-line");
  poly.style.pointerEvents = "none";
  if (colorClass) poly.classList.add(colorClass);
  svgEl.appendChild(poly);

  const card = svgEl.closest(".st-hist-card") || svgEl.parentElement;

  function ensureBadge(cardEl) {
    if (!cardEl) return null;

    const label = cardEl.querySelector?.(".st-hist-label");
    if (!label) return null;

    let b = label.querySelector?.(".st-hist-badge");
    if (!b) {
      b = document.createElement("span");
      b.className = "st-hist-badge";
      label.appendChild(b);
    }
    return b;
  }

  const badge = ensureBadge(card);

  let tip = card?.querySelector?.(".st-tip");
  if (card && !tip) {
    tip = document.createElement("div");
    tip.className = "st-tip";
    card.appendChild(tip);
  }

  let activeDot = null;
  let activeHit = null;

  function setDotHot(dot, on) {
    if (!dot) return;
    if (on) {
      if (activeDot && activeDot !== dot) setDotHot(activeDot, false);
      activeDot = dot;
      dot.classList.add("is-hot");
      dot.setAttribute("filter", `url(#${glowId})`);
    } else {
      dot.classList.remove("is-hot");
      if (dot === dotsByIdx[n - 1]) dot.setAttribute("filter", `url(#${glowId})`);
      else dot.removeAttribute("filter");

      if (activeDot === dot) activeDot = null;
    }
  }

  function showTip(p, clientX, clientY) {
    if (!tip || !card) return;
    const r = card.getBoundingClientRect();
    tip.textContent = `${fmtVal(p.v)} · ${fmtTs(p.ts)}`;
    if (badge) badge.textContent = fmtBadge(p);

    const x0 = (clientX != null) ? (clientX - r.left) : (p.x / w) * r.width;
    const y0 = (clientY != null) ? (clientY - r.top) : (p.y / h) * r.height;

    tip.classList.add("is-on");
    tip.style.left = "0px";
    tip.style.top = "0px";
    const tr = tip.getBoundingClientRect();
    const tw = tr.width || 120;
    const th = tr.height || 36;

    const padPx = 8;
    const minX = padPx + tw / 2;
    const maxX = r.width - padPx - tw / 2;

    const wantAbove = true;
    const aboveY = y0 - 10;
    const belowY = y0 + 16;

    const canAbove = (aboveY - th) >= padPx;
    const y = (wantAbove && canAbove) ? aboveY : Math.min(r.height - padPx, belowY);
    const x = Math.max(minX, Math.min(maxX, x0));

    tip.style.left = `${x}px`;
    tip.style.top  = `${Math.max(padPx, Math.min(r.height - padPx, y))}px`;
    tip.classList.toggle("is-below", !(wantAbove && canAbove));
    tip.classList.add("is-on");
  }

  function hideTip() {
    tip?.classList?.remove("is-on");
    tip?.classList?.remove("is-below");
    if (activeDot) setDotHot(activeDot, false);
    if (activeHit) activeHit.classList.remove("is-hot");
    activeDot = null;
    activeHit = null;
    if (badge && pts?.length) {
      const lp = pts[pts.length - 1];
      badge.textContent = fmtBadge(lp);
    }
  }

  function nearestPointFromClient(ev) {
    const r = svgEl.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * w;
    const idx = Math.round(((mx - pad) / (w - pad * 2)) * (n - 1));
    const i = Math.max(0, Math.min(n - 1, idx));
    return pts[i];
  }

  svgEl.addEventListener("pointermove", (ev) => {
    const p = nearestPointFromClient(ev);
    if (p) showTip(p, ev.clientX, ev.clientY);
  });
  svgEl.addEventListener("pointerleave", () => hideTip());
  svgEl.addEventListener("pointerdown", (ev) => {
    const p = nearestPointFromClient(ev);
    if (p) showTip(p, ev.clientX, ev.clientY);
    setTimeout(() => {
      const onDoc = (e2) => {
        if (!card?.contains?.(e2.target)) hideTip();
        document.removeEventListener("pointerdown", onDoc, true);
      };
      document.addEventListener("pointerdown", onDoc, true);
    }, 0);
  });

  const k = n <= 10 ? 1 : Math.ceil(n / 6);
  const shouldStamp = (i) => showShortTs && (i % k === 0 || i === n - 1);

  const glowId = ensureGlowFilter(svgEl);
  const dotsByIdx = new Array(n);
  const hitsByIdx = new Array(n);
  const labelRects = [];

  function rectsOverlap(a, b) {
    return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
  }

  function tryPlaceLabel(txtEl, x, y, anchor) {
    txtEl.setAttribute("x", x.toFixed(2));
    txtEl.setAttribute("y", y.toFixed(2));
    txtEl.setAttribute("text-anchor", anchor);

    const bb = txtEl.getBBox?.();
    if (!bb) return false;
    const r = { x1: bb.x, y1: bb.y, x2: bb.x + bb.width, y2: bb.y + bb.height };

    if (r.x1 < 0 || r.y1 < 0 || r.x2 > w || r.y2 > h) return false;

    for (const prev of labelRects) {
      if (rectsOverlap(r, prev)) return false;
    }
    labelRects.push(r);
    return true;
  }

  if (card) card._stHideTip = hideTip;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");

    hit.setAttribute("cx", p.x);
    hit.setAttribute("cy", p.y);
    hit.setAttribute("r", i === n - 1 ? 12 : 10);
    hit.setAttribute("fill", "transparent");
    hit.style.pointerEvents = "all";
    hit.style.cursor = "pointer";
    hitsByIdx[i] = hit;

    function hotOn() {
      const d = dotsByIdx[i];
      if (d) setDotHot(d, true);
      if (activeHit && activeHit !== hit) activeHit.classList.remove("is-hot");
      activeHit = hit;
      activeHit.classList.add("is-hot");
    }

    hit.addEventListener("pointerenter", (e) => { hotOn(); showTip(p, e.clientX, e.clientY); });
    hit.addEventListener("pointermove",  (e) => { hotOn(); showTip(p, e.clientX, e.clientY); });
    hit.addEventListener("pointerleave", () => hideTip());
    hit.addEventListener("pointerdown",  (e) => {
      hotOn();
      showTip(p, e.clientX, e.clientY);
      setTimeout(() => {
        const onDoc = (ev) => {
          if (!card.contains(ev.target)) hideTip();
          document.removeEventListener("pointerdown", onDoc, true);
        };
        document.addEventListener("pointerdown", onDoc, true);
      }, 0);
    });

    svgEl.appendChild(hit);

    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", p.x);
    c.setAttribute("cy", p.y);
    c.setAttribute("r", i === n - 1 ? "2.0" : "1.25");
    c.setAttribute("fill", "currentColor");
    c.classList.add("st-dot");
    if (i !== n - 1) c.classList.add("st-dot-all");
    if (colorClass) c.classList.add(colorClass);
    c.style.pointerEvents = "none";
    if (i === n - 1) c.setAttribute("filter", `url(#${glowId})`);
    dotsByIdx[i] = c;

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${fmtVal(p.v)} @ ${fmtTs(p.ts)}`;

    c.appendChild(title);
    svgEl.appendChild(c);

    if (shouldStamp(i)) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const s = fmtShortTs(p.ts);
      if (s) {
        t.classList.add("st-label");
        if (colorClass) t.classList.add(colorClass);
        t.textContent = s;
        svgEl.appendChild(t);

        const anchor = p.x > (w - 18) ? "end" : "start";
        const tx = Math.max(2, Math.min(w - 2, p.x));
        const positions = [
          { x: tx, y: Math.max(10, p.y - 7), a: anchor },
          { x: tx, y: Math.min(h - 2, p.y + 12), a: anchor },
          { x: Math.max(2, tx - 10), y: Math.max(10, p.y - 7), a: "end" },
          { x: Math.min(w - 2, tx + 10), y: Math.max(10, p.y - 7), a: "start" },
        ];

        let ok = false;
        for (const pos of positions) {
          if (tryPlaceLabel(t, pos.x, pos.y, pos.a)) { ok = true; break; }
        }
        if (!ok) t.remove();
      }
    }
  }
  if (badge && pts?.length) {
    const lp = pts[pts.length - 1];
    const p0 = (initialBadge && Number.isFinite(Number(initialBadge.v)))
      ? { v: Number(initialBadge.v), ts: initialBadge.ts }
      : lp;
    badge.textContent = fmtBadge(p0);
  }
}

let _stHistBound = false;
export function initSpeedtestHistoryModal(getApiBase, getLang) {
  if (_stHistBound) return;
  _stHistBound = true;

  const btn = $("stHistBtn");
  const modal = $("stHistModal");
  if (!btn || !modal) return;

  function close() {
    modal.querySelectorAll(".st-tip.is-on").forEach(el => {
      el.classList.remove("is-on", "is-below");
    });

    modal.querySelectorAll("svg").forEach(svg => {
      svg.dispatchEvent(new PointerEvent("pointerleave"));
    });

    modal.classList.add("is-hidden");
  }

  modal.addEventListener("click", (e) => {
    const el = e.target;
    if (el && el.getAttribute && el.getAttribute("data-close") === "1") close();
  });

  btn.addEventListener("click", async () => {
    try {
      modal.classList.remove("is-hidden");

      const apiBase = getApiBase?.() || "";
      const j = await stFetchHistory(apiBase);
      const hist = Array.isArray(j?.history) ? j.history : [];
      hist.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
      const last = hist[hist.length - 1] || null;

      sparkline($("stHistPing"),
        hist.map(it => it?.ping_ms),
        {
          times: hist.map(it => it?.ts),
          colorClass: "ping",
          initialBadge: last ? { v: last?.ping_ms, ts: last?.ts } : null,
          fmtBadge: p => `${p.v.toFixed(1)} ms`,
          fmtVal: v => `${v.toFixed(1)} ms`,
          fmtTs: t => fmtTs(t),
        }
      );

      sparkline($("stHistJitter"),
        hist.map(it => it?.jitter_ms),
        {
          times: hist.map(it => it?.ts),
          colorClass: "jitter",
          initialBadge: last ? { v: last?.jitter_ms, ts: last?.ts } : null,
          fmtBadge: p => `${p.v.toFixed(1)} ms`,
          fmtVal: v => `${v.toFixed(1)} ms`,
          fmtTs: t => fmtTs(t),
        }
      );

      sparkline($("stHistDown"),
        hist.map(it => it?.down_mbps),
        {
          times: hist.map(it => it?.ts),
          colorClass: "down",
          initialBadge: last ? { v: last?.down_mbps, ts: last?.ts } : null,
          fmtBadge: p => `${p.v.toFixed(1)} Mbps`,
          fmtVal: v => `${v.toFixed(1)} Mbps`,
          fmtTs: t => fmtTs(t),
        }
      );

      sparkline($("stHistUp"),
        hist.map(it => it?.up_mbps),
        {
          times: hist.map(it => it?.ts),
          colorClass: "up",
          initialBadge: last ? { v: last?.up_mbps, ts: last?.ts } : null,
          fmtBadge: p => `${p.v.toFixed(1)} Mbps`,
          fmtVal: v => `${v.toFixed(1)} Mbps`,
          fmtTs: t => fmtTs(t),
        }
      );
      const hint = $("stHistHint");
      if (hint) {
        const lastTs = Number(last?.ts || 0);
        hint.textContent = hist.length
          ? `${hist.length} samples · last: ${lastTs ? fmtTs(lastTs) : "—"}`
          : "—";
      }
    } catch (e) {
      const hint = $("stHistHint");
      if (hint) hint.textContent = String(e?.message || e);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("is-hidden")) close();
  });
}

// Render speedtest UI block (running/idle + gauges)
export function updateSpeedtestViews(st, notifyHeight) {
  const normal = $("stNormalView");
  const running = $("stRunningView");
  if (!normal || !running) return;

  const now = Date.now();
  const isRunning = !!st?.running;
  const lastTs = Number(st?.last?.ts || 0);
  const forced = now < ST_UI.forceUntil;

  if ((isRunning || forced) && !ST_UI.wasRunning) {
    ST_UI.lastTsSeen = lastTs;
    ST_UI.holdUntil = 0;
    ST_UI.downNeedleZeroed = false;
    ST_UI.upNeedleZeroed = false;
  }

  if (!isRunning && ST_UI.wasRunning) {
    const hold = Number(ST_UI.endHoldMs) || 2000;

    if (lastTs && lastTs !== ST_UI.lastTsSeen) ST_UI.lastTsSeen = lastTs;

    ST_UI.holdUntil = now + hold;
    ST_UI.resetAt = now + 0;
    ST_UI.resetDone = false;

    if (ST_UI.phase === "up") flashGaugeValue("up", ST_UI.lastUp);
    else flashGaugeValue("down", ST_UI.lastDown);
  }

  const showRunning = isRunning || forced || now < ST_UI.holdUntil;

  normal.classList.toggle("is-fading", showRunning);
  running.classList.toggle("is-active", showRunning);
  running.classList.remove("is-hidden");
  normal.classList.remove("is-hidden");

  if (showRunning) {
    const live = isRunning || forced;
    const prog = st?.progress || null;
    const ping = live ? (prog?.ping_ms ?? st?.last?.ping_ms) : st?.last?.ping_ms;
    const jitter = live ? (prog?.jitter_ms ?? st?.last?.jitter_ms) : st?.last?.jitter_ms;

    const pb = $("stPingBadge");
    const jb = $("stJitterBadge");
    if (pb) pb.textContent = t("st.badge.ping", { val: fmtMs(ping) });
    if (jb) jb.textContent = t("st.badge.jitter", { val: fmtMs(jitter) });

    const down = live ? (prog?.down_mbps ?? null) : st?.last?.down_mbps;
    const up = live ? (prog?.up_mbps ?? null) : st?.last?.up_mbps;
    const upLiveFinite = (up != null && up !== "" && Number.isFinite(Number(up)));

    const srvMaxDown = Number(st?.max_down_mbps);
    const srvMaxUp = Number(st?.max_up_mbps);

    const maxDown = Number.isFinite(srvMaxDown) && srvMaxDown > 0 ? srvMaxDown : niceGaugeMax(down, 250);
    const maxUp = Number.isFinite(srvMaxUp) && srvMaxUp > 0 ? srvMaxUp : niceGaugeMax(up, 50);

    if ((isRunning || forced) && !ST_UI.wasRunning) ST_UI.phase = "down";

    if (live && upLiveFinite && ST_UI.phase !== "up") {
      if (ST_UI.waitDownZeroBeforeUpload && !ST_UI.downNeedleZeroed) {
        setGaugeVisual("stDown", 0, maxDown);
        ST_UI.downNeedleZeroed = true;
        return;
      }
      ST_UI.phase = "up";
      flashGaugeValue("down", ST_UI.lastDown);
    }

    if (!ST_UI.downNeedleZeroed) ST_UI.lastDown = down;
    ST_UI.lastUp = up;
    ST_UI.lastMaxDown = maxDown;
    ST_UI.lastMaxUp = maxUp;

    if (live) {
      if (ST_UI.downNeedleZeroed) {
        setGaugeVisual("stDown", 0, maxDown);
        const downValEl = $("stDownGaugeVal");
        const downMaxEl = $("stDownGaugeMax");
        if (downValEl) downValEl.textContent =
          (ST_UI.lastDown == null || ST_UI.lastDown === "") ? "—" : t("st.gauge.valLine", { val: Number(ST_UI.lastDown).toFixed(2) });
        if (downMaxEl) downMaxEl.textContent = t("st.gauge.maxLine", { max: (maxDown || 250).toFixed(0) });
      } else {
        setGauge("stDown", down, maxDown);
      }

      if (ST_UI.phase === "up") setGauge("stUp", up, maxUp);
      else setGaugeVisual("stUp", 0, maxUp);
    } else {
      const downValEl = $("stDownGaugeVal");
      const upValEl = $("stUpGaugeVal");
      const downMaxEl = $("stDownGaugeMax");
      const upMaxEl = $("stUpGaugeMax");

      if (downValEl) downValEl.textContent =
        (ST_UI.lastDown == null || ST_UI.lastDown === "") ? "—" : t("st.gauge.valLine", { val: Number(ST_UI.lastDown).toFixed(2) });
      if (upValEl) upValEl.textContent =
        (ST_UI.lastUp == null || ST_UI.lastUp === "") ? "—" : t("st.gauge.valLine", { val: Number(ST_UI.lastUp).toFixed(2) });

      if (downMaxEl) downMaxEl.textContent = t("st.gauge.maxLine", { max: (ST_UI.lastMaxDown || 250).toFixed(0) });
      if (upMaxEl) upMaxEl.textContent = t("st.gauge.maxLine", { max: (ST_UI.lastMaxUp || 50).toFixed(0) });

      if (!ST_UI.resetDone && ST_UI.resetAt && Date.now() >= ST_UI.resetAt) {
        setGaugeVisual("stUp", 0, ST_UI.lastMaxUp || 50);
        ST_UI.upNeedleZeroed = true;
        ST_UI.resetDone = true;
      } else if (ST_UI.resetDone) {
        setGaugeVisual("stUp", 0, ST_UI.lastMaxUp || 50);
      }
    }

    setTimeout(() => notifyHeight?.(), 30);
  }

  ST_UI.wasRunning = isRunning || forced;
}
