import { t } from "./i18n.js";

const LS = {
  LAST_SEEN_TAG: "stats_ui_update_last_seen_tag",
  LAST_AUTO_OPEN_DAY: "stats_ui_update_last_auto_open_day",
  LAST_AUTO_OPEN_TAG: "stats_ui_update_last_auto_open_tag",
};

// Returns "YYYY-MM-DD" for daily throttling.
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Coerces any value to a safe string.
function safeText(s) {
  return String(s ?? "");
}

// Shorthand querySelector with optional root.
function qs(sel, root = document) {
  return root.querySelector(sel);
}

// Creates a DOM element with attributes and children.
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = String(v);
    else if (k === "html") n.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      n.addEventListener(k.slice(2).toLowerCase(), v);
    } else n.setAttribute(k, String(v));
  }
  for (const c of children) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

// Normalizes version tags like "v1.2.3" -> "1.2.3".
function normalizeVersion(v) {
  const s = String(v || "").trim();
  const versionMatch = s.match(/(\d+\.\d+\.\d+)/);
  if (versionMatch) {
    return versionMatch[1];
  }
  return s.replace(/^v/i, "").replace(/^gharmonize\s*/i, "");
}

// Checks whether latestTag should be considered newer than current.
function versionLooksNewer(current, latestTag) {
  const a = normalizeVersion(current);
  const b = normalizeVersion(latestTag);

  if (!a) return false;
  if (!b) return false;
  if (a === b) return false;

  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  const semverish = pa.every(Number.isFinite) && pb.every(Number.isFinite);

  if (semverish) {
    const L = Math.max(pa.length, pb.length);
    for (let i = 0; i < L; i++) {
      const va = Number.isFinite(pa[i]) ? pa[i] : 0;
      const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
      if (vb > va) return true;
      if (vb < va) return false;
    }
    return false;
  }

  return a !== b;
}

// Fetches JSON with a simple AbortController timeout.
async function fetchJson(url, { timeoutMs = 6000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const tt = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
      headers: {
        Accept: "application/vnd.github+json",
        ...headers,
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(tt);
  }
}

// Renders Markdown via GitHub Markdown API into HTML (GFM + emojis + tables).
async function renderGitHubMarkdownToHtml(markdown, contextRepo, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const tt = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.github.com/markdown", {
      method: "POST",
      cache: "no-store",
      signal: ctrl.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: safeText(markdown || ""),
        mode: "gfm",
        context: safeText(contextRepo || ""),
      }),
    });

    if (!r.ok) throw new Error(`markdown HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(tt);
  }
}

// Very small HTML decode helper for Atom feed content which may be HTML-escaped.
function decodeHtmlEntities(s) {
  const t = safeText(s);
  if (!t) return "";
  const ta = document.createElement("textarea");
  ta.innerHTML = t;
  return ta.value;
}

function looksLikeHtml(s) {
  const t = safeText(s).trim();
  return t.startsWith("<") && t.includes(">");
}

// Ensures the update modal DOM exists and returns its root element.
function ensureModal() {
  let root = qs("#updateModalRoot");
  if (root) return root;

  root = el("div", { id: "updateModalRoot", class: "update-modal-root is-hidden" });
  root.appendChild(el("div", { class: "update-modal-backdrop", onClick: () => hideModal() }));

  const modal = el("div", { class: "update-modal", role: "dialog", "aria-modal": "true" });

  modal.appendChild(
    el("div", { class: "update-modal__head" }, [
      el("div", { class: "update-modal__title", id: "updateModalTitle" }, [""]),
      el(
        "button",
        {
          class: "update-modal__close btn",
          type: "button",
          "aria-label": t("update.modal.close_aria"),
          onClick: () => hideModal(),
        },
        ["✕"]
      ),
    ])
  );

  modal.appendChild(el("div", { class: "update-modal__meta mono", id: "updateModalMeta" }, ["—"]));
  modal.appendChild(el("div", { class: "update-modal__content", id: "updateModalContent" }, ["—"]));

  modal.appendChild(
    el("div", { class: "update-modal__foot" }, [
      el(
        "a",
        {
          class: "btn btn-primary",
          id: "updateModalLink",
          href: "#",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        [t("update.modal.open_github")]
      ),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: () => hideModal(),
        },
        [t("update.modal.close_btn")]
      ),
    ])
  );

  root.appendChild(modal);
  document.body.appendChild(root);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideModal();
  });

  return root;
}

// Shows the update modal.
function showModal() {
  const root = ensureModal();
  root.classList.remove("is-hidden");
  document.documentElement.classList.add("modal-open");
}

// Hides the update modal.
function hideModal() {
  const root = qs("#updateModalRoot");
  if (!root) return;
  root.classList.add("is-hidden");
  document.documentElement.classList.remove("modal-open");
}

// Updates modal UI bits (title/meta/body/link).
function setModalContent({ title, metaText, html, link }) {
  ensureModal();
  const tt = qs("#updateModalTitle");
  const m = qs("#updateModalMeta");
  const c = qs("#updateModalContent");
  const a = qs("#updateModalLink");

  if (tt) tt.textContent = title || "—";
  if (m) m.textContent = metaText || "—";
  if (c) c.innerHTML = html || "<p>—</p>";
  if (a) a.href = link || "#";
}

// Toggles the pulsing dot state for update availability.
function markDotHasUpdate(dotEl, on) {
  if (!dotEl) return;
  dotEl.classList.toggle("has-update", !!on);
  dotEl.setAttribute("data-update", on ? "1" : "0");
}

// Detects installed app version from DOM hints.
export function detectAppVersionFromDom() {
  const meta = document.querySelector('meta[name="app-version"]');
  const mv = meta?.getAttribute("content")?.trim();
  if (mv) return mv;

  const icon = document.querySelector('link[rel="icon"]');
  const href = icon?.getAttribute("href") || "";
  const m2 = href.match(/[?&]v=([^&]+)/i);
  if (m2?.[1]) return decodeURIComponent(m2[1]);

  return null;
}

// Initializes periodic GitHub release checks and wires the status dot + modal.
export function initUpdateChecker(opts = {}) {
  const {
    dotEl,
    repo = "G-grbz/argusSyS",
    currentVersion = detectAppVersionFromDom(),
    checkEveryMs = 30 * 60 * 1000,
    autoOpenDaily = false,
    quiet = true,
  } = opts;

  if (!dotEl) throw new Error("initUpdateChecker: dotEl required");
  if (!repo) throw new Error("initUpdateChecker: repo required");

  let lastRelease = null;
  let hasUpdate = false;

  async function checkOnce() {
    try {
      const rel = await fetchJson(`/api/update/latest`, { timeoutMs: 7000 });

      const tag = safeText(rel?.tag_name || "").trim();
      const name = safeText(rel?.name || tag || t("update.release.fallback_name")).trim();
      const body = safeText(rel?.body || "").trim();
      const bodyHtml = safeText(rel?.body_html || "").trim();
      const url = safeText(rel?.html_url || `https://github.com/${repo}/releases`).trim();
      const published = safeText(rel?.published_at || "").trim();

      lastRelease = { tag, name, body, url, published };

      const effectiveRepo = safeText(rel?.repo || repo).trim() || repo;
      const newer = versionLooksNewer(currentVersion, tag);
      hasUpdate = !!newer;
      markDotHasUpdate(dotEl, hasUpdate);

      const metaBits = [
        effectiveRepo,
        `${t("update.meta.latest")}: ${tag || "—"}`,
        `${t("update.meta.installed")}: ${currentVersion || "—"}`,
      ];
      if (published) {
        metaBits.push(
          `${t("update.meta.published")}: ${published.replace("T", " ").replace("Z", " UTC")}`
        );
      }
      const metaText = metaBits.join(" • ");

      if (hasUpdate) {
        let html = "";
        try {
          if (bodyHtml) {
            const decoded = decodeHtmlEntities(bodyHtml);
            html = looksLikeHtml(decoded) ? decoded : `<pre class="mono" style="white-space:pre-wrap">${safeText(decoded)}</pre>`;
          } else if (body) {
            html = await renderGitHubMarkdownToHtml(body, repo, { timeoutMs: 9000 });
          } else {
            html = `<p><strong>${safeText(name)}</strong></p>`;
          }
        } catch {
          const fallback = bodyHtml ? decodeHtmlEntities(bodyHtml) : safeText(body || name);
          html = `<pre class="mono" style="white-space:pre-wrap">${safeText(fallback)}</pre>`;
        }

        setModalContent({
          title: `${t("update.modal.title_available")} — ${tag || name}`,
          metaText,
          html,
          link: url,
        });

        if (autoOpenDaily) {
          const day = todayKey();
          const lastDay = localStorage.getItem(LS.LAST_AUTO_OPEN_DAY) || "";
          const lastTag = localStorage.getItem(LS.LAST_AUTO_OPEN_TAG) || "";
          const should = day !== lastDay || (tag && tag !== lastTag);

          if (should) {
            localStorage.setItem(LS.LAST_AUTO_OPEN_DAY, day);
            if (tag) localStorage.setItem(LS.LAST_AUTO_OPEN_TAG, tag);
            showModal();
          }
        }
      } else {
        setModalContent({
          title: t("update.modal.title_none"),
          metaText: `${repo} • ${t("update.meta.installed")}: ${currentVersion || "—"}`,
          html: `<p>${t("update.modal.no_newer_release")}</p>`,
          link: `https://github.com/${repo}/releases`,
        });
      }

      if (tag) localStorage.setItem(LS.LAST_SEEN_TAG, tag);
    } catch (e) {
      if (!quiet) console.warn("update check failed:", e);
    }
  }

  dotEl.addEventListener("click", (e) => {
    showModal();
    e.preventDefault?.();
    e.stopPropagation?.();
  });

  checkOnce();
  const timer = setInterval(checkOnce, Math.max(10_000, Number(checkEveryMs) || 1800000));

  return {
    stop() {
      clearInterval(timer);
    },
    checkNow: checkOnce,
    getState() {
      return { repo, currentVersion, hasUpdate, lastRelease };
    },
  };
}

// Re-apply i18n strings to modal UI using current language (t()).

export function updateUpdateModalI18n(handle) {
  try {
    const root = document.querySelector("#updateModalRoot");
    if (!root) return;
    const titleEl = root.querySelector("#updateModalTitle");
    const closeBtn = root.querySelector(".update-modal__close");
    const linkEl = root.querySelector("#updateModalLink");
    const closeBtn2 = root.querySelector(".update-modal__foot button.btn");

    if (closeBtn) closeBtn.setAttribute("aria-label", t("update.modal.close_aria"));
    if (linkEl) linkEl.textContent = t("update.modal.open_github");
    if (closeBtn2) closeBtn2.textContent = t("update.modal.close_btn");

    const st = handle?.getState?.();
    if (!st) {
      if (titleEl && !titleEl.textContent.trim()) titleEl.textContent = t("update.modal.title_available");
      return;
    }

    const { repo, currentVersion, hasUpdate, lastRelease } = st;

    let metaText = `${repo} • ${t("update.meta.installed")}: ${currentVersion || "—"}`;

    if (hasUpdate && lastRelease) {
      const { tag, published } = lastRelease;
      const bits = [
        repo,
        `${t("update.meta.latest")}: ${tag || "—"}`,
        `${t("update.meta.installed")}: ${currentVersion || "—"}`,
      ];
      if (published) {
        bits.push(`${t("update.meta.published")}: ${published.replace("T", " ").replace("Z", " UTC")}`);
      }
      metaText = bits.join(" • ");

      if (titleEl) {
        titleEl.textContent = `${t("update.modal.title_available")} — ${tag || lastRelease.name || "—"}`;
      }
    } else {
      if (titleEl) titleEl.textContent = t("update.modal.title_none");
    }

    const metaEl = root.querySelector("#updateModalMeta");
    if (metaEl) metaEl.textContent = metaText;
  } catch {}
}

