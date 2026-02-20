export const STORAGE_KEYS = {
  trackingEnabled: "trackingEnabled",
  debugEnabled: "debugEnabled",
  sessions: "sessions",
  domainTotals: "domainTotals",
  visitedDomainsToday: "visitedDomainsToday",
  cooldowns: "cooldowns",
  snoozes: "snoozes",
  lastResetDate: "lastResetDate",
  currentSessionState: "currentSessionState",
  stageNotified: "stageNotified"
};

export function localDateKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(timestamp - offset).toISOString().slice(0, 10);
}

export function getDefaultState() {
  return {
    trackingEnabled: true,
    debugEnabled: false,
    sessions: [],
    domainTotals: {},
    visitedDomainsToday: { dateKey: localDateKey(), domains: {} },
    cooldowns: {},
    snoozes: {},
    lastResetDate: localDateKey(),
    currentSessionState: null,
    stageNotified: {}
  };
}

export async function getState() {
  const defaults = getDefaultState();
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    trackingEnabled:
      typeof stored[STORAGE_KEYS.trackingEnabled] === "boolean"
        ? stored[STORAGE_KEYS.trackingEnabled]
        : defaults.trackingEnabled,
    debugEnabled:
      typeof stored[STORAGE_KEYS.debugEnabled] === "boolean"
        ? stored[STORAGE_KEYS.debugEnabled]
        : defaults.debugEnabled,
    sessions: Array.isArray(stored[STORAGE_KEYS.sessions]) ? stored[STORAGE_KEYS.sessions] : defaults.sessions,
    domainTotals:
      stored[STORAGE_KEYS.domainTotals] && typeof stored[STORAGE_KEYS.domainTotals] === "object"
        ? stored[STORAGE_KEYS.domainTotals]
        : defaults.domainTotals,
    visitedDomainsToday:
      stored[STORAGE_KEYS.visitedDomainsToday] &&
      typeof stored[STORAGE_KEYS.visitedDomainsToday] === "object"
        ? stored[STORAGE_KEYS.visitedDomainsToday]
        : defaults.visitedDomainsToday,
    cooldowns:
      stored[STORAGE_KEYS.cooldowns] && typeof stored[STORAGE_KEYS.cooldowns] === "object"
        ? stored[STORAGE_KEYS.cooldowns]
        : defaults.cooldowns,
    snoozes:
      stored[STORAGE_KEYS.snoozes] && typeof stored[STORAGE_KEYS.snoozes] === "object"
        ? stored[STORAGE_KEYS.snoozes]
        : defaults.snoozes,
    lastResetDate:
      typeof stored[STORAGE_KEYS.lastResetDate] === "string"
        ? stored[STORAGE_KEYS.lastResetDate]
        : defaults.lastResetDate,
    currentSessionState:
      stored[STORAGE_KEYS.currentSessionState] &&
      typeof stored[STORAGE_KEYS.currentSessionState] === "object"
        ? stored[STORAGE_KEYS.currentSessionState]
        : defaults.currentSessionState,
    stageNotified:
      stored[STORAGE_KEYS.stageNotified] && typeof stored[STORAGE_KEYS.stageNotified] === "object"
        ? stored[STORAGE_KEYS.stageNotified]
        : defaults.stageNotified
  };
}

export async function patchState(patch) {
  await chrome.storage.local.set(patch);
}

export function ensureDailyState(state) {
  const today = localDateKey();
  if (state.lastResetDate === today) {
    if (state.visitedDomainsToday?.dateKey !== today) {
      state.visitedDomainsToday = { dateKey: today, domains: {} };
    }
    return false;
  }

  state.domainTotals = {};
  state.visitedDomainsToday = { dateKey: today, domains: {} };
  state.stageNotified = {};
  state.lastResetDate = today;
  return true;
}

export function ensureDomainTotalRecord(state, domain) {
  const today = localDateKey();
  const rec = state.domainTotals[domain];
  if (!rec || rec.dateKey !== today) {
    state.domainTotals[domain] = { dateKey: today, activeTimeSecToday: 0 };
  }
  return state.domainTotals[domain];
}

export function getTodayDomainSec(state, domain) {
  const rec = ensureDomainTotalRecord(state, domain);
  return Number(rec.activeTimeSecToday || 0);
}
