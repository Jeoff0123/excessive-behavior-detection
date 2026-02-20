const trackingToggle = document.getElementById("trackingToggle");
const debugToggle = document.getElementById("debugToggle");
const statusText = document.getElementById("statusText");
const modeSelect = document.getElementById("modeSelect");
const idleTimeoutSelect = document.getElementById("idleTimeoutSelect");
const domainText = document.getElementById("domainText");
const timeText = document.getElementById("timeText");
const stageText = document.getElementById("stageText");
const riskText = document.getElementById("riskText");
const cooldownText = document.getElementById("cooldownText");
const counterStatusText = document.getElementById("counterStatusText");
const debugActions = document.getElementById("debugActions");
const simulateBtn = document.getElementById("simulateBtn");
const endSessionBtn = document.getElementById("endSessionBtn");
const clearTodayBtn = document.getElementById("clearTodayBtn");
const exportBtn = document.getElementById("exportBtn");
const clearDataBtn = document.getElementById("clearDataBtn");

function hasExtensionRuntime() {
  return typeof chrome !== "undefined" && Boolean(chrome?.runtime?.id);
}

function setStatus(text, isError = false) {
  if (!statusText) {
    return;
  }
  statusText.textContent = text;
  statusText.style.color = isError ? "#9c2a17" : "#61584b";
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Number(totalSec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function formatCooldown(until) {
  const remainMs = Number(until) - Date.now();
  if (remainMs <= 0) {
    return "Inactive";
  }
  const totalSec = Math.ceil(remainMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s remaining`;
}

function formatCounterStatus(reason, isActive) {
  if (isActive) {
    return "Counting";
  }

  const map = {
    no_session: "Paused: no active session",
    tracking_disabled: "Paused: tracking is OFF",
    break_pause: "Paused: 5-minute break active",
    break_return_window_expired: "Paused: waiting for break auto-end",
    idle_timeout: "Paused: idle timeout reached",
    idle_5min: "Paused: idle for 5+ min",
    cooldown_active: "Paused: cooldown active",
    tab_inactive_or_invalid_url: "Paused: inactive tab or invalid URL",
    not_last_focused_tab: "Paused: tab/window not focused",
    domain_mismatch: "Paused: domain changed",
    tab_unavailable: "Paused: tab unavailable"
  };
  return map[reason] || "Paused";
}

async function send(type, payload = {}) {
  if (!hasExtensionRuntime()) {
    return { ok: false, error: "Extension context unavailable. Open this from the extension popup." };
  }
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    return { ok: false, error: error?.message || "Failed to contact background service worker." };
  }
}

async function refresh() {
  const res = await send("GET_POPUP_STATE");
  if (!res?.ok) {
    setStatus(res?.error || "Failed to load state.", true);
    return;
  }

  const { data } = res;
  trackingToggle.checked = Boolean(data.trackingEnabled);
  debugToggle.checked = Boolean(data.debugEnabled);
  if (modeSelect) {
    modeSelect.value = String(data.mode || "default");
  }
  if (idleTimeoutSelect) {
    idleTimeoutSelect.value = String(data.idleTimeoutMin || 5);
  }
  debugActions.classList.toggle("hidden", !data.debugEnabled);

  domainText.textContent = data.domain || "-";
  timeText.textContent = formatDuration(data.activeTimeSecToday);
  stageText.textContent = String(data.stage);
  riskText.textContent = data.riskLabel;
  cooldownText.textContent = data.cooldownActive ? formatCooldown(data.cooldownUntil) : "Inactive";
  counterStatusText.textContent = formatCounterStatus(data.countStatusReason, data.countStatusActive);
}

trackingToggle?.addEventListener("change", async () => {
  const res = await send("SET_TRACKING", { enabled: trackingToggle.checked });
  if (!res?.ok) {
    setStatus(res?.error || "Failed to change tracking.", true);
    return;
  }
  setStatus(`Tracking ${res.enabled ? "enabled" : "disabled"}.`);
  await refresh();
});

debugToggle?.addEventListener("change", async () => {
  const res = await send("SET_DEBUG", { enabled: debugToggle.checked });
  if (!res?.ok) {
    setStatus(res?.error || "Failed to change debug mode.", true);
    return;
  }
  setStatus(`Debug mode ${res.enabled ? "enabled" : "disabled"}.`);
  await refresh();
});

modeSelect?.addEventListener("change", async () => {
  const mode = String(modeSelect.value || "default");
  const res = await send("SET_MODE", { mode });
  if (!res?.ok) {
    setStatus(res?.error || "Failed to change mode.", true);
    return;
  }
  setStatus(`Mode set to ${res.modeLabel || res.mode}.`);
  await refresh();
});

idleTimeoutSelect?.addEventListener("change", async () => {
  const minutes = Number(idleTimeoutSelect.value || 5);
  const res = await send("SET_IDLE_TIMEOUT", { minutes });
  if (!res?.ok) {
    setStatus(res?.error || "Failed to set idle timeout.", true);
    return;
  }
  setStatus(`Idle timeout set to ${res.minutes} minutes.`);
  await refresh();
});

simulateBtn?.addEventListener("click", async () => {
  const res = await send("DEBUG_SIMULATE_10_MIN");
  if (!res?.ok) {
    setStatus(res?.error || "Failed debug simulation.", true);
    return;
  }
  setStatus(`DEBUG: Added 10 minutes to ${res.domain}.`);
  await refresh();
});

endSessionBtn?.addEventListener("click", async () => {
  const res = await send("DEBUG_END_SESSION");
  if (!res?.ok) {
    setStatus(res?.error || "Failed to end session.", true);
    return;
  }
  setStatus("DEBUG: Session ended.");
  await refresh();
});

clearTodayBtn?.addEventListener("click", async () => {
  const res = await send("DEBUG_CLEAR_TODAY_DOMAIN");
  if (!res?.ok) {
    setStatus(res?.error || "Failed to clear today total.", true);
    return;
  }
  setStatus(`DEBUG: Cleared today's total for ${res.domain}.`);
  await refresh();
});

exportBtn?.addEventListener("click", async () => {
  const res = await send("EXPORT_CSV");
  if (!res?.ok) {
    setStatus(res?.error || "Export failed.", true);
    return;
  }

  const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sessions_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("CSV exported.");
});

clearDataBtn?.addEventListener("click", async () => {
  const confirmed = confirm("Clear all extension data and cooldown rules?");
  if (!confirmed) {
    return;
  }

  const res = await send("CLEAR_DATA");
  if (!res?.ok) {
    setStatus(res?.error || "Failed to clear data.", true);
    return;
  }

  setStatus("All data cleared.");
  await refresh();
});

if (!hasExtensionRuntime()) {
  setStatus("Extension context unavailable. Open this from the browser extension popup.", true);
} else {
  refresh().catch((error) => setStatus(error?.message || "Failed to initialize popup.", true));
  setInterval(() => {
    refresh().catch(() => {
      // Keep popup responsive even when background state temporarily fails.
    });
  }, 1000);
}
