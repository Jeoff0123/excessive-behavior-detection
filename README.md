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
- Risk mapping:
  - Stage 0 -> Low
  - Stage 1-2 -> Medium
  - Stage 3-4 -> High
- Session ends:
  - tab closed
  - idle 5 minutes
  - forced end (switch/navigation/debug)
  - break return window expired (`break_no_return_10m`)
- Interventions:
  - Stage 1 notification once/domain/day
  - Stage 2 notification + blocked-page nudge
  - Stage 2 nudge shown once per session
  - Snooze is a per-domain cross-session suppression window (10 minutes)
  - Take a 5-minute break pauses the current session and starts a return window
  - Return is user-driven activity (interaction or tab switch), not automatic redirect
  - If no valid browsing activity returns within 10 minutes after break, session ends with `break_no_return_10m`
  - If the user returns during that window, a new session starts
  - Stage 3 auto-cooldown
  - Stage 4 auto-cooldown (10 minutes)
- End-session questions:
  - shown only when a session ends by `tab_closed` or `idle_5min`
  - shown only for Medium/High risk (or `provisionalLabel >= Medium`)
  - shown once per session
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
