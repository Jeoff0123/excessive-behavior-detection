# Excessive Web Browsing Detector (Phase 1)

This extension implements rule-based excessive browsing detection with staged interventions and a cooldown block flow.

This tool is a digital well-being aid, not an enforcement or security control.

## Included files

- `manifest.json`
- `background.js` (MV3 service worker)
- `content.js` (throttled activity signals)
- `popup.html`, `popup.css`, `popup.js`
- `blocked.html`, `blocked.js`
- `prompt.html`, `prompt.js`
- `storage.js`, `rules.js`, `export.js`

## Core behavior

- Stage thresholds by per-domain active time today:
  - Stage 0: <30 min
  - Stage 1: 30-59 min
  - Stage 2: 60-119 min
  - Stage 3: 120-239 min
  - Stage 4: >=240 min
- Mode profiles (popup):
  - `Default` (`x1.0` thresholds, balanced prompt tone)
  - `Study-Research` (`x1.2` thresholds, more tolerant + break-focused tone)
  - `Entertainment` (`x0.9` thresholds, slightly stricter + stop-focused tone)
  - mode also adjusts snooze suppression window (`12` / `10` / `8` minutes respectively)
- Risk mapping:
  - Stage 0 -> Low
  - Stage 1-2 -> Medium
  - Stage 3-4 -> High
- Session ends:
  - tab closed
  - idle timeout (`idle_timeout`, configurable: 3/5/10 minutes, default 5)
  - session switch (`session_switch`) when active tracking moves to a different tab/domain
  - non-trackable navigation (`non_trackable_navigation`) when active tracking moves to a non-http(s) page
  - forced end (`forced_end`) for explicit termination paths (e.g., Tracking OFF, debug end-session)
  - break return window expired (`break_no_return_10m`)
- Revisit signal:
  - `revisitCount` stores prior visits to the same domain on the same day (frequency-style)
  - export includes `revisitCountMode` and `sessionSchemaVersion` for dataset compatibility
  - export also includes `mode` and `ruleVersion` for dataset reproducibility
  - debug-generated rows are tagged with `isDebugRow` and `debugSources`
- Interventions:
  - Stage 1 notification once/domain/day
  - Stage 2 notification + blocked-page nudge
  - Stage 2 nudge shown once per session
  - Snooze is a per-domain cross-session suppression window (10 minutes)
  - Snooze cap: max 3 snoozes per domain per hour
  - If snooze cap is reached, Stage 2 nudges are briefly muted (anti-spam guard)
  - Take a 5-minute break pauses the current session and starts a return window
  - Return is user-driven activity (interaction or tab switch), not automatic redirect
  - If no valid browsing activity returns within 10 minutes after break, session ends with `break_no_return_10m`
  - If the user returns during that window, a new session starts
  - Stage 3 auto-cooldown
  - Stage 4 auto-cooldown (10 minutes)
- End-session questions:
  - shown only when a session ends by `tab_closed` or `idle_timeout`
  - shown only for Medium/High risk (or `provisionalLabel >= Medium`)
  - shown once per session
  - sessions store `labelConfidence` (`pending_prompt`, `confirmed`, `adjusted`, `skipped`, `rule_only`) and `promptSkipped`
- Dataset quality gate:
  - popup shows automatic training readiness (`ready` / `not ready`)
  - popup lets you tune `min training rows` and `min rows per class` thresholds
  - training readiness uses high-confidence labels (`confirmed`/`adjusted`) as the primary training set
  - includes class balance monitor (Low/Medium/High counts)
  - includes response-rate and disagreement-rate checks for end-session self-reports
  - includes blocking issues (mixed schema/rule versions, low rows, imbalance) and warnings (debug ratio, forced-end ratio, weak-label ratio)
- Cooldown enforcement:
  - `tabs.onUpdated` redirect checks to `blocked.html`

## Debug mode controls (Popup)

Enable `Debug Mode` to reveal:

- `DEBUG Simulate +10 min`
- `DEBUG End Session Now`
- `DEBUG Clear Today for Domain`

## Privacy

- Data is stored in `chrome.storage.local` on-device.
- No backend/server upload is used.
- Session `url` is minimized to origin only (`scheme://host`) to avoid storing path/query content.
- You can pause collection with Tracking OFF and remove records with Clear Data.

## Positioning

- This extension supports self-regulation and awareness.
- It is not intended to be bypass-proof or a strict enforcement system.

## Load and test

1. Open `chrome://extensions` (or Brave extensions page).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open the extension popup and verify:
   - Tracking toggle works
   - Debug toggle reveals/hides debug buttons
   - Stage/risk updates after normal browsing or debug simulation
5. For cooldown tests:
   - Use debug simulation to reach Stage 4 quickly
   - Navigate to the same domain and confirm redirect to `blocked.html`
6. For prompt tests:
   - End a medium/high-risk session by closing the tracked tab or waiting for idle timeout
   - Confirm Stage 2 nudge actions (`Take a 5-minute break`, `Snooze`, `Close tab`) do not show end-session questions until true session end
   - Open `prompt.html` rate flow and submit answers
   - Confirm cooldown still blocks until timer reaches zero
7. Click `Export CSV` to verify records include prompt answers.

## Time Split Safeguard Template

Use this template before training to enforce a leak-safe time split, confidence-aware labels, and quality safeguards:

```bash
node scripts/time_split_guard.mjs --in sessions.csv --outDir ./splits --trainRatio 0.8 --schema 3 --rule phase1_mode_v1 --excludeDebug true --labelPolicy high_confidence --minRows 60 --minClassRows 10 --minResponseRate 0.4 --maxDisagreementRate 0.6 --enforceQuality true
```

Outputs:
- `train_split.csv`
- `test_split.csv`
- `split_report.json`

Options:
- `--labelPolicy high_confidence` trains only on high-confidence rows (`labelConfidence` = `confirmed`/`adjusted`).
- `--labelPolicy all_weighted --weakWeight 0.35` includes weak rows with lower `sampleWeight` in output CSVs.
- `--enforceQuality true` blocks split generation if hard quality gates fail.
