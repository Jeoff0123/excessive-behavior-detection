const THROTTLE_MS = 5000;
let lastSent = 0;

function sendActivity(activityType) {
  const now = Date.now();
  if (now - lastSent < THROTTLE_MS) {
    return;
  }
  lastSent = now;
  if (!chrome?.runtime?.id) {
    return;
  }

  try {
    const maybePromise = chrome.runtime.sendMessage({ type: "ACTIVITY_PING", activityType });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {
        // Service worker may be asleep or extension may be reloading.
      });
    }
  } catch (_error) {
    // Extension context can be invalidated during reload/update.
  }
}

window.addEventListener("scroll", () => sendActivity("scroll"), { passive: true });
window.addEventListener("click", () => sendActivity("click"), { passive: true });
window.addEventListener("keydown", () => sendActivity("keydown"), { passive: true });
window.addEventListener("focus", () => sendActivity("focus"), { passive: true });
