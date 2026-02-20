import {
  STORAGE_KEYS,
  localDateKey,
  getState,
  patchState,
  ensureDailyState,
  ensureDomainTotalRecord,
  getTodayDomainSec
} from "./storage.js";
import {
  MEDIUM,
  getStage,
  getRiskLevel,
  formatRiskLabel,
  sanitizeMode,
  getModeConfig,
  RULE_VERSION
} from "./rules.js";
import { exportSessionsCsv } from "./export.js";

const ALARM_TICK = "tick_30s";
const TICK_INTERVAL_MIN = 0.5;
const DEFAULT_IDLE_TIMEOUT_MIN = 5;
const IDLE_TIMEOUT_OPTIONS_MIN = [3, 5, 10];
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;
const ICON_FILE = "icon.png";
const SNOOZE_MINUTES = 10;
const SNOOZE_LIMIT_PER_HOUR = 3;
const SNOOZE_WINDOW_MS = 60 * 60 * 1000;
const BREAK_RETURN_WINDOW_MS = 10 * 60 * 1000;
const SESSION_SCHEMA_VERSION = 3;
const END_REASON_IDLE = "idle_timeout";
const BADGE_OFF_COLOR = "#6b7280";
const BADGE_COLOR_BY_STAGE = {
  0: "#64748b",
  1: "#16a34a",
  2: "#d97706",
  3: "#dc2626",
  4: "#7e22ce"
};

let currentSession = null;
const endingSessionIds = new Set();

function isTrackableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function getDomain(url) {
  if (!isTrackableUrl(url)) {
    return null;
  }
  const host = new URL(url).hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

function getTrackableOrigin(url) {
  if (!isTrackableUrl(url)) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}`;
  } catch (_error) {
    return null;
  }
}

function getActiveMode(state) {
  return sanitizeMode(state?.mode);
}

function makeSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sanitizeIdleTimeoutMin(value) {
  const asNumber = Number(value);
  if (IDLE_TIMEOUT_OPTIONS_MIN.includes(asNumber)) {
    return asNumber;
  }
  return DEFAULT_IDLE_TIMEOUT_MIN;
}

function getIdleTimeoutMs(state) {
  return sanitizeIdleTimeoutMin(state?.idleTimeoutMin) * 60 * 1000;
}

function formatMsToMinSec(ms) {
  const totalSec = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function normalize(value, cap) {
  const n = Number(value || 0);
  if (n <= 0) {
    return 0;
  }
  return Math.min(1, n / cap);
}

function computeProvisional(activeTimeSec, scrollCount, tabSwitchCount, revisitCount, mode) {
  const multiplier = Number(getModeConfig(mode).multiplier || 1);
  const time = normalize(activeTimeSec, Math.max(1, Math.round(1800 * multiplier)));
  const scroll = normalize(scrollCount, Math.max(1, Math.round(200 * multiplier)));
  const switches = normalize(tabSwitchCount, Math.max(1, Math.round(20 * multiplier)));
  const revisit = normalize(revisitCount, Math.max(1, Math.round(10 * multiplier)));
  const score = 0.4 * time + 0.2 * scroll + 0.2 * switches + 0.2 * revisit;

  let label = 2;
  if (score < 0.33) {
    label = 0;
  } else if (score < 0.66) {
    label = 1;
  }

  return {
    provisionalLabel: label,
    provisionalScore: Number(score.toFixed(4))
  };
}

function computeHybridFinal(provisionalLabel, q1LongerThanIntended, q2HardToStop) {
  const q1Score =
    q1LongerThanIntended === "yes" ? 1 : q1LongerThanIntended === "no" ? 0 : null;

  const q2Score =
    typeof q2HardToStop === "number" && Number.isFinite(q2HardToStop)
      ? Math.max(0, Math.min(1, (q2HardToStop - 1) / 4))
      : null;

  const available = [q1Score, q2Score].filter((v) => v !== null);
  if (!available.length) {
    return { finalLabel: provisionalLabel, labelSource: "hybrid_skipped" };
  }

  const userScore = available.reduce((a, b) => a + b, 0) / available.length;
  let finalLabel = provisionalLabel;

  if (provisionalLabel === 1 && userScore >= 0.75) {
    finalLabel = 2;
  } else if (provisionalLabel === 2 && userScore <= 0.25) {
    finalLabel = 1;
  } else if (provisionalLabel === 1 && userScore <= 0.25) {
    finalLabel = 0;
  }

  return {
    finalLabel,
    labelSource: finalLabel === provisionalLabel ? "hybrid_confirmed" : "hybrid_adjusted"
  };
}

function normalizeVisitCount(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) {
    return Math.floor(n);
  }
  return value ? 1 : 0;
}

function shouldShowEndSessionQuestions(state, endReason, riskLevel, provisionalLabel) {
  const endedNaturally =
    endReason === "tab_closed" || endReason === END_REASON_IDLE || endReason === "idle_5min";
  const mediumOrHigher = riskLevel >= MEDIUM || provisionalLabel >= MEDIUM;
  return Boolean(state.trackingEnabled && endedNaturally && mediumOrHigher);
}

function matchBlockedDomain(targetDomain, blockedDomain) {
  return targetDomain === blockedDomain || targetDomain.endsWith(`.${blockedDomain}`);
}

function findActiveBlockForDomain(cooldowns, domain, now = Date.now()) {
  let matched = null;
  for (const [blockedDomain, untilRaw] of Object.entries(cooldowns)) {
    const until = Number(untilRaw || 0);
    if (until <= now) {
      continue;
    }
    if (matchBlockedDomain(domain, blockedDomain)) {
      if (!matched || until > matched.blockedUntil) {
        matched = { blockedDomain, blockedUntil: until };
      }
    }
  }
  return matched;
}

async function blockSite(domain, durationMs = DEFAULT_COOLDOWN_MS) {
  const untilEpochMs = Date.now() + durationMs;
  const state = await getState();
  ensureDailyState(state);
  state.cooldowns[domain] = untilEpochMs;
  await patchState({
    [STORAGE_KEYS.cooldowns]: state.cooldowns,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate
  });
  return untilEpochMs;
}

async function clearDomainCooldown(domain) {
  const state = await getState();
  ensureDailyState(state);
  if (!state.cooldowns[domain]) {
    return;
  }
  delete state.cooldowns[domain];
  await patchState({
    [STORAGE_KEYS.cooldowns]: state.cooldowns,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate
  });
}

async function setSnooze(domain, minutes) {
  const state = await getState();
  ensureDailyState(state);
  const until = Date.now() + minutes * 60 * 1000;
  state.snoozes[domain] = until;
  await patchState({
    [STORAGE_KEYS.snoozes]: state.snoozes,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate
  });
  return until;
}

async function applySnoozeWithCap(domain, minutes) {
  const state = await getState();
  ensureDailyState(state);
  const now = Date.now();
  const cutoff = now - SNOOZE_WINDOW_MS;
  const existing = Array.isArray(state.snoozeHistory?.[domain]) ? state.snoozeHistory[domain] : [];
  const recent = existing
    .map((value) => Number(value || 0))
    .filter((ts) => Number.isFinite(ts) && ts > cutoff && ts <= now + 1000)
    .sort((a, b) => a - b);

  if (recent.length >= SNOOZE_LIMIT_PER_HOUR) {
    state.snoozeHistory[domain] = recent;
    await patchState({
      [STORAGE_KEYS.snoozeHistory]: state.snoozeHistory,
      [STORAGE_KEYS.lastResetDate]: state.lastResetDate
    });
    const waitMs = Math.max(0, recent[0] + SNOOZE_WINDOW_MS - now);
    return {
      allowed: false,
      count: recent.length,
      waitMs
    };
  }

  recent.push(now);
  state.snoozeHistory[domain] = recent;
  const until = now + minutes * 60 * 1000;
  state.snoozes[domain] = until;
  await patchState({
    [STORAGE_KEYS.snoozes]: state.snoozes,
    [STORAGE_KEYS.snoozeHistory]: state.snoozeHistory,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate
  });

  return {
    allowed: true,
    until,
    count: recent.length
  };
}

function isSnoozed(state, domain, now = Date.now()) {
  return Number(state.snoozes?.[domain] || 0) > now;
}

async function clearExpiredState(now = Date.now()) {
  const state = await getState();
  const didReset = ensureDailyState(state);
  let changedCooldowns = false;
  let changedSnoozes = false;
  let changedSnoozeHistory = false;

  for (const [domain, untilRaw] of Object.entries(state.cooldowns)) {
    if (Number(untilRaw || 0) <= now) {
      delete state.cooldowns[domain];
      changedCooldowns = true;
    }
  }

  for (const [domain, untilRaw] of Object.entries(state.snoozes || {})) {
    if (Number(untilRaw || 0) <= now) {
      delete state.snoozes[domain];
      changedSnoozes = true;
    }
  }

  for (const [domain, rawList] of Object.entries(state.snoozeHistory || {})) {
    const original = Array.isArray(rawList) ? rawList : [];
    const filtered = original
      .map((value) => Number(value || 0))
      .filter((ts) => Number.isFinite(ts) && ts > now - SNOOZE_WINDOW_MS);

    if (!filtered.length) {
      if (original.length > 0 || state.snoozeHistory[domain]) {
        delete state.snoozeHistory[domain];
        changedSnoozeHistory = true;
      }
      continue;
    }

    const changed =
      filtered.length !== original.length ||
      filtered.some((value, index) => Number(original[index] || 0) !== value);
    if (changed) {
      state.snoozeHistory[domain] = filtered;
      changedSnoozeHistory = true;
    }
  }

  const patch = {};
  if (changedCooldowns) {
    patch[STORAGE_KEYS.cooldowns] = state.cooldowns;
  }
  if (changedSnoozes) {
    patch[STORAGE_KEYS.snoozes] = state.snoozes;
  }
  if (changedSnoozeHistory) {
    patch[STORAGE_KEYS.snoozeHistory] = state.snoozeHistory;
  }
  if (didReset) {
    patch[STORAGE_KEYS.lastResetDate] = state.lastResetDate;
    patch[STORAGE_KEYS.domainTotals] = state.domainTotals;
    patch[STORAGE_KEYS.visitedDomainsToday] = state.visitedDomainsToday;
    patch[STORAGE_KEYS.stageNotified] = state.stageNotified;
  }
  if (Object.keys(patch).length) {
    await patchState(patch);
  }
}

async function handleTabUpdate(tabId, url) {
  if (!isTrackableUrl(url)) {
    return false;
  }
  const domain = getDomain(url);
  if (!domain) {
    return false;
  }

  const state = await getState();
  ensureDailyState(state);
  if (!state.trackingEnabled) {
    return false;
  }
  const matched = findActiveBlockForDomain(state.cooldowns, domain, Date.now());
  if (!matched) {
    return false;
  }

  const blockedPrefix = chrome.runtime.getURL("blocked.html");
  if (url.startsWith(blockedPrefix)) {
    return false;
  }

  const redirectUrl = chrome.runtime.getURL(
    `blocked.html?mode=cooldown&domain=${encodeURIComponent(matched.blockedDomain)}&site=${encodeURIComponent(matched.blockedDomain)}&until=${encodeURIComponent(String(matched.blockedUntil))}`
  );
  await chrome.tabs.update(tabId, { url: redirectUrl });
  return true;
}

async function enforceBlockOnActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    return false;
  }
  return handleTabUpdate(tab.id, tab.url);
}

async function sendStageNotification(domain, stage, mode) {
  const tone = getModeConfig(mode).promptTone;
  const stage2ByTone = {
    balanced: `You've spent extended time on ${domain}. Consider a short break.`,
    break_focused: `You're in Study-Research mode. A short break can help you reset and continue.`,
    stop_focused: `You're in Entertainment mode. Consider stopping this tab or taking a break now.`
  };
  const titleByStage = {
    1: "Stage 1: Gentle reminder",
    2: "Stage 2: Take a break",
    3: "Stage 3: Cooldown started"
  };

  const messageByStage = {
    1: `${domain} usage is increasing.`,
    2: stage2ByTone[tone] || stage2ByTone.balanced,
    3: `${domain} entered cooldown.`
  };

  try {
    await chrome.notifications.create(`stage_${stage}_${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL(ICON_FILE),
      title: titleByStage[stage] || "Browsing warning",
      message: messageByStage[stage] || `${domain} usage increased.`
    });
  } catch (error) {
    console.error("Notification failed", error);
  }
}

async function openStage2Nudge(domain, tabId, mode) {
  const safeMode = sanitizeMode(mode);
  const promptTone = getModeConfig(safeMode).promptTone;
  const url = chrome.runtime.getURL(
    `blocked.html?mode=stage_nudge&stage=2&domain=${encodeURIComponent(domain)}&site=${encodeURIComponent(domain)}&sourceTabId=${encodeURIComponent(String(tabId || 0))}&riskMode=${encodeURIComponent(safeMode)}&promptTone=${encodeURIComponent(promptTone)}`
  );
  await chrome.tabs.create({ url });
}

function stageNotifyKey(domain, stage, dateKey) {
  return `${dateKey}|${domain}|${stage}`;
}

async function maybeTriggerStageInterventions(state, domain, previousStage, nextStage, mode) {
  if (!state.trackingEnabled) {
    return;
  }

  const dateKey = localDateKey();
  let changed = false;

  if (previousStage < 1 && nextStage >= 1) {
    const key = stageNotifyKey(domain, 1, dateKey);
    if (!state.stageNotified[key]) {
      await sendStageNotification(domain, 1, mode);
      state.stageNotified[key] = true;
      changed = true;
    }
  }

  if (previousStage < 2 && nextStage >= 2) {
    const key = stageNotifyKey(domain, 2, dateKey);
    if (!state.stageNotified[key]) {
      await sendStageNotification(domain, 2, mode);
      state.stageNotified[key] = true;
      changed = true;
    }
  }

  if (previousStage < 3 && nextStage >= 3) {
    const activeCooldown = Number(state.cooldowns[domain] || 0) > Date.now();
    if (!activeCooldown) {
      state.cooldowns[domain] = await blockSite(domain, DEFAULT_COOLDOWN_MS);
      await enforceBlockOnActiveTab();
      await sendStageNotification(domain, 3, mode);
      changed = true;
    }
  }

  if (previousStage < 4 && nextStage >= 4) {
    const activeCooldown = Number(state.cooldowns[domain] || 0) > Date.now();
    if (!activeCooldown) {
      state.cooldowns[domain] = await blockSite(domain, DEFAULT_COOLDOWN_MS);
      await enforceBlockOnActiveTab();
      changed = true;
    }
  }

  // Keep Stage 2 nudge isolated from Stage 3/4 cooldown escalation.
  if (nextStage === 2) {
    const sessionCanShow = Boolean(currentSession) && !currentSession.stage2PromptShown;
    const cooldownActive = Number(state.cooldowns[domain] || 0) > Date.now();
    if (sessionCanShow && !cooldownActive && !isSnoozed(state, domain)) {
      currentSession.stage2PromptShown = true;
      await persistCurrentSession();
      await openStage2Nudge(domain, currentSession.tabId, mode);
    }
  }

  if (changed) {
    await patchState({
      [STORAGE_KEYS.stageNotified]: state.stageNotified,
      [STORAGE_KEYS.cooldowns]: state.cooldowns
    });
  }
}

async function persistCurrentSession() {
  await patchState({ [STORAGE_KEYS.currentSessionState]: currentSession });
}

async function startSessionFromTab(tab) {
  if (!tab || !tab.id || !isTrackableUrl(tab.url || "")) {
    return;
  }

  const state = await getState();
  ensureDailyState(state);
  if (!state.trackingEnabled) {
    return;
  }

  const domain = getDomain(tab.url);
  if (!domain) {
    return;
  }

  const visited = state.visitedDomainsToday?.domains || {};
  const priorVisits = normalizeVisitCount(visited[domain]);
  const revisitCount = Math.max(0, priorVisits);
  visited[domain] = priorVisits + 1;
  state.visitedDomainsToday = { dateKey: localDateKey(), domains: visited };

  currentSession = {
    sessionId: makeSessionId(),
    domain,
    url: getTrackableOrigin(tab.url) || tab.url,
    tabId: tab.id,
    startTime: Date.now(),
    lastTickAt: Date.now(),
    lastActivityAt: Date.now(),
    activeTimeSec: 0,
    scrollCount: 0,
    tabSwitchCount: 0,
    revisitCount,
    stage2PromptShown: false,
    stage2Choice: null,
    stage2ActionFailed: false,
    stage2FailReason: null,
    snoozeMinutes: null,
    snoozeUntil: null,
    breakTriggered: false,
    breakType: null,
    breakDurationSec: null,
    awaitingReturnAfterBreak: false,
    breakCooldownUntil: null,
    breakReturnDeadline: null,
    promptShown: false
  };

  await patchState({
    [STORAGE_KEYS.visitedDomainsToday]: state.visitedDomainsToday,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate,
    [STORAGE_KEYS.currentSessionState]: currentSession
  });
}

async function shouldCountTime(state, now) {
  const status = await getCountStatus(state, now);
  return status.active;
}

async function getCountStatus(state, now = Date.now()) {
  if (!currentSession) {
    return { active: false, reason: "no_session" };
  }

  if (!state.trackingEnabled) {
    return { active: false, reason: "tracking_disabled" };
  }

  if (currentSession.awaitingReturnAfterBreak) {
    const returnDeadline = Number(currentSession.breakReturnDeadline || 0);
    if (returnDeadline > now) {
      return { active: false, reason: "break_pause" };
    }
    return { active: false, reason: "break_return_window_expired" };
  }

  if (now - currentSession.lastActivityAt > getIdleTimeoutMs(state)) {
    return { active: false, reason: "idle_timeout" };
  }

  const cooldownUntil = Number(state.cooldowns[currentSession.domain] || 0);
  if (cooldownUntil > now) {
    return { active: false, reason: "cooldown_active" };
  }

  try {
    const tab = await chrome.tabs.get(currentSession.tabId);
    if (!tab.active || !isTrackableUrl(tab.url || "")) {
      return { active: false, reason: "tab_inactive_or_invalid_url" };
    }

    const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const focusedTab = focusedTabs[0] || null;
    if (!focusedTab || focusedTab.id !== tab.id) {
      return { active: false, reason: "not_last_focused_tab" };
    }

    if (getDomain(tab.url) !== currentSession.domain) {
      return { active: false, reason: "domain_mismatch" };
    }

    return { active: true, reason: "counting" };
  } catch (_error) {
    return { active: false, reason: "tab_unavailable" };
  }
}

async function accrueActiveTime(now = Date.now()) {
  if (!currentSession) {
    return;
  }

  const elapsedSec = Math.floor((now - currentSession.lastTickAt) / 1000);
  currentSession.lastTickAt = now;

  if (elapsedSec <= 0) {
    await persistCurrentSession();
    return;
  }

  const state = await getState();
  ensureDailyState(state);

  const countable = await shouldCountTime(state, now);
  if (!countable) {
    await patchState({
      [STORAGE_KEYS.currentSessionState]: currentSession,
      [STORAGE_KEYS.lastResetDate]: state.lastResetDate,
      [STORAGE_KEYS.domainTotals]: state.domainTotals,
      [STORAGE_KEYS.visitedDomainsToday]: state.visitedDomainsToday,
      [STORAGE_KEYS.stageNotified]: state.stageNotified,
      [STORAGE_KEYS.snoozes]: state.snoozes
    });
    return;
  }

  const beforeSec = getTodayDomainSec(state, currentSession.domain);
  const afterSec = beforeSec + elapsedSec;
  const mode = getActiveMode(state);
  ensureDomainTotalRecord(state, currentSession.domain).activeTimeSecToday = afterSec;
  currentSession.activeTimeSec += elapsedSec;

  await maybeTriggerStageInterventions(
    state,
    currentSession.domain,
    getStage(beforeSec, mode),
    getStage(afterSec, mode),
    mode
  );

  await patchState({
    [STORAGE_KEYS.domainTotals]: state.domainTotals,
    [STORAGE_KEYS.currentSessionState]: currentSession,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate,
    [STORAGE_KEYS.visitedDomainsToday]: state.visitedDomainsToday,
    [STORAGE_KEYS.stageNotified]: state.stageNotified,
    [STORAGE_KEYS.cooldowns]: state.cooldowns,
    [STORAGE_KEYS.snoozes]: state.snoozes
  });
}

async function openSessionPrompt(sessionId) {
  const url = chrome.runtime.getURL(`prompt.html?sessionId=${encodeURIComponent(sessionId)}`);
  await chrome.tabs.create({ url });
}

async function endSession(endReason) {
  if (!currentSession) {
    return null;
  }

  const sessionId = currentSession.sessionId;
  if (endingSessionIds.has(sessionId)) {
    return null;
  }
  endingSessionIds.add(sessionId);

  try {
    await accrueActiveTime(Date.now());

    const state = await getState();
    ensureDailyState(state);
    const mode = getActiveMode(state);

    const domainSec = getTodayDomainSec(state, currentSession.domain);
    const stage = getStage(domainSec, mode);
    const riskLevel = getRiskLevel(stage);
    const provisional = computeProvisional(
      currentSession.activeTimeSec,
      currentSession.scrollCount,
      currentSession.tabSwitchCount,
      currentSession.revisitCount,
      mode
    );

    const finalized = {
      sessionSchemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: currentSession.sessionId,
      domain: currentSession.domain,
      url: currentSession.url,
      tabId: currentSession.tabId,
      startTime: currentSession.startTime,
      endTime: Date.now(),
      endReason,
      activeTimeSec: currentSession.activeTimeSec,
      scrollCount: currentSession.scrollCount,
      tabSwitchCount: currentSession.tabSwitchCount,
      revisitCount: currentSession.revisitCount,
      revisitCountMode: "daily_prior_visits",
      stage,
      riskLevel,
      mode,
      ruleVersion: RULE_VERSION,
      idleTimeoutMinUsed: sanitizeIdleTimeoutMin(state.idleTimeoutMin),
      provisionalLabel: provisional.provisionalLabel,
      provisionalScore: provisional.provisionalScore,
      finalLabel: provisional.provisionalLabel,
      labelSource: "hybrid_skipped",
      labelConfidence: "rule_only",
      stage2Choice: currentSession.stage2Choice,
      stage2ActionFailed: Boolean(currentSession.stage2ActionFailed),
      stage2FailReason: currentSession.stage2FailReason || null,
      snoozeMinutes: currentSession.snoozeMinutes,
      snoozeUntil: currentSession.snoozeUntil,
      breakTriggered: Boolean(currentSession.breakTriggered),
      breakType: currentSession.breakType,
      breakDurationSec: currentSession.breakDurationSec,
      promptShown: false,
      promptSkipped: null,
      q1LongerThanIntended: null,
      q2HardToStop: null
    };

    state.sessions.push(finalized);
    if (state.sessions.length > MAX_SESSIONS) {
      state.sessions = state.sessions.slice(state.sessions.length - MAX_SESSIONS);
    }

    if (
      shouldShowEndSessionQuestions(
        state,
        endReason,
        riskLevel,
        provisional.provisionalLabel
      )
    ) {
      finalized.promptShown = true;
      finalized.labelConfidence = "pending_prompt";
      await openSessionPrompt(finalized.sessionId);
    }

    await patchState({
      [STORAGE_KEYS.sessions]: state.sessions,
      [STORAGE_KEYS.currentSessionState]: null,
      [STORAGE_KEYS.lastResetDate]: state.lastResetDate
    });

    currentSession = null;
    return finalized;
  } finally {
    endingSessionIds.delete(sessionId);
  }
}

async function syncToActiveTab(tab, source = "unknown") {
  if (!tab || !tab.id) {
    return;
  }

  if (currentSession?.awaitingReturnAfterBreak) {
    const now = Date.now();
    const returnDeadline = Number(currentSession.breakReturnDeadline || 0);
    const resumedByUser = source === "activity" || source === "tab_switch";

    if (returnDeadline > 0 && now > returnDeadline) {
      await endSession("break_no_return_10m");
    } else if (resumedByUser && isTrackableUrl(tab.url || "")) {
      await endSession("break_resumed_new_session");
      await startSessionFromTab(tab);
      return;
    } else {
      if (currentSession.tabId === tab.id) {
        currentSession.url = getTrackableOrigin(tab.url || "") || currentSession.url;
        await persistCurrentSession();
      }
      return;
    }
  }

  if (!isTrackableUrl(tab.url || "")) {
    if (currentSession && currentSession.tabId === tab.id) {
      const blockedPrefix = chrome.runtime.getURL("blocked.html");
      const isBlockedPage = typeof tab.url === "string" && tab.url.startsWith(blockedPrefix);
      if (isBlockedPage) {
        const state = await getState();
        ensureDailyState(state);
        const activeCooldown = Number(state.cooldowns[currentSession.domain] || 0) > Date.now();
        if (activeCooldown) {
          // Keep the same session alive while temporarily blocked.
          await persistCurrentSession();
          return;
        }
      }
      await endSession("forced_end");
    }
    return;
  }

  if (!currentSession) {
    await startSessionFromTab(tab);
    return;
  }

  const incomingDomain = getDomain(tab.url);
  const isSame = currentSession.tabId === tab.id && currentSession.domain === incomingDomain;

  if (isSame) {
    currentSession.url = getTrackableOrigin(tab.url) || currentSession.url;
    currentSession.lastActivityAt = Date.now();
    await persistCurrentSession();
    return;
  }

  if (source === "tab_switch") {
    currentSession.tabSwitchCount += 1;
    await persistCurrentSession();
  }

  await endSession("forced_end");
  await startSessionFromTab(tab);
}

async function handleActivityPing(senderTab, activityType) {
  if (!senderTab || !senderTab.id || !isTrackableUrl(senderTab.url || "")) {
    return;
  }

  await syncToActiveTab(senderTab, "activity");
  if (!currentSession) {
    return;
  }

  if (currentSession.tabId !== senderTab.id || currentSession.domain !== getDomain(senderTab.url)) {
    return;
  }

  currentSession.lastActivityAt = Date.now();
  if (activityType === "scroll") {
    currentSession.scrollCount += 1;
  }
  await persistCurrentSession();
}

async function exportCsv() {
  const state = await getState();
  return exportSessionsCsv(state.sessions);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function getPopupState() {
  const state = await getState();
  const didReset = ensureDailyState(state);
  const now = Date.now();

  const tab = await getActiveTab();
  const domain = tab?.url ? getDomain(tab.url) : null;
  const activeTimeSecToday = domain ? getTodayDomainSec(state, domain) : 0;
  const mode = getActiveMode(state);
  const modeConfig = getModeConfig(mode);
  const stage = getStage(activeTimeSecToday, mode);
  const riskLevel = getRiskLevel(stage);
  const matchedCooldown = domain ? findActiveBlockForDomain(state.cooldowns, domain, now) : null;
  const cooldownUntil = matchedCooldown ? Number(matchedCooldown.blockedUntil || 0) : 0;
  const cooldownActive = cooldownUntil > now;
  const countStatus = await getCountStatus(state, now);

  if (didReset) {
    await patchState({
      [STORAGE_KEYS.lastResetDate]: state.lastResetDate,
      [STORAGE_KEYS.domainTotals]: state.domainTotals,
      [STORAGE_KEYS.visitedDomainsToday]: state.visitedDomainsToday,
      [STORAGE_KEYS.stageNotified]: state.stageNotified
    });
  }

  return {
    trackingEnabled: state.trackingEnabled,
    debugEnabled: state.debugEnabled,
    mode,
    modeLabel: modeConfig.label,
    idleTimeoutMin: sanitizeIdleTimeoutMin(state.idleTimeoutMin),
    domain,
    activeTimeSecToday,
    stage,
    riskLevel,
    riskLabel: formatRiskLabel(riskLevel),
    cooldownActive,
    cooldownUntil,
    countStatusActive: countStatus.active,
    countStatusReason: countStatus.reason,
    sessionActive: Boolean(currentSession),
    currentSessionId: currentSession?.sessionId || null
  };
}

async function updateActionBadge(stateArg = null) {
  const state = stateArg || (await getState());
  ensureDailyState(state);

  if (!state.trackingEnabled) {
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_OFF_COLOR });
    return;
  }

  const tab = await getActiveTab();
  const domain = tab?.url ? getDomain(tab.url) : null;
  if (!domain) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const sec = getTodayDomainSec(state, domain);
  const stage = getStage(sec, getActiveMode(state));
  await chrome.action.setBadgeText({ text: `S${stage}` });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_BY_STAGE[stage] || BADGE_COLOR_BY_STAGE[0] });
}

async function clearAllData() {
  await chrome.storage.local.clear();
  currentSession = null;
  await chrome.action.setBadgeText({ text: "" });
}

async function initialize() {
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: TICK_INTERVAL_MIN });

  const state = await getState();
  ensureDailyState(state);
  await patchState({
    [STORAGE_KEYS.trackingEnabled]: state.trackingEnabled,
    [STORAGE_KEYS.debugEnabled]: state.debugEnabled,
    [STORAGE_KEYS.mode]: getActiveMode(state),
    [STORAGE_KEYS.idleTimeoutMin]: sanitizeIdleTimeoutMin(state.idleTimeoutMin),
    [STORAGE_KEYS.sessions]: state.sessions,
    [STORAGE_KEYS.domainTotals]: state.domainTotals,
    [STORAGE_KEYS.visitedDomainsToday]: state.visitedDomainsToday,
    [STORAGE_KEYS.cooldowns]: state.cooldowns,
    [STORAGE_KEYS.snoozes]: state.snoozes,
    [STORAGE_KEYS.snoozeHistory]: state.snoozeHistory,
    [STORAGE_KEYS.lastResetDate]: state.lastResetDate,
    [STORAGE_KEYS.stageNotified]: state.stageNotified
  });

  await clearExpiredState();

  if (state.currentSessionState && state.currentSessionState.tabId) {
    currentSession = state.currentSessionState;
  }

  if (!currentSession && state.trackingEnabled) {
    const tab = await getActiveTab();
    if (tab?.id && isTrackableUrl(tab.url || "")) {
      await startSessionFromTab(tab);
    }
  }

  await updateActionBadge(state);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => console.error("Install init failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => console.error("Startup init failed", error));
});

initialize().catch((error) => console.error("Init failed", error));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_TICK) {
    return;
  }

  (async () => {
    await clearExpiredState();
    await enforceBlockOnActiveTab();
    const state = await getState();
    ensureDailyState(state);

    if (!currentSession) {
      await updateActionBadge();
      return;
    }

    if (currentSession.awaitingReturnAfterBreak) {
      const returnDeadline = Number(currentSession.breakReturnDeadline || 0);
      if (returnDeadline > 0 && Date.now() > returnDeadline) {
        await endSession("break_no_return_10m");
      }
      await updateActionBadge();
      return;
    }

    if (Date.now() - currentSession.lastActivityAt >= getIdleTimeoutMs(state)) {
      await endSession(END_REASON_IDLE);
      await updateActionBadge();
      return;
    }

    await accrueActiveTime();
    await updateActionBadge();
  })().catch((error) => console.error("Tick failed", error));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  (async () => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const blocked = await handleTabUpdate(tab.id, tab.url || "");
    if (blocked) {
      await updateActionBadge();
      return;
    }
    await syncToActiveTab(tab, "tab_switch");
    await updateActionBadge();
  })().catch((error) => console.error("onActivated failed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const shouldCheck =
    Boolean(changeInfo.url) || changeInfo.status === "loading" || changeInfo.status === "complete";
  if (!shouldCheck) {
    return;
  }

  (async () => {
    const candidateUrl = changeInfo.url || tab.url || "";
    const blocked = await handleTabUpdate(tabId, candidateUrl);
    if (blocked) {
      return;
    }

    if (tab.active && changeInfo.url) {
      await syncToActiveTab({ ...tab, id: tabId, url: changeInfo.url }, "navigation");
      await updateActionBadge();
    }
  })().catch((error) => console.error("onUpdated failed", error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    if (currentSession && currentSession.tabId === tabId) {
      await endSession("tab_closed");
      await updateActionBadge();
    }
  })().catch((error) => console.error("onRemoved failed", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "ACTIVITY_PING") {
      await handleActivityPing(sender.tab, message.activityType);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "GET_POPUP_STATE") {
      const data = await getPopupState();
      sendResponse({ ok: true, data });
      return;
    }

    if (message?.type === "SET_TRACKING") {
      const enabled = Boolean(message.enabled);
      await patchState({ [STORAGE_KEYS.trackingEnabled]: enabled });
      if (!enabled) {
        if (currentSession) {
          await endSession("forced_end");
        }
      } else {
        const tab = await getActiveTab();
        if (tab?.id && isTrackableUrl(tab.url || "")) {
          await syncToActiveTab(tab, "tracking_on");
        }
      }
      await updateActionBadge();
      sendResponse({ ok: true, enabled });
      return;
    }

    if (message?.type === "SET_IDLE_TIMEOUT") {
      const minutes = sanitizeIdleTimeoutMin(message.minutes);
      await patchState({ [STORAGE_KEYS.idleTimeoutMin]: minutes });
      sendResponse({ ok: true, minutes });
      return;
    }

    if (message?.type === "SET_MODE") {
      const mode = sanitizeMode(message.mode);
      const modeConfig = getModeConfig(mode);
      await patchState({ [STORAGE_KEYS.mode]: mode });
      await updateActionBadge();
      sendResponse({ ok: true, mode, modeLabel: modeConfig.label });
      return;
    }

    if (message?.type === "SET_DEBUG") {
      const enabled = Boolean(message.enabled);
      await patchState({ [STORAGE_KEYS.debugEnabled]: enabled });
      sendResponse({ ok: true, enabled });
      return;
    }

    if (message?.type === "DEBUG_SIMULATE_10_MIN") {
      const state = await getState();
      if (!state.debugEnabled) {
        sendResponse({ ok: false, error: "Debug mode is disabled." });
        return;
      }

      const tab = await getActiveTab();
      const domain = tab?.url ? getDomain(tab.url) : null;
      if (!domain) {
        sendResponse({ ok: false, error: "No active domain." });
        return;
      }

      ensureDailyState(state);
      const mode = getActiveMode(state);
      const beforeSec = getTodayDomainSec(state, domain);
      const afterSec = beforeSec + 600;
      ensureDomainTotalRecord(state, domain).activeTimeSecToday = afterSec;
      await maybeTriggerStageInterventions(
        state,
        domain,
        getStage(beforeSec, mode),
        getStage(afterSec, mode),
        mode
      );

      await patchState({
        [STORAGE_KEYS.domainTotals]: state.domainTotals,
        [STORAGE_KEYS.stageNotified]: state.stageNotified,
        [STORAGE_KEYS.cooldowns]: state.cooldowns,
        [STORAGE_KEYS.snoozes]: state.snoozes,
        [STORAGE_KEYS.lastResetDate]: state.lastResetDate
      });

      await updateActionBadge(state);
      sendResponse({ ok: true, domain, activeTimeSecToday: afterSec });
      return;
    }

    if (message?.type === "DEBUG_END_SESSION") {
      const state = await getState();
      if (!state.debugEnabled) {
        sendResponse({ ok: false, error: "Debug mode is disabled." });
        return;
      }
      await endSession("forced_end");
      await updateActionBadge();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "DEBUG_CLEAR_TODAY_DOMAIN") {
      const state = await getState();
      if (!state.debugEnabled) {
        sendResponse({ ok: false, error: "Debug mode is disabled." });
        return;
      }
      const tab = await getActiveTab();
      const domain = tab?.url ? getDomain(tab.url) : null;
      if (!domain) {
        sendResponse({ ok: false, error: "No active domain." });
        return;
      }

      ensureDailyState(state);
      ensureDomainTotalRecord(state, domain).activeTimeSecToday = 0;
      const today = localDateKey();
      for (const key of Object.keys(state.stageNotified)) {
        if (key.startsWith(`${today}|${domain}|`)) {
          delete state.stageNotified[key];
        }
      }

      await patchState({
        [STORAGE_KEYS.domainTotals]: state.domainTotals,
        [STORAGE_KEYS.stageNotified]: state.stageNotified,
        [STORAGE_KEYS.lastResetDate]: state.lastResetDate
      });

      await updateActionBadge(state);
      sendResponse({ ok: true, domain });
      return;
    }

    if (message?.type === "EXPORT_CSV") {
      const csv = await exportCsv();
      sendResponse({ ok: true, csv });
      return;
    }

    if (message?.type === "CLEAR_DATA") {
      await clearAllData();
      await updateActionBadge();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "SAVE_PROMPT_ANSWERS") {
      const { sessionId, q1LongerThanIntended, q2HardToStop } = message;
      const state = await getState();
      const idx = state.sessions.findIndex((s) => s.sessionId === sessionId);
      if (idx < 0) {
        sendResponse({ ok: false, error: "Session not found." });
        return;
      }

      const session = state.sessions[idx];
      const alreadyRated =
        session.q1LongerThanIntended !== null || session.q2HardToStop !== null;
      if (alreadyRated) {
        sendResponse({ ok: false, error: "Session already rated." });
        return;
      }

      const validQ1 =
        q1LongerThanIntended === "yes" ||
        q1LongerThanIntended === "no" ||
        q1LongerThanIntended === "skip";
      const validQ2 =
        q2HardToStop === null ||
        (Number.isInteger(q2HardToStop) && q2HardToStop >= 1 && q2HardToStop <= 5);
      if (!validQ1 || !validQ2) {
        sendResponse({ ok: false, error: "Invalid session rating payload." });
        return;
      }

      session.q1LongerThanIntended = q1LongerThanIntended;
      session.q2HardToStop = q2HardToStop;

      const adjusted = computeHybridFinal(
        session.provisionalLabel,
        q1LongerThanIntended,
        q2HardToStop
      );

      session.finalLabel = adjusted.finalLabel;
      session.labelSource = adjusted.labelSource;
      const promptSkipped = q1LongerThanIntended === "skip" && q2HardToStop === null;
      session.promptSkipped = promptSkipped;
      if (promptSkipped) {
        session.labelConfidence = "skipped";
      } else if (adjusted.labelSource === "hybrid_adjusted") {
        session.labelConfidence = "adjusted";
      } else if (adjusted.labelSource === "hybrid_confirmed") {
        session.labelConfidence = "confirmed";
      } else {
        session.labelConfidence = "rule_only";
      }

      state.sessions[idx] = session;
      await patchState({ [STORAGE_KEYS.sessions]: state.sessions });
      sendResponse({ ok: true, domain: session.domain });
      return;
    }

    if (message?.type === "STAGE2_NUDGE_ACTION") {
      const action = String(message.action || "");
      const domain = (message.domain && String(message.domain).toLowerCase()) || null;
      const sourceTabId = Number(message.sourceTabId || 0);
      const senderTabId = Number(sender?.tab?.id || 0);

      if (!domain) {
        sendResponse({ ok: false, error: "Missing domain." });
        return;
      }

      if (action === "break_5") {
        let targetTabId = sourceTabId;
        let actionFailed = false;
        let failReason = null;
        let until = 0;

        if (targetTabId && senderTabId && targetTabId === senderTabId) {
          targetTabId = 0;
        }

        if (!targetTabId && currentSession?.domain === domain && currentSession.tabId !== senderTabId) {
          targetTabId = currentSession.tabId;
        }

        if (!targetTabId) {
          actionFailed = true;
          failReason = "no_valid_target_tab";
          console.debug("Stage2 break skipped: no valid target tab.", { domain, sourceTabId });
        }

        if (targetTabId) {
          try {
            const targetTab = await chrome.tabs.get(targetTabId);
            const targetDomain = getDomain(targetTab?.url || "");
            const domainMatches =
              targetDomain &&
              (matchBlockedDomain(targetDomain, domain) || matchBlockedDomain(domain, targetDomain));
            if (!domainMatches) {
              actionFailed = true;
              failReason = "no_valid_target_tab";
              targetTabId = 0;
            }
          } catch (_error) {
            actionFailed = true;
            failReason = "no_valid_target_tab";
            targetTabId = 0;
          }
        }

        if (targetTabId) {
          until = await blockSite(domain, 5 * 60 * 1000);
          try {
            const redirect = chrome.runtime.getURL(
              `blocked.html?mode=cooldown&domain=${encodeURIComponent(domain)}&site=${encodeURIComponent(domain)}&until=${encodeURIComponent(String(until))}`
            );
            await chrome.tabs.update(targetTabId, { url: redirect });
          } catch (_error) {
            await clearDomainCooldown(domain);
            actionFailed = true;
            failReason = "no_valid_target_tab";
            console.debug("Stage2 break skipped: target tab update failed.", {
              domain,
              targetTabId
            });
          }
        }

        if (currentSession && currentSession.domain === domain) {
          currentSession.stage2Choice = "break_5";
          currentSession.stage2ActionFailed = actionFailed;
          currentSession.stage2FailReason = failReason;
          currentSession.breakTriggered = !actionFailed;
          currentSession.breakType = actionFailed ? null : "user_initiated";
          currentSession.breakDurationSec = actionFailed ? null : 300;
          if (!actionFailed) {
            currentSession.awaitingReturnAfterBreak = true;
            currentSession.breakCooldownUntil = until;
            currentSession.breakReturnDeadline = until + BREAK_RETURN_WINDOW_MS;
          }
          await persistCurrentSession();
        }

        await updateActionBadge();
        const result = actionFailed ? "noop" : "success";
        sendResponse({
          ok: true,
          result,
          message: actionFailed
            ? "Could not start break because the target tab is unavailable."
            : "Break started for 5 minutes.",
          actionFailed,
          failReason
        });
        return;
      }

      if (action === "snooze") {
        const state = await getState();
        const mode = getActiveMode(state);
        const snoozeMinutes = Number(getModeConfig(mode).snoozeMinutes || SNOOZE_MINUTES);
        const snoozeDecision = await applySnoozeWithCap(domain, snoozeMinutes);
        const actionFailed = !snoozeDecision.allowed;
        const failReason = actionFailed ? "snooze_cap_reached" : null;
        if (currentSession && currentSession.domain === domain) {
          currentSession.stage2Choice = "snooze";
          currentSession.stage2ActionFailed = actionFailed;
          currentSession.stage2FailReason = failReason;
          currentSession.snoozeUntil = actionFailed ? null : snoozeDecision.until;
          currentSession.snoozeMinutes = actionFailed ? null : snoozeMinutes;
          await persistCurrentSession();
        }
        await updateActionBadge();

        if (actionFailed) {
          sendResponse({
            ok: true,
            result: "noop",
            message: `Snooze limit reached (${SNOOZE_LIMIT_PER_HOUR}/hour). Try again in ${formatMsToMinSec(snoozeDecision.waitMs)}, or take a 5-minute break.`,
            actionFailed: true,
            failReason,
            snoozeCount: snoozeDecision.count,
            maxSnoozesPerHour: SNOOZE_LIMIT_PER_HOUR
          });
          return;
        }

        const escalationHint =
          snoozeDecision.count >= 2
            ? ` (Snooze ${snoozeDecision.count}/${SNOOZE_LIMIT_PER_HOUR} this hour.)`
            : "";
        sendResponse({
          ok: true,
          result: "success",
          message: `Snoozed for ${snoozeMinutes} minutes.${escalationHint}`,
          actionFailed: false,
          failReason: null,
          snoozeCount: snoozeDecision.count,
          maxSnoozesPerHour: SNOOZE_LIMIT_PER_HOUR
        });
        return;
      }

      if (action === "close_tab") {
        let targetTabId = sourceTabId;
        let actionFailed = false;
        let failReason = null;
        if (targetTabId && senderTabId && targetTabId === senderTabId) {
          targetTabId = 0;
        }
        if (!targetTabId && currentSession?.domain === domain && currentSession.tabId !== senderTabId) {
          targetTabId = currentSession.tabId;
        }

        if (targetTabId) {
          try {
            const targetTab = await chrome.tabs.get(targetTabId);
            const targetDomain = getDomain(targetTab?.url || "");
            const domainMatches =
              targetDomain &&
              (matchBlockedDomain(targetDomain, domain) || matchBlockedDomain(domain, targetDomain));
            if (!domainMatches) {
              actionFailed = true;
              failReason = "no_valid_target_tab";
              targetTabId = 0;
            }
          } catch (_error) {
            actionFailed = true;
            failReason = "no_valid_target_tab";
            targetTabId = 0;
          }
        }

        if (!targetTabId) {
          actionFailed = true;
          failReason = failReason || "no_valid_target_tab";
          console.debug("Stage2 close_tab skipped: no valid target tab.", { domain, sourceTabId });
        }

        if (currentSession && currentSession.domain === domain) {
          currentSession.stage2Choice = "close_tab";
          currentSession.stage2ActionFailed = actionFailed;
          currentSession.stage2FailReason = failReason;
          await persistCurrentSession();
        }

        const result = actionFailed ? "noop" : "success";
        sendResponse({
          ok: true,
          result,
          message: actionFailed
            ? "The tab is already closed or unavailable."
            : "Closing the tab.",
          actionFailed,
          failReason
        });
        if (targetTabId) {
          setTimeout(() => {
            chrome.tabs.remove(targetTabId).catch(() => {
              // tab may already be gone
            });
          }, 0);
        }
        return;
      }

      sendResponse({ ok: false, error: "Unknown Stage 2 action." });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "Unexpected error." });
  });

  return true;
});
