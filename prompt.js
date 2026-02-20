function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("sessionId");
}

function getSelected(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("saveBtn");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#9c2a17" : "#256d5a";
}

saveBtn.addEventListener("click", async () => {
  const sessionId = getSessionId();
  if (!sessionId) {
    setStatus("Missing sessionId in URL.", true);
    return;
  }

  const q1 = getSelected("q1") || "skip";
  const q2Raw = getSelected("q2") || "skip";
  const q2 = q2Raw === "skip" ? null : Number(q2Raw);

  const response = await chrome.runtime.sendMessage({
    type: "SAVE_PROMPT_ANSWERS",
    sessionId,
    q1LongerThanIntended: q1,
    q2HardToStop: q2
  });

  if (!response?.ok) {
    setStatus(response?.error || "Failed to save answers.", true);
    return;
  }

  setStatus("Saved. You can close this tab.");
});
