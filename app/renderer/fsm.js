'use strict';
/* Tiny state machines: one named state at a time, a table of allowed moves.
 *
 * Works in the main process (require), the pages (window.FSM) and plain Node
 * (unit tests, the docs generator). No dependencies.
 *
 * A definition is plain data, so it can be tested and drawn:
 *   {
 *     id: 'drawings',
 *     initial: 'shown',
 *     on: { RESET: 'shown' },                 // allowed from every state (a state can override)
 *     states: {
 *       shown:  { desc: '...', on: { TOGGLE: 'hiding' } },
 *       hiding: { desc: '...', after: { 2200: 'TIMEOUT' }, on: { TOGGLE: 'shown', TIMEOUT: 'hidden' } },
 *       // a target can also be a list of { target, when(data) }: the first match wins
 *     },
 *   }
 *
 * Rules the machine enforces:
 *  - send(EVENT) only moves along a listed transition; anything else is ignored
 *    (returns false, recorded in history as ignored). Nothing throws.
 *  - "after" timers belong to the state: leaving the state cancels them, so a
 *    timer can never fire into a later state.
 *  - epoch counts entries into the initial state. Code that awaits something
 *    can save the epoch first and bail if it changed (the thing it was working
 *    for has ended in the meantime).
 *  - Listeners run after the state has changed; they get { from, to, event, data }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSM = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const HISTORY = 40;

  function candidates(def, state, event) {
    const st = def.states[state];
    const own = st && st.on && Object.prototype.hasOwnProperty.call(st.on, event) ? st.on[event] : undefined;
    const raw = own !== undefined ? own : (def.on && def.on[event]);
    if (raw === undefined || raw === null) return [];
    return (Array.isArray(raw) ? raw : [raw]).map((t) => (typeof t === 'string' ? { target: t } : t));
  }

  function resolve(def, state, event, data) {
    for (const c of candidates(def, state, event)) {
      if (!c.when || c.when(data)) return c.target;
    }
    return null;
  }

  // Throws on a broken definition (unknown targets, timers firing unknown events).
  function validate(def) {
    const problems = [];
    if (!def || !def.id) problems.push('missing id');
    if (!def.states || !def.states[def.initial]) problems.push(`initial state "${def.initial}" is not defined`);
    const names = Object.keys(def.states || {});
    const check = (where, raw) => {
      for (const t of (Array.isArray(raw) ? raw : [raw])) {
        const target = typeof t === 'string' ? t : t && t.target;
        if (!names.includes(target)) problems.push(`${where} -> unknown state "${target}"`);
      }
    };
    for (const [ev, raw] of Object.entries(def.on || {})) check(`(any) ${ev}`, raw);
    for (const [name, st] of Object.entries(def.states || {})) {
      for (const [ev, raw] of Object.entries(st.on || {})) check(`${name} ${ev}`, raw);
      for (const [ms, ev] of Object.entries(st.after || {})) {
        if (!(Number(ms) > 0)) problems.push(`${name} after "${ms}" is not a delay`);
        if (!candidates(def, name, ev).length) problems.push(`${name} after ${ms} sends ${ev}, which ${name} does not handle`);
      }
    }
    if (problems.length) throw new Error(`state machine "${def && def.id}": ${problems.join('; ')}`);
    return true;
  }

  // Every edge, for docs and tests: [{ from, event, to, guarded }]
  function edges(def) {
    const out = [];
    for (const name of Object.keys(def.states)) {
      const events = new Set([...Object.keys(def.states[name].on || {}), ...Object.keys(def.on || {})]);
      for (const ev of events) {
        const list = candidates(def, name, ev);
        for (const c of list) out.push({ from: name, event: ev, to: c.target, guarded: !!c.when || list.length > 1 });
      }
    }
    return out;
  }

  function toMermaid(def, opts) {
    const skipGlobal = !(opts && opts.showGlobal);
    const id = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
    const lines = ['stateDiagram-v2', `  [*] --> ${id(def.initial)}`];
    for (const name of Object.keys(def.states)) {
      if (name !== id(name)) lines.push(`  state "${name}" as ${id(name)}`);
    }
    const seen = new Set();
    for (const e of edges(def)) {
      const own = def.states[e.from].on && Object.prototype.hasOwnProperty.call(def.states[e.from].on, e.event);
      if (skipGlobal && !own) continue;
      const key = `${e.from}|${e.event}|${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${id(e.from)} --> ${id(e.to)}: ${e.event}${e.guarded ? ' *' : ''}`);
    }
    for (const [name, st] of Object.entries(def.states)) {
      for (const [ms, ev] of Object.entries(st.after || {})) lines.push(`  note right of ${id(name)}: after ${ms} ms sends ${ev}`);
    }
    return lines.join('\n');
  }

  function createMachine(def, opts) {
    validate(def);
    const o = opts || {};
    const now = o.now || (() => Date.now());
    let state = def.initial;
    let since = now();
    let epoch = 0;
    let timers = [];
    const listeners = new Set();
    const history = [];

    const remember = (entry) => {
      history.push(entry);
      if (history.length > HISTORY) history.shift();
    };
    const clearTimers = () => { timers.forEach((t) => clearTimeout(t)); timers = []; };
    const startTimers = () => {
      const after = def.states[state].after;
      if (!after) return;
      const at = state;
      for (const [ms, ev] of Object.entries(after)) {
        timers.push(setTimeout(() => { if (state === at) machine.send(ev); }, Number(ms)));
      }
    };

    const machine = {
      id: def.id,
      def,
      get state() { return state; },
      get since() { return since; },
      get epoch() { return epoch; },
      // is('host') matches 'host' and every 'host.*' state.
      is(...names) { return names.some((n) => state === n || state.startsWith(`${n}.`)); },
      can(event, data) { return resolve(def, state, event, data) !== null; },
      send(event, data) {
        const target = resolve(def, state, event, data);
        if (target === null) {
          remember({ at: now(), from: state, to: state, event, ignored: true });
          if (o.onIgnored) o.onIgnored({ state, event, data });
          return false;
        }
        const from = state;
        remember({ at: now(), from, to: target, event });
        if (target !== from) {
          clearTimers();
          state = target;
          since = now();
          if (target === def.initial) epoch += 1;
          startTimers();
          if (o.log) o.log(`state: ${def.id} ${from} -> ${target} (${event})`);
        }
        for (const fn of [...listeners]) {
          try { fn({ from, to: target, event, data }); } catch (e) { if (o.onError) o.onError(e); else throw e; }
        }
        return true;
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // For logs, Copy details, tests and agents.
      snapshot(n) {
        const t = now();
        return {
          id: def.id,
          state,
          forMs: t - since,
          desc: (def.states[state] && def.states[state].desc) || '',
          epoch,
          history: history.slice(-(n || 10)).map((h) => ({ ...h, agoMs: t - h.at })),
        };
      },
      dispose() { clearTimers(); listeners.clear(); },
    };
    return machine;
  }

  return { createMachine, validate, edges, toMermaid };
}));
