export const LOW = 0;
export const MEDIUM = 1;
export const HIGH = 2;
export const DEFAULT_MODE = "default";
export const RULE_VERSION = "phase1_mode_v1";

const MODE_CONFIG = {
  default: {
    label: "Default",
    multiplier: 1.0,
    promptTone: "balanced",
    snoozeMinutes: 10
  },
  study_research: {
    label: "Study-Research",
    multiplier: 1.2,
    promptTone: "break_focused",
    snoozeMinutes: 12
  },
  entertainment: {
    label: "Entertainment",
    multiplier: 0.9,
    promptTone: "stop_focused",
    snoozeMinutes: 8
  }
};

export function sanitizeMode(mode) {
  const id = String(mode || "").toLowerCase();
  return MODE_CONFIG[id] ? id : DEFAULT_MODE;
}

export function getModeConfig(mode) {
  return MODE_CONFIG[sanitizeMode(mode)];
}

export function getStageThresholdsSec(mode = DEFAULT_MODE) {
  const multiplier = Number(getModeConfig(mode).multiplier || 1);
  return [30 * 60, 60 * 60, 120 * 60, 240 * 60].map((base) => Math.round(base * multiplier));
}

// Stage thresholds are based on today's active time for the current domain.
export function getStage(activeTimeSecToday, mode = DEFAULT_MODE) {
  const [stage1, stage2, stage3, stage4] = getStageThresholdsSec(mode);
  if (activeTimeSecToday < stage1) {
    return 0;
  }
  if (activeTimeSecToday < stage2) {
    return 1;
  }
  if (activeTimeSecToday < stage3) {
    return 2;
  }
  if (activeTimeSecToday < stage4) {
    return 3;
  }
  return 4;
}

// Risk map: Stage 0 -> Low, Stage 1-2 -> Medium, Stage 3-4 -> High.
export function getRiskLevel(stage) {
  if (stage === 0) {
    return LOW;
  }
  if (stage <= 2) {
    return MEDIUM;
  }
  return HIGH;
}

export function formatRiskLabel(riskLevel) {
  if (riskLevel === LOW) {
    return "Low";
  }
  if (riskLevel === MEDIUM) {
    return "Medium";
  }
  return "High";
}
