import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ============================================================
   Utils
   - Small helpers used across the module
============================================================ */

// Return current time as milliseconds since epoch
function nowMs() {
  return Date.now();
}

// Clamp a value to an integer range (invalid input -> min)
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

/* ============================================================
   Rate Limit Handling
   - Detect Ookla rate limits and compute backoff windows
============================================================ */

// Custom error to represent "rate limited" failures
class RateLimitError extends Error {
  constructor(message, { code = 173, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "RateLimitError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

// Check if a log/message looks like a rate limit response
function isRateLimitedText(s) {
  const t = String(s || "").toLowerCase();
  return (
    t.includes("limit reached") ||
    t.includes("too many requests") ||
    t.includes("rate limit") ||
    t.includes("429")
  );
}

// Compute a simple step-based backoff (count starts at 1)
function computeRateLimitBackoffMs(count) {
  const steps = [
    30 * 60 * 1000,
    60 * 60 * 1000,
    2 * 60 * 60 * 1000,
    4 * 60 * 60 * 1000,
    6 * 60 * 60 * 1000,
  ];

  const c = Math.max(1, Math.floor(Number(count) || 1));
  return steps[Math.min(steps.length - 1, c - 1)];
}

// Format milliseconds as rounded-up minutes string (e.g. "5m")
function fmtMin(ms) {
  const m = Math.ceil(Math.max(0, Number(ms) || 0) / 60000);
  return m + "m";
}

const HISTORY_24H_MS = 24 * 60 * 60 * 1000;

/* ============================================================
   Binary Resolution
   - Find an Ookla speedtest binary (bundled or installed)
============================================================ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check whether a path is executable (best-effort on Windows)
function isExecutable(p) {
  try {
    if (process.platform === "win32") return fs.existsSync(p);
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Try to resolve the bundled "speedtest" binary shipped with the app
function resolveBundledSpeedtest() {
  const base = path.resolve(__dirname, "bin");

  if (process.platform === "win32") {
    const p = path.join(base, "win", "speedtest.exe");
    return fs.existsSync(p) ? p : null;
  }

  const arch = process.arch;
  const candidates = [];

  if (arch === "x64") candidates.push("x86-64");
  else if (arch === "ia32") candidates.push("i386");
  else if (arch === "arm64") candidates.push("aarch64");
  else if (arch === "arm") candidates.push("armhf", "armel");
  else candidates.push(arch);

  for (const dir of candidates) {
    const p = path.join(base, dir, "speedtest");
    if (fs.existsSync(p)) {
      if (isExecutable(p)) return p;
      try {
        fs.chmodSync(p, 0o755);
        if (isExecutable(p)) return p;
      } catch {}
    }
  }

  return null;
}

/* ============================================================
   Command Execution
   - Spawn a process, capture stdout/stderr, support timeout
============================================================ */

// Run a command and capture output (never throws; returns a result object)
function runCmd(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    let p;
    try {
      p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({
        code: 127,
        stdout: "",
        stderr: String(e?.message || e),
        killed: false,
        spawn_error: true,
      });
    }

    const t = setTimeout(() => {
      killed = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    p.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    p.stderr?.on("data", (d) => (stderr += d.toString("utf8")));

    p.on("error", (err) => {
      clearTimeout(t);
      resolve({
        code: 127,
        stdout,
        stderr: (stderr ? stderr + "\n" : "") + String(err?.message || err),
        killed,
        spawn_error: true,
        errno: err?.errno,
        syscall: err?.syscall,
      });
    });

    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

// Resolve a command path using the shell ("command -v")
async function which(cmd) {
  const r = await runCmd(
    "sh",
    ["-lc", `command -v ${cmd} 2>/dev/null || true`],
    { timeoutMs: 5000 }
  );
  const s = (r.stdout || "").trim();
  return s || null;
}

/* ============================================================
   JSON Parsing & Salvage
   - Parse JSON output; if it's noisy, try to salvage blocks
============================================================ */

// Extract a JSON block starting at a given position (supports {} and [])
function extractJsonBlockFrom(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return { block: s.slice(start, i + 1), end: i };
      }
    }
  }

  return null;
}

// Score a candidate object by how "result-ish" it looks
function scoreCandidate(obj) {
  if (!obj || typeof obj !== "object") return 0;

  let sc = 0;
  if (obj.ping) sc += 2;
  if (obj.download) sc += 3;
  if (obj.upload) sc += 3;
  if (obj.type === "result") sc += 10;

  if (obj.isp) sc += 1;
  if (obj.interface) sc += 1;
  if (obj.server) sc += 1;

  return sc;
}

// Pick the best-looking speedtest result object from nested structures
function pickBestSpeedtestResult(v) {
  if (!v) return null;

  if (Array.isArray(v)) {
    let best = null;
    let bestScore = 0;

    for (const it of v) {
      const cand = pickBestSpeedtestResult(it) || it;
      const sc = scoreCandidate(cand);
      if (cand?.type === "result") return cand;
      if (sc > bestScore) {
        bestScore = sc;
        best = cand;
      }
    }
    return bestScore > 0 ? best : null;
  }

  if (typeof v === "object") {
    if (v.type === "result") return v;

    const inner =
      v.result && typeof v.result === "object"
        ? v.result
        : v.data && typeof v.data === "object"
        ? v.data
        : null;

    if (inner) {
      const picked = pickBestSpeedtestResult(inner);
      if (picked) return picked;
    }

    return v;
  }

  return null;
}

// Scan text for JSON blocks, parse them, and return the best-scoring one
function extractBestJsonBlock(text) {
  const s = String(text || "");
  const blocks = [];
  let pos = 0;

  while (pos < s.length && blocks.length < 40) {
    const rel = s.slice(pos).search(/[\{\[]/);
    if (rel < 0) break;
    const start = pos + rel;

    const got = extractJsonBlockFrom(s, start);
    if (!got) {
      pos = start + 1;
      continue;
    }

    blocks.push(got.block);
    pos = got.end + 1;
  }

  let best = null;
  let bestScore = -1;

  for (const b of blocks) {
    try {
      const obj0 = JSON.parse(b);
      const obj = pickBestSpeedtestResult(obj0) || obj0;
      const sc = scoreCandidate(obj);
      if (sc > bestScore) {
        bestScore = sc;
        best = obj;
      }
    } catch {}
  }

  return best;
}

// Parse JSON safely; if direct parse fails, try block salvage
function safeJsonParse(text) {
  const s = (text || "").trim();
  if (!s) return { ok: false, error: "empty_output" };

  try {
    const parsed = JSON.parse(s);
    const picked = pickBestSpeedtestResult(parsed);
    return {
      ok: true,
      value: picked || parsed,
      salvaged: Boolean(picked && picked !== parsed),
    };
  } catch (e1) {
    const best = extractBestJsonBlock(s);
    if (best) return { ok: true, value: best, salvaged: true };

    const head = s.slice(0, 200);
    const tail = s.slice(Math.max(0, s.length - 200));
    return {
      ok: false,
      error: "invalid_json",
      message: String(e1?.message || e1),
      head,
      tail,
      len: s.length,
    };
  }
}

/* ============================================================
   Ookla Progress Parsing
   - Parse speedtest --progress output (JSON lines or text)
============================================================ */

// Remove ANSI color codes from text
function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

// Convert different units to Mbps (best-effort)
function speedToMbps(val, unitRaw) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;

  const u = String(unitRaw || "").trim();
  if (!u) return n;

  const unit = u.toLowerCase();

  if (unit === "bps") return n / 1_000_000;
  if (unit === "kbps") return n / 1_000;
  if (unit === "mbps") return n;
  if (unit === "gbps") return n * 1_000;

  if (unit === "b/s") return (n * 8) / 1_000_000;
  if (unit === "kb/s") return (n * 8) / 1_000;
  if (unit === "mb/s") return n * 8;
  if (unit === "gb/s") return n * 8 * 1_000;

  if (unit === "kibps") return (n * 1024) / 1_000_000;
  if (unit === "mibps") return (n * 1024 * 1024) / 1_000_000;
  if (unit === "gibps") return (n * 1024 * 1024 * 1024) / 1_000_000;

  return n;
}

// Parse a human-readable Ookla progress line into a structured object
function parseOoklaProgressLine(lineRaw) {
  const line = stripAnsi(lineRaw).replace(/\s+/g, " ").trim();
  if (!line) return null;

  const out = {};

  let m = line.match(
    /\bDownload\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z/]+)?\b/i
  );
  if (m) {
    out.stage = "download";
    const mbps = speedToMbps(m[1], m[2] || "Mbps");
    if (Number.isFinite(mbps)) out.down_mbps = mbps;
  }

  m = line.match(/\bUpload\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z/]+)?\b/i);
  if (m) {
    out.stage = "upload";
    const mbps = speedToMbps(m[1], m[2] || "Mbps");
    if (Number.isFinite(mbps)) out.up_mbps = mbps;
  }

  const lat =
    line.match(/\bIdle\s+Latency\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*ms\b/i) ||
    line.match(/\bLatency\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*ms\b/i);

  if (lat) {
    out.stage = out.stage || "ping";
    const ping = Number(lat[1]);
    if (Number.isFinite(ping)) out.ping_ms = ping;

    const jit = line.match(/\bjitter[:\s]*([0-9]+(?:\.[0-9]+)?)\s*ms\b/i);
    if (jit) {
      const j = Number(jit[1]);
      if (Number.isFinite(j)) out.jitter_ms = j;
    }
  }

  return Object.keys(out).length ? out : null;
}

// Run Ookla speedtest in JSON mode + progress, and stream progress updates
function runOoklaJsonWithProgress(cmd, { timeoutMs = 120000, onProgress } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    let p;
    try {
      p = spawn(
        cmd,
        ["--accept-license", "--accept-gdpr", "-f", "json", "--progress", "yes"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (e) {
      return resolve({
        code: 127,
        stdout: "",
        stderr: String(e?.message || e),
        killed: false,
        spawn_error: true,
      });
    }

    const feedLines = (() => {
      let buf = "";
      return (chunk) => {
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r\n|\n|\r/);
        buf = parts.pop() || "";

        for (const part of parts) {
          const line = stripAnsi(part).trim();
          if (!line) continue;

          if (line[0] === "{" || line[0] === "[") {
            try {
              const ev = JSON.parse(line);
              if (ev && typeof ev === "object" && typeof onProgress === "function") {
                if (ev.type === "ping" || ev.ping || ev.latency) {
                  onProgress({
                    stage: "ping",
                    ping_ms: ooklaPingMs(ev),
                    jitter_ms: ooklaJitterMs(ev),
                  });
                }

                if (ev.type === "download" && ev.download) {
                  onProgress({
                    stage: "download",
                    down_mbps: sectionToMbps(ev.download),
                  });
                }

                if (ev.type === "upload" && ev.upload) {
                  onProgress({
                    stage: "upload",
                    up_mbps: sectionToMbps(ev.upload),
                  });
                }
              }
              continue;
            } catch {}
          }

          const parsed = parseOoklaProgressLine(line);
          if (parsed && typeof onProgress === "function") {
            try {
              onProgress(parsed);
            } catch {}
          }
        }
      };
    })();

    const t = setTimeout(() => {
      killed = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    p.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
      feedLines(d);
    });

    p.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
      feedLines(d);
    });

    p.on("error", (err) => {
      clearTimeout(t);
      resolve({
        code: 127,
        stdout,
        stderr: (stderr ? stderr + "\n" : "") + String(err?.message || err),
        killed,
        spawn_error: true,
        errno: err?.errno,
        syscall: err?.syscall,
      });
    });

    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

/* ============================================================
   Runner Detection
   - Decide which CLI to use (Ookla / speedtest-cli / librespeed)
============================================================ */

// Detect the best available speedtest runner on the system
async function detectRunner() {
  const forced = (process.env.SPEEDTEST_BIN || "").trim();
  if (forced) return { kind: "ookla", bin: forced };

  const bundled = resolveBundledSpeedtest();
  if (bundled) return { kind: "ookla", bin: bundled };

  const st = await which("speedtest");
  if (st) {
    const v = await runCmd("speedtest", ["--version"], { timeoutMs: 5000 });
    const ver = (v.stdout || v.stderr || "").toLowerCase();
    const isPythonCli = ver.includes("speedtest-cli");
    if (!isPythonCli) return { kind: "ookla", bin: "speedtest" };
  }

  const stcli = await which("speedtest-cli");
  if (stcli) return { kind: "speedtest-cli", bin: "speedtest-cli" };

  const libre = await which("librespeed-cli");
  if (libre) return { kind: "librespeed-cli", bin: "librespeed-cli" };

  return null;
}

/* ============================================================
   Ookla Result Parsing
   - Normalize different JSON shapes into ping/jitter/down/up
============================================================ */

// Convert to a finite number or null
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Extract ping latency (ms) from Ookla JSON object
function ooklaPingMs(j) {
  if (j?.ping == null) return toNum(j?.latency);
  if (typeof j.ping === "number" || typeof j.ping === "string") return toNum(j.ping);
  return toNum(j.ping.latency ?? j.ping.latency_ms ?? j.ping.latencyMs);
}

// Extract jitter (ms) from Ookla JSON object
function ooklaJitterMs(j) {
  if (j?.ping && typeof j.ping === "object") {
    return toNum(j.ping.jitter ?? j.ping.jitter_ms ?? j.ping.jitterMs);
  }
  return toNum(j?.jitter);
}

// Convert Ookla "download/upload" sections into Mbps
function sectionToMbps(sec) {
  if (!sec || typeof sec !== "object") return null;

  const bw = toNum(sec.bandwidth ?? sec.bandwidth_bytes ?? sec.bandwidthBytes);
  if (bw != null) return (bw * 8) / 1_000_000;

  const bps = toNum(sec.bandwidth_bps ?? sec.bps);
  if (bps != null) return bps / 1_000_000;

  const bytes = toNum(sec.bytes);
  const elapsed = toNum(sec.elapsed);
  if (bytes != null && elapsed != null && elapsed > 0) {
    const bytesPerSec = bytes / (elapsed / 1000);
    return (bytesPerSec * 8) / 1_000_000;
  }

  return null;
}

/* ============================================================
   Run Speedtest
   - Execute the selected runner, parse, and normalize results
============================================================ */

// Convert bits-per-second to Mbps
function bpsToMbps(bps) {
  const n = Number(bps);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}

// Find a fallback runner when Ookla fails (prefer speedtest-cli)
async function findFallbackRunner() {
  const stcli = await which("speedtest-cli");
  if (stcli) return { kind: "speedtest-cli", bin: "speedtest-cli" };

  const st = await which("speedtest");
  if (st) {
    const v = await runCmd("speedtest", ["--version"], { timeoutMs: 5000 });
    const ver = (v.stdout || v.stderr || "").toLowerCase();
    if (ver.includes("speedtest-cli")) return { kind: "speedtest-cli", bin: "speedtest" };
  }

  return null;
}

// Run one speedtest using the chosen runner and return a normalized result
async function runSpeedtest(runner, timeoutMs, onProgress) {
  if (!runner) {
    throw new Error(
      "No speedtest runner found (speedtest-cli / speedtest (Ookla) / librespeed-cli)"
    );
  }

  if (runner.kind === "speedtest-cli") {
    const r = await runCmd(runner.bin, ["--secure", "--json"], { timeoutMs });
    if (r.killed) throw new Error(`speedtest-cli timeout after ${timeoutMs}ms`);
    if (r.code !== 0) {
      throw new Error(`speedtest-cli exit ${r.code}: ${r.stderr || r.stdout}`);
    }

    const pj = safeJsonParse(r.stdout);
    if (!pj.ok) {
      throw new Error(
        `speedtest-cli ${pj.error}: ${pj.message || ""} (len=${pj.len || 0}) stderr=${(
          r.stderr || ""
        )
          .trim()
          .slice(0, 200)}`
      );
    }

    const j = pj.value;

    return {
      runner: "speedtest-cli",
      ping_ms: Number.isFinite(Number(j?.ping)) ? Number(j.ping) : null,
      jitter_ms: null,
      down_mbps: bpsToMbps(j?.download),
      up_mbps: bpsToMbps(j?.upload),
    };
  }

  if (runner.kind === "ookla") {
    const r = await runOoklaJsonWithProgress(runner.bin, { timeoutMs, onProgress });

    if (r.killed) throw new Error(`speedtest timeout after ${timeoutMs}ms`);

    if (r.spawn_error) {
      const fb = await findFallbackRunner();
      if (fb) return await runSpeedtest(fb, timeoutMs, onProgress);
      throw new Error(`speedtest spawn failed: ${r.stderr}`);
    }

    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || "").trim();
      const rateLimited = r.code === 173 || isRateLimitedText(msg);

      const fb = await findFallbackRunner();
      if (fb) {
        const fbRes = await runSpeedtest(fb, timeoutMs, onProgress);
        return {
          ...fbRes,
          note: rateLimited ? "ookla_rate_limited_fallback" : "ookla_failed_fallback",
          ookla_exit: r.code,
          ookla_rate_limited: rateLimited ? true : false,
        };
      }

      if (rateLimited) {
        throw new RateLimitError(
          `rate_limited: ${msg.slice(0, 240) || "Limit reached"}`,
          { code: r.code || 173 }
        );
      }

      throw new Error(`speedtest exit ${r.code}: ${msg}`);
    }

    const combined = (r.stdout || "") + "\n" + (r.stderr || "");

    let pj = safeJsonParse(r.stdout);

    const looksLikeFinal =
      pj?.ok &&
      pj.value &&
      (pj.value.type === "result" ||
        (pj.value.ping && pj.value.download && pj.value.upload) ||
        scoreCandidate(pj.value) >= 8);

    if (!looksLikeFinal) {
      const pj2 = safeJsonParse(combined);
      if (pj2?.ok) pj = pj2;
    }

    if (!pj?.ok) {
      const fb = await findFallbackRunner();
      if (fb) return await runSpeedtest(fb, timeoutMs, onProgress);

      throw new Error(
        `speedtest ${pj?.error || "parse_error"}: ${pj?.message || ""} (len=${
          pj?.len || 0
        })`
      );
    }

    const j = pj.value;

    return {
      runner: "ookla",
      ping_ms: ooklaPingMs(j),
      jitter_ms: ooklaJitterMs(j),
      down_mbps: sectionToMbps(j?.download),
      up_mbps: sectionToMbps(j?.upload),
    };
  }

  if (runner.kind === "librespeed-cli") {
    const r = await runCmd(runner.bin, ["--json"], { timeoutMs });
    if (r.killed) throw new Error(`librespeed-cli timeout after ${timeoutMs}ms`);
    if (r.code !== 0) {
      throw new Error(`librespeed-cli exit ${r.code}: ${r.stderr || r.stdout}`);
    }

    const pj = safeJsonParse(r.stdout);
    if (!pj.ok) {
      throw new Error(
        `librespeed-cli ${pj.error}: ${pj.message || ""} (len=${pj.len || 0}) stderr=${(
          r.stderr || ""
        )
          .trim()
          .slice(0, 200)}`
      );
    }

    const j = pj.value;

    const pingMs = Number(j?.ping ?? j?.latency);
    const jitterMs = Number(j?.jitter);
    const downMbps = Number(j?.download ?? j?.download_mbps);
    const upMbps = Number(j?.upload ?? j?.upload_mbps);

    return {
      runner: "librespeed-cli",
      ping_ms: Number.isFinite(pingMs) ? pingMs : null,
      jitter_ms: Number.isFinite(jitterMs) ? jitterMs : null,
      down_mbps: Number.isFinite(downMbps) ? downMbps : null,
      up_mbps: Number.isFinite(upMbps) ? upMbps : null,
    };
  }

  throw new Error(`Unsupported runner: ${runner.kind}`);
}

/* ============================================================
   Controller
   - State + scheduling + progress + rate-limit backoff logic
============================================================ */

// Pick a "nice" gauge max bucket for UI (rounded steps)
function niceGaugeMaxBucket(mbps, fallback) {
  const v = Number(mbps);
  const x = Number.isFinite(v) && v > 0 ? v : fallback;

  const steps = [25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000];
  for (const s of steps) if (x <= s) return s;
  return Math.ceil(x / 1000) * 1000;
}

// Create a speedtest controller with tick/runNow APIs (for servers or small apps)
export function createSpeedtestController({
  timeoutMs = 120000,
  defaultIntervalMin = 0,
  stateFile = process.env.SPEEDTEST_STATE_FILE || "/app/data/speedtest-state.json",
  runOnStart = (process.env.SPEEDTEST_RUN_ON_START || "1") !== "0",
} = {}) {

  // Read persisted controller state from disk (best-effort)
  function readState() {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const j = JSON.parse(raw);

      const interval_min = Number(j?.interval_min);
      const rate_limit_until = Number(j?.rate_limit_until || 0);
      const rate_limit_count = Number(j?.rate_limit_count || 0);
      const history = Array.isArray(j?.history) ? j.history : [];
      const max_down_mbps = Number(j?.max_down_mbps || 0);
      const max_up_mbps = Number(j?.max_up_mbps || 0);

      return {
        interval_min: Number.isFinite(interval_min) ? interval_min : null,
        rate_limit_until: Number.isFinite(rate_limit_until) ? rate_limit_until : 0,
        rate_limit_count: Number.isFinite(rate_limit_count) ? rate_limit_count : 0,
        max_down_mbps: Number.isFinite(max_down_mbps) ? max_down_mbps : 0,
        max_up_mbps: Number.isFinite(max_up_mbps) ? max_up_mbps : 0,
        history: history
        .map((it) => ({
          ts: Number(it?.ts || 0) || 0,
          runner: String(it?.runner || ""),
          ping_ms: Number(it?.ping_ms),
          jitter_ms: Number(it?.jitter_ms),
          down_mbps: Number(it?.down_mbps),
          up_mbps: Number(it?.up_mbps),
          note: it?.note ? String(it.note) : "",
        }))
        .filter((it) => it.ts > 0),
      };
    } catch {}

    return null;
  }

  // Persist controller state to disk (best-effort, atomicity not guaranteed)
  function writeState(min, extra = {}) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(
        stateFile,
        JSON.stringify(
          {
            interval_min: min,
            saved_at: Date.now(),
            ...extra,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {}
  }

  const loaded = readState();

  let intervalMin = clampInt(loaded?.interval_min ?? defaultIntervalMin, 0, 60 * 24);
  let rateLimitUntil = Number(loaded?.rate_limit_until || 0) || 0;
  let rateLimitCount = Number(loaded?.rate_limit_count || 0) || 0;
  let maxDown = Number(loaded?.max_down_mbps || 0) || 0;
  let maxUp = Number(loaded?.max_up_mbps || 0) || 0;
  let nextRunTs = 0;
  let history = Array.isArray(loaded?.history) ? loaded.history : [];

  // Drop old history (keeps last 24h, capped).
  function pruneHistory(now = nowMs()) {
    const cutoff = now - HISTORY_24H_MS;
    history = (Array.isArray(history) ? history : []).filter((it) => (it?.ts || 0) >= cutoff);
    if (history.length > 5000) history = history.slice(history.length - 5000);
    return history;
  }

  // Append a normalized entry to 24h history.
  function pushHistory(entry) {
    const now = nowMs();
    pruneHistory(now);
    const it = {
      ts: now,
      runner: String(entry?.runner || runnerName || ""),
      ping_ms: entry?.ping_ms ?? null,
      jitter_ms: entry?.jitter_ms ?? null,
      down_mbps: entry?.down_mbps ?? null,
      up_mbps: entry?.up_mbps ?? null,
      note: entry?.note ? String(entry.note) : "",
    };
    history.push(it);
    return it;
  }

  let runnerInfo = null;
  let runnerName = null;

  let progress = null;
  let running = false;
  let last = null;
  let lastError = null;

  // Ensure we detected a runner only once (cached)
  async function ensureRunner() {
    if (runnerInfo) return runnerInfo;
    runnerInfo = await detectRunner();
    runnerName = runnerInfo?.kind || null;
    return runnerInfo;
  }

  // Execute a single run (handles progress, state, backoff, and errors)
  async function doRun() {
    if (running) return;

    running = true;
    lastError = null;

    progress = {
      ts: nowMs(),
      stage: "starting",
      ping_ms: null,
      jitter_ms: null,
      down_mbps: null,
      up_mbps: null,
    };

    try {
      const rInfo = await ensureRunner();

      const res = await runSpeedtest(rInfo, timeoutMs, (p) => {
        if (!progress) {
          progress = {
            ts: nowMs(),
            stage: "running",
            ping_ms: null,
            jitter_ms: null,
            down_mbps: null,
            up_mbps: null,
          };
        }

        progress = {
          ...progress,
          ...p,
          ts: nowMs(),
        };
      });

      // If we had to fallback due to Ookla rate-limit, set a backoff window
      if (res?.ookla_rate_limited) {
        const now = nowMs();
        rateLimitCount = Math.max(1, (Number(rateLimitCount) || 0) + 1);

        const backoffMs = computeRateLimitBackoffMs(rateLimitCount);
        rateLimitUntil = now + backoffMs;

        if (!nextRunTs || nextRunTs < rateLimitUntil) nextRunTs = rateLimitUntil;

        writeState(intervalMin, {
          rate_limit_until: rateLimitUntil,
          rate_limit_count: rateLimitCount,
        });

        lastError = `rate_limited: retry in ${fmtMin(backoffMs)} (fallback used)`;

        if (progress) progress = { ...progress, stage: "rate_limited", ts: now };
      }

      if (!res?.ookla_rate_limited && (rateLimitUntil || rateLimitCount)) {
        rateLimitUntil = 0;
        rateLimitCount = 0;
        writeState(intervalMin, {
          rate_limit_until: rateLimitUntil,
          rate_limit_count: rateLimitCount,
        });
      }

      const final = { ...res };

      if (progress) {
        if (final.ping_ms == null) final.ping_ms = progress.ping_ms ?? null;
        if (final.jitter_ms == null) final.jitter_ms = progress.jitter_ms ?? null;
        if (final.down_mbps == null) final.down_mbps = progress.down_mbps ?? null;
        if (final.up_mbps == null) final.up_mbps = progress.up_mbps ?? null;
      }

      const nextMaxDown = niceGaugeMaxBucket(final.down_mbps, 250);
      const nextMaxUp = niceGaugeMaxBucket(final.up_mbps, 50);

      if (nextMaxDown && nextMaxDown !== maxDown) maxDown = nextMaxDown;
      if (nextMaxUp && nextMaxUp !== maxUp) maxUp = nextMaxUp;

      last = { ts: nowMs(), ...final };
      runnerName = final.runner;

      pushHistory({
        runner: final.runner,
        ping_ms: final.ping_ms,
        jitter_ms: final.jitter_ms,
        down_mbps: final.down_mbps,
        up_mbps: final.up_mbps,
        note: final.note || "",
      });

      writeState(intervalMin, {
        rate_limit_until: rateLimitUntil,
        rate_limit_count: rateLimitCount,
        max_down_mbps: maxDown,
        max_up_mbps: maxUp,
        history,
      });

      if (progress) {
        progress = {
          ...progress,
          stage: "done",
          ping_ms: final.ping_ms ?? progress.ping_ms,
          jitter_ms: final.jitter_ms ?? progress.jitter_ms,
          down_mbps: final.down_mbps ?? progress.down_mbps,
          up_mbps: final.up_mbps ?? progress.up_mbps,
          ts: nowMs(),
        };
      }
    } catch (e) {
      const now = nowMs();

      if (e && e.name === "RateLimitError") {
        rateLimitCount = Math.max(1, (Number(rateLimitCount) || 0) + 1);

        const backoffMs = e.retryAfterMs || computeRateLimitBackoffMs(rateLimitCount);
        rateLimitUntil = now + backoffMs;

        if (!nextRunTs || nextRunTs < rateLimitUntil) nextRunTs = rateLimitUntil;

        writeState(intervalMin, {
          rate_limit_until: rateLimitUntil,
          rate_limit_count: rateLimitCount,
        });

        lastError = `rate_limited: retry in ${fmtMin(backoffMs)}`;
        if (progress) progress = { ...progress, stage: "rate_limited", ts: now };
        return;
      }

      lastError = String(e?.message || e);
      if (progress) progress = { ...progress, stage: "error", ts: now };
    } finally {
      running = false;
    }
  }

  // Compute and store next run timestamp based on interval
  function scheduleNext(fromTs = nowMs()) {
    nextRunTs = intervalMin ? fromTs + intervalMin * 60 * 1000 : 0;
  }

  // Periodic tick: detect runner, honor backoff, start run when it's time
  function tick() {
    if (!runnerInfo) ensureRunner().catch(() => {});
    if (!intervalMin) return;

    const now = nowMs();

    if (rateLimitUntil && now < rateLimitUntil) {
      if (!nextRunTs || nextRunTs < rateLimitUntil) nextRunTs = rateLimitUntil;
      return;
    }

    if (!nextRunTs) scheduleNext(now);

    if (now >= nextRunTs && !running) {
      scheduleNext(now);
      doRun();
    }
  }

  // Trigger a run immediately (or return a rate-limit snapshot if blocked)
  function runNow() {
    const now = nowMs();

    if (rateLimitUntil && now < rateLimitUntil) {
      const left = rateLimitUntil - now;
      lastError = `rate_limited: retry in ${fmtMin(left)}`;
      if (!nextRunTs || nextRunTs < rateLimitUntil) nextRunTs = rateLimitUntil;
      return snapshot();
    }

    if (!running) doRun();
    return snapshot();
  }

  // Update the run interval in minutes and reschedule
  function setIntervalMin(min) {
    intervalMin = clampInt(min, 0, 60 * 24);

    writeState(intervalMin, {
      rate_limit_until: rateLimitUntil,
      rate_limit_count: rateLimitCount,
    });

    scheduleNext(nowMs());
    return snapshot();
  }

  // Get current controller state for API responses / UI polling
  function snapshot() {
    pruneHistory();
    return {
      runner: runnerName,
      running,
      interval_min: intervalMin,
      next_run_ts: nextRunTs,
      last,
      last_error: lastError,
      progress: running ? progress : null,
      max_down_mbps: maxDown,
      max_up_mbps: maxUp,
      history_24h: history,
    };
  }

  scheduleNext(nowMs());

  const now = nowMs();

  if (runOnStart && intervalMin > 0) {
    if (!rateLimitUntil || now >= rateLimitUntil) {
      doRun();
      scheduleNext(now);
    } else {
      nextRunTs = Math.max(nextRunTs || 0, rateLimitUntil);
    }
  }

  return { tick, runNow, setIntervalMin, snapshot };
}
