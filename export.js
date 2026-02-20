const CSV_HEADER =
  "sessionSchemaVersion,sessionId,domain,startTime,endTime,endReason,activeTimeSec,scrollCount,tabSwitchCount,revisitCount,revisitCountMode,stage,riskLevel,idleTimeoutMinUsed,provisionalLabel,provisionalScore,finalLabel,labelSource,labelConfidence,promptSkipped,stage2Choice,stage2ActionFailed,stage2FailReason,snoozeMinutes,breakTriggered,breakDurationSec,q1LongerThanIntended,q2HardToStop";

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportSessionsCsv(sessions) {
  const lines = sessions.map((s) =>
    [
      s.sessionSchemaVersion ?? 1,
      s.sessionId,
      s.domain,
      s.startTime,
      s.endTime,
      s.endReason,
      s.activeTimeSec,
      s.scrollCount,
      s.tabSwitchCount,
      s.revisitCount,
      s.revisitCountMode || "binary_daily_seen",
      s.stage,
      s.riskLevel,
      s.idleTimeoutMinUsed,
      s.provisionalLabel,
      s.provisionalScore,
      s.finalLabel,
      s.labelSource,
      s.labelConfidence,
      s.promptSkipped,
      s.stage2Choice,
      s.stage2ActionFailed,
      s.stage2FailReason,
      s.snoozeMinutes,
      s.breakTriggered,
      s.breakDurationSec,
      s.q1LongerThanIntended,
      s.q2HardToStop
    ]
      .map(csvEscape)
      .join(",")
  );

  return `${CSV_HEADER}\n${lines.join("\n")}`;
}
