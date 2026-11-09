# Game Guide: notes for coding agents

Electron app. A player shares a game window; a friend watches over WebRTC (PeerJS) and draws marks, pings, arrows, a cursor and reactions that show on top of the player's game.

## Layout

- `app/main.js`: main process. Windows, capture source listing, the click-through overlay, hotkeys, security guards, updater wiring.
- `app/renderer/app.js`: the page. Sharing, joining, drawing, connection recovery, stats.
- `app/renderer/fsm.js`: tiny state machine helper (no dependencies; main, page and Node).
- `app/renderer/session-machine.js`: the session phase machine (page).
- `app/machines.js`: main-process machines (updater, hide-drawings hotkey).
- `docs/state-machines.md`: generated diagrams of every machine, plus the implicit state kept on purpose. Read it before touching lifecycle code.
- `app/updater.js` + `app/swapscript.js`: self-update through GitHub Releases.
- `app/native.js`: Koffi calls for window tracking and process priority (Windows/macOS).

## State rules

1. Lifecycles are explicit machines. Don't add a boolean such as `S.isReconnecting`: add a state or event to the definition, then run `npm run machines` (CI fails if `docs/state-machines.md` is stale).
2. Change the connection objects (`S.conn`, `S.call`, `S.peer`, `S.stream`) first, then `session.send(EVENT)`: listeners redraw on the transition.
3. After any `await` in session code: `const ep = session.epoch; await x; if (ep !== session.epoch) return;` (stop any stream you just got).
4. Session timers use `later()` (cleared by `teardown()`). Timers that belong to one state go in the definition as `after`.
5. `S.ended`, `S.relinking` and `S.phase` are getters; assigning them throws (strict mode).

## Inspect live state

- Page (DevTools, Playwright `page.evaluate`): `window.__app.phase`, `window.__app.machines.session.snapshot()`.
- Main (Playwright `electronApp.evaluate`): `global.__gg.machines.update.state`, `global.__gg.machines.drawings.state`, `global.__gg.toggleDrawings()`.
- From the page to main: `await window.bridge.state()`.
- Copy details (Connection panel) lists all three machines with their recent moves. The log has one line per move: `state: <machine> <from> -> <to> (<EVENT>)`.

## Tests

| Command | What | Time |
|---|---|---|
| `npm run test:unit` | State machines and the release plan (Node only) | ~3 s |
| `npm test` | End-to-end: two Chromium pages + a local pairing server | ~4 min |
| `npm run test:edge` | Session edge cases: silent viewer, goodbye on the video path, End during capture start | ~1 min |
| `npm run test:electron` | Real Electron: capture, overlay, hotkeys, security guards (Linux: `xvfb-run -a`) | ~1 min |
| `npm run test:update` | Updater machine against a fake GitHub (Linux: `xvfb-run -a`) | ~15 s |
| `node test/packaged-smoke.cjs <exe>` | The packaged app (after `npm run package`) | ~15 s |

Every test prints PASS/FAIL/SKIP lines and exits 1 on any FAIL. `.github/workflows/tests.yml` runs them on Linux, Windows and macOS; each job's summary lists every check, and the job annotations carry the same list (readable with `gh api .../check-runs/<job>/annotations`).

## Shipping

Every push to `main` goes to players automatically (about 20 minutes) once Tests pass on Linux, Windows and macOS, unless only docs, tests or CI changed. Patch versions count up by themselves; bump `app/package.json` only for a new major/minor.

- Work on a branch. Push or merge to `main` only when the owner asks to merge or deploy.
- Don't push tags or start the Release workflow yourself.
- `node scripts/release-plan.mjs [sha]` shows what a commit would ship as (read-only).

## Don't

- No OBS or other dependency, no game injection or hooking (anti-cheat risk). The app is standalone.
- Never commit signing keys or tokens.
