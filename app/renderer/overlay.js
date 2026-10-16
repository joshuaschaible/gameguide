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
  let lastBeep = 0;
  function beep(kind) {
    if (!soundOn()) return;
    const now = performance.now();
    if (now - lastBeep < 700) return;
    lastBeep = now;
    try {
      ctx = ctx || new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(kind === 'ping' ? 880 : 660, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(kind === 'ping' ? 1320 : 990, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.18);
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
  report();
})();
