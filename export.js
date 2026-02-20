const CSV_HEADER =
  "sessionId,domain,startTime,endTime,endReason,activeTimeSec,scrollCount,tabSwitchCount,revisitCount,stage,riskLevel,provisionalLabel,provisionalScore,finalLabel,labelSource,stage2Choice,snoozeMinutes,breakTriggered,breakDurationSec,q1LongerThanIntended,q2HardToStop";

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
      s.sessionId,
      s.domain,
      s.startTime,
      s.endTime,
      s.endReason,
      s.activeTimeSec,
      s.scrollCount,
      s.tabSwitchCount,
      s.revisitCount,
      s.stage,
      s.riskLevel,
      s.provisionalLabel,
      s.provisionalScore,
      s.finalLabel,
      s.labelSource,
      s.stage2Choice,
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
