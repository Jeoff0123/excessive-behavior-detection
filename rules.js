export const LOW = 0;
export const MEDIUM = 1;
export const HIGH = 2;

// Stage thresholds are based on today's active time for the current domain.
export function getStage(activeTimeSecToday) {
  if (activeTimeSecToday < 30 * 60) {
    return 0;
  }
  if (activeTimeSecToday < 60 * 60) {
    return 1;
  }
  if (activeTimeSecToday < 120 * 60) {
    return 2;
  }
  if (activeTimeSecToday < 240 * 60) {
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
