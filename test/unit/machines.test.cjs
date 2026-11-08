// The app's state machines, checked as plain data (no Electron, no browser):
//   node --test test/unit
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, validate, edges } = require('../../app/renderer/fsm.js');
const { DRAWINGS, UPDATE } = require('../../app/machines.js');
const { SESSION } = require('../../app/renderer/session-machine.js');

const run = (def, events) => {
  const m = createMachine(def);
  for (const e of events) {
    const [ev, data] = Array.isArray(e) ? e : [e];
    assert.ok(m.send(ev, data), `${def.id}: ${ev} should be allowed in ${m.state}`);
  }
  return m;
};

test('every definition is valid and every state is reachable', () => {
  for (const def of [DRAWINGS, UPDATE, SESSION]) {
    validate(def);
    const reach = new Set([def.initial]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of edges(def)) if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; }
    }
    assert.deepEqual([...reach].sort(), Object.keys(def.states).sort(), `${def.id}: unreachable states`);
    for (const [name, st] of Object.entries(def.states)) assert.ok(st.desc, `${def.id}.${name} needs a desc (it goes in the docs)`);
  }
});

// ---- drawings (main process hotkey) ----
test('drawings: a quick second press shows them again (used to hide twice)', () => {
  const m = run(DRAWINGS, ['TOGGLE', 'TOGGLE']);
  assert.equal(m.state, 'shown');
});

test('drawings: hide completes after the toast', async () => {
  const m = run(DRAWINGS, ['TOGGLE']);
  assert.equal(m.state, 'hiding');
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(m.state, 'hidden');
  m.send('TOGGLE');
  assert.equal(m.state, 'shown');
});

test('drawings: ending the session cancels a pending hide (used to hide the next session)', async () => {
  const m = run(DRAWINGS, ['TOGGLE', 'RESET']);
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(m.state, 'shown');
});

// ---- update (main process) ----
test('update: the happy path', () => {
  const m = run(UPDATE, ['CHECK', 'FOUND', 'INSTALL', 'PROGRESS', 'PROGRESS', 'UNPACK', 'RESTART']);
  assert.equal(m.state, 'restarting');
});

test('update: no check and no second install while installing', () => {
  const m = run(UPDATE, ['CHECK', 'FOUND', 'INSTALL']);
  for (const s of ['downloading', 'installing']) {
    assert.equal(m.state, s);
    assert.equal(m.can('CHECK'), false, `CHECK in ${s}`);
    assert.equal(m.can('INSTALL'), false, `INSTALL in ${s}`);
    if (s === 'downloading') m.send('UNPACK');
  }
  m.send('RESTART');
  assert.equal(m.can('CHECK'), false);
});

test('update: install only from an offer', () => {
  for (const pre of [[], ['CHECK', 'LATEST'], ['CHECK', 'NO_ASSET'], ['CHECK', 'CHECK_FAILED']]) {
    const m = run(UPDATE, pre);
    assert.equal(m.can('INSTALL'), false, `INSTALL in ${m.state}`);
  }
});

test('update: a failed background check keeps the offer up', () => {
  const m = run(UPDATE, ['CHECK', 'FOUND', 'CHECK', ['CHECK_FAILED', { prev: 'available' }]]);
  assert.equal(m.state, 'available');
  const n = run(UPDATE, ['CHECK', ['CHECK_FAILED', { prev: 'idle' }]]);
  assert.equal(n.state, 'failed');
});

test('update: a failed install can be retried after the next check', () => {
  const m = run(UPDATE, ['CHECK', 'FOUND', 'INSTALL', 'INSTALL_FAILED', 'CHECK', 'FOUND', 'INSTALL']);
  assert.equal(m.state, 'downloading');
});

test('update: off builds stay off', () => {
  const m = run(UPDATE, ['CHECK', 'OFF']);
  assert.equal(m.can('CHECK'), false);
});

// ---- session (renderer) ----
test('session: sharing, a friend joins, leaves, another joins, end', () => {
  const m = run(SESSION, ['SHARE', 'CAPTURED', 'REGISTERED', 'VIEWER_FOUND', 'LINK_OPEN', 'VIEWER_GONE', 'VIEWER_FOUND', 'LINK_OPEN']);
  assert.equal(m.state, 'host.live');
  m.send('RESET');
  assert.equal(m.state, 'idle');
});

test('session: host keeps video while the drawing link is rebuilt', () => {
  const m = run(SESSION, ['SHARE', 'CAPTURED', 'REGISTERED', 'VIEWER_FOUND', 'LINK_OPEN', 'LINK_LOST', 'RELINKED']);
  assert.equal(m.state, 'host.live');
  m.send('LINK_LOST');
  m.send('VIEWER_GONE');
  assert.equal(m.state, 'host.waiting');
});

test('session: host goes back to registering when offline before anyone joined', () => {
  const m = run(SESSION, ['SHARE', 'CAPTURED', 'REGISTERED', 'OFFLINE', 'REGISTERED']);
  assert.equal(m.state, 'host.waiting');
});

test('session: viewer joins, relinks, rejoins', () => {
  const m = run(SESSION, ['JOIN', 'LINK_OPEN', 'VIDEO', 'RELINK', 'RELINK', ['RELINKED', { video: true }]]);
  assert.equal(m.state, 'viewer.watching');
  m.send('RELINK');
  m.send('RELINKED', { video: false });
  assert.equal(m.state, 'viewer.awaitingVideo');
  m.send('RESET');
  m.send('REJOIN');
  assert.equal(m.state, 'viewer.rejoining');
  assert.equal(m.can('JOIN'), false, 'a rejoin starts over through RESET');
  m.send('RESET');
  m.send('JOIN');
  assert.equal(m.state, 'viewer.joining');
});

test('session: RESET from every phase ends in idle and bumps the epoch', () => {
  for (const name of Object.keys(SESSION.states)) {
    const m = createMachine(SESSION);
    // walk to the state
    const path = {
      idle: [], 'host.capturing': ['SHARE'], 'host.registering': ['SHARE', 'CAPTURED'],
      'host.waiting': ['SHARE', 'CAPTURED', 'REGISTERED'], 'host.connecting': ['SHARE', 'CAPTURED', 'REGISTERED', 'VIEWER_FOUND'],
      'host.live': ['SHARE', 'CAPTURED', 'REGISTERED', 'VIEWER_FOUND', 'LINK_OPEN'],
      'host.relinking': ['SHARE', 'CAPTURED', 'REGISTERED', 'VIEWER_FOUND', 'LINK_OPEN', 'LINK_LOST'],
      'viewer.joining': ['JOIN'], 'viewer.awaitingVideo': ['JOIN', 'LINK_OPEN'], 'viewer.watching': ['JOIN', 'LINK_OPEN', 'VIDEO'],
      'viewer.relinking': ['JOIN', 'LINK_OPEN', 'VIDEO', 'RELINK'], 'viewer.rejoining': ['REJOIN'],
    }[name];
    assert.ok(path, `test needs a path to ${name}`);
    path.forEach((e) => assert.ok(m.send(e), `${e} on the way to ${name}`));
    assert.equal(m.state, name);
    const ep = m.epoch;
    m.send('RESET');
    assert.equal(m.state, 'idle');
    if (name !== 'idle') assert.equal(m.epoch, ep + 1, `epoch after leaving ${name}`);
  }
});

test('session: events from the other role are ignored', () => {
  const m = run(SESSION, ['SHARE', 'CAPTURED']);
  assert.equal(m.send('VIDEO'), false);
  assert.equal(m.send('RELINK'), false);
  const v = run(SESSION, ['JOIN']);
  assert.equal(v.send('VIEWER_FOUND'), false);
});
