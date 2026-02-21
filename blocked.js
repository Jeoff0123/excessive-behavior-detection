function parseParams() {
  const search = new URLSearchParams(window.location.search);
  return {
    mode: search.get("mode") || "cooldown",
    stage: Number(search.get("stage") || 0),
    site: search.get("site") || search.get("domain") || "unknown",
    until: Number(search.get("until") || 0),
    returnUrl: search.get("returnUrl") || null,
    sourceTabId: Number(search.get("sourceTabId") || 0),
    riskMode: search.get("riskMode") || "default",
    promptTone: search.get("promptTone") || "balanced"
  };
}

function setStatus(message, tone = "success") {
  const el = document.getElementById("actionStatus");
  if (!el) {
    return;
  }
  const colorByTone = {
    success: "#256d5a",
    info: "#5f584f",
    error: "#9c2a17"
  };
  el.textContent = message;
  el.style.color = colorByTone[tone] || colorByTone.info;
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

async function sendStage2Action(action, domain, sourceTabId, options = {}) {
  const closeOnSuccess = options.closeOnSuccess !== false;
  const closeWhenResult =
    typeof options.closeWhenResult === "function" ? options.closeWhenResult : null;
  const closeDelayMs = Math.max(0, Number(options.closeDelayMs || 0));
  const response = await chrome.runtime.sendMessage({
    type: "STAGE2_NUDGE_ACTION",
    action,
    domain,
    sourceTabId
  });

  if (!response?.ok) {
    setStatus(response?.error || "Action failed.", "error");
    return response;
  }

  const result = response.result || (response.actionFailed ? "noop" : "success");
  const tone =
    result === "noop" || (result === "success" && response.navigationTarget === "none")
      ? "info"
      : "success";
  setStatus(response.message || "Action completed.", tone);

  if (closeOnSuccess && result === "success" && !response.actionFailed) {
    const shouldClose = closeWhenResult ? Boolean(closeWhenResult(response)) : true;
    if (!shouldClose) {
      return response;
    }
    try {
      if (closeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
      }
      await closeCurrentTab();
    } catch (_error) {
      // Keep the nudge page open if the tab cannot be closed.
    }
  }

  return response;
}

function getModeLabel(riskMode) {
  const labels = {
    default: "Default",
    study_research: "Study-Research",
    entertainment: "Entertainment"
  };
  return labels[riskMode] || labels.default;
}

function renderStage2Nudge(site, sourceTabId, promptTone, riskMode) {
  const titleText = document.getElementById("titleText");
  const messageText = document.getElementById("messageText");
  const remaining = document.getElementById("remaining");
  const nudgeActions = document.getElementById("nudgeActions");
  const takeBreakBtn = document.getElementById("takeBreakBtn");
  const snoozeBtn = document.getElementById("snoozeBtn");
  const closeTabBtn = document.getElementById("closeTabBtn");

  const tone = String(promptTone || "balanced");
  const modeLabel = getModeLabel(riskMode);
  if (tone === "break_focused") {
    titleText.textContent = "Take a Short Reset";
    messageText.textContent = `Mode: ${modeLabel}. Pause for 5 minutes, then continue with intention.`;
  } else if (tone === "stop_focused") {
    titleText.textContent = "Pause or Stop This Session";
    messageText.textContent = `Mode: ${modeLabel}. This session is escalating. Consider closing this tab.`;
  } else {
    titleText.textContent = "Take a Break";
    messageText.textContent = "You've been browsing for a while. What would you like to do now?";
  }
  remaining.textContent = "";
  nudgeActions.classList.remove("hidden");

  const buttons = [takeBreakBtn, snoozeBtn, closeTabBtn];
  const setButtonsDisabled = (disabled) => {
    for (const btn of buttons) {
      if (btn) {
        btn.disabled = disabled;
      }
    }
  };

  async function runAction(action, options = {}) {
    setButtonsDisabled(true);
    try {
      const response = await sendStage2Action(action, site, sourceTabId, {
        closeOnSuccess: options.closeOnSuccess
      });
      const result = response?.result || (response?.actionFailed ? "noop" : "success");

      if (!response?.ok || result === "noop") {
        setButtonsDisabled(false);
        return;
      }

      if (!options.lockOnSuccess) {
        setButtonsDisabled(false);
      }
    } catch (error) {
      setStatus(error?.message || "Action failed.", "error");
      setButtonsDisabled(false);
    }
  }

  takeBreakBtn.addEventListener("click", () => {
    runAction("break_5", { closeOnSuccess: false, lockOnSuccess: true }).catch(() => {
      // handled in runAction
    });
  });

  snoozeBtn.addEventListener("click", () => {
    runAction("snooze", {
      closeOnSuccess: true,
      lockOnSuccess: false,
      closeDelayMs: 250,
      closeWhenResult: (response) => response?.navigationTarget !== "none"
    }).catch(() => {
      // handled in runAction
    });
  });

  closeTabBtn.addEventListener("click", () => {
    runAction("close_tab", { closeOnSuccess: true, lockOnSuccess: false }).catch(() => {
      // handled in runAction
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
  const { mode, stage, site, until, returnUrl, sourceTabId, promptTone, riskMode } = parseParams();
  const siteEl = document.getElementById("site");
  siteEl.textContent = site;

  if (mode === "stage_nudge" && stage === 2) {
    renderStage2Nudge(site, sourceTabId, promptTone, riskMode);
    return;
  }

  renderCooldown(site, until, returnUrl);
}

render();
