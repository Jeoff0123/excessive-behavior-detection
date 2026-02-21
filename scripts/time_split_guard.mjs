#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    in: "",
    outDir: ".",
    trainRatio: 0.8,
    schema: "3",
    rule: "phase1_mode_v1",
    excludeDebug: true,
    labelPolicy: "high_confidence",
    weakWeight: 0.35,
    minRows: 60,
    minClassRows: 10,
    minResponseRate: 0.4,
    maxDisagreementRate: 0.6,
    enforceQuality: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--in" && val) {
      args.in = val;
      i += 1;
    } else if (key === "--outDir" && val) {
      args.outDir = val;
      i += 1;
    } else if (key === "--trainRatio" && val) {
      args.trainRatio = Number(val);
      i += 1;
    } else if (key === "--schema" && val) {
      args.schema = String(val);
      i += 1;
    } else if (key === "--rule" && val) {
      args.rule = String(val);
      i += 1;
    } else if (key === "--excludeDebug" && val) {
      args.excludeDebug = String(val).toLowerCase() !== "false";
      i += 1;
    } else if (key === "--labelPolicy" && val) {
      args.labelPolicy = String(val);
      i += 1;
    } else if (key === "--weakWeight" && val) {
      args.weakWeight = Number(val);
      i += 1;
    } else if (key === "--minRows" && val) {
      args.minRows = Number(val);
      i += 1;
    } else if (key === "--minClassRows" && val) {
      args.minClassRows = Number(val);
      i += 1;
    } else if (key === "--minResponseRate" && val) {
      args.minResponseRate = Number(val);
      i += 1;
    } else if (key === "--maxDisagreementRate" && val) {
      args.maxDisagreementRate = Number(val);
      i += 1;
    } else if (key === "--enforceQuality" && val) {
      args.enforceQuality = String(val).toLowerCase() !== "false";
      i += 1;
    }
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(header, rows) {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(header.map((k) => csvEscape(row[k])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function parseBool(value) {
  if (value === true || value === false) {
    return value;
  }
  const v = String(value || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function hasDebugFlag(row) {
  if (parseBool(row.isDebugRow)) {
    return true;
  }
  const sources = String(row.debugSources || "").trim();
  return sources.length > 0;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseRiskLabel(value) {
  const n = Number(value);
  if (n === 0 || n === 1 || n === 2) {
    return n;
  }
  return null;
}

function getConfidenceTier(row) {
  const confidence = String(row.labelConfidence || "").trim().toLowerCase();
  if (confidence === "confirmed" || confidence === "adjusted") {
    return "high";
  }
  return "weak";
}

function isPromptEligible(row) {
  const endReason = String(row.endReason || "");
  const endedNaturally =
    endReason === "tab_closed" || endReason === "idle_timeout" || endReason === "idle_5min";
  const risk = parseRiskLabel(row.riskLevel);
  const provisional = parseRiskLabel(row.provisionalLabel);
  const mediumOrHigher = (risk !== null && risk >= 1) || (provisional !== null && provisional >= 1);
  return endedNaturally && mediumOrHigher;
}

function isPromptMeaningfullyAnswered(row) {
  const q1 = String(row.q1LongerThanIntended || "").trim().toLowerCase();
  const q2 = Number(row.q2HardToStop);
  const q2Valid = Number.isInteger(q2) && q2 >= 1 && q2 <= 5;
  const skipped = parseBool(row.promptSkipped) || q1 === "skip";
  const hasResponse = q1 === "yes" || q1 === "no" || q2Valid;
  return hasResponse && !skipped;
}

function computeQualityGate(rows, config) {
  const classCounts = { 0: 0, 1: 0, 2: 0 };
  const classCountsAll = { 0: 0, 1: 0, 2: 0 };
  const debugRows = [];
  const highConfidenceRows = [];
  const weakRows = [];
  let promptEligibleRows = 0;
  let promptAnsweredRows = 0;
  let comparablePromptRows = 0;
  let disagreementRows = 0;

  for (const row of rows) {
    const label = parseRiskLabel(row.finalLabel);
    if (label === null) {
      continue;
    }

    if (hasDebugFlag(row)) {
      debugRows.push(row);
      continue;
    }

    classCountsAll[label] += 1;
    const tier = getConfidenceTier(row);
    if (tier === "high") {
      highConfidenceRows.push(row);
      classCounts[label] += 1;
    } else {
      weakRows.push(row);
    }

    if (isPromptEligible(row)) {
      promptEligibleRows += 1;
      if (isPromptMeaningfullyAnswered(row)) {
        promptAnsweredRows += 1;
      }
    }

    if (isPromptMeaningfullyAnswered(row)) {
      const provisional = parseRiskLabel(row.provisionalLabel);
      if (provisional !== null) {
        comparablePromptRows += 1;
        if (provisional !== label) {
          disagreementRows += 1;
        }
      }
    }
  }

  const minClassCount = Math.min(classCounts[0], classCounts[1], classCounts[2]);
  const responseRate = promptEligibleRows > 0 ? promptAnsweredRows / promptEligibleRows : 1;
  const disagreementRate =
    comparablePromptRows > 0 ? disagreementRows / comparablePromptRows : 0;

  const blockingIssues = [];
  const warnings = [];

  if (highConfidenceRows.length < config.minRows) {
    blockingIssues.push(
      `Need at least ${config.minRows} high-confidence rows (current: ${highConfidenceRows.length}).`
    );
  }
  if (minClassCount < config.minClassRows) {
    blockingIssues.push(
      `High-confidence class imbalance: need >=${config.minClassRows} per class (Low=${classCounts[0]}, Medium=${classCounts[1]}, High=${classCounts[2]}).`
    );
  }
  if (promptEligibleRows > 0 && responseRate < config.minResponseRate) {
    blockingIssues.push(
      `Prompt response rate ${Math.round(responseRate * 100)}% is below minimum ${Math.round(
        config.minResponseRate * 100
      )}%.`
    );
  }
  if (comparablePromptRows >= 10 && disagreementRate > config.maxDisagreementRate) {
    blockingIssues.push(
      `Prompt disagreement rate ${Math.round(
        disagreementRate * 100
      )}% is above maximum ${Math.round(config.maxDisagreementRate * 100)}%.`
    );
  }

  if (debugRows.length > 0) {
    warnings.push(`${debugRows.length} debug rows detected.`);
  }
  if (weakRows.length > 0) {
    warnings.push(`${weakRows.length} weak-confidence rows available for weighted training.`);
  }
  if (promptEligibleRows === 0) {
    warnings.push("No prompt-eligible sessions found.");
  } else if (comparablePromptRows < 10) {
    warnings.push(
      `Only ${comparablePromptRows} comparable prompt rows; disagreement monitoring stabilizes at 10+ rows.`
    );
  }

  return {
    readyForTraining: blockingIssues.length === 0,
    totals: {
      allFilteredRows: rows.length,
      highConfidenceRows: highConfidenceRows.length,
      weakRows: weakRows.length,
      debugRows: debugRows.length,
      promptEligibleRows,
      promptAnsweredRows,
      comparablePromptRows
    },
    classCounts,
    classCountsAll,
    rates: {
      responseRate,
      disagreementRate
    },
    blockingIssues,
    warnings,
    rows: {
      highConfidenceRows,
      weakRows
    }
  };
}

function toIso(ms) {
  const n = toNumber(ms);
  return n == null ? null : new Date(n).toISOString();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) {
    console.error("Usage: node scripts/time_split_guard.mjs --in <sessions.csv> [--outDir .]");
    process.exit(1);
  }
  if (!Number.isFinite(args.trainRatio) || args.trainRatio <= 0 || args.trainRatio >= 1) {
    console.error("--trainRatio must be > 0 and < 1");
    process.exit(1);
  }
  if (!["high_confidence", "all_weighted"].includes(args.labelPolicy)) {
    console.error('--labelPolicy must be "high_confidence" or "all_weighted"');
    process.exit(1);
  }
  if (!Number.isFinite(args.weakWeight) || args.weakWeight <= 0 || args.weakWeight > 1) {
    console.error("--weakWeight must be > 0 and <= 1");
    process.exit(1);
  }
  if (!Number.isFinite(args.minRows) || args.minRows < 1) {
    console.error("--minRows must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(args.minClassRows) || args.minClassRows < 1) {
    console.error("--minClassRows must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(args.minResponseRate) || args.minResponseRate < 0 || args.minResponseRate > 1) {
    console.error("--minResponseRate must be between 0 and 1");
    process.exit(1);
  }
  if (
    !Number.isFinite(args.maxDisagreementRate) ||
    args.maxDisagreementRate < 0 ||
    args.maxDisagreementRate > 1
  ) {
    console.error("--maxDisagreementRate must be between 0 and 1");
    process.exit(1);
  }

  const raw = fs.readFileSync(args.in, "utf8");
  const parsed = parseCsv(raw);
  if (parsed.length < 2) {
    console.error("CSV has no data rows.");
    process.exit(1);
  }

  const header = parsed[0];
  const records = parsed.slice(1).map((cells) => {
    const rec = {};
    for (let i = 0; i < header.length; i += 1) {
      rec[header[i]] = cells[i] ?? "";
    }
    return rec;
  });

  const filtered = records.filter((row) => {
    if (String(row.sessionSchemaVersion || "") !== args.schema) {
      return false;
    }
    if (String(row.ruleVersion || "") !== args.rule) {
      return false;
    }
    if (args.excludeDebug && hasDebugFlag(row)) {
      return false;
    }
    return toNumber(row.startTime) != null;
  });

  const qualityGate = computeQualityGate(filtered, {
    minRows: args.minRows,
    minClassRows: args.minClassRows,
    minResponseRate: args.minResponseRate,
    maxDisagreementRate: args.maxDisagreementRate
  });

  if (args.enforceQuality && !qualityGate.readyForTraining) {
    console.error("Data-quality gate failed:");
    for (const issue of qualityGate.blockingIssues) {
      console.error(` - ${issue}`);
    }
    process.exit(1);
  }

  const splitBaseRows =
    args.labelPolicy === "high_confidence"
      ? qualityGate.rows.highConfidenceRows
      : [
          ...qualityGate.rows.highConfidenceRows,
          ...qualityGate.rows.weakRows
        ];

  const splitRows = splitBaseRows
    .filter((row) => parseRiskLabel(row.finalLabel) !== null && toNumber(row.startTime) != null)
    .map((row) => {
      const tier = getConfidenceTier(row);
      return {
        ...row,
        labelTier: tier,
        sampleWeight: tier === "high" ? "1" : String(args.weakWeight)
      };
    });

  splitRows.sort((a, b) => Number(a.startTime) - Number(b.startTime));
  if (splitRows.length < 2) {
    console.error("Not enough filtered rows to split.");
    process.exit(1);
  }

  const splitIndex = Math.max(1, Math.min(splitRows.length - 1, Math.floor(splitRows.length * args.trainRatio)));
  const trainRows = splitRows.slice(0, splitIndex);
  const testRows = splitRows.slice(splitIndex);

  const trainIds = new Set(trainRows.map((r) => r.sessionId));
  const leakage = testRows.some((r) => trainIds.has(r.sessionId));
  if (leakage) {
    console.error("Leakage detected: train/test share sessionId.");
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const trainPath = path.join(args.outDir, "train_split.csv");
  const testPath = path.join(args.outDir, "test_split.csv");
  const reportPath = path.join(args.outDir, "split_report.json");

  const outputHeader = [...header];
  if (!outputHeader.includes("labelTier")) {
    outputHeader.push("labelTier");
  }
  if (!outputHeader.includes("sampleWeight")) {
    outputHeader.push("sampleWeight");
  }

  fs.writeFileSync(trainPath, rowsToCsv(outputHeader, trainRows), "utf8");
  fs.writeFileSync(testPath, rowsToCsv(outputHeader, testRows), "utf8");

  const report = {
    input: path.resolve(args.in),
    schema: args.schema,
    ruleVersion: args.rule,
    excludeDebug: args.excludeDebug,
    labelPolicy: args.labelPolicy,
    weakWeight: args.weakWeight,
    trainRatio: args.trainRatio,
    enforceQuality: args.enforceQuality,
    qualityGate: {
      readyForTraining: qualityGate.readyForTraining,
      minRows: args.minRows,
      minClassRows: args.minClassRows,
      minResponseRate: args.minResponseRate,
      maxDisagreementRate: args.maxDisagreementRate,
      totals: qualityGate.totals,
      classCounts: qualityGate.classCounts,
      classCountsAll: qualityGate.classCountsAll,
      rates: qualityGate.rates,
      blockingIssues: qualityGate.blockingIssues,
      warnings: qualityGate.warnings
    },
    totalInputRows: records.length,
    totalFilteredRows: filtered.length,
    totalSplitRows: splitRows.length,
    trainRows: trainRows.length,
    testRows: testRows.length,
    trainTimeRange: {
      start: toIso(trainRows[0]?.startTime),
      end: toIso(trainRows[trainRows.length - 1]?.startTime)
    },
    testTimeRange: {
      start: toIso(testRows[0]?.startTime),
      end: toIso(testRows[testRows.length - 1]?.startTime)
    }
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Wrote ${trainPath} (${trainRows.length} rows)`);
  console.log(`Wrote ${testPath} (${testRows.length} rows)`);
  console.log(`Wrote ${reportPath}`);
}

main();
