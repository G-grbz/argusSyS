import { KEYS, lsGet, lsSet } from "./storage.js";
import { $ } from "./dom.js";

// Keep logo image in sync with current theme
export function syncLogoToTheme() {
  const img = document.querySelector(".logo-img");
  if (!img) return;

  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  const darkSrc = img.getAttribute("data-logo-dark");
  const lightSrc = img.getAttribute("data-logo-light");
  if (!darkSrc || !lightSrc) return;

  const next = theme === "light" ? lightSrc : darkSrc;
  if (img.getAttribute("src") !== next) {
    img.setAttribute("src", next);
  }
}

// Apply theme and optionally persist it
export function applyTheme(theme, notifyHeight, opts = {}) {
  const { persist = true } = opts;

  const tmode = theme === "light" || theme === "dark" ? theme : null;
  if (!tmode) return;

  const root = document.documentElement;
  root.classList.add("theme-switching");
  clearTimeout(root._themeSwitchTmo);
  root._themeSwitchTmo = setTimeout(() => root.classList.remove("theme-switching"), 220);

  root.setAttribute("data-theme", tmode);

  if (persist) lsSet(KEYS.THEME_KEY, tmode);

  syncLogoToTheme();
  setTimeout(() => notifyHeight?.(), 30);
}

// Initialize theme from saved preference and wire up toggle button
export function initTheme(notifyHeight) {
  const themeToggle = $("themeToggle");

  const savedTheme = lsGet(KEYS.THEME_KEY, "dark") || "dark";

  document.documentElement.setAttribute("data-theme", savedTheme);
  syncLogoToTheme();

  const sunSvg =
    '<svg width="16" height="16" fill="currentColor"><path d="M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z"/></svg>';

  const moonSvg =
    '<svg width="16" height="16" fill="currentColor"><path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/></svg>';

  if (themeToggle) {
    themeToggle.innerHTML = savedTheme === "dark" ? sunSvg : moonSvg;

    themeToggle.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const newTheme = currentTheme === "dark" ? "light" : "dark";

      applyTheme(newTheme, notifyHeight, { persist: true });

      themeToggle.innerHTML = newTheme === "dark" ? sunSvg : moonSvg;
    });
  }
}

// Sync theme from parent when running in embed mode
export function initThemeSync(notifyHeight) {
  if (!document.documentElement.hasAttribute("data-embed")) return;

  window.addEventListener("message", (ev) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== "object") return;

    if (
      msg.type === "hp:theme" &&
      (msg.theme === "dark" || msg.theme === "light")
    ) {
      applyTheme(msg.theme, notifyHeight, { persist: false });
    }
  });
}
