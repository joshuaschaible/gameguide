// Unit tests for the state machine helper (app/renderer/fsm.js). Plain Node:
//   node --test test/unit
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, validate, edges, toMermaid } = require('../../app/renderer/fsm.js');

const LIGHT = {
  id: 'light',
  initial: 'off',
  on: { RESET: 'off' },
  states: {
    off: { on: { FLIP: 'on' } },
    on: { on: { FLIP: 'off', DIM: [{ target: 'dim', when: (d) => d && d.level < 50 }, { target: 'on' }] } },
    dim: { after: { 30: 'FADE' }, on: { FLIP: 'off', FADE: 'off' } },
  },
};

test('moves only along listed transitions', () => {
  const m = createMachine(LIGHT);
  assert.equal(m.state, 'off');
  assert.equal(m.send('DIM'), false, 'DIM is not allowed from off');
  assert.equal(m.state, 'off');
  assert.equal(m.send('FLIP'), true);
  assert.equal(m.state, 'on');
  assert.equal(m.can('FLIP'), true);
  assert.equal(m.can('NOPE'), false);
});

test('ignored events are recorded, not thrown', () => {
  const seen = [];
  const m = createMachine(LIGHT, { onIgnored: (x) => seen.push(x) });
  m.send('FADE');
  assert.deepEqual(seen.map((x) => x.event), ['FADE']);
  assert.equal(m.snapshot().history[0].ignored, true);
});

test('guards pick the first matching target', () => {
  const m = createMachine(LIGHT);
  m.send('FLIP');
  m.send('DIM', { level: 80 });
  assert.equal(m.state, 'on');
  m.send('DIM', { level: 10 });
  assert.equal(m.state, 'dim');
});

test('global events apply in every state', () => {
  const m = createMachine(LIGHT);
  m.send('FLIP');
  m.send('RESET');
  assert.equal(m.state, 'off');
});

test('"after" timers fire, and are cancelled when the state is left', async () => {
  const m = createMachine(LIGHT);
  m.send('FLIP'); m.send('DIM', { level: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(m.state, 'off', 'FADE fired');
  m.send('FLIP'); m.send('DIM', { level: 1 });
  m.send('FLIP'); // leave dim before the timer
  m.send('FLIP'); // on again
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(m.state, 'on', 'old timer did not fire into the new state');
});

test('epoch counts entries into the initial state', () => {
  const m = createMachine(LIGHT);
  assert.equal(m.epoch, 0);
  m.send('FLIP');
  const ep = m.epoch;
  m.send('RESET');
  assert.notEqual(m.epoch, ep, 'a continuation saved before RESET can tell');
  m.send('RESET'); // off -> off: nothing ended, epoch stays
  assert.equal(m.epoch, ep + 1);
});

test('is() matches a state and its dotted children', () => {
  const m = createMachine({ id: 'x', initial: 'a', states: { a: { on: { GO: 'host.live' } }, 'host.live': {} } });
  m.send('GO');
  assert.ok(m.is('host'));
  assert.ok(m.is('host.live'));
  assert.ok(!m.is('hos'));
  assert.ok(m.is('a', 'host'));
});

test('listeners run after the change and see from/to/event', () => {
  const m = createMachine(LIGHT);
  const calls = [];
  m.subscribe((t) => calls.push([t.from, t.to, t.event, m.state]));
  m.send('FLIP');
  assert.deepEqual(calls, [['off', 'on', 'FLIP', 'on']]);
});

test('validate catches broken definitions', () => {
  assert.throws(() => validate({ id: 'b', initial: 'nope', states: { a: {} } }), /initial state/);
  assert.throws(() => validate({ id: 'b', initial: 'a', states: { a: { on: { X: 'zzz' } } } }), /unknown state "zzz"/);
  assert.throws(() => validate({ id: 'b', initial: 'a', states: { a: { after: { 10: 'T' } } } }), /does not handle/);
});

test('edges and mermaid list every transition', () => {
  const e = edges(LIGHT);
  assert.ok(e.some((x) => x.from === 'dim' && x.event === 'FADE' && x.to === 'off'));
  assert.ok(e.some((x) => x.from === 'on' && x.event === 'DIM' && x.guarded));
  const mm = toMermaid(LIGHT);
  assert.match(mm, /^stateDiagram-v2/);
  assert.match(mm, /dim --> off: FADE/);
  assert.match(mm, /after 30 ms sends FADE/);
});
