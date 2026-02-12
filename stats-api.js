// - Serves JSON at /stats and static UI from ./ui
// - Samples lightweight history on the server (shared for all clients)
// - Tries to work both on host and inside containers (prefers /host/* mounts when present)

import http from "node:http";
import { URL } from "node:url";
import os from "node:os";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSpeedtestController } from "./speedtest-api.js";

/* ============================================================================
   Config
   - All knobs via env vars (sane defaults)
============================================================================ */

const PORT = Number(process.env.PORT || 3012);
const NET_IFACE = (process.env.NET_IFACE || "").trim();
const GPU_POLL_MS = Number(process.env.GPU_POLL_MS || 1000);
const GPU_TIMEOUT_MS = Number(process.env.GPU_TIMEOUT_MS || 1000);
const HISTORY_SAMPLE_MS = Number(process.env.HISTORY_SAMPLE_MS || 1000);
const HISTORY_MAX_MIN = Number(process.env.HISTORY_MAX_MIN || 120);
const HISTORY_DB_PATH = process.env.HISTORY_DB_PATH || "./data/history_state.json";

const DISK_PATHS = (process.env.DISK_PATHS || "/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ============================================================================
   Update Proxy (GitHub Releases Atom Feed)
============================================================================ */

const GITHUB_DEFAULT_REPO = (process.env.GITHUB_DEFAULT_REPO || "G-grbz/argusSyS").trim();

// Validate "owner/repo" slug.
function isValidRepoSlug(s) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(s || ""));
}

// Parse the *first* <entry> from GitHub releases.atom as "latest"
function parseLatestReleaseFromAtom(xmlText) {
  const xml = String(xmlText || "");
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1] || "";
  if (!entry) return null;

  const pick = (re) => entry.match(re)?.[1]?.trim() || "";
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const link = pick(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  const updated = pick(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
  const content = pick(/<content[^>]*type="html"[^>]*>([\s\S]*?)<\/content>/i);

  const tag = title.replace(/^release\s+/i, "").trim();

  return {
    tag_name: tag,
    name: title,
    body_html: content,
    html_url: link,
    published_at: updated,
  };
}

// Fetch and parse latest GitHub release via Atom feed (no token needed).
async function fetchLatestReleaseFromAtom(repo) {
  const url = `https://github.com/${repo}/releases.atom`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "stats-api-update-proxy",
      "Cache-Control": "no-store",
    },
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`Atom HTTP ${r.status} ${r.statusText} :: ${text.slice(0, 200)}`);
  return parseLatestReleaseFromAtom(text);
}

/* ============================================================================
   Runtime State
   - Small in-memory caches for delta computations and polling
============================================================================ */

let lastGpu = null;
let lastGpuTs = 0;
let lastGpuErr = null;

let lastNetSample = null;
let lastCpuTimes = null;
let lastDiskIo = new Map();

/* ============================================================================
   Shared History (server-side)
   - Sampled independently from clients
   - Persisted to a local JSON file (best-effort)
============================================================================ */

// Ensure directory exists for a file path (best-effort)
function ensureDirFor(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
}

// Clamp a number into [a..b]
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

const history = {
  v: 1,
  maxMin: HISTORY_MAX_MIN,
  sampleMs: HISTORY_SAMPLE_MS,
  ts: [],

  cpu1: [],
  cpu5: [],
  cpu15: [],
  cpu_util: [],

  gpu_util: [],
  vram_used_b: [],

  ram_used_b: [],
  ram_free_b: [],
  swap_used_b: [],

  net_down_bps: [],
  net_up_bps: [],
};

// Compute max history length based on sampling interval and max minutes
function maxHistoryLen() {
  const maxSec = clamp(history.maxMin * 60, 60, 120 * 60);
  const per = Math.max(1, Math.floor(history.sampleMs / 1000));
  return Math.ceil(maxSec / per);
}

// Push a value into a history array and trim it to length L
function pushHist(key, val, L) {
  const arr = history[key];
  if (!Array.isArray(arr)) return;
  arr.push(val);
  if (arr.length > L) arr.splice(0, arr.length - L);
}

// Trim every array field in history to length L
function trimAll(L) {
  for (const k of Object.keys(history)) {
    if (Array.isArray(history[k]) && history[k].length > L) {
      history[k].splice(0, history[k].length - L);
    }
  }
}

// Load persisted history from disk (best-effort)
function loadHistoryFromDisk() {
  try {
    const raw = fs.readFileSync(HISTORY_DB_PATH, "utf8");
    const st = JSON.parse(raw);
    if (!st || st.v !== 1) return;

    for (const k of Object.keys(history)) {
      if (Array.isArray(history[k]) && Array.isArray(st[k])) {
        history[k] = st[k].slice();
      }
    }
    if (Array.isArray(st.ts)) history.ts = st.ts.slice();

    trimAll(maxHistoryLen());
  } catch {}
}

let lastHistoryFlush = 0;

// Persist history to disk (throttled unless forced)
function flushHistoryToDisk(force = false) {
  const now = Date.now();
  if (!force && now - lastHistoryFlush < 100) return;
  lastHistoryFlush = now;

  try {
    ensureDirFor(HISTORY_DB_PATH);
    const payload = {
      v: 1,
      savedAt: now,
      maxMin: history.maxMin,
      sampleMs: history.sampleMs,

      ts: history.ts,
      cpu1: history.cpu1,
      cpu5: history.cpu5,
      cpu15: history.cpu15,
      cpu_util: history.cpu_util,

      gpu_util: history.gpu_util,
      vram_used_b: history.vram_used_b,

      ram_used_b: history.ram_used_b,
      ram_free_b: history.ram_free_b,
      swap_used_b: history.swap_used_b,

      net_down_bps: history.net_down_bps,
      net_up_bps: history.net_up_bps,
    };

    fs.writeFileSync(HISTORY_DB_PATH, JSON.stringify(payload), "utf8");
  } catch {}
}

// Sample current metrics into the shared history ring buffers
function sampleForHistory() {
  const L = maxHistoryLen();
  const ts = Date.now();

  const cpu = cpuSummary();
  const cpu_util = cpuUtilPct();
  const cpuUtilVal = Number.isFinite(cpu_util) ? cpu_util : 0;

  const gpu = gpuSummary();
  const g0 = gpu?.primary || null;
  const gpuUtilVal = Number.isFinite(Number(g0?.util_pct)) ? Number(g0.util_pct) : 0;
  const vramUsedB = Number.isFinite(Number(g0?.mem_used_b)) ? Number(g0.mem_used_b) : 0;

  const mem = memBytes();
  const ramUsedB = Number.isFinite(mem.used) ? mem.used : 0;
  const ramFreeB = Number.isFinite(mem.available) ? mem.available : 0;
  const swapUsedB = Number.isFinite(mem.swap_used) ? mem.swap_used : 0;

  const ns = netSpeedSample();
  const downBps = Number.isFinite(ns.down_bps) ? Math.max(0, ns.down_bps) : 0;
  const upBps = Number.isFinite(ns.up_bps) ? Math.max(0, ns.up_bps) : 0;

  history.ts.push(ts);
  if (history.ts.length > L) history.ts.splice(0, history.ts.length - L);

  pushHist("cpu1", cpu.load1, L);
  pushHist("cpu5", cpu.load5, L);
  pushHist("cpu15", cpu.load15, L);
  pushHist("cpu_util", cpuUtilVal, L);

  pushHist("gpu_util", gpuUtilVal, L);
  pushHist("vram_used_b", vramUsedB, L);

  pushHist("ram_used_b", ramUsedB, L);
  pushHist("ram_free_b", ramFreeB, L);
  pushHist("swap_used_b", swapUsedB, L);

  pushHist("net_down_bps", downBps, L);
  pushHist("net_up_bps", upBps, L);

  flushHistoryToDisk(false);
}

loadHistoryFromDisk();

/* ============================================================================
   Speedtest Controller
============================================================================ */

// Create controller that can run speedtests on demand / schedule (see speedtest-api.js)
const speedtest = createSpeedtestController({
  timeoutMs: Number(process.env.SPEEDTEST_TIMEOUT_MS || 120000),
  defaultIntervalMin: Number(process.env.SPEEDTEST_INTERVAL_MIN || 0),
});

// Tick speedtest scheduler (lightweight)
setInterval(() => {
  try {
    speedtest.tick();
  } catch {}
}, 1000);

// Sample shared history continuously
setInterval(() => {
  try {
    sampleForHistory();
  } catch {}
}, HISTORY_SAMPLE_MS);

/* ============================================================================
   Small FS Helpers
============================================================================ */

// Check if a path exists and is accessible
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// Read a text file and trim it (or return null)
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

// Read file as UTF-8 string (or null)
function safeReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// Read file as Buffer (or null)
function safeReadBuf(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

// List directory entries safely (or null)
function listDirSafe(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return null;
  }
}

// Try reading the first non-empty text from a list of paths
function readTextFirst(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const v = fs.readFileSync(p, "utf8").trim();
        if (v) return v;
      }
    } catch {}
  }
  return null;
}

// Check if a command exists in PATH
function which(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// Detect if running inside a container (best-effort)
function inContainer() {
  return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
}

/* ============================================================================
   System / BIOS / Battery
============================================================================ */

// Read BIOS firmware + version/date (container-friendly, best-effort)
function biosInfo() {
  const firmware =
    fs.existsSync("/sys/firmware/efi") || fs.existsSync("/host/sys/firmware/efi")
      ? "UEFI"
      : "Legacy";

  if (inContainer() && which("dmidecode")) {
    try {
      const version = execSync("dmidecode -s bios-version", { encoding: "utf8" }).trim();
      const date = execSync("dmidecode -s bios-release-date", { encoding: "utf8" }).trim();
      if (version || date) return { firmware, version: version || null, date: date || null };
    } catch {}
  }

  const version = readTextFirst([
    "/host/sys/class/dmi/id/bios_version",
    "/sys/class/dmi/id/bios_version",
  ]);

  const date = readTextFirst(["/host/sys/class/dmi/id/bios_date", "/sys/class/dmi/id/bios_date"]);

  if (version || date) return { firmware, version: version || null, date: date || null };
  return { firmware, version: null, date: null };
}

// List power_supply entries from sysfs
function listPowerSupplies() {
  const base = "/sys/class/power_supply";
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }

  return names.map((name) => {
    const dir = `${base}/${name}`;
    const type = readText(`${dir}/type`);
    const online = readText(`${dir}/online`);
    const capacity = readText(`${dir}/capacity`);
    const status = readText(`${dir}/status`);
    return { name, dir, type, online, capacity, status };
  });
}

// Return laptop battery info (filters out peripheral “batteries” like mice/headsets)
function batteryInfo() {
  try {
    const items = listPowerSupplies();
    if (!items.length) return null;

    const ac = items.find((x) => (x.type || "").toLowerCase() === "mains") || null;
    const ac_online = ac?.online == null ? null : String(ac.online).trim() === "1";

    const battCandidates = items.filter((x) => (x.type || "").toLowerCase() === "battery");
    const isPeripheral = (name) =>
      /hidpp|mouse|kbd|keyboard|headset|phone|bluetooth|wireless/i.test(name || "");

    const bat = battCandidates.find((x) => !isPeripheral(x.name)) || null;

    if (!bat) {
      return { present: false, capacity_pct: null, status: null, ac_online };
    }

    const cap = bat.capacity != null ? Number(bat.capacity) : null;
    const capacity_pct = Number.isFinite(cap) ? cap : null;
    const status = bat.status || null;

    return { present: true, capacity_pct, status, ac_online };
  } catch {
    return null;
  }
}

/* ============================================================================
   System / DMI (Manufacturer / Product / Serial)
============================================================================ */

// Read DMI field from /sys (prefers /host when available)
function readDmiField(name) {
  return readTextFirst([
    `/host/sys/class/dmi/id/${name}`,
    `/sys/class/dmi/id/${name}`,
  ]);
}

// Basic system identity from DMI (best-effort, container-friendly)
function systemIdentity() {
  const manufacturer = readDmiField("sys_vendor") || null;
  const product_name = readDmiField("product_name") || null;
  const system_version = readDmiField("product_version") || null;

  const serial_number =
    readDmiField("product_serial") ||
    readDmiField("chassis_serial") ||
    readDmiField("board_serial") ||
    null;

  const product_family = readDmiField("product_family") || null;
  const product_sku = readDmiField("product_sku") || null;

  const clean = (v) => {
    const s = (v || "").trim();
    if (!s) return null;
    if (/^(none|unknown|to be filled by o\.e\.m\.|default string)$/i.test(s)) return null;
    return s;
  };

  return {
    manufacturer: clean(manufacturer),
    product_name: clean(product_name),
    system_version: clean(system_version),
    serial_number: clean(serial_number),
    product_family: clean(product_family),
    product_sku: clean(product_sku),
  };
}

/* ============================================================================
   Host Session / Desktop Detection
   - Best-effort detection; useful for UI “System” card
============================================================================ */

// Return the proc root to inspect (prefers /host/proc when mounted)
function hostProcRoot() {
  if (exists("/host/proc/1")) return "/host/proc";
  if (exists("/proc/1")) return "/proc";
  return null;
}

// Try detecting host display server by checking host runtime files
function detectDisplayServerFromHost() {
  const x11 =
    exists("/host/tmp/.X11-unix") &&
    fs.readdirSync("/host/tmp/.X11-unix").some((n) => /^X\d+$/.test(n));

  let wayland = false;
  try {
    if (exists("/host/run/user")) {
      const uids = (listDirSafe("/host/run/user") || []).filter((n) => /^\d+$/.test(n));
      for (const uid of uids) {
        const dir = `/host/run/user/${uid}`;
        if (!exists(dir)) continue;
        const hit = (listDirSafe(dir) || []).some((n) => n.startsWith("wayland-"));
        if (hit) {
          wayland = true;
          break;
        }
      }
    }
  } catch {}

  if (wayland) return "wayland";
  if (x11) return "x11";
  return null;
}

// Detect desktop environment by scanning process cmdlines for known markers
function detectDesktopFromProcCmdline() {
  const markers = [
    { key: "GNOME", match: ["gnome-shell", "gnome-session"] },
    { key: "KDE", match: ["plasmashell", "ksmserver", "kwin_wayland", "kwin_x11"] },
    { key: "XFCE", match: ["xfce4-session"] },
    { key: "Cinnamon", match: ["cinnamon-session"] },
    { key: "MATE", match: ["mate-session"] },
    { key: "Sway", match: ["sway"] },
    { key: "Hyprland", match: ["hyprland"] },
    { key: "i3", match: ["i3", "i3bar"] },
    { key: "bspwm", match: ["bspwm"] },
    { key: "Openbox", match: ["openbox"] },
    { key: "Awesome", match: ["awesome"] },
    { key: "Qtile", match: ["qtile"] },
    { key: "Xmonad", match: ["xmonad"] },
  ];

  const proc = hostProcRoot();
  if (!proc) return null;

  let pids = [];
  try {
    pids = fs.readdirSync(proc).filter((x) => /^\d+$/.test(x));
  } catch {
    return null;
  }

  for (const pid of pids) {
    const cmdBuf = safeReadBuf(`${proc}/${pid}/cmdline`);
    if (!cmdBuf?.length) continue;

    const cmd = cmdBuf.toString("utf8").split("\0").filter(Boolean).join(" ");
    if (!cmd) continue;

    for (const m of markers) {
      if (m.match.some((w) => cmd.includes(w))) return m.key;
    }
  }

  return null;
}

// Parse /etc/os-release content into a key/value object
function parseOsRelease(txt) {
  if (!txt) return null;

  const out = {};
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;

    let v = (m[2] || "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// Parse a NUL-separated /proc/<pid>/environ buffer into an object
function parseEnviron(buf) {
  if (!buf || !buf.length) return {};
  const s = buf.toString("utf8");
  const out = {};
  for (const part of s.split("\0")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

// Pick a “good enough” desktop/session env by scanning host processes
function pickSessionEnvFromHostProc() {
  const proc = hostProcRoot();
  if (!proc) return null;

  let pids = [];
  try {
    pids = fs.readdirSync(proc).filter((x) => /^\d+$/.test(x));
  } catch {
    return null;
  }

  const wantedCmd = [
    "gnome-session",
    "plasmashell",
    "ksmserver",
    "xfce4-session",
    "lxqt-session",
    "cinnamon-session",
    "mate-session",
    "sway",
    "hyprland",
  ];

  for (const pid of pids) {
    const base = `${proc}/${pid}`;

    try {
      const cmdBuf = safeReadBuf(`${base}/cmdline`);
      if (!cmdBuf || !cmdBuf.length) continue;

      const cmd = cmdBuf.toString("utf8").split("\0").filter(Boolean).join(" ");
      if (!cmd) continue;

      if (!wantedCmd.some((w) => cmd.includes(w))) continue;

      const env = parseEnviron(safeReadBuf(`${base}/environ`));
      const desktop =
        (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || env.GDMSESSION || "").trim() ||
        null;

      const sessionType = (env.XDG_SESSION_TYPE || "").trim() || null;
      const displayServer = env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : null;

      if (desktop || sessionType || displayServer) {
        return { desktop, session_type: sessionType, display_server: displayServer };
      }
    } catch {
      continue;
    }
  }

  let scanned = 0;
  for (const pid of pids) {
    if (scanned++ > 2500) break;
    const base = `${proc}/${pid}`;

    try {
      const env = parseEnviron(safeReadBuf(`${base}/environ`));
      if (!env || (!env.XDG_SESSION_TYPE && !env.XDG_CURRENT_DESKTOP && !env.DESKTOP_SESSION)) {
        continue;
      }

      const desktop =
        (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || env.GDMSESSION || "").trim() ||
        null;

      const sessionType = (env.XDG_SESSION_TYPE || "").trim() || null;
      const displayServer = env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : null;

      if (desktop || sessionType || displayServer) {
        return { desktop, session_type: sessionType, display_server: displayServer };
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Collect high-level system info (distro/kernel/desktop/session)
function systemInfo() {
  const hostOsRel = safeReadFile("/host/etc/os-release");
  const localOsRel = safeReadFile("/etc/os-release");
  const osr = parseOsRelease(hostOsRel || localOsRel);

  const distro = (osr && (osr.PRETTY_NAME || osr.NAME)) || (os.platform ? os.platform() : "linux");

  let kernel = null;
  try {
    kernel = execSync("uname -r", { encoding: "utf8" }).trim();
  } catch {}

  const hostSess = pickSessionEnvFromHostProc();
  const displayGuess = detectDisplayServerFromHost();

  const xdgDesktop =
    hostSess?.desktop ??
    detectDesktopFromProcCmdline() ??
    ((process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || "").trim() || null);

  const displayServer =
    hostSess?.display_server ??
    displayGuess ??
    (process.env.WAYLAND_DISPLAY ? "wayland" : process.env.DISPLAY ? "x11" : null);

  const sessionType =
    (hostSess?.session_type ?? null) ||
    ((process.env.XDG_SESSION_TYPE || "").trim() || null) ||
    displayServer ||
    null;

  return {
    distro,
    kernel,
    arch: os.arch(),
    platform: os.platform(),
    hostname: os.hostname(),
    desktop: xdgDesktop,
    session_type: sessionType,
    display_server: displayServer,
  };
}

/* ============================================================================
   Light Caching
============================================================================ */

let sysCache = null;
let sysCacheTs = 0;
const SYS_CACHE_MS = Number(process.env.SYS_CACHE_MS || 10000);

// Cached wrapper for systemInfo()
function systemInfoCached() {
  const now = Date.now();
  if (sysCache && now - sysCacheTs < SYS_CACHE_MS) return sysCache;
  sysCache = systemInfo();
  sysCacheTs = now;
  return sysCache;
}

let disksCache = null;
let disksCacheTs = 0;
const DISK_CACHE_MS = Number(process.env.DISK_CACHE_MS || 4000);

// Cached dfBytes for configured disk paths
function disksCached() {
  const now = Date.now();
  if (disksCache && now - disksCacheTs < DISK_CACHE_MS) return disksCache;

  const disks = {};
  for (const p of DISK_PATHS) {
    try {
      const d = dfBytes(p);
      disks[keyify(p)] = d;
    } catch (e) {
      disks[keyify(p)] = { path: p, error: String(e) };
    }
  }

  disksCache = disks;
  disksCacheTs = now;
  return disksCache;
}

/* ============================================================================
   Host Mountpoints
   - Used to validate that requested paths are host-mounted (when in container)
============================================================================ */

// Convert mountinfo escaped sequences to real characters
function unescapeMountPath(p) {
  return String(p || "")
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

let hostMountMapCache = null;
let hostMountMapTs = 0;
const HOST_MOUNT_CACHE_MS = 3000;

// Read host mountpoints into a map: mountpoint -> { fstype, source, major_minor }
function readHostMountpointsMap() {
  const now = Date.now();
  if (hostMountMapCache && now - hostMountMapTs < HOST_MOUNT_CACHE_MS) {
    return hostMountMapCache;
  }

  const map = new Map();

  const mountinfoPath = exists("/host/proc/1/mountinfo")
    ? "/host/proc/1/mountinfo"
    : exists("/proc/1/mountinfo")
    ? "/proc/1/mountinfo"
    : exists("/proc/self/mountinfo")
    ? "/proc/self/mountinfo"
    : null;

  const mountsPath = exists("/host/proc/1/mounts")
    ? "/host/proc/1/mounts"
    : exists("/proc/1/mounts")
    ? "/proc/1/mounts"
    : exists("/proc/self/mounts")
    ? "/proc/self/mounts"
    : null;

  try {
    if (!mountinfoPath) throw new Error("no mountinfo path");

    const txt = fs.readFileSync(mountinfoPath, "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;

      const sep = line.indexOf(" - ");
      if (sep < 0) continue;

      const left = line.slice(0, sep).split(" ");
      const right = line.slice(sep + 3).split(" ");

      const majorMinor = (left[2] || "").trim();
      const mp = unescapeMountPath(left[4]);
      const fstype = (right[0] || "").trim();
      const source = (right[1] || "").trim();
      const normMp = mp ? mp.replace(/\/+$/, "") || "/" : null;

      if (normMp) map.set(normMp, { fstype, source, major_minor: majorMinor || null });
    }
  } catch {
    try {
      if (!mountsPath) throw new Error("no mounts path");

      const txt = fs.readFileSync(mountsPath, "utf8");
      for (const line of txt.split("\n")) {
        if (!line) continue;

        const parts = line.split(" ");
        const source = unescapeMountPath(parts[0]);
        const mp = unescapeMountPath(parts[1]);
        const fstype = (parts[2] || "").trim();
        const normMp = mp ? mp.replace(/\/+$/, "") || "/" : null;

        if (normMp) map.set(normMp, { fstype, source });
      }
    } catch {}
  }

  hostMountMapCache = map;
  hostMountMapTs = now;
  return map;
}

// Lookup host mount info for a path (exact mountpoint match)
function getHostMountInfo(pathStr) {
  const norm = (p) => String(p || "").replace(/\/+$/, "") || "/";
  const p = norm(pathStr);
  const map = readHostMountpointsMap();
  return map.get(p) || null;
}

// Check if a given path is mounted on the host (exact mountpoint match)
function isMountedOnHost(pathStr) {
  return !!getHostMountInfo(pathStr);
}

/* ============================================================================
   Disk
   - df for disk usage + optional lsblk metadata (model/label/uuid)
============================================================================ */

let blkMetaCache = null;
let blkMetaTs = 0;
const BLK_META_CACHE_MS = Number(process.env.BLK_META_CACHE_MS || 15000);

// Normalize lsblk "NAME" into /dev/* path
function toDevPath(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (!s) return null;
  return s.startsWith("/dev/") ? s : `/dev/${s}`;
}

// Infer parent disk device from a partition device path
function parentDevFromPart(devPath) {
  const base = String(devPath || "");
  if (!base.startsWith("/dev/")) return null;
  const n = base.slice(5);

  const mNvme = n.match(/^(nvme\d+n\d+)p\d+$/);
  if (mNvme) return `/dev/${mNvme[1]}`;

  const mMmc = n.match(/^(mmcblk\d+)p\d+$/);
  if (mMmc) return `/dev/${mMmc[1]}`;

  const mSd = n.match(/^(sd[a-z]+)\d+$/);
  if (mSd) return `/dev/${mSd[1]}`;

  return null;
}

// Query lsblk JSON and build a map from /dev/* -> {type, model, label, uuid}
function readLsblkMeta() {
  try {
    const out = execSync("lsblk -J -o NAME,TYPE,MODEL,LABEL,PARTLABEL,UUID", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!out) return new Map();
    const j = JSON.parse(out);
    const map = new Map();

    function walk(node, parentDiskDev) {
      const dev = toDevPath(node.name);
      const type = (node.type || "").trim();
      if (!dev) return;

      if (type === "disk") {
        const model = (node.model || "").trim();
        map.set(dev, { dev, type, model, label: "", uuid: "" });
        parentDiskDev = dev;
      } else {
        const label = (node.label || node.partlabel || "").trim();
        const uuid = (node.uuid || "").trim();
        const parentModel = parentDiskDev ? map.get(parentDiskDev)?.model || "" : "";
        map.set(dev, { dev, type, model: parentModel, label, uuid });
      }

      if (Array.isArray(node.children)) {
        for (const ch of node.children) walk(ch, parentDiskDev);
      }
    }

    for (const n of j.blockdevices || []) walk(n, null);
    return map;
  } catch {
    return new Map();
  }
}

// Cached wrapper for readLsblkMeta()
function lsblkMetaCached() {
  const now = Date.now();
  if (blkMetaCache && now - blkMetaTs < BLK_META_CACHE_MS) return blkMetaCache;
  blkMetaCache = readLsblkMeta();
  blkMetaTs = now;
  return blkMetaCache;
}

// Make a stable key from a path (used to flatten disk fields)
function keyify(p) {
  return p.replace(/^\/+/, "").replace(/\//g, "_").replace(/[^\w]/g, "_");
}

// Run df and enrich with host mount + lsblk metadata
function dfBytes(pathStr) {
  const isSpecial = pathStr === "/host" || pathStr === "/";
  const expectHostMount = !isSpecial;

  if (inContainer() && expectHostMount && !isMountedOnHost(pathStr)) {
    throw new Error(`not mounted on host (${pathStr})`);
  }

  const out = execSync(`df -B1 -P -- ${JSON.stringify(pathStr)}`, { encoding: "utf8" }).trim();
  const line = out.split("\n")[1] || "";
  if (!line) throw new Error(`df returned no data (${pathStr})`);
  const parts = line.split(/\s+/);

  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const free = Number(parts[3]);
  const mount = parts[5] || pathStr;

  const hostLookupPath = pathStr === "/host" ? "/" : (pathStr === "/" ? "/" : pathStr);

  const mi = getHostMountInfo(hostLookupPath);
  const fstype = mi?.fstype || null;
  const source = mi?.source || null;
  const major_minor = mi?.major_minor || null;

  let blk_model = null;
  let blk_label = null;
  let blk_uuid = null;

  try {
    if (source && String(source).startsWith("/dev/")) {
      const meta = lsblkMetaCached();
      const hit = meta.get(source) || meta.get(toDevPath(source));
      const parent = parentDevFromPart(source);
      const parentHit = parent ? meta.get(parent) : null;

      blk_model = (hit?.model || parentHit?.model || "").trim() || null;
      blk_label = (hit?.label || "").trim() || null;
      blk_uuid = (hit?.uuid || "").trim() || null;
    }
  } catch {}

  const isSystem = pathStr === "/host" || pathStr === "/";
  const stableKey = isSystem ? "__system__" : keyify(pathStr);
  const label_key = isSystem ? "disk.label.system" : null;
  const label = isSystem ? "System Disk" : mount;

  return {
    key: stableKey,
    path: pathStr,
    mount,
    label,
    label_key,
    total,
    used,
    free,
    fstype,
    source,
    major_minor,
    blk_model,
    blk_label,
    blk_uuid,
  };
}

/* ============================================================================
   Disk IO (B/s) via /proc/diskstats
============================================================================ */

const SECTOR_SIZE = 512;

// Read host diskstats and return map major:minor -> { r_bytes, w_bytes }
function readHostDiskstats() {
  const p = exists("/host/proc/diskstats") ? "/host/proc/diskstats" : "/proc/diskstats";
  const txt = safeReadFile(p);
  if (!txt) return new Map();

  const out = new Map();

  for (const line of txt.split("\n")) {
    if (!line) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const major = parts[0];
    const minor = parts[1];
    const key = `${major}:${minor}`;

    const sectorsRead = Number(parts[5]);
    const sectorsWritten = Number(parts[9]);

    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue;

    out.set(key, {
      r_bytes: sectorsRead * SECTOR_SIZE,
      w_bytes: sectorsWritten * SECTOR_SIZE,
    });
  }

  return out;
}

// Compute per-device read/write bytes/sec since last call
function diskIoSpeedsNow() {
  const now = Date.now();
  const cur = readHostDiskstats();
  const speeds = new Map();

  for (const [mm, v] of cur.entries()) {
    const prev = lastDiskIo.get(mm);
    if (!prev) {
      speeds.set(mm, { read_bps: 0, write_bps: 0 });
      lastDiskIo.set(mm, { ts: now, r: v.r_bytes, w: v.w_bytes });
      continue;
    }

    const dt = (now - prev.ts) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) {
      speeds.set(mm, { read_bps: 0, write_bps: 0 });
      continue;
    }

    const dr = v.r_bytes - prev.r;
    const dw = v.w_bytes - prev.w;

    speeds.set(mm, {
      read_bps: Math.max(0, dr / dt),
      write_bps: Math.max(0, dw / dt),
    });

    lastDiskIo.set(mm, { ts: now, r: v.r_bytes, w: v.w_bytes });
  }

  return speeds;
}

/* ============================================================================
   Memory
============================================================================ */

// Read /proc/meminfo and return bytes for RAM + swap
function memBytes() {
  const out = execSync("cat /proc/meminfo", { encoding: "utf8" });
  const kv = {};

  for (const line of out.split("\n")) {
    if (!line) continue;
    const [k, rest] = line.split(":");
    const v = (rest || "").trim().split(/\s+/)[0];
    kv[k.trim()] = Number(v);
  }

  const KiB = 1024;

  const total = (kv.MemTotal || 0) * KiB;
  const available = (kv.MemAvailable || 0) * KiB;
  const used = total - available;

  const swap_total = (kv.SwapTotal || 0) * KiB;
  const swap_free = (kv.SwapFree || 0) * KiB;
  const swap_used = swap_total - swap_free;

  return { total, available, used, swap_total, swap_free, swap_used };
}

/* ============================================================================
   Formatting Helpers
============================================================================ */

// Human-readable byte formatting (base 1024)
function formatBytes(n) {
  if (!Number.isFinite(n)) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Format seconds into a compact duration (e.g. 1d 2h 3m 4s)
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const d = Math.floor(seconds / 86400);
  seconds %= 86400;
  const h = Math.floor(seconds / 3600);
  seconds %= 3600;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;

  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// Format bytes/sec using formatBytes
function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "n/a";
  return `${formatBytes(bytesPerSec)}/s`;
}

/* ============================================================================
   CPU
============================================================================ */

// Read CPU temperatures from thermal zones (max temp), best-effort
function readCpuTempsC() {
  try {
    const base = "/sys/class/thermal";
    const dirs = fs.readdirSync(base).filter((n) => n.startsWith("thermal_zone"));
    const temps = [];

    for (const d of dirs) {
      try {
        const p = path.join(base, d, "temp");
        const raw = fs.readFileSync(p, "utf8").trim();
        const v = Number(raw);
        if (Number.isFinite(v)) temps.push(v / 1000);
      } catch {}
    }

    return temps;
  } catch {
    return [];
  }
}

// Compute CPU utilization percent based on deltas of os.cpus().times
function cpuUtilPct() {
  const cpus = os.cpus() || [];
  if (!cpus.length) return null;

  let idle = 0;
  let total = 0;

  for (const c of cpus) {
    const t = c.times || {};
    const i = Number(t.idle || 0);
    const tt =
      Number(t.user || 0) +
      Number(t.nice || 0) +
      Number(t.sys || 0) +
      Number(t.idle || 0) +
      Number(t.irq || 0);

    idle += i;
    total += tt;
  }

  const now = Date.now();
  if (!lastCpuTimes) {
    lastCpuTimes = { ts: now, idle, total };
    return null;
  }

  const dtIdle = idle - lastCpuTimes.idle;
  const dtTotal = total - lastCpuTimes.total;

  lastCpuTimes = { ts: now, idle, total };

  if (dtTotal <= 0) return null;

  const util = (1 - dtIdle / dtTotal) * 100;
  return Math.max(0, Math.min(100, util));
}

// Read CPU max frequency from sysfs (GHz), best-effort
function readCpuMaxFreqGHz() {
  const candidates = [
    "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq",
    "/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq",
    "/host/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq",
    "/host/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq",
  ];

  for (const p of candidates) {
    const txt = readText(p);
    const kHz = Number(txt);
    if (Number.isFinite(kHz) && kHz > 0) {
      return +(kHz / 1e6).toFixed(2);
    }
  }
  return null;
}

// Return CPU summary: model/cores/loadavg/temp/base GHz
function cpuSummary() {
  const cpus = os.cpus() || [];
  const model = cpus[0]?.model || null;
  const cores = cpus.length || 0;
  const [l1, l5, l15] = os.loadavg();
  const temps = readCpuTempsC();
  const tempMax = temps.length ? Math.max(...temps) : null;
  const baseGHz = readCpuMaxFreqGHz();

  return {
    model,
    cores,
    load1: l1,
    load5: l5,
    load15: l15,
    temp_c: tempMax,
    base_ghz: baseGHz,
  };
}

/* ============================================================================
   GPU (NVIDIA via nvidia-smi)
============================================================================ */

// Split CSV line into trimmed columns
function parseCsvLine(line) {
  return line.split(",").map((s) => s.trim());
}

// Query nvidia-smi once and return structured GPU info (or null/error)
function gpuQueryOnce() {
  try {
    execSync("nvidia-smi -L", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GPU_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch {
    return null;
  }

  try {
    const q =
      "nvidia-smi " +
      "--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.total,memory.used,power.draw,power.limit " +
      "--format=csv,noheader,nounits";

    const out = execSync(q, {
      encoding: "utf8",
      timeout: GPU_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!out) return null;

    const gpus = out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [index, name, tempC, util, memTotal, memUsed, pwrDraw, pwrLimit] = parseCsvLine(line);

        const totalMiB = Number(memTotal);
        const usedMiB = Number(memUsed);

        const totalB = Number.isFinite(totalMiB) ? totalMiB * 1024 * 1024 : null;
        const usedB = Number.isFinite(usedMiB) ? usedMiB * 1024 * 1024 : null;
        const freeB = totalB != null && usedB != null ? totalB - usedB : null;

        return {
          index: Number(index),
          name: name || null,
          temp_c: Number(tempC),
          util_pct: Number(util),
          mem_total_b: totalB,
          mem_used_b: usedB,
          mem_free_b: freeB,
          power_w: Number(pwrDraw),
          power_limit_w: Number(pwrLimit),
        };
      });

    const primary = gpus[0] || null;
    return { count: gpus.length, gpus, primary };
  } catch (e) {
    return { error: String(e) };
  }
}

// Cached GPU summary; returns stale cached data on errors when possible
function gpuSummary() {
  const now = Date.now();

  if (lastGpu && now - lastGpuTs < GPU_POLL_MS) {
    return {
      ...lastGpu,
      cached: true,
      age_ms: now - lastGpuTs,
      last_error: lastGpuErr,
    };
  }

  const fresh = gpuQueryOnce();

  if (!fresh) {
    lastGpu = null;
    lastGpuTs = now;
    lastGpuErr = "nvidia-smi unavailable";
    return null;
  }

  if (fresh?.error) {
    lastGpuErr = fresh.error;

    if (lastGpu) {
      return {
        ...lastGpu,
        cached: true,
        stale: true,
        age_ms: now - lastGpuTs,
        last_error: lastGpuErr,
      };
    }

    return fresh;
  }

  lastGpu = fresh;
  lastGpuTs = now;
  lastGpuErr = null;

  return { ...fresh, cached: false, age_ms: 0, last_error: null };
}

/* ============================================================================
   Network
============================================================================ */

// Pick a default outward-facing interface and IP (best-effort)
function netSummary() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      candidates.push({ name, family: a.family, address: a.address });
    }
  }

  const ipv4 = candidates.find((x) => x.family === "IPv4") || candidates[0] || null;
  return { iface: ipv4?.name || null, ip: ipv4?.address || null };
}

// Read rx/tx byte counters for an interface
function readIfaceBytes(iface) {
  const rx = Number(
    execSync(`cat /sys/class/net/${JSON.stringify(iface)}/statistics/rx_bytes`, {
      encoding: "utf8",
    }).trim()
  );

  const tx = Number(
    execSync(`cat /sys/class/net/${JSON.stringify(iface)}/statistics/tx_bytes`, {
      encoding: "utf8",
    }).trim()
  );

  return { rx, tx };
}

// Select interface: env override wins, else auto
function pickIface() {
  if (NET_IFACE) return NET_IFACE;
  const n = netSummary();
  return n.iface;
}

// Compute instantaneous down/up speed based on rx/tx deltas
function netSpeedSample() {
  const iface = pickIface();
  if (!iface) return { iface: null, down_bps: null, up_bps: null };

  const now = Date.now();
  let cur;

  try {
    cur = readIfaceBytes(iface);
  } catch {
    return { iface, down_bps: null, up_bps: null };
  }

  if (!lastNetSample || lastNetSample.iface !== iface) {
    lastNetSample = { ts: now, iface, rx: cur.rx, tx: cur.tx };
    return { iface, down_bps: 0, up_bps: 0 };
  }

  const dt = (now - lastNetSample.ts) / 1000;
  const down = dt > 0 ? (cur.rx - lastNetSample.rx) / dt : 0;
  const up = dt > 0 ? (cur.tx - lastNetSample.tx) / dt : 0;

  lastNetSample = { ts: now, iface, rx: cur.rx, tx: cur.tx };
  return { iface, down_bps: down, up_bps: up };
}

/* ============================================================================
   HTTP Response Helpers
============================================================================ */

// Send JSON response with no-store cache headers
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Send HTML response with no-store cache headers
function sendHtml(res, code, html) {
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

/* ============================================================================
   UI Static Serving
============================================================================ */

const UI_DIR = process.env.UI_DIR || "./ui";
const UI_INDEX = process.env.UI_INDEX || "index.html";

// Map file extension to Content-Type
function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

// Send a static file (buffered) with basic headers
function sendFile(res, filePath) {
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-store",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

// Serve UI assets from UI_DIR safely (prevents path traversal)
function serveUiAsset(res, pathname) {
  const rel =
    pathname === "/" || pathname === "/index.html" ? UI_INDEX : pathname.replace(/^\/+/, "");

  const base = path.resolve(UI_DIR);
  const filePath = path.resolve(base, rel);

  if (!filePath.startsWith(base + path.sep) && filePath !== base) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return sendJson(res, 404, { error: "not_found", path: pathname, filePath });
    }
    return sendFile(res, filePath);
  } catch (e) {
    return sendJson(res, 500, { error: String(e) });
  }
}

/* ============================================================================
   Routes
============================================================================ */

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && u.pathname === "/stats/speedtest/history") {
      const snap = speedtest.snapshot();
      sendJson(res, 200, {
        ok: true,
        window: "24h",
        now: Date.now(),
        history: Array.isArray(snap.history_24h) ? snap.history_24h : [],
        max_down_mbps: snap.max_down_mbps,
        max_up_mbps: snap.max_up_mbps,
      });
      return;
    }

    const pathname = u.pathname;

    if (pathname === "/favicon.ico") {
      const base = path.resolve(UI_DIR);
      const fp = path.resolve(base, "img/favicon.ico");
      if (!fs.existsSync(fp)) return sendJson(res, 404, { error: "not_found" });
      return sendFile(res, fp);
    }

    if (pathname === "/api/update/latest") {
      const repoQ = (u.searchParams.get("repo") || "").trim();
      const repo = repoQ || GITHUB_DEFAULT_REPO;

      if (!isValidRepoSlug(repo)) return sendJson(res, 400, { error: "bad_repo" });

      try {
        const rel = await fetchLatestReleaseFromAtom(repo);
        if (!rel) {
          return sendJson(res, 200, {
            repo,
            tag_name: "",
            name: "",
            body: "",
            body_html: "",
            html_url: `https://github.com/${repo}/releases`,
            published_at: "",
            source: "atom",
            no_release_found: true,
          });
        }

        return sendJson(res, 200, {
          repo,
          ...rel,
          source: "atom",
          no_release_found: false,
        });
      } catch (e) {
        return sendJson(res, 502, { error: "atom_fetch_failed", message: String(e) });
      }
    }

    if (pathname === "/stats") {
      const mem = memBytes();
      const cpu_util_pct = cpuUtilPct();
      const cpu = cpuSummary();
      const gpu = gpuSummary();
      const g0 = gpu?.primary || null;

      const net = netSummary();
      const netSpeed = netSpeedSample();
      const uptime_s = os.uptime();

      const system = systemInfoCached();
      const ident = systemIdentity();
      const bios = biosInfo();
      const battery = batteryInfo();

      const disks = disksCached();

      const ioNow = diskIoSpeedsNow();
      for (const d of Object.values(disks)) {
        if (!d || d.error) continue;
        const mm = d.major_minor;
        const s = mm ? ioNow.get(mm) : null;
        d.read_bps = s ? s.read_bps : 0;
        d.write_bps = s ? s.write_bps : 0;
      }

      const flat = {
        mem_total: mem.total,
        mem_free: mem.available,
        mem_used: mem.used,
        mem_swap_total: mem.swap_total,
        mem_swap_free: mem.swap_free,
        mem_swap_used: mem.swap_used,

        cpu_model: cpu.model ?? null,
        cpu_cores: cpu.cores,
        cpu_load1: cpu.load1,
        cpu_load5: cpu.load5,
        cpu_load15: cpu.load15,
        cpu_base_ghz: cpu.base_ghz ?? null,
        cpu_util_pct,
        cpu_temp_c: cpu.temp_c ?? null,

        uptime_s,
        net_iface: net.iface,
        net_ip: net.ip,
        net_down_bps: netSpeed.down_bps,
        net_up_bps: netSpeed.up_bps,

        gpu_name: g0?.name ?? null,
        gpu_temp_c: g0?.temp_c ?? null,
        gpu_util_pct: g0?.util_pct ?? null,
        gpu_mem_total: g0?.mem_total_b ?? null,
        gpu_mem_used: g0?.mem_used_b ?? null,
        gpu_mem_free: g0?.mem_free_b ?? null,
        gpu_power_w: g0?.power_w ?? null,
        gpu_power_limit_w: g0?.power_limit_w ?? null,
        gpu_count: gpu?.count ?? 0,
      };

      for (const [k, d] of Object.entries(disks)) {
        if (d && !d.error) {
          flat[`disk_${k}_total`] = d.total;
          flat[`disk_${k}_free`] = d.free;
          flat[`disk_${k}_used`] = d.used;
          flat[`disk_${k}_read_bps`] = d.read_bps ?? 0;
          flat[`disk_${k}_write_bps`] = d.write_bps ?? 0;
        } else {
          flat[`disk_${k}_error`] = d?.error || "unknown";
        }
      }

      const cpuLine =
        `Cores: ${cpu.cores} | ` +
        `Load: ${cpu.load1.toFixed(2)} / ${cpu.load5.toFixed(2)} / ${cpu.load15.toFixed(2)}` +
        (cpu.temp_c != null ? ` | Temp: ${cpu.temp_c.toFixed(1)}°C` : "");

      const gpuLine = (() => {
        if (!gpu) return "GPU: n/a";
        if (gpu.error) return `GPU: error (${gpu.error})`;
        if (!gpu.primary) return "GPU: none";

        const g = gpu.primary;
        const memUsed = Number.isFinite(g.mem_used_b) ? formatBytes(g.mem_used_b) : "n/a";
        const memTot = Number.isFinite(g.mem_total_b) ? formatBytes(g.mem_total_b) : "n/a";
        const util = Number.isFinite(g.util_pct) ? `${g.util_pct.toFixed(0)}%` : "n/a";
        const temp = Number.isFinite(g.temp_c) ? `${g.temp_c.toFixed(0)}°C` : "n/a";
        const pwr = Number.isFinite(g.power_w) ? `${g.power_w.toFixed(0)}W` : "n/a";
        const lim = Number.isFinite(g.power_limit_w) ? `${g.power_limit_w.toFixed(0)}W` : "n/a";

        return `${g.name || "GPU"} | Util: ${util} | VRAM: ${memUsed} / ${memTot} | Temp: ${temp} | Pwr: ${pwr}/${lim}`;
      })();

      const netLine = `IF: ${net.iface || "n/a"} | IP: ${net.ip || "n/a"}`;
      const netSpeedLine = `↓ ${formatRate(netSpeed.down_bps)} | ↑ ${formatRate(netSpeed.up_bps)}`;
      const uptimeLine = formatDuration(uptime_s);
      const ramLine = `Free: ${formatBytes(mem.available)} | Used: ${formatBytes(mem.used)} | Total: ${formatBytes(mem.total)}`;

      const st = speedtest.snapshot();
      const diskLines = {};
      for (const p of DISK_PATHS) {
        const k = keyify(p);
        const d = disks[k];
        diskLines[`disk_${k}_line`] =
          !d || d.error
            ? `${p}: error`
            : `Free: ${formatBytes(d.free)} | Used: ${formatBytes(d.used)} | Total: ${formatBytes(d.total)}`;
      }

      return sendJson(res, 200, {
        ts: Date.now(),

        history: {
          v: history.v,
          sample_ms: history.sampleMs,
          max_min: history.maxMin,
          ts: history.ts,

          cpu1: history.cpu1,
          cpu5: history.cpu5,
          cpu15: history.cpu15,
          cpu_util: history.cpu_util,

          gpu_util: history.gpu_util,
          vram_used_b: history.vram_used_b,

          ram_used_b: history.ram_used_b,
          ram_free_b: history.ram_free_b,
          swap_used_b: history.swap_used_b,

          net_down_bps: history.net_down_bps,
          net_up_bps: history.net_up_bps,
        },

        system,
        bios,
        battery,
        ident,

        system_distro: system?.distro ?? null,
        system_kernel: system?.kernel ?? null,
        system_arch: system?.arch ?? null,
        system_hostname: system?.hostname ?? null,
        system_desktop: system?.desktop ?? null,
        system_session_type: system?.session_type ?? null,
        system_display_server: system?.display_server ?? null,

        cpu,
        mem,
        net,
        gpu,

        cpu_util_pct,
        uptime_s,
        disks,

        ...flat,

        speedtest: st,
        speedtest_last: st.last,
        speedtest_last_error: st.last_error,
        speedtest_interval_min: st.interval_min,
        speedtest_next_run_ts: st.next_run_ts,
        speedtest_running: st.running,

        cpu_line: cpuLine,
        net_line: netLine,
        net_speed_line: netSpeedLine,
        uptime_line: uptimeLine,
        ram_line: ramLine,
        gpu_line: gpuLine,

        ...diskLines,
      });
    }

    if (
      pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/styles.css" ||
      pathname === "/app.js" ||
      pathname.endsWith(".css") ||
      pathname.endsWith(".js") ||
      pathname.endsWith(".json") ||
      pathname.endsWith(".svg") ||
      pathname.endsWith(".png") ||
      pathname.endsWith(".ico")
    ) {
      return serveUiAsset(res, pathname);
    }

    if (pathname === "/health") {
      return sendJson(res, 200, { ok: true, ts: Date.now() });
    }

    if (pathname === "/speedtest/last" || pathname === "/stats/speedtest/last") {
      return sendJson(res, 200, speedtest.snapshot());
    }

    if (pathname === "/speedtest/run" || pathname === "/stats/speedtest/run") {
      return sendJson(res, 200, speedtest.runNow());
    }

    if (pathname === "/speedtest/config" || pathname === "/stats/speedtest/config") {
      const raw = (u.searchParams.get("interval") || "").trim();
      const interval = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(interval)) return sendJson(res, 400, { error: "bad_interval" });
      return sendJson(res, 200, speedtest.setIntervalMin(interval));
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (e) {
    return sendJson(res, 500, { error: String(e) });
  }
});

/* ============================================================================
   Startup
============================================================================ */

// Start listening on all interfaces
server.listen(PORT, "0.0.0.0", () => {
  console.log(`stats-api listening on :${PORT}`);
});
