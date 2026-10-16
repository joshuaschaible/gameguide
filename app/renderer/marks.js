'use strict';
// Shared mark renderer used by the friend's view and the player's overlay.
// Messages use normalized coordinates (0..1) relative to the shared source.
//   {t:'start', id, x, y, c}  {t:'move', id, x, y}  {t:'end', id}
//   {t:'ping', x, y, c}       {t:'clear'}
// Renders only while there is something to show; when idle it stops its
// animation loop entirely so it costs nothing (important over a running game).
(function () {
  const HOLD_MS = 4000;  // marks stay fully visible this long after drawing stops
  const FADE_MS = 700;   // then fade out over this long
  const PING_MS = 1600;

  class Marks {
    // rectFn() returns the area (CSS px, relative to the canvas) that maps to 0..1.
    // opts.onActive / opts.onIdle fire when marks appear / all have faded.
    constructor(canvas, rectFn, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.rectFn = rectFn || (() => ({ x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight }));
      this.opts = opts || {};
      this.strokes = new Map();
      this.pings = [];
      this.running = false;
      this._loop = this._loop.bind(this);
    }

    get active() { return this.strokes.size > 0 || this.pings.length > 0; }

    _wake() {
      if (this.running) return;
      this.running = true;
      if (this.opts.onActive) this.opts.onActive();
      requestAnimationFrame(this._loop);
    }

    apply(msg) {
      if (!msg || typeof msg !== 'object') return;
      const now = performance.now();
      const ok = (v) => typeof v === 'number' && v >= -0.05 && v <= 1.05;
      switch (msg.t) {
        case 'start':
          if (!ok(msg.x) || !ok(msg.y)) return;
          this.strokes.set(msg.id, { pts: [[msg.x, msg.y]], c: safeColor(msg.c), last: now, done: false });
          break;
        case 'move': {
          const s = this.strokes.get(msg.id);
          if (!s || !ok(msg.x) || !ok(msg.y)) return;
          s.pts.push([msg.x, msg.y]);
          s.last = now;
          break;
        }
        case 'end': {
          const s = this.strokes.get(msg.id);
          if (s) { s.done = true; s.last = now; }
          break;
        }
        case 'ping':
          if (!ok(msg.x) || !ok(msg.y)) return;
          this.pings.push({ x: msg.x, y: msg.y, c: safeColor(msg.c), at: now });
          break;
        case 'clear':
          this.strokes.clear();
          this.pings = [];
          break;
        default:
          return;
      }
      this._wake();
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(this.canvas.clientWidth * dpr);
      const h = Math.round(this.canvas.clientHeight * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _loop() {
      this._resize();
      const ctx = this.ctx;
      const now = performance.now();
      ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

      // prune expired marks first
      for (const [id, s] of this.strokes) {
        if (now - s.last >= HOLD_MS + FADE_MS) this.strokes.delete(id);
      }
      this.pings = this.pings.filter((p) => now - p.at < PING_MS);

      if (!this.active) {
        // Nothing left: canvas is cleared, stop looping until the next mark.
        this.running = false;
        if (this.opts.onIdle) this.opts.onIdle();
        return;
      }

      const r = this.rectFn();
      if (r && r.w > 0 && r.h > 0) {
        const px = (p) => [r.x + p[0] * r.w, r.y + p[1] * r.h];
        const lw = Math.max(3, Math.min(r.w, r.h) * 0.007);

        for (const s of this.strokes.values()) {
          const age = now - s.last;
          // Unfinished strokes that go silent (lost "end") still fade.
          ctx.globalAlpha = age < HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          // dark outline so marks read on bright and dark game scenes
          for (const pass of [0, 1]) {
            ctx.strokeStyle = pass === 0 ? outlineFor(s.c) : s.c;
            ctx.lineWidth = pass === 0 ? lw + 3 : lw;
            ctx.beginPath();
            const p0 = px(s.pts[0]);
            ctx.moveTo(p0[0], p0[1]);
            if (s.pts.length === 1) ctx.lineTo(p0[0] + 0.01, p0[1]);
            for (let i = 1; i < s.pts.length; i++) {
              const p = px(s.pts[i]);
              ctx.lineTo(p[0], p[1]);
            }
            ctx.stroke();
          }
        }

        for (const p of this.pings) {
          const k = (now - p.at) / PING_MS;
          const [x, y] = px([p.x, p.y]);
          const base = Math.max(10, Math.min(r.w, r.h) * 0.018);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = p.c;
          ctx.lineWidth = Math.max(3, base * 0.25);
          for (const m of [0, 0.35]) {
            const kk = Math.min(1, k + m);
            ctx.beginPath();
            ctx.arc(x, y, base * (0.6 + kk * 2.4), 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(x, y, base * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      requestAnimationFrame(this._loop);
    }
  }

  // Dark outline for light colors, light outline for dark ones, so every
  // color reads on both bright and dark game scenes.
  function outlineFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum < 0.35 ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
  }

  function safeColor(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ff3b6b';
  }

  window.Marks = Marks;
})();
