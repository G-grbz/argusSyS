// Clamp a number between min and max
export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Escape HTML to prevent XSS
export function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Read a query parameter from the current URL
export function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

// Convert bytes to GiB
export function toGiB(bytes) {
  const b = Number(bytes);
  return Number.isFinite(b) ? b / 1024 ** 3 : 0;
}

// Format bytes into human-readable units
export function formatBytes(n) {
  if (!Number.isFinite(n)) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x.toFixed(0) : x.toFixed(1)) + " " + units[i];
}

// Format bytes per second
export function formatRate(bps) {
  return Number.isFinite(bps) ? `${formatBytes(bps)}/s` : "n/a";
}

// Pick CSS color based on percentage
export function pctColorCss(p) {
  if (p < 70) return "var(--color-success)";
  if (p < 90) return "var(--color-warning)";
  return "var(--color-danger)";
}

// Update progress bar width and color
export function setBar(el, pct, colorCss) {
  if (!el) return;
  const v = clamp(Number(pct) || 0, 0, 100);
  el.style.width = v.toFixed(1) + "%";
  el.style.background = colorCss || pctColorCss(v);
}
