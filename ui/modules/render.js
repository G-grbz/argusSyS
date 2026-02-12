import { $, setText } from "./dom.js";
import { clamp, formatRate, formatBytes, setBar, toGiB, escHtml } from "./util.js";
import { I18N, t, formatUptimeI18n, formatDateTime } from "./i18n.js";
import { getServerHistory, setHistoryMinutesFromServerIfNeeded } from "./history.js";
import { spark, sparkTs, maxSparkLen, pushSparkPair, normalize01, downsample, sparkPath, sparkPathScaled, applyServerHistoryToSparks, swapPctFromBytes } from "./sparks.js";
import { renderDisks, setHeroDisk, heroDisk } from "./disks.js";
import { updateSpeedtestViews, fmtMs, fmtMbps, fmtTs } from "./speedtest.js";

// -----------------------------
// Raw JSON panel performance
// - Only stringify when Raw <details> is open
// - Throttle updates
// - Run in idle time to avoid jank
// - Truncate huge payloads
// -----------------------------
let _rawLastTs = 0;
let _rawInFlight = false;

export function updateRawPanel(data, {
  minIntervalMs = 1500,
  maxChars = 800_000,
  pretty = true,
  force = false,
} = {}) {
  const details = $("rawDetails");
  const pre = $("raw");
  const hint = $("rawHint");
  if (!details || !pre) return;

  // Closed => do nothing (no stringify, no DOM)
  if (!details.open) return;

  const now = Date.now();
  if (!force && now - _rawLastTs < minIntervalMs) return;
  if (_rawInFlight) return;

  _rawInFlight = true;
  _rawLastTs = now;

  const run = () => {
    try {
      const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
      if (json.length > maxChars) {
        pre.textContent = json.slice(0, maxChars) + "\n… (truncated)";
        if (hint) hint.textContent = t("raw.hint.truncated", { n: maxChars });
      } else {
        pre.textContent = json;
        if (hint) hint.textContent = t("raw.hint.open");
      }
    } catch (e) {
      pre.textContent = `Raw render error: ${e?.message || e}`;
    } finally {
      _rawInFlight = false;
    }
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 250 });
  } else {
    setTimeout(run, 0);
  }
}

// CPU badge rotator state (render-local)
let cpuBadgeRot = { timer: null, sig: "", idx: 0 };

// Format GHz label for badge
function formatCpuGhz(ghz) {
  const n = Number(ghz);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n.toFixed(2)} GHz`;
}

// Format core count using i18n
function formatCoresText(cores) {
  const n = Number(cores);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n === 1 ? t("cpu.cores.one", { n }) : t("cpu.cores.many", { n });
}

// Shorten CPU model name for badge
function shortCpuModel(raw) {
  if (!raw) return "";
  let s = String(raw)
    .replace(/\(R\)|\(TM\)/gi, "")
    .replace(/\bCPU\b/gi, "")
    .replace(/\bProcessor\b/gi, "")
    .replace(/@.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  let m = s.match(/Ryzen\s+\d\s+\d{4,5}[A-Z]*/i);
  if (m) return m[0].replace(/\s+/g, " ");

  m = s.match(/i[3579]-\d{4,5}[A-Z]*/i);
  if (m) return m[0].replace("-", " ").toLowerCase().replace(/^i/, "i");

  s = s
    .replace(/^Intel\s+Core\s+/i, "")
    .replace(/^Intel\s+/i, "")
    .replace(/^AMD\s+/i, "");

  return s;
}

// Stop the badge rotation timer
function stopCpuBadgeRotator() {
  if (cpuBadgeRot.timer) clearInterval(cpuBadgeRot.timer);
  cpuBadgeRot.timer = null;
}

// Return SVG icon for badge kind
function cpuBadgeIconSvg(kind) {
  if (kind === "model") {
    return `<svg class="badge-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2"></rect>
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"></path>
    </svg>`;
  }
  if (kind === "cores") {
    return `<svg class="badge-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1"></rect>
      <rect x="14" y="4" width="6" height="6" rx="1"></rect>
      <rect x="4" y="14" width="6" height="6" rx="1"></rect>
      <rect x="14" y="14" width="6" height="6" rx="1"></rect>
    </svg>`;
  }
  return `<svg class="badge-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M12 7v6l4 2"></path>
  </svg>`;
}

// Swap badge content with a small animation
function setBadgeHtmlAnimated(el, html) {
  if (!el) return;

  if (el._badgeSwapT) clearTimeout(el._badgeSwapT);

  el.classList.add("badge-rot");
  el.classList.remove("is-rotating");
  void el.offsetWidth;
  el.classList.add("is-rotating");
  el._badgeSwapT = setTimeout(() => {
    el.innerHTML = html;
  }, 300);
}

// Start rotating CPU badge content
export function startCpuBadgeRotatorMulti(texts) {
  const el = $("cpuBadge");
  if (!el) return;

  const items = (texts || [])
    .map((x) => {
      if (x && typeof x === "object") {
        const text = String(x.text || "").trim();
        const icon = String(x.icon || "").trim();
        return text ? { icon, text } : null;
      }
      const text = String(x || "").trim();
      return text ? { icon: "", text } : null;
    })
    .filter(Boolean);

  if (!items.length) {
    stopCpuBadgeRotator();
    setBadgeHtmlAnimated(el, "—");
    return;
  }

  if (items.length === 1) {
    stopCpuBadgeRotator();
    const it = items[0];
    const icon = it.icon ? cpuBadgeIconSvg(it.icon) : "";
    setBadgeHtmlAnimated(el, `${icon}<span class="badge-text">${escHtml(it.text)}</span>`);
    return;
  }

  const sig = items.map((i) => `${i.icon}:${i.text}`).join("|");
  if (cpuBadgeRot.sig === sig && cpuBadgeRot.timer) return;

  cpuBadgeRot.sig = sig;
  cpuBadgeRot.idx = 0;

  stopCpuBadgeRotator();
  {
    const it = items[0];
    const icon = it.icon ? cpuBadgeIconSvg(it.icon) : "";
    setBadgeHtmlAnimated(el, `${icon}<span class="badge-text">${escHtml(it.text)}</span>`);
  }

  cpuBadgeRot.timer = setInterval(() => {
    cpuBadgeRot.idx = (cpuBadgeRot.idx + 1) % items.length;
    const it = items[cpuBadgeRot.idx];
    const icon = it.icon ? cpuBadgeIconSvg(it.icon) : "";
    setBadgeHtmlAnimated(el, `${icon}<span class="badge-text">${escHtml(it.text)}</span>`);
  }, 5000);
}

// Map temp to label + bar color
function cpuHeat(tempC) {
  if (!Number.isFinite(tempC)) return { label: t("cpu.heat.na"), color: "var(--color-muted)" };
  if (tempC < 70) return { label: t("cpu.heat.ok"), color: "var(--color-success)" };
  if (tempC < 80) return { label: t("cpu.heat.warm"), color: "var(--color-warning)" };
  return { label: t("cpu.heat.hot"), color: "var(--color-danger)" };
}

// Main UI render
export function render(data, state, ctx) {
  const ts = data.ts ? new Date(data.ts) : new Date();

  $("subtitle").textContent = t("subtitle", {
    time: formatDateTime(ts),
    host: location.host || t("misc.local"),
  });

  const upLine =
    data.uptime_s != null ? formatUptimeI18n(data.uptime_s) :
    data.uptime_line || "—";
  $("uptimePill").textContent = upLine;
  $("summaryBadge").textContent = data.net?.ip || data.net_ip || "—";

  const h = getServerHistory(data);
  if (h) {
    state.lastServerHistory = h;

    setHistoryMinutesFromServerIfNeeded(h, state, (hm) => {
      try { localStorage.setItem("stats_ui_history_minutes", String(hm)); } catch {}
      const sel = $("historySelect");
      if (sel) sel.value = String(hm);
    });

    applyServerHistoryToSparks(h, state.historyMinutes);
  } else {
    state.lastServerHistory = null;
  }

  // ---- CPU ----
  const cores = data.cpu?.cores ?? data.cpu_cores ?? 0;
  const l1 = data.cpu?.load1 ?? data.cpu_load1 ?? 0;
  const l5 = data.cpu?.load5 ?? data.cpu_load5 ?? 0;
  const l15 = data.cpu?.load15 ?? data.cpu_load15 ?? 0;
  const temp = data.cpu?.temp_c ?? data.cpu_temp_c;
  const cpuUtil = data.cpu_util_pct ?? data.cpu?.util_pct ?? null;
  const cpuUtilNum = Number(cpuUtil);

  const cpuModelRaw = data.cpu?.model ?? data.cpu_model ?? "";
  const cpuGhz = data.cpu?.base_ghz ?? data.cpu_base_ghz ?? null;

  startCpuBadgeRotatorMulti([
    { icon: "model", text: shortCpuModel(cpuModelRaw) },
    { icon: "cores", text: formatCoresText(cores) },
    { icon: "ghz", text: formatCpuGhz(cpuGhz) },
  ]);

  $("cpuTemp").textContent = temp == null ? "—" : Number(temp).toFixed(1) + "°C";
  $("cpuLoad").textContent = `${Number(l1).toFixed(2)} / ${Number(l5).toFixed(2)} / ${Number(l15).toFixed(2)}`;

  const heat = cpuHeat(Number(temp));
  const heatBadge = $("cpuHeatBadge");
  if (heatBadge) {
    heatBadge.textContent = heat.label;
    heatBadge.className = "badge";
    if (heat.label === t("cpu.heat.ok")) heatBadge.classList.add("badge-success");
    else if (heat.label === t("cpu.heat.warm")) heatBadge.classList.add("badge-warning");
    else if (heat.label === t("cpu.heat.hot")) heatBadge.classList.add("badge-danger");
  }

  const perCore = cores > 0 ? l1 / cores : 0;
  $("cpuLoadPct").textContent = `${(perCore * 100).toFixed(0)}%`;
  setBar($("cpuBar"), clamp(perCore * 100, 0, 100), heat.color);

  const doSample = ctx.shouldSampleSpark();

  if (!ctx.usingServerHistory() && doSample) {
    const L = maxSparkLen(state.historyMinutes);
    pushSparkPair("cpu1", l1, L);
    pushSparkPair("cpu5", l5, L);
    pushSparkPair("cpu15", l15, L);
    pushSparkPair("cpu_util", Number.isFinite(cpuUtilNum) ? clamp(cpuUtilNum, 0, 100) : 0, L);
  }

  const n1 = normalize01(downsample(spark.cpu1, 140));
  const n5 = normalize01(downsample(spark.cpu5, 140));
  const n15 = normalize01(downsample(spark.cpu15, 140));
  const utilDS = downsample(spark.cpu_util, 140);
  const utilNormc = utilDS.map((x) => clamp(Number(x) / 100, 0, 1));

  $("cpuSpark")?.setAttribute("d", sparkPath(n1, 44));
  $("cpuSpark5")?.setAttribute("d", sparkPath(n5, 44));
  $("cpuSpark15")?.setAttribute("d", sparkPath(n15, 44));
  $("cpuUtilSpark")?.setAttribute("d", sparkPath(utilNormc, 44));

  const utilStr =
    cpuUtil == null || !Number.isFinite(Number(cpuUtil)) ? "—" : Number(cpuUtil).toFixed(0);

  setText("heroCpuUtil", (cpuUtil == null || !Number.isFinite(cpuUtilNum)) ? "—" : cpuUtilNum.toFixed(0) + "%");
  setText("heroCpuTemp", (temp == null || !Number.isFinite(Number(temp))) ? "—" : Number(temp).toFixed(1) + "°C");

  $("cpuSparkVal").textContent = t("cpu.sparkLine", {
    l1: Number(l1).toFixed(2),
    l5: Number(l5).toFixed(2),
    l15: Number(l15).toFixed(2),
    util: utilStr,
  });

  // ---- GPU ----
  const gname = data.gpu_name ?? data.gpu?.primary?.name ?? "—";
  const gtemp = data.gpu_temp_c ?? data.gpu?.primary?.temp_c;
  const gutil = data.gpu_util_pct ?? data.gpu?.primary?.util_pct;

  const gMemTotal = data.gpu_mem_total ?? data.gpu?.primary?.mem_total_b;
  const gMemUsed = data.gpu_mem_used ?? data.gpu?.primary?.mem_used_b;

  const gPwr = data.gpu_power_w ?? data.gpu?.primary?.power_w;
  const gLim = data.gpu_power_limit_w ?? data.gpu?.primary?.power_limit_w;

  $("gpuBadge").textContent = gname;
  $("gpuTemp").textContent = gtemp == null ? "—" : Number(gtemp).toFixed(0) + "°C";
  $("gpuUtil").textContent = gutil == null ? "—" : Number(gutil).toFixed(0) + "%";

  const utilPct = Number.isFinite(Number(gutil)) ? Number(gutil) : 0;
  $("gpuUtilPct").textContent = gutil == null ? "—" : utilPct.toFixed(0) + "%";
  setBar($("gpuUtilBar"), utilPct);

  const vramUsed = Number.isFinite(Number(gMemUsed)) ? Number(gMemUsed) : 0;

  if (!ctx.usingServerHistory() && doSample) {
    const L = maxSparkLen(state.historyMinutes);
    pushSparkPair("gpu", utilPct, L);
    pushSparkPair("vram", vramUsed, L);
  }

  const gpuUtilNorm = normalize01(downsample(spark.gpu, 140));
  const vramNorm = normalize01(downsample(spark.vram, 140));

  $("gpuSpark")?.setAttribute("d", sparkPath(gpuUtilNorm, 44));
  $("gpuVramSpark")?.setAttribute("d", sparkPath(vramNorm, 44));

  $("gpuSparkVal").textContent = t("gpu.sparkLine", {
    util: Number.isFinite(utilPct) ? utilPct.toFixed(0) + "" : t("misc.na"),
    vram: formatBytes(vramUsed),
  });

  const mt = Number(gMemTotal), mu = Number(gMemUsed);
  const memPct = Number.isFinite(mt) && mt > 0 && Number.isFinite(mu) ? (mu / mt) * 100 : 0;

  $("gpuMemLine").textContent =
    Number.isFinite(mu) && Number.isFinite(mt) ? `${formatBytes(mu)} / ${formatBytes(mt)}` : "—";
  setBar($("gpuMemBar"), memPct);

  $("gpuPower").textContent =
    Number.isFinite(Number(gPwr)) && Number.isFinite(Number(gLim))
      ? `${Number(gPwr).toFixed(0)}W / ${Number(gLim).toFixed(0)}W`
      : Number.isFinite(Number(gPwr))
      ? `${Number(gPwr).toFixed(0)}W`
      : "—";

  // ---- RAM ----
  const memTotal = data.mem?.total ?? data.mem_total;
  const memUsed = data.mem?.used ?? data.mem_used;
  const memFree = data.mem?.available ?? data.mem_free;

  $("ramTotal").textContent = formatBytes(memTotal);
  $("ramUsed").textContent = formatBytes(memUsed);
  $("ramFree").textContent = formatBytes(memFree);
  setText("heroRamFree", formatBytes(memFree));

  const ramPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const freePct = memTotal > 0 ? (memFree / memTotal) * 100 : 0;

  $("ramPct").textContent = ramPct.toFixed(1) + "%";
  setBar($("ramBar"), ramPct);
  $("ramBadge").textContent = ramPct.toFixed(0) + "%";

  const totalGiB = toGiB(memTotal);
  const usedGiB = toGiB(memUsed);
  const freeGiB = toGiB(memFree);

  if (!ctx.usingServerHistory() && doSample) {
    const L = maxSparkLen(state.historyMinutes);
    pushSparkPair("ram_used", usedGiB, L);
    pushSparkPair("ram_free", freeGiB, L);
  }

  $("ramUsedSpark")?.setAttribute("d", sparkPathScaled(downsample(spark.ram_used, 140), 44, totalGiB));
  $("ramFreeSpark")?.setAttribute("d", sparkPathScaled(downsample(spark.ram_free, 140), 44, totalGiB));

  $("ramSparkVal").textContent = t("ram.sparkLine", {
    used: usedGiB.toFixed(1),
    total: totalGiB.toFixed(1),
  });

  $("ramSparkHint").textContent = t("ram.hint", {
    free: freePct.toFixed(1),
    util: ramPct.toFixed(1),
  });

  const ramHot = ramPct >= 90;
  $("ramUsedSpark")?.setAttribute("stroke", ramHot ? "var(--color-danger)" : "var(--chart-ram-used)");

  // ---- SWAP ----
  const sTotal = Number(data.mem?.swap_total ?? data.mem_swap_total ?? 0);
  const sUsed = Number(data.mem?.swap_used ?? data.mem_swap_used ?? 0);

  const swapPathEl = document.getElementById("swapSpark");
  const swapValEl  = $("swapSparkVal");

  let swapVisible = true;
  try {
    const raw = localStorage.getItem("stats_ui_spark_vis_v1");
    const vis = JSON.parse(raw || "{}");
    if (vis?.ram?.swaputil === false) swapVisible = false;
  } catch {}

  if (!Number.isFinite(sTotal) || sTotal <= 0) {
    spark.swap_pct.length = 0;
    if (swapPathEl) swapPathEl.style.display = "none";
    if (swapValEl) swapValEl.textContent = "—";
  } else {
    if (swapPathEl) swapPathEl.style.display = swapVisible ? "" : "none";

    let swapPct = swapPctFromBytes(sUsed, sTotal);

    if (ctx.usingServerHistory()) {
      const raw = Array.isArray(spark._swap_used_raw) ? spark._swap_used_raw : [];
      const pctSeries = raw.map((b) => {
        const bb = Number(b);
        if (!Number.isFinite(bb) || bb < 0) return 0;
        return swapPctFromBytes(bb, sTotal);
      });
      spark.swap_pct = pctSeries;
    } else if (doSample) {
      const L = maxSparkLen(state.historyMinutes);
      pushSparkPair("swap_pct", swapPct, L);
    }

    $("swapSpark")?.setAttribute("d", sparkPathScaled(downsample(spark.swap_pct, 140), 44, 100));

    if (ctx.usingServerHistory() && spark.swap_pct.length) {
      const last = spark.swap_pct[spark.swap_pct.length - 1];
      if (Number.isFinite(Number(last))) swapPct = Number(last);
    }

    if (swapValEl) swapValEl.textContent = t("swap.sparkLine", {
      util: swapPct.toFixed(1),
      used: toGiB(sUsed).toFixed(1),
    });

    if (swapPathEl) {
      swapPathEl.setAttribute("stroke", swapPct >= 90 ? "var(--color-danger)" : "var(--chart-swap)");
      swapPathEl.setAttribute("stroke-dasharray", "4 3");
      if (!swapVisible) swapPathEl.style.display = "none";
    }
  }

  // ---- Network ----
  $("netIface").textContent = data.net?.iface ?? data.net_iface ?? "—";
  $("netIp").textContent = data.net?.ip ?? data.net_ip ?? "—";

  const down = data.net_down_bps ?? data.netSpeed?.down_bps ?? data.net_down ?? data.net?.down_bps;
  const upbps = data.net_up_bps ?? data.netSpeed?.up_bps ?? data.net_up ?? data.net?.up_bps;

  $("netDown").textContent = formatRate(down);
  $("netUp").textContent = formatRate(upbps);

  $("netSpeedLine").textContent = t("net.hint", {
    down: formatRate(down),
    up: formatRate(upbps),
  });

  $("netBadge").textContent = $("netIface").textContent;

  const dV = Number.isFinite(down) ? Math.max(0, down) : 0;
  const uV = Number.isFinite(upbps) ? Math.max(0, upbps) : 0;

  if (!ctx.usingServerHistory() && doSample) {
    const L = maxSparkLen(state.historyMinutes);
    pushSparkPair("down", dV, L);
    pushSparkPair("up", uV, L);
  }

  const downDS = downsample(spark.down, 140);
  const upDS = downsample(spark.up, 140);
  const maxDU = Math.max(...downDS, ...upDS, 1e-9);

  const downNorm = downDS.map((x) => x / maxDU);
  const upNorm = upDS.map((x) => x / maxDU);

  $("netDownSpark")?.setAttribute("d", sparkPath(downNorm, 36));
  $("netUpSpark")?.setAttribute("d", sparkPath(upNorm, 36));
  $("netSparkVal").textContent = t("net.maxLine", { max: formatRate(maxDU) });

  // ---- System ----
  const sys = data.system || {};
  const distro = sys.distro ?? data.system_distro ?? "—";
  const kernel = sys.kernel ?? data.system_kernel ?? "—";
  const arch = sys.arch ?? data.system_arch ?? "—";
  const host = sys.hostname ?? data.system_hostname ?? "—";
  const desktop = sys.desktop ?? data.system_desktop ?? "—";
  const sessionType = sys.session_type ?? data.system_session_type ?? "—";
  const bios = data.bios || {};
  const battery = data.battery || null;
  const ident = data.ident || {};

  setText("heroOs", distro || "—");

  $("sysHost").textContent = host;
  $("sysOs").textContent = distro;
  $("sysKernel").textContent = kernel;
  $("sysArch").textContent = arch;
  $("sysDesktop").textContent = desktop;
  $("sysSession").textContent = sessionType;
  $("sysFirmware").textContent = bios.firmware || "—";
  $("sysBiosVer").textContent = bios.version || "—";
  $("sysBiosDate").textContent = bios.date || "—";
  setText("sysManufacturer", ident.manufacturer || "—");
  setText("sysProductName", ident.product_name || "—");
  setText("sysSystemVersion", ident.system_version || "—");
  setText("sysSerialNo", ident.serial_number || "—");

  const batBlock = $("batteryBlock");
  const acBlock = $("acBlock");

  if (!battery) {
    if (batBlock) batBlock.style.display = "none";
    if (acBlock) acBlock.style.display = "none";
  } else {
    const hasBat = battery.present === true;

    if (batBlock) {
      if (!hasBat) {
        batBlock.style.display = "none";
      } else {
        batBlock.style.display = "";
        const cap = Number.isFinite(Number(battery.capacity_pct))
          ? `${Number(battery.capacity_pct).toFixed(0)}%`
          : "—";
        const st0 = battery.status || "—";
        $("sysBattery").textContent = `${cap} · ${st0}`;
      }
    }

    if (acBlock) {
      if (battery.ac_online == null) {
        acBlock.style.display = "none";
      } else {
        acBlock.style.display = "";
        $("sysAc").textContent = battery.ac_online ? t("system.acPlugged") : t("system.acUnplugged");
      }
    }
  }

  // ---- Disks ----
  const { fullest } = renderDisks(data, {
    diskCols: state.diskCols,
    DISK_GROUP: state.DISK_GROUP,
    applyOnlyToCardEl: ctx.applyOnlyToCardEl,
    iconGripGrid6: ctx.iconGripGrid6,
    notifyHeight: ctx.notifyHeight,
    initSortable: ctx.initSortable,
    applyCardOrder: ctx.applyCardOrder,
  });

  const diskBadgeEl = $("diskBadge");
  if (diskBadgeEl) {
    const validDiskCount = Object.values(data.disks || {})
      .filter((d) => d && !d.error && Number(d.total) > 0)
      .length;
    diskBadgeEl.textContent = t("disks.count", { n: validDiskCount });
  }

  const fb = $("fullestBadge");
  if (fb) {
    fb.textContent = fullest
      ? t("summary.fullestBadge", { mount: fullest.mount, pct: fullest.pct.toFixed(1) })
      : t("summary.fullestBadgeEmpty");
  }

  // Rotate hero disk highlight
  const now = Date.now();
  if (heroDisk.items.length) {
    if (!heroDisk.lastTs) heroDisk.lastTs = now;
    if (now - heroDisk.lastTs >= heroDisk.intervalMs) {
      heroDisk.idx = (heroDisk.idx + 1) % heroDisk.items.length;
      heroDisk.lastTs = now;
    }
    setHeroDisk(heroDisk.items[heroDisk.idx]);
  } else {
    setHeroDisk(null);
  }

  // ---- Speedtest ----
  const st = data.speedtest || null;
  if (st) {
    $("stRunner").textContent = st.runner || "—";
    $("stStatus").textContent =
      st.running
        ? t("st.status.running")
        : st.last_error
        ? t("st.status.error", { msg: st.last_error })
        : t("st.status.ok");

    $("stLast").textContent = st.last?.ts ? fmtTs(st.last.ts, I18N.lang) : "—";
    $("stNext").textContent = st.next_run_ts ? fmtTs(st.next_run_ts, I18N.lang) : "—";

    $("stPing").textContent = fmtMs(st.last?.ping_ms);
    $("stJitter").textContent = fmtMs(st.last?.jitter_ms);
    $("stDown").textContent = fmtMbps(st.last?.down_mbps);
    $("stUp").textContent = fmtMbps(st.last?.up_mbps);

    const stSel = $("stInterval");
    if (stSel && st.interval_min != null) {
      const srv = Number(st.interval_min);
      if (Number.isFinite(srv) && srv > 0) stSel.value = String(srv);
    }
  } else {
    $("stRunner").textContent = "—";
    $("stStatus").textContent = "—";
    $("stLast").textContent = "—";
    $("stNext").textContent = "—";
    $("stPing").textContent = "—";
    $("stJitter").textContent = "—";
    $("stDown").textContent = "—";
    $("stUp").textContent = "—";
  }

  updateSpeedtestViews(st, ctx.notifyHeight);
  updateRawPanel(data, { minIntervalMs: 3000, maxChars: 800_000, pretty: true });
}
