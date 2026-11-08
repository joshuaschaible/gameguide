// Writes docs/state-machines.md from the machine definitions (the code is the
// source of truth; the doc can't drift).
//   node scripts/machines.mjs          write the doc
//   node scripts/machines.mjs --check  exit 1 if the doc is out of date (CI)
import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FSM = require(path.join(root, 'app/renderer/fsm.js'));
const { DRAWINGS, UPDATE } = require(path.join(root, 'app/machines.js'));
const { SESSION } = require(path.join(root, 'app/renderer/session-machine.js'));
const OUT = path.join(root, 'docs/state-machines.md');

const MACHINES = [
  {
    def: SESSION,
    where: '`app/renderer/session-machine.js`, run by `app/renderer/app.js`',
    inspect: '`window.__app.phase`, `window.__app.machines.session.snapshot()`',
    drives: 'S.ended, S.relinking, the End button, the "+" invite button, the connection icon; `session.epoch` lets code that awaited something see that the session it worked for has ended.',
  },
  {
    def: UPDATE,
    where: '`app/machines.js`, run by `app/main.js` (updates section)',
    inspect: '`await window.bridge.state()` (page), `global.__gg.machines.update` (main)',
    drives: 'Every status sent to the page carries `state`; the update bar is drawn from it. Checks never run during an install, one install at a time.',
  },
  {
    def: DRAWINGS,
    where: '`app/machines.js`, run by `app/main.js` (hotkeys)',
    inspect: '`await window.bridge.state()` (page), `global.__gg.machines.drawings`, `global.__gg.toggleDrawings()` (main)',
    drives: 'Whether the overlay may show marks, the "hidden" receipt sent to the friend, and the page\'s "Drawings hidden" pill.',
  },
];

// Lifecycle-looking state we deliberately keep as plain variables.
const KEPT = [
  ['Overlay presence', '`app/main.js`: `overlayWin`, `target`, `overlayActive`', 'Each is set in one place and `track()` derives what to do from them every tick. A machine would add code, not safety.'],
  ['Window tracking', '`app/main.js`: `lastTrackState`', 'An observation recomputed every 200 to 1500 ms (tracking, background, minimized, away, closed, screen, untracked), not a lifecycle. Sent to the page as-is.'],
  ['Invite link hand-off', '`app/main.js`: `pendingInvite`', 'A one-slot queue held until the page has loaded.'],
  ['Marks on a canvas', '`app/renderer/marks.js`: `active`', 'Derived from what is on the canvas; nothing is stored.'],
  ['Overlay page', '`app/renderer/overlay.js`: `toastOn` + `marks.active`', 'Derived and reported to main, which owns the decision.'],
  ['Video recovery throttles', '`app/renderer/app.js`: `lastVideoRestart`, `lastRestart`, `S.netCapMbps`, `S.codecOverride`, `S.encoderStalls`, `S.swFixes`', 'Rate limits and counters, not phases. They now reset with every session (`teardown()`).'],
  ['Stream problem banner', '`app/renderer/app.js`: `issue`', 'Self-contained 10 s show / 10 s hold hysteresis.'],
  ['Pointer gesture', '`app/renderer/app.js`: `drawState.active`, `arrow`, `pan`, `laserOn`', 'One gesture at a time by construction of the pointer events; lives for one drag.'],
  ['Menus, picker mode, welcome slides, preview', '`app/renderer/app.js`: `menus`, `pickerMode`, `slide`, `previewOff`', 'Single values with no illegal combinations (one menu open is enforced by `closeMenus()`; the preview is derived from focus + the setting).'],
  ['Join/connect watchdogs', '`app/renderer/app.js`: `later()` timers', 'Already session-scoped: `teardown()` clears them.'],
];

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function section(m) {
  const def = m.def;
  const rows = Object.entries(def.states).map(([name, st]) => {
    const own = Object.entries(st.on || {}).flatMap(([ev, raw]) => (Array.isArray(raw) ? raw : [raw])
      .map((t) => `${ev} → ${typeof t === 'string' ? t : t.target}${typeof t === 'object' && t.when ? ' (if …)' : ''}`));
    const timers = Object.entries(st.after || {}).map(([ms, ev]) => `after ${ms} ms: ${ev}`);
    const none = def.on ? '(only the moves allowed from every state)' : '(none: final)';
    return `| \`${name}\` | ${cell(st.desc || '')} | ${cell([...own, ...timers].join('<br>') || none)} |`;
  });
  const global = Object.entries(def.on || {}).map(([ev, t]) => `\`${ev}\` → \`${t}\``).join(', ');
  return [
    `## ${def.id}`,
    '',
    def.desc,
    '',
    `- **Lives in:** ${m.where}`,
    `- **Drives:** ${m.drives}`,
    `- **Inspect:** ${m.inspect}`,
    global ? `- **From every state:** ${global}` : '',
    '',
    '```mermaid',
    FSM.toMermaid(def),
    '```',
    '',
    '| State | Meaning | Moves |',
    '|---|---|---|',
    ...rows,
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

const doc = [
  '# State machines',
  '',
  '<!-- Generated by `npm run machines` from the definitions. Do not edit by hand: CI fails when this file is out of date. -->',
  '',
  'Lifecycles in Game Guide are explicit state machines: one named state at a time and a table of allowed moves (`app/renderer/fsm.js`, no dependencies). An event that is not allowed in the current state is ignored and recorded, never half-applied. Timers that belong to a state are cancelled when the state is left.',
  '',
  'Every move is logged as `state: <machine> <from> -> <to> (<EVENT>)` and shows in **Copy details** (Connection panel), with each machine\'s current state and recent moves.',
  '',
  '**Rules for changes**',
  '',
  '1. A new phase or flag in a lifecycle goes into the definition (a state or an event), not into a new boolean. Then run `npm run machines`.',
  '2. Change the connection objects (`S.conn`, `S.call`, ...) first, then send the event: listeners redraw on the transition and must see the finished change.',
  '3. Session code that awaits something saves `session.epoch` first and returns if it changed.',
  '4. `S.ended`, `S.relinking` and `S.phase` are read-only views of the session machine.',
  '',
  ...MACHINES.map(section),
  '## Implicit state kept on purpose',
  '',
  'Found in the same review. These look like state but are counters, observations or single values, so they stay plain variables.',
  '',
  '| What | Where | Why it is not a machine |',
  '|---|---|---|',
  ...KEPT.map((r) => `| ${r.map(cell).join(' | ')} |`),
  '',
].join('\n');

if (process.argv.includes('--check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== doc) {
    console.error('docs/state-machines.md is out of date: run `npm run machines` and commit the result.');
    process.exit(1);
  }
  console.log('docs/state-machines.md is up to date');
} else {
  writeFileSync(OUT, doc);
  console.log(`wrote ${path.relative(root, OUT)}`);
}
