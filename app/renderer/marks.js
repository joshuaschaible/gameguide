'use strict';
// Shared mark renderer used by the friend's view and the player's overlay.
// Messages use normalized coordinates (0..1) relative to the shared source.
//   {t:'start', id, x, y, c}  {t:'move', id, x, y}  {t:'end', id}
//   {t:'ping', x, y, c}       {t:'clear'}
//   {t:'react', e, x}         emoji reaction floating up from (x, near bottom)
//   {t:'arrow', id, x1, y1, x2, y2, c, h, done}  arrow; resent while dragging (same id)
//   {t:'laser', x, y, c, ts} / {t:'laser', off:true}  live pointer dot with a short trail
//     (ts = sender's clock; the receiver replays a little behind, interpolating, so it glides)
// Renders only while there is something to show; when idle it stops its
// animation loop entirely so it costs nothing (important over a running game).
(function () {
  const HOLD_MS = 3000;  // default: marks stay fully visible this long after drawing stops
  // The person drawing picks how long their marks stay (1-10 s); it rides in the
  // stroke's start message as `h` so both screens fade it at the same time.
  const holdFor = (h) => (typeof h === 'number' && h >= 1 && h <= 10 ? h * 1000 : HOLD_MS);
  const FADE_MS = 700;   // then fade out over this long
  const PING_MS = 1600;
  const REACT_MS = 2600;
  const LASER_IDLE_MS = 1500; // dot disappears this long after the last update
  const LASER_TRAIL_MS = 260;
  const LASER_DELAY_MS = 50;  // playout delay on the receiving side (soaks up network jitter)
  // Catmull-Rom through 4 points: smooth curve that passes through every sample.
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t; const t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  // Only these can be shown (nothing else ever gets drawn on the player's screen).
  const REACTIONS = ['👍', '😂', '😮', '🔥', '❤️', '👀', '💀', '🎉'];

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
      this.reactions = [];
      this.arrows = new Map();
      this.laser = null;
      this.running = false;
      this._loop = this._loop.bind(this);
    }

    // The person moving the pointer sees it with no delay; everyone else a little behind.
    laserDelay() { return typeof this.opts.laserDelay === 'number' ? this.opts.laserDelay : LASER_DELAY_MS; }

    get active() { return this.strokes.size > 0 || this.pings.length > 0 || this.reactions.length > 0 || this.arrows.size > 0 || !!this.laser; }

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
          this.strokes.set(msg.id, { pts: [[msg.x, msg.y]], c: safeColor(msg.c), last: now, done: false, hold: holdFor(msg.h) });
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
        case 'react': {
          if (!REACTIONS.includes(msg.e)) return;
          const x = typeof msg.x === 'number' ? Math.min(0.95, Math.max(0.05, msg.x)) : 0.82;
          if (this.reactions.length > 40) this.reactions.shift();
          this.reactions.push({ e: msg.e, x, at: now, sway: Math.random() * Math.PI * 2 });
          break;
        }
        case 'arrow': {
          if (!ok(msg.x1) || !ok(msg.y1) || !ok(msg.x2) || !ok(msg.y2) || typeof msg.id !== 'string') return;
          const a = this.arrows.get(msg.id) || { c: safeColor(msg.c), hold: holdFor(msg.h) };
          Object.assign(a, { x1: msg.x1, y1: msg.y1, x2: msg.x2, y2: msg.y2, last: now, done: !!msg.done });
          if (this.arrows.size > 60 && !this.arrows.has(msg.id)) this.arrows.delete(this.arrows.keys().next().value);
          this.arrows.set(msg.id, a);
          break;
        }
        case 'laser': {
          if (msg.off) { if (this.laser) this.laser.offAt = now; break; }
          if (!ok(msg.x) || !ok(msg.y)) return;
          let L = this.laser;
          if (!L || L.offAt) L = this.laser = { samples: [], offset: undefined, lastAt: now };
          // Map the sender's clock onto ours: the smallest (arrival - sent) seen,
          // allowed to drift up slowly in case the network gets slower.
          const ts = typeof msg.ts === 'number' ? msg.ts : now;
          const o = now - ts;
          L.offset = L.offset === undefined ? o : Math.min(o, L.offset + (now - L.lastAt) * 0.05);
          L.lastAt = now;
          L.c = safeColor(msg.c);
          const t = ts + L.offset;
          const last = L.samples[L.samples.length - 1];
          if (last && t <= last[2]) break; // out of order / duplicate
          L.samples.push([msg.x, msg.y, t]);
          if (L.samples.length > 240) L.samples.splice(0, L.samples.length - 240);
          break;
        }
        case 'clear':
          this.strokes.clear();
          this.pings = [];
          this.arrows.clear();
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
        if (now - s.last >= s.hold + FADE_MS) this.strokes.delete(id);
      }
      this.pings = this.pings.filter((p) => now - p.at < PING_MS);
      this.reactions = this.reactions.filter((q) => now - q.at < REACT_MS);
      for (const [id, a] of this.arrows) {
        if (now - a.last >= a.hold + FADE_MS) this.arrows.delete(id);
      }
      if (this.laser) {
        const L = this.laser;
        if ((L.offAt && now - L.offAt > 180) || now - L.lastAt > LASER_IDLE_MS) this.laser = null;
        else {
          const keepFrom = now - this.laserDelay() - LASER_TRAIL_MS - 200;
          while (L.samples.length > 4 && L.samples[1][2] < keepFrom) L.samples.shift();
        }
      }

      if (!this.active) {
        // Nothing left: canvas is cleared, stop looping until the next mark.
        this.running = false;
        if (this.opts.onIdle) this.opts.onIdle();
        return;
      }

      const r = this.rectFn();
      if (r && r.w > 0 && r.h > 0) {
        const px = (p) => [r.x + p[0] * r.w, r.y + p[1] * r.h];
        // Sizes follow the picture, but not a viewer's zoom (r.z): marks keep
        // the same on-screen thickness when zoomed in.
        const unit = Math.min(r.w, r.h) / (r.z || 1);
        const lw = Math.max(3, unit * 0.007);

        for (const s of this.strokes.values()) {
          const age = now - s.last;
          // Unfinished strokes that go silent (lost "end") still fade.
          ctx.globalAlpha = age < s.hold ? 1 : Math.max(0, 1 - (age - s.hold) / FADE_MS);
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
          const base = Math.max(10, unit * 0.018);
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

        // Arrows: straight shaft + filled head, same outline trick as strokes.
        for (const a of this.arrows.values()) {
          const age = now - a.last;
          const alpha = !a.done || age < a.hold ? 1 : Math.max(0, 1 - (age - a.hold) / FADE_MS);
          const [x1, y1] = px([a.x1, a.y1]);
          const [x2, y2] = px([a.x2, a.y2]);
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (len < 2) continue;
          const head = Math.min(len * 0.45, Math.max(16, lw * 5.5));
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const hx = x2 - Math.cos(ang) * head * 0.8;
          const hy = y2 - Math.sin(ang) * head * 0.8;
          ctx.globalAlpha = alpha;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          for (const pass of [0, 1]) {
            const color = pass === 0 ? outlineFor(a.c) : a.c;
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = (pass === 0 ? lw + 3 : lw) * 1.2;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            const grow = pass === 0 ? 2.5 : 0;
            ctx.beginPath();
            ctx.moveTo(x2 + Math.cos(ang) * grow, y2 + Math.sin(ang) * grow);
            ctx.lineTo(x2 - Math.cos(ang - 0.45) * (head + grow), y2 - Math.sin(ang - 0.45) * (head + grow));
            ctx.lineTo(x2 - Math.cos(ang + 0.45) * (head + grow), y2 - Math.sin(ang + 0.45) * (head + grow));
            ctx.closePath();
            ctx.fill();
          }
        }

        // Laser: glowing dot gliding along a smooth curve, with a tapered trail.
        if (this.laser && this.laser.samples.length) {
          const L = this.laser;
          const fade = L.offAt ? Math.max(0, 1 - (now - L.offAt) / 180) : Math.min(1, Math.max(0, 1 - (now - L.lastAt - LASER_IDLE_MS + 300) / 300));
          const rad = Math.max(6, unit * 0.009);
          const tNow = now - this.laserDelay();
          const at = (t) => laserPos(L.samples, t);
          // trail: sample the curve every ~6 ms over the last LASER_TRAIL_MS
          const steps = Math.ceil(LASER_TRAIL_MS / 6);
          let prev = px(at(tNow - LASER_TRAIL_MS));
          ctx.lineCap = 'round';
          ctx.strokeStyle = L.c;
          for (let i = 1; i <= steps; i++) {
            const k = i / steps; // 0 = tail, 1 = head
            const cur = px(at(tNow - LASER_TRAIL_MS * (1 - k)));
            if (Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) > 0.3) {
              ctx.globalAlpha = fade * 0.6 * k * k;
              ctx.lineWidth = rad * (0.25 + 1.35 * k);
              ctx.beginPath();
              ctx.moveTo(prev[0], prev[1]);
              ctx.lineTo(cur[0], cur[1]);
              ctx.stroke();
            }
            prev = cur;
          }
          const [lx, ly] = px(at(tNow));
          this.laserDrawnAt = [lx, ly, tNow]; // (for tests)
          ctx.globalAlpha = fade;
          const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, rad * 3.2);
          g.addColorStop(0, L.c);
          g.addColorStop(0.3, L.c);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(lx, ly, rad * 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(lx, ly, rad * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }

        // Reactions: pop in near the bottom, float up with a little sway, fade out.
        const size = Math.max(34, unit * 0.075);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const q of this.reactions) {
          const k = (now - q.at) / REACT_MS;
          const rise = 1 - Math.pow(1 - k, 2); // ease-out
          const x = r.x + (q.x + Math.sin(q.sway + k * 5) * 0.012) * r.w;
          const y = r.y + (0.9 - rise * 0.45) * r.h;
          const pop = k < 0.08 ? 0.6 + (k / 0.08) * 0.5 : k < 0.14 ? 1.1 - ((k - 0.08) / 0.06) * 0.1 : 1;
          ctx.globalAlpha = k < 0.06 ? k / 0.06 : k > 0.6 ? Math.max(0, 1 - (k - 0.6) / 0.4) : 1;
          ctx.font = `${Math.round(size * pop)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
          ctx.shadowColor = 'rgba(0,0,0,0.35)';
          ctx.shadowBlur = 8;
          ctx.fillText(q.e, x, y);
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
      }
      requestAnimationFrame(this._loop);
    }
  }

  // Position on the laser path at time t (samples: [x, y, time], oldest first).
  function laserPos(sm, t) {
    const n = sm.length;
    if (n === 1 || t <= sm[0][2]) return [sm[0][0], sm[0][1]];
    if (t >= sm[n - 1][2]) return [sm[n - 1][0], sm[n - 1][1]]; // never guess ahead
    let i = n - 2;
    while (i > 0 && sm[i][2] > t) i--;
    const a = sm[Math.max(0, i - 1)]; const b = sm[i]; const c = sm[i + 1]; const d = sm[Math.min(n - 1, i + 2)];
    const k = (t - b[2]) / Math.max(1, c[2] - b[2]);
    return [cr(a[0], b[0], c[0], d[0], k), cr(a[1], b[1], c[1], d[1], k)];
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
  window.Marks.REACTIONS = REACTIONS;
})();
