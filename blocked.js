function parseParams() {
  const search = new URLSearchParams(window.location.search);
  return {
    mode: search.get("mode") || "cooldown",
    stage: Number(search.get("stage") || 0),
    site: search.get("site") || search.get("domain") || "unknown",
    until: Number(search.get("until") || 0),
    returnUrl: search.get("returnUrl") || null,
    sourceTabId: Number(search.get("sourceTabId") || 0)
  };
}

function setStatus(message, isError = false) {
  const el = document.getElementById("actionStatus");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.style.color = isError ? "#9c2a17" : "#256d5a";
}

function isAllowedReturnUrl(candidateUrl, site) {
  try {
    const parsed = new URL(candidateUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const cleanSite = String(site || "").toLowerCase();
    return host === cleanSite || host.endsWith(`.${cleanSite}`);
  } catch (_error) {
    return false;
  }
}

function formatRemaining(ms) {
  if (ms <= 0) {
    return "Cooldown finished. Redirecting...";
  }
  const sec = Math.ceil(ms / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `Try again in ${min}m ${rem}s`;
}

async function closeCurrentTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) {
    await chrome.tabs.remove(tab.id);
  }
}

async function sendStage2Action(action, domain, sourceTabId) {
  const response = await chrome.runtime.sendMessage({
    type: "STAGE2_NUDGE_ACTION",
    action,
    domain,
    sourceTabId
  });

  if (!response?.ok) {
    setStatus(response?.error || "Action failed.", true);
    return;
  }

  setStatus(response.message || "Action completed.");
  await closeCurrentTab();
}

function renderStage2Nudge(site, sourceTabId) {
  const titleText = document.getElementById("titleText");
  const messageText = document.getElementById("messageText");
  const remaining = document.getElementById("remaining");
  const nudgeActions = document.getElementById("nudgeActions");
  const takeBreakBtn = document.getElementById("takeBreakBtn");
  const snoozeBtn = document.getElementById("snoozeBtn");
  const closeTabBtn = document.getElementById("closeTabBtn");

  titleText.textContent = "Take a Break";
  messageText.textContent = "You\'ve been browsing for a while. What would you like to do now?";
  remaining.textContent = "";
  nudgeActions.classList.remove("hidden");

  takeBreakBtn.addEventListener("click", () => {
    sendStage2Action("break_5", site, sourceTabId).catch((error) => {
      setStatus(error?.message || "Action failed.", true);
    });
  });

  snoozeBtn.addEventListener("click", () => {
    sendStage2Action("snooze", site, sourceTabId).catch((error) => {
      setStatus(error?.message || "Action failed.", true);
    });
  });

  closeTabBtn.addEventListener("click", () => {
    sendStage2Action("close_tab", site, sourceTabId).catch((error) => {
      setStatus(error?.message || "Action failed.", true);
    });
  });
}

function renderCooldown(site, until, returnUrl) {
  const titleText = document.getElementById("titleText");
  const messageText = document.getElementById("messageText");
  const remainingEl = document.getElementById("remaining");

  titleText.textContent = "Cooldown Active";
  messageText.textContent = "This domain is temporarily blocked to interrupt excessive browsing.";

  const fallbackUrl = `https://${site}`;
  const safeReturnUrl = isAllowedReturnUrl(returnUrl, site) ? returnUrl : fallbackUrl;

  if (!Number.isFinite(until) || until <= 0) {
    remainingEl.textContent = "No cooldown timestamp found. Redirecting...";
    window.location.href = safeReturnUrl;
    return;
  }

  let redirected = false;
  const timer = setInterval(() => {
    const left = until - Date.now();
    remainingEl.textContent = formatRemaining(left);
    if (left <= 0 && !redirected) {
      redirected = true;
      clearInterval(timer);
      window.location.href = safeReturnUrl;
    }
  }, 1000);
}

function render() {
  const { mode, stage, site, until, returnUrl, sourceTabId } = parseParams();
  const siteEl = document.getElementById("site");
  siteEl.textContent = site;

  if (mode === "stage_nudge" && stage === 2) {
    renderStage2Nudge(site, sourceTabId);
    return;
  }

  renderCooldown(site, until, returnUrl);
}

render();
