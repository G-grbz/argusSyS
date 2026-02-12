import { clamp, escHtml, formatRate, formatBytes } from "./util.js";
import { t, formatTime, formatAge } from "./i18n.js";
import { downsample, spark, sparkTs } from "./sparks.js";

let sparkTipEl = null;

// Create (once) and reuse the sparkline tooltip element
function ensureSparkTooltip() {
  if (sparkTipEl) return sparkTipEl;
  const el = document.createElement("div");
  el.className = "spark-tooltip";
  el.style.display = "none";
  document.body.appendChild(el);
  sparkTipEl = el;
  return el;
}

// Format timestamp to localized time string
function fmtTime(ms) {
  return formatTime(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Attach hover tooltip behavior to a sparkline SVG
export function attachSparkTooltip(svgEl, getView, getWindowLabel) {
  if (!svgEl) return;
  const tip = ensureSparkTooltip();

  // Pick data index based on mouse position
  function pickIndex(ev, view) {
    const rect = svgEl.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / Math.max(rect.width, 1);
    const len = view?.t?.length || 0;
    if (!len) return -1;
    return clamp(Math.round(x * (len - 1)), 0, len - 1);
  }

  // Hide tooltip
  function hide() {
    tip.style.display = "none";
  }

  // Update tooltip content and position
  function move(ev) {
    const view = getView();
    const idx = pickIndex(ev, view);
    if (!view || idx < 0) return hide();

    const lines = [];
    const ts = view.t[idx];
    if (ts) {
      const age = formatAge(ts);
      const mid = age && age !== "—" ? ` · ${escHtml(age)}` : "";
      lines.push(`<span class="spark-tooltip__time">⏱ ${fmtTime(ts)}${mid}</span>`);
    }

    for (const s of view.series || []) {
      const v = s.valueAt(idx);
      lines.push(
        `<span class="spark-tooltip__row" style="--c:${escHtml(s.color || "")}">
          <span class="spark-tooltip__k">${escHtml(s.label)}</span>
          <span class="spark-tooltip__v">${escHtml(v)}</span>
        </span>`
      );
    }

    tip.innerHTML = lines.join("");
    tip.style.display = "flex";

    const pad = 10;
    let x = ev.clientX + 12;
    let y = ev.clientY + 12;

    const tw = tip.offsetWidth || 0;
    const th = tip.offsetHeight || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;

    if (x + tw + pad > vw) x = ev.clientX - 12 - tw;
    if (y + th + pad > vh) y = ev.clientY - 12 - th;

    tip.style.left = clamp(x, pad, vw - tw - pad) + "px";
    tip.style.top  = clamp(y, pad, vh - th - pad) + "px";
  }

  svgEl.addEventListener("mousemove", move);
  svgEl.addEventListener("mouseleave", hide);
}

// Downsample spark data and align timestamps
function viewDownsample(key, target = 140) {
  const vals = downsample(spark[key], target);
  const tms  = downsample(sparkTs[key], target);
  const L = Math.min(vals.length, tms.length);
  return { vals: vals.slice(-L), tms: tms.slice(-L) };
}

// Initialize all card tooltips
export function setupTooltips(getHistoryMinutes) {
    const fmtWindowLabel = () => t("tip.window", { n: Number(getHistoryMinutes()) || 0 });

    // CPU tooltip
    const cpuSvg = document.querySelector('[data-card="cpu"] .sparkline svg');
    attachSparkTooltip(cpuSvg, () => {
        const a1  = viewDownsample("cpu1");
        const a5  = viewDownsample("cpu5");
        const a15 = viewDownsample("cpu15");
        const au  = viewDownsample("cpu_util");

        const L = Math.min(a1.tms.length, a5.tms.length, a15.tms.length, au.tms.length);

        return {
            t: a1.tms.slice(-L),
            series: [
                { label: t("tip.cpu.m1"),   color: "var(--chart-cpu)",    valueAt: i => (a1.vals[i]  ?? 0).toFixed(2) },
                { label: t("tip.cpu.m5"),   color: "var(--chart-cpu2)",   valueAt: i => (a5.vals[i]  ?? 0).toFixed(2) },
                { label: t("tip.cpu.m15"),  color: "var(--chart-cpu3)",   valueAt: i => (a15.vals[i] ?? 0).toFixed(2) },
                { label: t("tip.cpu.util"), color: "var(--chart-cpu4)",   valueAt: i => clamp(au.vals[i] ?? 0, 0, 100).toFixed(0) + "%" },
            ],
        };
    }, fmtWindowLabel);

    // GPU tooltip
    const gpuSvg = document.querySelector('[data-card="gpu"] .sparkline svg');
    attachSparkTooltip(gpuSvg, () => {
        const u = viewDownsample("gpu");
        const v = viewDownsample("vram");
        const L = Math.min(u.tms.length, v.tms.length);

        return {
            t: u.tms.slice(-L),
            series: [
                { label: t("tip.gpu.util"), color: "var(--chart-gpu)",    valueAt: i => (u.vals[i] ?? 0).toFixed(0) + "%" },
                { label: t("tip.gpu.vram"), color: "var(--chart-vram)",   valueAt: i => formatBytes(v.vals[i] ?? 0) },
            ],
        };
    }, fmtWindowLabel);

    // RAM tooltip
    const ramSvg = document.querySelector('[data-card="ram"] .sparkline svg');
    attachSparkTooltip(ramSvg, () => {
        const u = viewDownsample("ram_used");
        const f = viewDownsample("ram_free");
        const s = viewDownsample("swap_pct");
        const L = Math.min(u.tms.length, f.tms.length, s.tms.length);

        return {
            t: u.tms.slice(-L),
            series: [
                { label: t("tip.ram.used"), color: "var(--chart-ram-used)", valueAt: i => (u.vals[i] ?? 0).toFixed(1) + ` ${t("unit.gib")}` },
                { label: t("tip.ram.free"), color: "var(--chart-ram-free)", valueAt: i => (f.vals[i] ?? 0).toFixed(1) + ` ${t("unit.gib")}` },
                { label: t("tip.swap.util"), color: "var(--chart-swap)", valueAt: i => clamp(Number(s.vals[i] ?? 0), 0, 100).toFixed(1) + "%" },
            ],
        };
    }, fmtWindowLabel);

    // Network tooltip
    const netSvg = document.querySelector('[data-card="net"] .sparkline svg');
    attachSparkTooltip(netSvg, () => {
        const d = viewDownsample("down");
        const u = viewDownsample("up");
        const L = Math.min(d.tms.length, u.tms.length);

        return {
            t: d.tms.slice(-L),
            series: [
                { label: t("tip.net.down"), color: "var(--chart-net-down)", valueAt: i => formatRate(d.vals[i] ?? 0) },
                { label: t("tip.net.up"),   color: "var(--chart-net-up)",   valueAt: i => formatRate(u.vals[i] ?? 0) },
            ],
        };
    }, fmtWindowLabel);
}
