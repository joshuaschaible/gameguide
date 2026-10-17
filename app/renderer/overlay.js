'use strict';
(function () {
  const toast = document.getElementById('toast');
  let toastOn = false;

  // Tell the main process when there's something to show, so the overlay
  // window only exists on screen while marks/toasts are visible.
  let reported = null;
  function report() {
    const active = marks.active || toastOn;
    if (active === reported) return;
    reported = active;
    window.bridge.overlayActive(active);
  }

  const marks = new window.Marks(document.getElementById('c'), null, {
    onActive: report,
    onIdle: report,
  });

  // Sound cue: tells the player a mark arrived, even if a fullscreen game
  // is covering the overlay. Toggle with Ctrl/Cmd+Shift+M or in the app.
  const soundOn = () => { try { return localStorage.getItem('app.sound') !== 'false'; } catch { return true; } };
  let ctx = null;
  // Each kind has its own minimum gap: a pen stroke beeps once, but every
  // reaction in a quick burst gets its own short pop.
  const MIN_GAP = { pen: 700, ping: 250, react: 60 };
  const lastBeep = {};
  let voices = 0;
  function beep(kind) {
    if (!soundOn()) return;
    const now = performance.now();
    if (now - (lastBeep[kind] || 0) < (MIN_GAP[kind] || 700)) return;
    if (voices >= 6) return; // never stack into a wall of noise
    lastBeep[kind] = now;
    try {
      ctx = ctx || new AudioContext();
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      const react = kind === 'react';
      // Reactions: short, quieter pop with a little random pitch so a burst
      // sounds lively instead of like one repeated tone.
      const f0 = kind === 'ping' ? 880 : react ? 900 + Math.random() * 400 : 660;
      const len = react ? 0.1 : 0.16;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.5, t + len * 0.5);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(react ? 0.12 : 0.18, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(ctx.destination);
      voices++;
      o.onended = () => { voices = Math.max(0, voices - 1); };
      o.start(t);
      o.stop(t + len + 0.02);
    } catch { /* ignore */ }
  }

  let toastTimer = null;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('on');
    toastOn = true;
    report();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('on');
      setTimeout(() => { toastOn = false; report(); }, 250);
    }, 1600);
  }

  window.bridge.onDraw((msg) => {
    marks.apply(msg);
    if (msg && msg.t === 'start') beep('pen');
    if (msg && msg.t === 'ping') beep('ping');
    if (msg && msg.t === 'react') beep('react');
    if (msg && msg.t === 'clear' && msg.local) showToast('Marks cleared');
    report();
  });
  window.bridge.onToggleSound(() => {
    const next = !soundOn();
    try { localStorage.setItem('app.sound', String(next)); } catch { /* ignore */ }
    const name = (window.bridge.brand && window.bridge.brand.name) || '';
    showToast(next ? `${name} sound on` : `${name} sound off`);
  });
  if (window.bridge.onToast) window.bridge.onToast((t) => showToast(String(t)));
  // If the system placed this window off from the game area (macOS menu bar),
  // size/offset the canvas to the game area so marks land where they belong.
  if (window.bridge.onOverlayFrame) {
    const canvas = document.getElementById('c');
    window.bridge.onOverlayFrame((f) => {
      if (!f || !f.fit) {
        canvas.style.left = canvas.style.top = canvas.style.width = canvas.style.height = '';
        canvas.style.inset = '';
      } else {
        canvas.style.inset = 'auto';
        canvas.style.left = `${-f.dx}px`;
        canvas.style.top = `${-f.dy}px`;
        canvas.style.width = `${f.w}px`;
        canvas.style.height = `${f.h}px`;
      }
      marks.redraw && marks.redraw();
    });
  }
  report();
})();
