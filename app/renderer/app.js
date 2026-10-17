'use strict';
/* Renderer. The product name comes from brand.json (bridge.brand).
 *
 * How connecting works:
 *  - The player picks a screen and gets a 6-character code. The code is their
 *    address on the free PeerJS signaling service (0.peerjs.com).
 *  - The friend types the code. Both apps exchange connection info through
 *    that service automatically, then video + drawings flow directly between
 *    the two computers (WebRTC). If a direct path is blocked, the built-in
 *    TURN relay carries it instead. Nothing needs copying back.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const bridge = window.bridge;
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const BRAND = bridge.brand || { name: 'App', id: 'app' };
  const NAME = BRAND.name;
  const ID_PREFIX = `${BRAND.id}-v1-`;

  // ---------- local storage helpers ----------
  // One-time move of settings saved by older versions (keys used to start with "gg.").
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('gg.') && localStorage.getItem(`app.${k.slice(3)}`) === null) localStorage.setItem(`app.${k.slice(3)}`, localStorage.getItem(k));
    }
  } catch { /* ignore */ }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  const S = {
    name: store.get('app.name', ''),
    avatar: null,        // set at boot from storage (or a random built-in)
    peerProfile: null,   // { name, avatar } of the other player while connected
    role: null,          // 'share' | 'join'
    peer: null,
    conn: null,          // data connection (drawings)
    call: null,          // media connection (video)
    stream: null,        // player's captured screen
    code: null,
    friend: null,
    ended: true,
    timers: [],
    log: [],
    info: { version: '?', platform: navigator.platform, arch: '' },
  };

  function log(msg) {
    const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
    S.log.push(line);
    if (S.log.length > 300) S.log.shift();
    console.log('[app]', msg);
  }

  // ---------- views ----------
  const STEPS = ['step-name', 'step-role', 'step-pick', 'step-share', 'step-join', 'step-watch'];
  function show(id) {
    for (const s of STEPS) $(s).hidden = s !== id;
    $('end').hidden = !['step-share', 'step-watch'].includes(id) && !(id === 'step-join' && !S.ended);
    renderChips();
  }
  // Figma-style chips of who's in the session (you + the other player).
  function renderChips() {
    const box = $('chips');
    box.innerHTML = '';
    const add = (name, avatar, isYou) => {
      const chip = document.createElement('span');
      chip.className = isYou ? 'chip' : 'chip peer';
      chip.title = isYou ? `${name} (you)` : name;
      chip.appendChild(window.Profile.render(avatar, name, 26));
      const n = document.createElement('span');
      n.className = 'chip-name';
      n.textContent = name;
      chip.appendChild(n);
      if (isYou && S.peerProfile) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'you';
        chip.appendChild(you);
      }
      box.appendChild(chip);
    };
    if (S.peerProfile) add(S.peerProfile.name, S.peerProfile.avatar, false);
    if (S.name) add(S.name, S.avatar, true);
  }
  // pv = profile version; changes whenever my name/avatar changes, so the
  // other side can tell (from heartbeats) that its copy is out of date.
  function myProfileMsg() { return { t: 'hello', name: S.name, avatar: S.avatar, pv: S.profileVer }; }
  function bumpProfile() { S.profileVer = Date.now(); store.set('app.profileVer', S.profileVer); }
  // Control messages go on every open path (drawing link + video connection).
  function sendCtl(msg) {
    try { if (S.conn && S.conn.open) S.conn.send(msg); } catch { /* ignore */ }
    try { if (S.drawDc && S.drawDc.readyState === 'open') S.drawDc.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
  // Heartbeat says which profile version the other side has; ask for it if ours is stale.
  function checkPeerPv(pv) {
    if (!pv || (S.peerProfile && S.peerProfile.pv === pv)) return;
    const now = Date.now();
    if (now - (S.profileAskedAt || 0) < 3000) return;
    S.profileAskedAt = now;
    sendCtl({ t: 'profile?' });
  }
  function handleCtl(m) {
    if (m.t === 'hello') {
      if (S.role === 'join') S.friend = String(m.name || '').slice(0, 24) || 'your friend';
      takePeerProfile(m);
      return true;
    }
    if (m.t === 'profile?') { sendCtl(myProfileMsg()); return true; }
    if (m.t === 'hb') { checkPeerPv(m.pv); return true; }
    return false;
  }
  function takePeerProfile(msg) {
    const name = String(msg.name || '').slice(0, 24) || 'Friend';
    const changed = S.peerProfile && (S.peerProfile.name !== name || JSON.stringify(S.peerProfile.avatar) !== JSON.stringify(window.Profile.sanitize(msg.avatar)));
    S.peerProfile = { name, avatar: window.Profile.sanitize(msg.avatar), pv: msg.pv || null };
    if (changed) log(`friend updated their profile (${name})`);
    renderChips();
  }

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = `status ${kind || ''}`.trim();
  }

  // ---------- ICE / signaling config ----------
  function iceServers() {
    const override = store.get('app.ice', null); // used by automated tests
    if (Array.isArray(override)) return override;
    const list = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // PeerJS's free public relay: used only when a direct path fails.
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    ];
    const t = store.get('app.turn', null);
    if (t && t.url) list.push({ urls: t.url, username: t.user || undefined, credential: t.pass || undefined });
    return list;
  }
  function peerOptions() {
    const relayOnly = store.get('app.relayOnly', false);
    const opts = {
      debug: 1,
      config: { iceServers: iceServers(), iceTransportPolicy: relayOnly ? 'relay' : 'all' },
      pingInterval: 5000,
    };
    const signal = store.get('app.signal', null); // used by automated tests
    if (signal && typeof signal === 'object') Object.assign(opts, signal);
    return opts;
  }

  // ---------- session cleanup ----------
  function clearTimers() { S.timers.forEach(clearTimeout); S.timers = []; }
  function later(ms, fn) { const t = setTimeout(fn, ms); S.timers.push(t); return t; }

  function teardown() {
    S.ended = true;
    clearTimers();
    clearInterval(S.statsTimer);
    clearInterval(S.linkWatch);
    stopHeartbeat();
    clearTimeout(S.relinkTimer);
    S.relinking = false;
    S.relinkTries = 0;
    S.peerHb = false;
    S.awaitRelink = null;
    S.native = null;
    try { S.call && S.call.close(); } catch { /* ignore */ }
    // Say goodbye on the drawing link (so the other side ends right away
    // instead of trying to rebuild it), then close a moment later.
    const conn = S.conn;
    const peer = S.peer;
    let bye = false;
    try { if (conn && conn.open) { conn.send({ t: 'bye' }); bye = true; } } catch { /* ignore */ }
    const finish = () => {
      try { conn && conn.close(); } catch { /* ignore */ }
      try { peer && peer.destroy(); } catch { /* ignore */ }
    };
    if (bye) setTimeout(finish, 300); else finish();
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.call = S.conn = S.peer = S.stream = null;
    S.playerStat = null;
    S.viewerStat = null;
    S.source = null;
    S.peerProfile = null;
    S.peerUpdating = false;
    if (document.getElementById('chips')) renderChips();
    S.trackState = null;
    S.codecOverride = null;
    S.videoRecoveries = [];
    S.encoderStalls = [];
    S.netCapMbps = null;
    S.lastSendMbps = null;
    S.lastEncoder = S.lastCodec = '';
    S.drawDc = null;
    S.drawSession = null;
    S.drawSeq = 0;
    if (S.rx) clearTimeout(S.rx.timer);
    S.rx = null;
    S.swFixes = [];
    S.swFallbackSince = null;
    S.overlayTargetId = null;
    const fz = document.getElementById('freeze'); if (fz) fz.hidden = true;
    S.friend = null;
    $('video').srcObject = null;
    if (bridge) bridge.closeOverlay();
    const oh = document.getElementById('overlay-hidden'); if (oh) oh.hidden = true;
  }

  function endSession(note) {
    S.awaitReturn = null;
    try { localStorage.removeItem('app.resume'); } catch { /* ignore */ }
    log(`session ended${note ? `: ${note}` : ''}`);
    teardown();
    S.role = null;
    $('role-note').hidden = !note;
    $('role-note').textContent = note || '';
    show('step-role');
  }

  // ---------- connection route (for status + details) ----------
  async function describeRoute(pc) {
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId) || {};
      const remote = stats.get(pair.remoteCandidateId) || {};
      // Which network each end uses (lan / tailscale / ipv6 ...), no full IPs.
      const netKind = (c) => {
        const a = String(c.address || c.ip || '');
        if (!a) return '?';
        if (/\.local$/i.test(a)) return 'hidden';
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0/i.test(a)) return 'tailscale';
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) return 'lan';
        if (/^169\.254\./.test(a) || /^fe80/i.test(a)) return 'link-local';
        return a.includes(':') ? 'ipv6' : 'public';
      };
      const where = (c) => `${netKind(c)}${c.networkType && c.networkType !== 'unknown' ? ` ${c.networkType}` : ''}`;
      const relayed = local.candidateType === 'relay' || remote.candidateType === 'relay';
      const lan = local.candidateType === 'host' && remote.candidateType === 'host';
      return {
        kind: relayed ? 'relay' : lan ? 'lan' : 'internet',
        label: relayed ? 'backup connection' : lan ? 'same network' : 'over the internet',
        local: `${local.candidateType || '?'}/${local.protocol || '?'} ${where(local)}`,
        remote: `${remote.candidateType || '?'}/${remote.protocol || '?'} ${where(remote)}`,
        rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      };
    } catch { return null; }
  }

  function watchPc(pc, label) {
    if (!pc) return;
    pc.addEventListener('iceconnectionstatechange', () => log(`${label} ICE: ${pc.iceConnectionState}`));
    pc.addEventListener('connectionstatechange', () => log(`${label} connection: ${pc.connectionState}`));
    pc.addEventListener('icegatheringstatechange', () => log(`${label} ICE gathering: ${pc.iceGatheringState}`));
  }

  function friendlyPeerError(err) {
    const t = err && err.type;
    switch (t) {
      case 'peer-unavailable':
        return `No one is sharing with that code right now. Check the code, and make sure your friend still has ${NAME} open on the code screen.`;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        return "Couldn't get online. Check that this computer is connected to the internet, then try again.";
      case 'browser-incompatible':
        return 'This build is missing WebRTC support.';
      case 'webrtc':
        return 'Couldn\'t connect to your friend. Try again. If it keeps failing, open Settings > Advanced and turn on "Always use the backup connection" on both computers.';
      default:
        return `Connection problem (${t || 'unknown'}). Try again.`;
    }
  }

  // =====================================================================
  // STREAM QUALITY
  // =====================================================================
  const QUALITY_DEFAULTS = { res: '1080', fps: 60, mbps: 12, prefer: 'balanced', codec: 'h264' };
  function quality() { return Object.assign({}, QUALITY_DEFAULTS, store.get('app.quality', {}) || {}); }
  // The bitrate actually used: the chosen max, lowered for this session when the
  // network keeps dropping the video (S.netCapMbps).
  function effectiveMbps() {
    const q = quality();
    return S.netCapMbps ? Math.min(q.mbps, S.netCapMbps) : q.mbps;
  }
  // 1.2.1: "sharp" could stall the frame rate; move 1.2.0 users to balanced once.
  if (!store.get('app.qv121', false)) {
    const old = store.get('app.quality', null);
    if (old && old.prefer === 'sharp') { old.prefer = 'balanced'; store.set('app.quality', old); }
    store.set('app.qv121', true);
  }
  const RES_HEIGHT = { native: 0, '1440': 1440, '1080': 1080, '900': 900, '720': 720 };
  const MAX_SEND_W = 3840;
  const MAX_SEND_H = 2160;

  // True when we asked for H.264 but the browser is encoding VP8/VP9 in
  // software (it does this silently when the hardware encoder refuses).
  function softwareFallback() {
    if (S.role !== 'share' || !S.lastCodec) return false;
    const wanted = S.codecOverride || quality().codec;
    return wanted === 'h264' && !/h264/i.test(S.lastCodec) && /libvpx|libaom|software/i.test(S.lastEncoder || '');
  }

  // Downscale/limit the captured screen. Applies live.
  async function applyCaptureQuality() {
    const track = S.stream && S.stream.getVideoTracks()[0];
    if (!track || !S.native) return;
    const q = quality();
    const c = { frameRate: { ideal: q.fps, max: q.fps } };
    let h = RES_HEIGHT[q.res] || S.native.h;
    if (h > S.native.h) h = S.native.h;
    let w = Math.round((S.native.w * h) / S.native.h);
    // Never send more than 4K (3840x2160): hardware H.264 encoders (Mac
    // VideoToolbox, NVIDIA) can't go past 4096 wide, and the browser then
    // silently falls back to software VP8 at a few fps.
    const fit = Math.min(1, MAX_SEND_W / w, MAX_SEND_H / h);
    w = Math.round((w * fit) / 2) * 2;
    h = Math.round((h * fit) / 2) * 2;
    c.width = { ideal: w, max: w };
    c.height = { ideal: h, max: h };
    try {
      await track.applyConstraints(c);
      const st = track.getSettings();
      log(`capture now ${st.width}x${st.height}@${Math.round(st.frameRate || 0)}`);
    } catch (e) { log(`capture constraints failed: ${e && e.message}`); }
  }

  // Encoder limits on the outgoing video. Applies live.
  async function applySenderQuality(pc) {
    if (!pc) return;
    const q = quality();
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = effectiveMbps() * 1000000;
        p.encodings[0].maxFramerate = q.fps;
        p.encodings[0].scaleResolutionDownBy = 1;
        p.encodings[0].priority = 'high';
        p.encodings[0].networkPriority = 'high';
        // sharp: keep resolution, drop frames under pressure. smooth: the opposite.
        p.degradationPreference = { sharp: 'maintain-resolution', smooth: 'maintain-framerate' }[q.prefer] || 'balanced';
        await sender.setParameters(p);
        log(`encoder: max ${effectiveMbps()} Mbps, ${q.fps} fps, ${q.prefer}`);
      } catch (e) { log(`encoder settings skipped: ${e && e.message}`); }
    }
  }

  // SDP tweaks: preferred codec first, and a high starting bitrate so the
  // picture is sharp in seconds instead of ramping up from blurry.
  function tuneSdp(sdp, codec, mbps) {
    const lines = sdp.split('\r\n');
    const mIdx = lines.findIndex((l) => l.startsWith('m=video'));
    if (mIdx < 0) return sdp;
    let end = lines.findIndex((l, i) => i > mIdx && l.startsWith('m='));
    if (end < 0) end = lines.length;
    const want = { h264: 'H264', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' }[codec];
    const pts = {};
    for (let i = mIdx; i < end; i++) {
      const m = lines[i].match(/^a=rtpmap:(\d+) ([\w-]+)\//);
      if (m) pts[m[1]] = m[2];
    }
    if (want) {
      const parts = lines[mIdx].split(' ');
      const head = parts.slice(0, 3);
      const list = parts.slice(3);
      // For H264 prefer packetization-mode=1 variants.
      const score = (pt) => {
        if (pts[pt] !== want) return 0;
        const f = lines.find((l) => l.startsWith(`a=fmtp:${pt} `)) || '';
        return want === 'H264' && f.includes('packetization-mode=1') ? 2 : 1;
      };
      const sorted = list.slice().sort((a, b) => score(b) - score(a));
      lines[mIdx] = head.concat(sorted).join(' ');
    }
    const kbps = Math.round(mbps * 1000);
    const start = Math.min(kbps, 6000);
    for (let i = mIdx; i < end; i++) {
      const m = lines[i].match(/^a=fmtp:(\d+) (.*)$/);
      if (m && ['H264', 'VP8', 'VP9', 'AV1'].includes(pts[m[1]]) && !m[2].includes('x-google-start-bitrate')) {
        lines[i] = `${lines[i]};x-google-start-bitrate=${start};x-google-max-bitrate=${kbps}`;
      }
    }
    // Codecs without an fmtp line (VP8) get one so the start bitrate applies.
    for (const [pt, name] of Object.entries(pts)) {
      if (['VP8'].includes(name) && !lines.some((l) => l.startsWith(`a=fmtp:${pt} `))) {
        const at = lines.findIndex((l, i) => i > mIdx && i < end && l.startsWith(`a=rtpmap:${pt} `));
        if (at > 0) { lines.splice(at + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${start};x-google-max-bitrate=${kbps}`); end++; }
      }
    }
    return lines.join('\r\n');
  }

  // Live stats for both sides.
  // fps() turns a running frame counter into frames/second between calls.
  const rates = {};
  function rate(key, count, ts) {
    if (count == null || ts == null) return null;
    const p = rates[key];
    rates[key] = { count, ts };
    if (!p || ts <= p.ts || count < p.count) return null;
    return ((count - p.count) * 1000) / (ts - p.ts);
  }
  async function readVideoStats(pc, dir) {
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let rtp = null; let codec = null; let source = null;
      stats.forEach((r) => {
        if (r.type === dir && r.kind === 'video') rtp = r;
        if (r.type === 'media-source' && r.kind === 'video') source = r;
      });
      if (!rtp) return null;
      if (rtp.codecId) codec = stats.get(rtp.codecId);
      const ts = rtp.timestamp;
      const out = dir === 'outbound-rtp';
      const bytes = out ? rtp.bytesSent : rtp.bytesReceived;
      const mbpsRaw = rate(`${dir}-bytes`, bytes, ts);
      return {
        w: rtp.frameWidth, h: rtp.frameHeight,
        fps: out ? rate('sent', rtp.framesSent, ts) : rate('decoded', rtp.framesDecoded, ts),
        captureFps: source ? rate('captured', source.frames, source.timestamp || ts) : null,
        encodedFps: out ? rate('encoded', rtp.framesEncoded, ts) : null,
        receivedFps: out ? null : rate('received', rtp.framesReceived, ts),
        droppedFps: out ? null : rate('dropped', rtp.framesDropped, ts),
        mbps: mbpsRaw != null ? (mbpsRaw * 8) / 1e6 : null,
        codec: codec ? codec.mimeType.replace('video/', '') : '?',
        limit: rtp.qualityLimitationReason || 'none',
        frames: out ? rtp.framesSent : rtp.framesDecoded,
        sourceFrames: source ? source.frames : null,
        encoder: rtp.encoderImplementation || rtp.decoderImplementation || '',
        hw: out ? rtp.powerEfficientEncoder : rtp.powerEfficientDecoder,
      };
    } catch { return null; }
  }
  const r0 = (n) => (n == null ? '–' : Math.round(n));
  function fmtStats(v, route) {
    if (!v || !v.w) return 'Starting video…';
    const parts = [`${v.w}×${v.h}`, `${r0(v.fps)} fps`];
    if (v.mbps != null) parts.push(`${v.mbps.toFixed(1)} Mbps`);
    parts.push(`${v.codec}${v.hw === true ? ' (hardware)' : v.hw === false ? ' (software)' : ''}`);
    if (route) parts.push(route.label);
    return parts.join(' · ');
  }
  // Where frames are lost, step by step. Player side only.
  function pipeline(v, viewer) {
    if (!v) return '';
    const steps = [
      `captured ${r0(v.captureFps)}`,
      `encoded ${r0(v.encodedFps)}`,
      `sent ${r0(v.fps)}`,
    ];
    if (viewer) steps.push(`friend got ${r0(viewer.recv)}`, `friend shows ${r0(viewer.shown)}`);
    return `Frames per second: ${steps.join(' → ')}`;
  }
  function bottleneck(v, viewer, q, route) {
    if (!v || v.captureFps == null) return '';
    const want = q.fps * 0.75;
    if (v.captureFps < want) return `Only ${r0(v.captureFps)} new frames per second are coming from the source. If the game itself runs faster than that: share the game window instead of the whole screen, lower the resolution, or switch the game from exclusive Fullscreen to Borderless.`;
    if (v.encodedFps != null && v.encodedFps < v.captureFps * 0.75) {
      return v.limit === 'cpu' || v.hw === false
        ? 'Your computer can\'t keep up with this quality. Try 30 fps or a lower resolution.'
        : 'Some frames are being dropped. Try a lower resolution or quality.';
    }
    if (v.limit === 'bandwidth') return route && route.kind === 'relay'
      ? `You're on the slower backup connection. If you're both on the same Wi-Fi and one of you is on a Mac: System Settings > Privacy & Security > Local Network > turn on ${NAME}, then start again.`
      : 'Your internet upload speed is the limit. Lower the quality or resolution, or plug in a network cable.';
    if (viewer && viewer.recv != null && viewer.recv < v.fps * 0.75) return 'Some video is getting lost between you. Lower the quality, or plug in a network cable.';
    if (viewer && viewer.shown != null && viewer.recv != null && viewer.shown < viewer.recv * 0.75) return `Your friend's computer can't display the video fast enough. They can try making the ${NAME} window smaller.`;
    return '';
  }
  // Counts consecutive 2-second ticks where a frame counter did not move.
  const freeze = {
    last: {}, stuck: {},
    reset() { this.last = {}; this.stuck = {}; },
    check(key, value) {
      if (value == null) return 0;
      if (this.last[key] === value) this.stuck[key] = (this.stuck[key] || 0) + 1;
      else this.stuck[key] = 0;
      this.last[key] = value;
      return this.stuck[key];
    },
  };

  function startStatsLoop() {
    freeze.reset();
    clearInterval(S.statsTimer);
    for (const k of Object.keys(rates)) delete rates[k];
    let routeCache = null; let n = 0;
    S.statsTimer = setInterval(async () => {
      const pc = S.call && S.call.peerConnection;
      if (!pc) return;
      if (!routeCache || n++ % 5 === 0) routeCache = await describeRoute(pc);
      if (S.role === 'share') {
        const v = await readVideoStats(pc, 'outbound-rtp');
        const f = freeze.check('send', v && v.frames);
        const cf = freeze.check('capture', v && v.sourceFrames);
        const viewer = S.viewerStat && Date.now() - S.viewerStat.at < 5000 ? S.viewerStat : null;
        if (v && v.mbps != null && v.mbps > 0.3) S.lastSendMbps = v.mbps;
        if (v) { S.lastEncoder = v.encoder || ''; S.lastCodec = v.codec || ''; }
        if (softwareFallback() && !S.codecOverride && f === 0) {
          const now = Date.now();
          S.swFixes = (S.swFixes || []).filter((t) => now - t < 10 * 60000);
          if (!S.swFallbackSince) S.swFallbackSince = now;
          // Give it 6 s (it can be a blip), then rebuild; at most twice per 10 min.
          if (now - S.swFallbackSince > 6000 && S.swFixes.length < 2) {
            S.swFixes.push(now);
            S.swFallbackSince = null;
            log(`video fell back to software ${S.lastCodec} (${S.lastEncoder}), rebuilding to get hardware H.264 back`);
            restartVideo('software encoder fallback', { kind: 'manual', force: true });
          }
        } else S.swFallbackSince = null;
        $('q-stats').textContent = `Sending: ${fmtStats(v, routeCache)}`;
        $('q-pipe').textContent = pipeline(v, viewer);
        let hint = bottleneck(v, viewer, quality(), routeCache);
        if (cf >= 3 && S.trackState !== 'minimized' && S.trackState !== 'closed') {
          hint = 'Your game stopped sending video. Fixing it…';
          restartCapture(`no new frames for ${cf * 2}s`);
        } else if (cf >= 3) {
          hint = 'Your game is minimized, so there is nothing to send. It resumes when you go back to the game.';
        } else if (f >= 2 && cf === 0) {
          hint = 'Video got stuck. Fixing it…';
          restartVideo(`encoder/sending stalled ${f * 2}s, capture ok`, { kind: 'encoder' });
        }
        if (cf === 3 || f === 3) log(`freeze detected on player (capture stalled: ${cf >= 3}, send stalled: ${f >= 3}, limit: ${v && v.limit})`);
        if (n % 5 === 0 && v) log(`stats: ${fmtStats(v, routeCache)} | ${pipeline(v, viewer)} | limit ${v.limit} | encoder ${v.encoder}`);
        $('q-hint').textContent = hint;
        if (S.conn && S.conn.open && n % 2 === 0) {
          S.conn.send({ t: 'stat', cap: cf >= 3, send: f >= 3, limit: v ? v.limit : '' });
        }
      } else if (S.role === 'join') {
        const v = await readVideoStats(pc, 'inbound-rtp');
        const f = freeze.check('recv', v && v.frames);
        if (f === 0 && S.playerStat && S.playerStat.restarting) S.playerStat.restarting = false;
        const shown = rate('shown', S.framesShown, performance.now());
        $('watch-status').textContent = `Watching ${S.friend || 'your friend'} · ${fmtStats(v, routeCache)}${shown != null ? ` · showing ${r0(shown)} fps` : ''}`;
        if (S.conn && S.conn.open && v) {
          S.conn.send({ t: 'vstat', recv: v.receivedFps, decoded: v.fps, shown, dropped: v.droppedFps, decoder: v.encoder });
        }
        const ps = S.playerStat || {};
        let msg = '';
        if (f >= 5 && S.conn && S.conn.open && (f === 5 || f % 8 === 0)) {
          // Frozen while drawings still work: ask the player to rebuild video.
          S.conn.send({ t: 'need-video', why: `no frames ${f * 2}s` });
          log(`no frames for ${f * 2}s, asked player to rebuild video`);
        }
        if (f >= 3) {
          msg = ps.restarting ? `${S.friend || 'Your friend'}'s video got stuck. Fixing it…`
            : ps.cap ? `No new frames from ${S.friend || 'your friend'}'s game. If it's moving, they should switch it to Borderless / Windowed Fullscreen.`
            : ps.send ? `${S.friend || 'Your friend'}'s computer is struggling to send video. They can lower resolution or bitrate.`
            : routeCache && routeCache.kind === 'relay' ? 'Video paused: the connection is too slow. Waiting…'
            : 'Video paused: no new frames arriving. Waiting…';
          if (f === 3) log(`freeze detected on viewer (${msg})`);
        }
        $('freeze').textContent = msg;
        $('freeze').hidden = !msg;
      }
    }, 2000);
  }

  function initQualityControls() {
    const q = quality();
    $('q-res').value = q.res;
    $('q-fps').value = String(q.fps);
    $('q-mbps').value = String(q.mbps);
    $('q-prefer').value = q.prefer;
    $('q-codec').value = q.codec;
    const save = async (ev) => {
      const next = {
        res: $('q-res').value,
        fps: Number($('q-fps').value),
        mbps: Number($('q-mbps').value),
        prefer: $('q-prefer').value,
        codec: $('q-codec').value,
      };
      store.set('app.quality', next);
      if (S.netCapMbps) { S.netCapMbps = null; log('session quality limit cleared by settings change'); }
      log(`quality set: ${JSON.stringify(next)}`);
      await applyCaptureQuality();
      if (S.call) await applySenderQuality(S.call.peerConnection);
      if (S.role === 'share' && S.call) {
        const codecChanged = ev && ev.target && ev.target.id === 'q-codec';
        const stuckSoftware = softwareFallback();
        if (codecChanged || S.codecOverride || stuckSoftware) {
          S.codecOverride = null;
          S.encoderStalls = [];
          $('q-hint').textContent = 'Applying… the video blinks for a second.';
          restartVideo(codecChanged ? 'codec changed in settings' : 'settings changed, getting the hardware encoder back', { kind: 'manual', force: true });
        }
      }
    };
    ['q-res', 'q-fps', 'q-mbps', 'q-prefer', 'q-codec'].forEach((id) => $(id).addEventListener('change', save));
  }

  // =====================================================================
  // PLAYER: share my game
  // =====================================================================
  // Renders the source picker into `box`. onPick(source) is called on click.
  async function renderSources(box, onPick) {
    box.innerHTML = '<p class="note">Looking for games, apps and screens…</p>';
    let res;
    try { res = await bridge.listSources(); } catch (e) { res = { sources: [], error: String(e) }; }
    log(`sources: ${res.sources.length}, screen permission: ${res.status}, window tracking: ${res.tracking}${res.trackingError ? ` (${res.trackingError})` : ''}${res.error ? `, error: ${res.error}` : ''}`);
    const permProblem = res.status && res.status !== 'granted' && res.status !== 'not-determined';
    box.innerHTML = '';
    if (!res.sources.length) {
      box.innerHTML = `<p class="note">Nothing to share found. If you are on a Mac, allow Screen Recording for ${NAME}, then quit and reopen the app.</p>`;
      return { permProblem: true };
    }
    const groups = [
      { title: 'Games & apps', hint: 'Only this window is shared. Drawings follow it around.', items: res.sources.filter((x) => x.kind === 'window') },
      { title: 'Whole screen', hint: 'Everything on the screen is shared.', items: res.sources.filter((x) => x.kind === 'screen') },
    ];
    for (const g of groups) {
      if (!g.items.length) continue;
      const head = document.createElement('div');
      head.className = 'src-group';
      head.innerHTML = '<strong></strong><span></span>';
      head.querySelector('strong').textContent = g.title;
      head.querySelector('span').textContent = g.hint;
      box.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'sources';
      for (const src of g.items) {
        const b = document.createElement('button');
        b.className = src.likelyGame ? 'source likely-game' : 'source';
        b.title = src.name;
        if (src.likelyGame) {
          const tag = document.createElement('span');
          tag.className = 'likely';
          tag.textContent = '★ Looks like your game';
          b.appendChild(tag);
        }
        const img = document.createElement('img');
        img.className = 'src-thumb';
        img.alt = '';
        img.src = src.thumb;
        b.appendChild(img);
        const label = document.createElement('span');
        label.className = 'src-label';
        if (src.icon) {
          const ic = document.createElement('img');
          ic.className = 'src-icon';
          ic.alt = '';
          ic.src = src.icon;
          label.appendChild(ic);
        }
        const t = document.createElement('strong');
        t.textContent = src.name;
        label.appendChild(t);
        b.appendChild(label);
        b.addEventListener('click', () => onPick(src));
        grid.appendChild(b);
      }
      box.appendChild(grid);
    }
    return { permProblem };
  }

  async function loadSources() {
    const r = await renderSources($('sources'), (src) => startSharing(src));
    $('perm').hidden = !(r && r.permProblem);
  }

  // Starts capturing one source. Returns the new stream (not yet in use).
  async function captureSource(source) {
    await bridge.selectSource(source.id);
    const q = quality();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: q.fps, max: 60 }, width: { max: 7680 }, height: { max: 4320 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = 'motion'; } catch { /* ignore */ }
    const st = track.getSettings();
    log(`capturing "${source.name}" (${source.kind}) ${st.width}x${st.height}@${st.frameRate}`);
    track.addEventListener('ended', () => {
      // Only react if this is still the live source (e.g. the game was closed).
      if (S.ended || !S.stream || S.stream.getVideoTracks()[0] !== track) return;
      if (source.kind === 'window') {
        log(`capture of "${source.name}" ended, looking for it again`);
        reattachWindow(source, 0);
      } else {
        endSession('Screen sharing stopped.');
      }
    });
    return { stream, native: { w: st.width || 1920, h: st.height || 1080 } };
  }

  function showSourceName(source) {
    $('source-name').textContent = source.kind === 'window' ? `Sharing: ${source.name}` : `Sharing: ${source.name}`;
  }

  async function startSharing(source, opts) {
    teardown();
    S.ended = false;
    S.role = 'share';
    S.source = source;
    show('step-share');
    $('code').textContent = '······';
    $('copy-code').disabled = true; $('copy-invite').disabled = true;
    $('share-title').textContent = 'Send this code to your friend';
    setStatus($('share-status'), 'Starting capture…', 'busy');
    try {
      const c = await captureSource(source);
      S.stream = c.stream;
      S.native = c.native;
    } catch (e) {
      log(`capture failed: ${e && e.name} ${e && e.message}`);
      endSession(`Capture was blocked. On a Mac, allow ${NAME} under Screen & System Audio Recording, then quit and reopen it.`);
      return;
    }
    showSourceName(source);
    await applyCaptureQuality();
    await bridge.openOverlay({ kind: source.kind, id: source.id, displayId: source.displayId });
    S.overlayTargetId = source.id;
    openHostPeer(0, opts && opts.code);
  }

  // Swap what's being shared without dropping the friend.
  async function switchSource(source) { return replaceCapture(source, false); }

  // Restarts capture of the current source (same window/screen). Used when
  // Windows stops delivering frames, e.g. after alt-tabbing a fullscreen game.
  let lastRestart = 0;
  let restarting = false;
  async function restartCapture(reason) {
    if (S.ended || S.role !== 'share' || !S.source || restarting) return;
    const now = Date.now();
    if (now - lastRestart < 12000) return;
    lastRestart = now;
    restarting = true;
    log(`restarting capture (${reason})`);
    if (S.conn && S.conn.open) S.conn.send({ t: 'stat', restarting: true });
    try { await replaceCapture(S.source, true); } finally { restarting = false; }
  }

  // The shared window disappeared (closed, or the game recreated its window
  // when changing display mode). Look for a window with the same title.
  async function reattachWindow(source, attempt) {
    if (S.ended || S.role !== 'share') return;
    let res = null;
    try { res = await bridge.listSources(); } catch { /* ignore */ }
    const match = res && res.sources.find((x) => x.kind === 'window' && x.name === source.name);
    if (match) {
      log(`found "${source.name}" again, reattaching`);
      await replaceCapture(match, true);
      return;
    }
    if (attempt < 5) {
      setStatus($('share-status'), `Lost "${source.name}". Looking for it…`, 'busy');
      later(1500, () => reattachWindow(source, attempt + 1));
      return;
    }
    setStatus($('share-status'), `"${source.name}" closed. Pick another source to keep sharing.`, 'bad');
    openSourceDialog();
  }

  async function replaceCapture(source, silent) {
    if (S.ended || S.role !== 'share') return;
    if (!silent) log(`switching source to "${source.name}"`);
    let c;
    try {
      c = await captureSource(source);
    } catch (e) {
      log(`capture failed: ${e && e.name} ${e && e.message}`);
      if (!silent) setStatus($('share-status'), `Couldn't capture "${source.name}". Still sharing the previous source.`, 'bad');
      return;
    }
    const old = S.stream;
    S.stream = c.stream;
    S.native = c.native;
    S.source = source;
    await applyCaptureQuality();
    const newTrack = c.stream.getVideoTracks()[0];
    const pc = S.call && S.call.peerConnection;
    if (pc) {
      const sender = pc.getSenders().find((x) => x.track && x.track.kind === 'video') || pc.getSenders()[0];
      try {
        await sender.replaceTrack(newTrack);
        await applySenderQuality(pc);
      } catch (e) { log(`replaceTrack failed: ${e && e.message}`); }
    }
    if (old) old.getTracks().forEach((t) => t.stop());
    freeze.reset();
    const sameTarget = silent && S.overlayTargetId === source.id;
    if (!sameTarget) {
      await bridge.openOverlay({ kind: source.kind, id: source.id, displayId: source.displayId });
      S.overlayTargetId = source.id;
    }
    showSourceName(source);
    if (silent) {
      log(`capture restarted for "${source.name}"`);
      if (S.conn && S.conn.open) S.conn.send({ t: 'stat', restarting: false });
      if (S.conn && S.conn.open) setStatus($('share-status'), `Connected. ${S.friend || 'Your friend'} can see your game and draw on it.`, 'good');
      return;
    }
    bridge.draw({ t: 'clear' });
    if (S.conn && S.conn.open) S.conn.send({ t: 'source', name: source.name });
    setStatus($('share-status'), S.conn && S.conn.open ? `Now sharing "${source.name}". ${S.friend || 'Your friend'} sees it.` : `Now sharing "${source.name}".`, 'good');
  }

  function openSourceDialog() {
    const dlg = $('source-dialog');
    renderSources($('dialog-sources'), (src) => { dlg.close(); switchSource(src); });
    if (!dlg.open) dlg.showModal();
  }

  function makeCode() {
    const a = new Uint32Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
  }

  // fixedCode: reopen the same code after an update so the friend can rejoin.
  function openHostPeer(attempt, fixedCode) {
    if (S.ended) return;
    S.code = fixedCode || makeCode();
    const id = ID_PREFIX + S.code.toLowerCase();
    log(`opening host peer (attempt ${attempt + 1})`);
    setStatus($('share-status'), 'Getting your code…', 'busy');
    const peer = new window.Peer(id, peerOptions());
    S.peer = peer;

    peer.on('open', () => {
      if (S.peer !== peer) return;
      log('host peer registered');
      $('code').textContent = S.code;
      $('copy-code').disabled = false; $('copy-invite').disabled = false;
      setStatus($('share-status'), 'Waiting for your friend to enter the code…', 'busy');
    });
    peer.on('connection', (conn) => onViewerConnection(conn));
    peer.on('disconnected', () => {
      if (S.ended || S.peer !== peer) return;
      // Losing the signaling server does not affect an existing direct connection.
      log('signaling disconnected, reconnecting');
      later(1500, () => { if (!S.ended && S.peer === peer && !peer.destroyed) peer.reconnect(); });
    });
    peer.on('error', (err) => {
      if (S.peer !== peer) return;
      log(`host peer error: ${err.type} ${err.message || ''}`);
      if (err.type === 'unavailable-id' && fixedCode && attempt < 12) {
        // The pairing service still remembers the old copy of this code for a
        // few seconds after a restart: keep trying the same code.
        peer.destroy();
        setStatus($('share-status'), 'Getting your code back…', 'busy');
        later(2500, () => openHostPeer(attempt + 1, fixedCode));
        return;
      }
      if (err.type === 'unavailable-id' && attempt < 17) {
        peer.destroy();
        openHostPeer(attempt + 1);
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        if (!S.conn) {
          $('code').textContent = '······';
          $('copy-code').disabled = true; $('copy-invite').disabled = true;
        }
        setStatus($('share-status'), `${friendlyPeerError(err)} Retrying…`, 'bad');
        later(4000, () => {
          if (S.ended || S.peer !== peer) return;
          if (S.conn && S.conn.open) { if (!peer.destroyed) peer.reconnect(); return; }
          peer.destroy();
          openHostPeer(attempt + 1);
        });
        return;
      }
      setStatus($('share-status'), friendlyPeerError(err), 'bad');
    });
  }

  // ---------- second path for drawings: inside the video connection ----------
  // The video connection already has a data (SCTP) channel inside it, so we
  // open one more, pre-agreed channel there ("negotiated", same id on both
  // sides, no extra handshake). Each mark goes out on BOTH the drawing link
  // and this channel; the player uses whichever copy arrives first. On some
  // networks one of the two connections keeps dropping, and this way marks
  // still get through instantly on the other.
  const DRAW_DC_ID = 100;
  function attachDrawChannel(pc) {
    if (!pc || pc.ggDrawDc) return;
    try {
      const dc = pc.createDataChannel('gg-draw', { negotiated: true, id: DRAW_DC_ID, ordered: true });
      pc.ggDrawDc = dc;
      dc.onopen = () => {
        S.drawDc = dc;
        log('drawing path inside the video connection is open');
        try { dc.send(JSON.stringify(myProfileMsg())); } catch { /* ignore */ }
      };
      dc.onclose = () => { if (S.drawDc === dc) S.drawDc = null; };
      dc.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (S.role === 'share' && DRAW_TYPES.includes(m.t)) { receiveDraw(m); return; }
        handleCtl(m);
      };
    } catch (e) {
      log(`no drawing path inside the video connection (${e && e.message})`);
    }
  }
  const DRAW_TYPES = ['start', 'move', 'end', 'ping', 'clear', 'react'];

  // Viewer: number each mark message and send it on every open path.
  function sendDrawMsg(msg) {
    if (!S.drawSession) S.drawSession = Math.random().toString(36).slice(2, 8);
    const m = { ...msg, s: S.drawSession, q: (S.drawSeq = (S.drawSeq || 0) + 1) };
    let sent = 0;
    try { if (S.conn && S.conn.open) { S.conn.send(m); sent++; } } catch { /* ignore */ }
    try { if (S.drawDc && S.drawDc.readyState === 'open') { S.drawDc.send(JSON.stringify(m)); sent++; } } catch { /* ignore */ }
    if (!sent && !S.noPathLogged) { S.noPathLogged = true; log('mark not sent: no drawing path open right now'); }
    if (sent) S.noPathLogged = false;
  }

  // Player: apply each numbered mark message once, in order, whichever path
  // it came on. A gap (message lost with a dying path) is skipped after 300 ms.
  function receiveDraw(m) {
    if (typeof m.q !== 'number' || !m.s) { bridge.draw(m); return; } // older friend
    let R = S.rx;
    if (!R || R.s !== m.s) R = S.rx = { s: m.s, next: m.q, buf: new Map(), timer: null };
    if (m.q < R.next || R.buf.has(m.q)) return; // already have it
    R.buf.set(m.q, m);
    flushDraw(R);
  }
  function flushDraw(R) {
    while (R.buf.has(R.next)) {
      const m = R.buf.get(R.next);
      R.buf.delete(R.next);
      R.next++;
      const { s, q, ...plain } = m;
      bridge.draw(plain);
    }
    clearTimeout(R.timer);
    R.timer = null;
    if (R.buf.size) {
      R.timer = setTimeout(() => {
        if (S.rx !== R || !R.buf.size) return;
        R.next = Math.min(...R.buf.keys());
        flushDraw(R);
      }, 300);
    }
  }

  // Drawings travel on their own data connection. If the network drops it
  // (seen on Macs: video keeps flowing, data link dies), the friend rebuilds
  // just this link and the video call stays up.
  function hostLinkDead() {
    return !!(S.peerHb && Date.now() - (S.lastHeard || 0) > 8000);
  }

  function onViewerConnection(conn) {
    const relink = !!(conn.metadata && conn.metadata.relink);
    const samePeer = (S.conn && S.conn.peer === conn.peer) || (S.awaitRelink && S.awaitRelink.peer === conn.peer);
    if (relink && samePeer && S.call) { adoptDataLink(conn); return; }
    if (S.conn && S.conn.open && !hostLinkDead()) {
      log('second viewer refused');
      conn.on('open', () => { conn.send({ t: 'busy' }); setTimeout(() => conn.close(), 800); });
      return;
    }
    const stale = S.conn;
    S.conn = conn;
    S.awaitRelink = null;
    clearTimeout(S.relinkTimer);
    if (stale && stale !== conn) { try { stale.close(); } catch { /* ignore */ } }
    const viewerName = (conn.metadata && String(conn.metadata.name || '').slice(0, 24)) || 'Your friend';
    log('viewer reached us through pairing service, opening direct connection');
    setStatus($('share-status'), `${viewerName} found you. Connecting…`, 'busy');
    watchPc(conn.peerConnection, 'data');

    const openTimer = later(30000, () => {
      if (S.conn === conn && !conn.open) {
        log('data channel did not open within 30s');
        setStatus($('share-status'), `Couldn't connect to ${viewerName}. Ask them to try again. If it keeps failing, open Settings > Advanced and turn on "Always use the backup connection" on both computers.`, 'bad');
        try { conn.close(); } catch { /* ignore */ }
        S.conn = null;
      }
    });

    conn.on('open', () => {
      clearTimeout(openTimer);
      S.friend = viewerName;
      S.lastHeard = Date.now();
      S.peerHb = false;
      startHeartbeat();
      log('data channel open, starting video');
      const q = quality();
      conn.send({ ...myProfileMsg(), codec: q.codec, mbps: q.mbps });
      S.codecOverride = null;
      S.videoRecoveries = [];
      S.encoderStalls = [];
      S.netCapMbps = null;
      const call = startVideoCall(conn);
      $('share-title').textContent = `${viewerName} is watching`;
      setStatus($('share-status'), `Connected. ${viewerName} can see your screen and draw on it.`, 'good');
      later(4000, async () => {
        const r = await describeRoute(call.peerConnection);
        if (r) {
          log(`route: ${r.label} (${r.local} → ${r.remote}, rtt ${r.rtt}ms)`);
          if (S.conn === conn && conn.open) setStatus($('share-status'), `Connected (${r.label}). ${viewerName} can see your screen and draw on it.`, 'good');
        }
        const d = await describeRoute(conn.peerConnection);
        if (d) log(`drawing route: ${d.label} (${d.local} → ${d.remote}, rtt ${d.rtt}ms)`);
      });
    });
    conn.on('data', (msg) => hostData(conn, msg));
    conn.on('close', () => hostClosed(conn));
    conn.on('error', (e) => log(`data connection error: ${e && e.type}`));
  }

  // The friend rebuilt the drawing link: swap it in, keep the video call.
  function adoptDataLink(conn) {
    const old = S.conn;
    S.conn = conn;
    S.awaitRelink = null;
    clearTimeout(S.relinkTimer);
    if (old && old !== conn) { try { old.close(); } catch { /* ignore */ } }
    log('friend is reconnecting the drawing link');
    watchPc(conn.peerConnection, 'data');
    conn.on('open', () => {
      S.lastHeard = Date.now();
      startHeartbeat();
      log('drawing link rebuilt');
      conn.send(myProfileMsg());
      later(4000, async () => {
        const d = await describeRoute(conn.peerConnection);
        if (d) log(`drawing route: ${d.label} (${d.local} → ${d.remote}, rtt ${d.rtt}ms)`);
      });
    });
    conn.on('data', (msg) => hostData(conn, msg));
    conn.on('close', () => hostClosed(conn));
    conn.on('error', (e) => log(`data connection error: ${e && e.type}`));
  }

  function hostData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (S.conn === conn) S.lastHeard = Date.now();
    if (msg.t === 'hb') { S.peerHb = true; checkPeerPv(msg.pv); return; }
    if (msg.t === 'bye') { conn.byeReceived = true; return; }
    if (msg.t === 'profile?') { sendCtl(myProfileMsg()); return; }
    if (msg.t === 'hello') { takePeerProfile(msg); S.peerUpdating = false; return; }
    if (msg.t === 'updating') { S.peerUpdating = true; log('friend is installing an update'); return; }
    if (msg.t === 'need-video') {
      log(`friend reports no video (${String(msg.why || '').slice(0, 40)})`);
      const captureStuck = (freeze.stuck.capture || 0) >= 2;
      restartVideo(`friend reports no video: ${String(msg.why || '').slice(0, 40)}`, {
        kind: msg.manual ? 'manual' : captureStuck ? 'capture' : 'network',
        freshCapture: captureStuck || !!msg.manual,
        force: !!msg.manual,
      });
      return;
    }
    if (msg.t === 'vstat') { S.viewerStat = { recv: num(msg.recv), shown: num(msg.shown), decoded: num(msg.decoded), at: Date.now() }; return; }
    if (DRAW_TYPES.includes(msg.t)) receiveDraw(msg);
  }

  function hostClosed(conn) {
    if (S.conn !== conn) return;
    // Link died without a goodbye from a friend that can rebuild it: keep
    // video running and give them time to reconnect the drawing link.
    if (!S.ended && !conn.byeReceived && S.peerHb && S.call && !S.peerUpdating) {
      log('drawing link closed, waiting up to 20 s for friend to reconnect it');
      S.conn = null;
      S.awaitRelink = { peer: conn.peer };
      clearTimeout(S.relinkTimer);
      S.relinkTimer = setTimeout(() => { if (S.awaitRelink && !S.conn) viewerGone(); }, 20000);
      return;
    }
    viewerGone();
  }

  function viewerGone() {
    log('viewer left');
    S.drawDc = null;
    if (S.rx) clearTimeout(S.rx.timer);
    S.rx = null;
    S.awaitRelink = null;
    clearTimeout(S.relinkTimer);
    stopHeartbeat();
    S.peerHb = false;
    S.peerProfile = null;
    renderChips();
    bridge.draw({ t: 'clear' });
    try { S.call && S.call.close(); } catch { /* ignore */ }
    S.call = null;
    S.conn = null;
    clearInterval(S.statsTimer);
    $('q-stats').textContent = '';
    $('q-hint').textContent = '';
    if (S.ended) return;
    $('share-title').textContent = 'Send this code to your friend';
    if (S.peerUpdating) {
      setStatus($('share-status'), `${S.friend || 'Your friend'} is updating and will reconnect by themselves…`, 'busy');
      S.peerUpdating = false;
    } else {
      setStatus($('share-status'), `${S.friend || 'Your friend'} left. Waiting for someone to enter the code…`, 'busy');
    }
    S.friend = null;
  }

  // Both sides send a tiny heartbeat on the drawing link so a silently dead
  // link is noticed within seconds (only acted on when the other side sends
  // heartbeats too, i.e. runs a version that can rebuild the link).
  function startHeartbeat() {
    clearInterval(S.hbTimer);
    S.hbTimer = setInterval(() => {
      try { if (S.conn && S.conn.open) S.conn.send({ t: 'hb', pv: S.profileVer }); } catch { /* ignore */ }
      try { if (S.drawDc && S.drawDc.readyState === 'open') S.drawDc.send(JSON.stringify({ t: 'hb', pv: S.profileVer })); } catch { /* ignore */ }
      if (S.role === 'share' && S.conn && hostLinkDead() && !S.quietLogged) {
        S.quietLogged = true;
        log(`no word from friend on the drawing link for ${Math.round((Date.now() - S.lastHeard) / 1000)} s`);
      } else if (!hostLinkDead()) S.quietLogged = false;
    }, 2000);
  }
  function stopHeartbeat() {
    clearInterval(S.hbTimer);
    S.hbTimer = null;
  }

  // Opens (or re-opens) the video connection to the friend. Drawings use a
  // separate connection, so video can be rebuilt without anyone noticing.
  function startVideoCall(conn) {
    const q = quality();
    const codec = S.codecOverride || q.codec;
    const mbps = effectiveMbps();
    const call = S.peer.call(conn.peer, S.stream, {
      metadata: { name: S.name, codec, mbps },
      sdpTransform: (sdp) => tuneSdp(sdp, codec, mbps),
    });
    attachDrawChannel(call.peerConnection);
    S.call = call;
    const pc = call.peerConnection;
    watchPc(pc, 'video');
    tuneSender(pc);
    startStatsLoop();
    call.on('close', () => log('video call closed'));
    call.on('error', (e) => log(`video call error: ${e && e.type}`));
    // If the video path itself fails while drawings still work, rebuild it.
    let badSince = 0;
    pc.addEventListener('iceconnectionstatechange', () => {
      const st = pc.iceConnectionState;
      if (st === 'failed') restartVideo('video connection failed', { kind: 'network' });
      if (st === 'disconnected') {
        badSince = Date.now();
        // Short drops often heal by themselves; only rebuild if it stays down.
        later(8000, () => { if (S.call === call && pc.iceConnectionState === 'disconnected' && Date.now() - badSince >= 7900) restartVideo('video connection lost', { kind: 'network' }); });
      }
    });
    return call;
  }

  let lastVideoRestart = 0;
  async function restartVideo(reason, opts) {
    if (S.ended || S.role !== 'share' || !S.conn || !S.conn.open || !S.stream) return;
    const now = Date.now();
    if (now - lastVideoRestart < 10000 && !(opts && opts.force)) {
      // Too soon after the last rebuild: retry once the 10 s gap is over,
      // unless the video has recovered by then.
      if (!S.videoRetryPending) {
        S.videoRetryPending = true;
        later(10000 - (now - lastVideoRestart) + 200, () => {
          S.videoRetryPending = false;
          const pc = S.call && S.call.peerConnection;
          const healthy = pc && ['connected', 'completed'].includes(pc.iceConnectionState) && S.call.open;
          if (!healthy) restartVideo(`${reason} (retry)`, opts);
        });
      }
      return;
    }
    lastVideoRestart = now;
    const kind = (opts && opts.kind) || 'network';
    if (kind === 'encoder') {
      // The encoder itself keeps hanging: fall back to the most robust codec.
      S.encoderStalls = (S.encoderStalls || []).filter((t) => now - t < 180000);
      S.encoderStalls.push(now);
      if (S.encoderStalls.length >= 2 && quality().codec !== 'vp8' && S.codecOverride !== 'vp8') {
        S.codecOverride = 'vp8';
        log('encoder keeps hanging, switching codec to VP8 for this session');
      }
    } else if (kind === 'network') {
      // The link dropped under load: come back below the rate that broke it,
      // instead of climbing straight back up and dropping again.
      const was = effectiveMbps();
      const sent = S.lastSendMbps && S.lastSendMbps > 0.5 ? S.lastSendMbps : was;
      S.netCapMbps = Math.max(3, Math.round(Math.min(was, sent) * 0.7));
      log(`network dropped the video at ~${sent.toFixed(1)} Mbps; capping this session at ${S.netCapMbps} Mbps`);
      $('q-hint').textContent = `The connection kept dropping, so quality is limited to ${S.netCapMbps} Mbps for this session. Change "Max quality" to reset it.`;
    }
    log(`rebuilding video connection (${reason})`);
    if (opts && opts.freshCapture && S.source) {
      try { await replaceCapture(S.source, true); } catch { /* ignore */ }
    }
    const old = S.call;
    if (S.peer && S.peer.disconnected && !S.peer.destroyed) {
      try { S.peer.reconnect(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!S.conn || S.ended) return; // drawing link went away while we waited
    startVideoCall(S.conn);
    if (old) setTimeout(() => { try { old.close(); } catch { /* ignore */ } }, 500);
    if (S.conn.open) S.conn.send({ t: 'stat', restarting: true });
  }

  function tuneSender(pc) {
    if (!pc) return;
    const apply = () => applySenderQuality(pc);
    apply();
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') apply(); });
  }

  // =====================================================================
  // FRIEND: join and draw
  // =====================================================================
  function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }

  function normalizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // opts.rejoinUntil: keep retrying this code until then (friend is updating).
  function joinFriend(raw, opts) {
    const code = normalizeCode(raw);
    const rejoinUntil = opts && opts.rejoinUntil;
    if (code.length !== 6) {
      setStatus($('join-status'), 'Codes are 6 letters and numbers. Check the code and try again.', 'bad');
      return;
    }
    teardown();
    S.ended = false;
    S.role = 'join';
    S.code = code;
    $('join-btn').disabled = true;
    $('end').hidden = false;
    setStatus($('join-status'), 'Connecting…', 'busy');
    log('opening viewer peer');
    const peer = new window.Peer(peerOptions());
    S.peer = peer;

    const fail = (text) => {
      if (S.peer !== peer) return;
      if (rejoinUntil && Date.now() < rejoinUntil) {
        log(`rejoin attempt failed (${text}); trying again`);
        const who = (opts && opts.friend) || 'your friend';
        teardown();
        S.ended = false;
        S.role = 'join';
        show('step-join');
        $('join-code').value = code;
        $('end').hidden = false;
        setStatus($('join-status'), `Waiting for ${who} to come back (updating)…`, 'busy');
        later(4000, () => { if (!S.ended && S.role === 'join') joinFriend(code, opts); });
        return;
      }
      log(`join failed: ${text}`);
      teardown();
      $('join-btn').disabled = false;
      $('end').hidden = true;
      show('step-join');
      setStatus($('join-status'), text, 'bad');
    };

    const hostId = ID_PREFIX + code.toLowerCase();
    const playerEnded = () => {
      log('player ended the connection');
      teardown();
      $('join-btn').disabled = false;
      show('step-join');
      $('end').hidden = true;
      setStatus($('join-status'), `${S.friend || 'Your friend'} ended the session.`, '');
    };
    const videoAlive = () => {
      const pc = S.call && S.call.peerConnection;
      return !!(pc && pc.connectionState === 'connected');
    };

    // Wires a drawing link (the first one, or a rebuilt one).
    const wireLink = (conn, relink) => {
      watchPc(conn.peerConnection, 'data');
      if (conn.peerConnection) {
        conn.peerConnection.addEventListener('iceconnectionstatechange', () => {
          if (S.conn !== conn) return;
          S.dataDiscAt = conn.peerConnection.iceConnectionState === 'disconnected' ? Date.now() : null;
        });
      }
      conn.on('open', () => {
        S.lastHeard = Date.now();
        S.dataDiscAt = null;
        startHeartbeat();
        conn.send(myProfileMsg());
        later(4000, async () => {
          const d = await describeRoute(conn.peerConnection);
          if (d) log(`drawing route: ${d.label} (${d.local} → ${d.remote}, rtt ${d.rtt}ms)`);
        });
        if (relink) {
          S.relinking = false;
          S.relinkTries = 0;
          log('drawing link rebuilt');
          return;
        }
        log('data channel open, waiting for video');
        setStatus($('join-status'), 'Connected. Waiting for video…', 'busy');
        later(20000, () => {
          if (S.conn === conn && conn.open && !$('video').srcObject) fail('Connected, but no video arrived. Ask your friend to end the session and share again.');
        });
      });
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (S.conn === conn) S.lastHeard = Date.now();
        if (msg.t === 'hb') { S.peerHb = true; checkPeerPv(msg.pv); return; }
        if (msg.t === 'bye') { conn.byeReceived = true; return; }
        if (msg.t === 'profile?') { sendCtl(myProfileMsg()); return; }
        if (msg.t === 'hello') { S.friend = String(msg.name || '').slice(0, 24) || 'your friend'; takePeerProfile(msg); log('player said hello'); }
        if (msg.t === 'stat') { S.playerStat = Object.assign(S.playerStat || {}, msg); return; }
        if (msg.t === 'updating') {
          S.awaitReturn = { code, until: Date.now() + 120000, friend: S.friend };
          log('player is installing an update');
          $('freeze').textContent = `${S.friend || 'Your friend'} is updating. Reconnecting automatically…`;
          $('freeze').hidden = false;
          return;
        }
        if (msg.t === 'receipt') { showReceipt(String(msg.state || '')); return; }
        if (msg.t === 'source') { localMarks.apply({ t: 'clear' }); log(`player switched source to "${String(msg.name || '').slice(0, 80)}"`); return; }
        if (msg.t === 'busy') fail('Someone else is already watching this share. Ask your friend for a fresh code.');
      });
      conn.on('close', () => {
        if (S.conn !== conn || S.ended) return;
        if (S.awaitReturn && Date.now() < S.awaitReturn.until) {
          const back = S.awaitReturn;
          log('player is restarting for an update, will rejoin');
          teardown();
          show('step-join');
          $('join-code').value = back.code;
          joinFriend(back.code, { rejoinUntil: back.until, friend: back.friend });
          return;
        }
        // Closed without a goodbye from a player that can take a rebuilt link:
        // the network dropped it, so rebuild instead of ending the session.
        if (!conn.byeReceived && S.peerHb && S.peer === peer && !peer.destroyed) { relinkData('closed'); return; }
        playerEnded();
      });
      conn.on('error', (e) => log(`data connection error: ${e && e.type}`));
    };

    // Opens a fresh drawing link to the player; video is left alone.
    const relinkData = (why) => {
      if (S.ended || S.peer !== peer || peer.destroyed) return;
      S.relinking = true;
      S.relinkTries = (S.relinkTries || 0) + 1;
      log(`drawing link ${why}, reconnecting it (try ${S.relinkTries})`);
      const go = () => {
        if (S.ended || S.peer !== peer || peer.destroyed) return;
        const old = S.conn;
        const conn = peer.connect(hostId, { reliable: true, serialization: 'json', metadata: { name: S.name, relink: true } });
        S.conn = conn;
        if (old && old !== conn) { try { old.close(); } catch { /* ignore */ } }
        wireLink(conn, true);
        later(Math.min(20000, 6000 + S.relinkTries * 2000), () => {
          if (S.conn === conn && !conn.open && !S.ended) relinkData('still down');
        });
      };
      if (peer.disconnected) {
        peer.once('open', go);
        try { peer.reconnect(); } catch { /* ignore */ }
      } else go();
    };

    // Watches the drawing link; rebuilds it if it fails or goes quiet.
    clearInterval(S.linkWatch);
    S.linkWatch = setInterval(() => {
      if (S.ended || S.peer !== peer || S.relinking || !S.peerHb) return;
      const c = S.conn;
      if (!c || !c.open) return;
      const ice = c.peerConnection ? c.peerConnection.iceConnectionState : '';
      const quiet = Date.now() - (S.lastHeard || Date.now());
      if (ice === 'failed' || ice === 'closed') relinkData(`failed (${ice})`);
      else if (quiet > 6000) relinkData(`quiet for ${Math.round(quiet / 1000)} s`);
      else if (ice === 'disconnected' && S.dataDiscAt && Date.now() - S.dataDiscAt > 4000) relinkData('disconnected');
    }, 1000);

    peer.on('open', () => {
      if (S.peer !== peer) return;
      log('viewer peer registered, looking up code');
      setStatus($('join-status'), 'Looking for your friend…', 'busy');
      const conn = peer.connect(hostId, {
        reliable: true,
        serialization: 'json',
        metadata: { name: S.name },
      });
      S.conn = conn;
      wireLink(conn, false);
      later(8000, () => {
        if (S.conn === conn && !conn.open) setStatus($('join-status'), 'Found your friend. Connecting (this can take up to 30 seconds)…', 'busy');
      });
      later(35000, () => {
        if (S.conn === conn && !conn.open && !S.relinking) fail('Found your friend, but couldn\'t connect. Try again. If it keeps failing, open Settings > Advanced and turn on "Always use the backup connection" on both computers.');
      });
    });

    peer.on('call', (call) => {
      if (S.peer !== peer) return;
      log('incoming video call, answering');
      const prevCall = S.call;
      S.call = call;
      if (prevCall && prevCall !== call) setTimeout(() => { try { prevCall.close(); } catch { /* ignore */ } }, 300);
      const md = call.metadata || {};
      if (md.name && !S.friend) S.friend = String(md.name).slice(0, 24);
      const codec = ['h264', 'vp9', 'vp8', 'av1', 'auto'].includes(md.codec) ? md.codec : 'auto';
      const mbps = Number(md.mbps) > 0 && Number(md.mbps) <= 50 ? Number(md.mbps) : 12;
      call.answer(undefined, { sdpTransform: (sdp) => tuneSdp(sdp, codec, mbps) });
      attachDrawChannel(call.peerConnection);
      watchPc(call.peerConnection, 'video');
      call.on('stream', (stream) => {
        log('video stream received');
        S.awaitReturn = null;
        const v = $('video');
        v.srcObject = stream;
        v.play().catch(() => {});
        show('step-watch');
        $('watch-status').textContent = `Watching ${S.friend || 'your friend'}`;
        startStatsLoop();
        later(4000, async () => {
          const r = await describeRoute(call.peerConnection);
          if (r) log(`route: ${r.label} (${r.local} → ${r.remote}, rtt ${r.rtt}ms)`);
        });
      });
      call.on('close', () => log('video call closed'));
      call.on('error', (e) => log(`video call error: ${e && e.type}`));
    });

    peer.on('disconnected', () => {
      if (S.ended || S.peer !== peer) return;
      log('signaling disconnected');
      if (!(S.conn && S.conn.open) && !S.relinking) later(1500, () => { if (!S.ended && S.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect(); });
    });
    peer.on('error', (err) => {
      if (S.peer !== peer) return;
      log(`viewer peer error: ${err.type} ${err.message || ''}`);
      if (S.relinking) {
        // Player gone for good (and video too): the session is over.
        if (err.type === 'peer-unavailable' && !videoAlive()) playerEnded();
        return; // otherwise the relink timer tries again
      }
      if (S.conn && S.conn.open) return; // ignore signaling hiccups once connected
      fail(friendlyPeerError(err));
    });
  }

  // ---------- receipts: did my mark reach their screen? ----------
  let receiptTimer = null;
  function showReceipt(state) {
    const who = S.friend || 'your friend';
    const text = {
      shown: `✓ Shown on ${who}'s screen`,
      hidden: `⚠ Not shown: ${who} hid drawings (Ctrl/Cmd+Shift+H)`,
      minimized: `⚠ Not shown: ${who}'s game is minimized`,
      closed: `⚠ Not shown: ${who}'s shared window closed`,
      'not-visible': `⚠ Couldn't show it on ${who}'s screen`,
    }[state] || '';
    if (!text) return;
    const el = $('receipt');
    el.textContent = text;
    el.className = `receipt ${state === 'shown' ? 'ok' : 'bad'}`;
    el.hidden = false;
    clearTimeout(receiptTimer);
    receiptTimer = setTimeout(() => { el.hidden = true; }, state === 'shown' ? 1500 : 5000);
    if (state !== 'shown') log(`player reported mark not shown: ${state}`);
  }

  // ---------- drawing on the friend's side ----------
  // How long this person's marks stay up, in seconds (Settings, 1-10, default 3).
  function markSeconds() {
    const v = Number(store.get('app.markSeconds', 3));
    return v >= 1 && v <= 10 ? Math.round(v) : 3;
  }
  const drawState = { tool: 'pen', color: store.get('app.color', '#ff3b6b'), active: null, seq: 0 };
  const video = $('video');
  const canvas = $('draw');

  function contentRect() {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }
  const localMarks = new window.Marks(canvas, contentRect);

  // Count frames actually painted on the friend's screen.
  S.framesShown = 0;
  if (video.requestVideoFrameCallback) {
    const onFrame = () => { S.framesShown += 1; video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }

  function norm(ev) {
    const b = canvas.getBoundingClientRect();
    const r = contentRect();
    return {
      x: (ev.clientX - b.left - r.x) / r.w,
      y: (ev.clientY - b.top - r.y) / r.h,
    };
  }
  function inside(p) { return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1; }
  function send(msg) {
    localMarks.apply(msg);
    sendDrawMsg(msg);
  }
  const r4 = (n) => Math.round(n * 10000) / 10000;

  canvas.addEventListener('pointerdown', (ev) => {
    const p = norm(ev);
    if (!inside(p)) return;
    if (drawState.tool === 'ping') {
      send({ t: 'ping', x: r4(p.x), y: r4(p.y), c: drawState.color });
      return;
    }
    canvas.setPointerCapture(ev.pointerId);
    drawState.active = `s${Date.now().toString(36)}${(drawState.seq++).toString(36)}`;
    send({ t: 'start', id: drawState.active, x: r4(p.x), y: r4(p.y), c: drawState.color, h: markSeconds() });
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drawState.active) return;
    const p = norm(ev);
    send({ t: 'move', id: drawState.active, x: r4(Math.min(1, Math.max(0, p.x))), y: r4(Math.min(1, Math.max(0, p.y))) });
  });
  const stopStroke = () => {
    if (!drawState.active) return;
    send({ t: 'end', id: drawState.active });
    drawState.active = null;
  };
  canvas.addEventListener('pointerup', stopStroke);
  canvas.addEventListener('pointercancel', stopStroke);

  function setTool(tool) {
    drawState.tool = tool;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  }
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  function setColor(color, fromCustom) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    drawState.color = color.toLowerCase();
    store.set('app.color', drawState.color);
    let matched = false;
    document.querySelectorAll('.swatch[data-color]').forEach((x) => {
      const on = !fromCustom && x.dataset.color.toLowerCase() === drawState.color;
      x.classList.toggle('active', on);
      matched = matched || on;
    });
    const custom = document.querySelector('.swatch.custom');
    custom.classList.toggle('active', !matched);
    if (!matched) { custom.style.background = drawState.color; $('custom-color').value = drawState.color; }
  }
  document.querySelectorAll('.swatch[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color, false)));
  $('custom-color').addEventListener('input', (ev) => setColor(ev.target.value, true));
  setColor(drawState.color, false);
  $('clear').addEventListener('click', () => send({ t: 'clear' }));
  $('refresh-video').addEventListener('click', () => {
    if (!S.conn || !S.conn.open) return;
    S.conn.send({ t: 'need-video', why: 'refresh button', manual: true });
    log('asked player to refresh video');
    $('freeze').textContent = 'Refreshing video…';
    $('freeze').hidden = false;
  });
  // ---------- reactions ----------
  // Emoji that float up and fade on the player's screen (and on ours).
  const REACTIONS = window.Marks.REACTIONS;
  let reactTimes = [];
  function sendReaction(e) {
    const now = Date.now();
    reactTimes = reactTimes.filter((t) => now - t < 1000);
    if (reactTimes.length >= 6) return; // keep it fun, not a flood
    reactTimes.push(now);
    send({ t: 'react', e, x: r4(0.72 + Math.random() * 0.2) });
  }
  REACTIONS.forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.title = `Send ${e} (key ${i + 1})`;
    b.textContent = e;
    const k = document.createElement('small');
    k.textContent = String(i + 1);
    b.appendChild(k);
    b.addEventListener('click', () => sendReaction(e));
    $('react-menu').appendChild(b);
  });
  const setReactMenu = (open) => {
    $('react-menu').hidden = !open;
    $('react-btn').setAttribute('aria-expanded', String(open));
    $('react-btn').classList.toggle('active', open);
  };
  $('react-btn').addEventListener('click', (ev) => { ev.stopPropagation(); setReactMenu($('react-menu').hidden); });
  document.addEventListener('click', (ev) => { if (!$('react-menu').hidden && !ev.target.closest('.react-wrap')) setReactMenu(false); });

  document.addEventListener('keydown', (ev) => {
    if ($('step-watch').hidden || ev.target.tagName === 'INPUT') return;
    const k = ev.key.toLowerCase();
    if (k === 'p') setTool('pen');
    if (k === 'o') setTool('ping');
    if (k === 'c') send({ t: 'clear' });
    if (k === 'escape') setReactMenu(false);
    const n = Number(ev.key);
    if (n >= 1 && n <= REACTIONS.length && !ev.ctrlKey && !ev.metaKey && !ev.altKey) sendReaction(REACTIONS[n - 1]);
  });

  // =====================================================================
  // wiring
  // =====================================================================
  $('name').value = S.name;
  $('name-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const n = $('name').value.trim().slice(0, 24);
    if (!n) return;
    S.name = n;
    store.set('app.name', n);
    if (!pendingInviteCode && S.maybeWelcome) setTimeout(S.maybeWelcome, 200);
    if (pendingInviteCode) {
      store.set('app.onboarded', true);
      const c = pendingInviteCode;
      pendingInviteCode = null;
      show('step-join');
      $('join-code').value = c;
      joinFriend(c);
      return;
    }
    show('step-role');
  });
  $('go-share').addEventListener('click', () => { $('role-note').hidden = true; show('step-pick'); loadSources(); });
  $('go-join').addEventListener('click', () => {
    $('role-note').hidden = true;
    show('step-join');
    setStatus($('join-status'), '', '');
    $('join-btn').disabled = false;
    $('join-code').focus();
  });
  $('pick-back').addEventListener('click', () => show('step-role'));
  $('pick-refresh').addEventListener('click', loadSources);
  $('open-perm').addEventListener('click', () => bridge.openScreenSettings());
  function inviteText(code) {
    const base = S.info.inviteBase;
    if (base) {
      return `Join my ${NAME} session! ${base}?code=${code}\n(Or open ${NAME} > Join a friend and enter code ${code})`;
    }
    return `Join my ${NAME} session! Open ${NAME} > Join a friend and enter code ${code}${S.info.downloadUrl ? `\nDon't have it? ${S.info.downloadUrl}` : ''}`;
  }
  $('copy-invite').addEventListener('click', async () => {
    if (!S.code) return;
    await bridge.copy(inviteText(S.code));
    log('invite copied');
    $('copy-invite').textContent = 'Copied! Paste it in Discord';
    setTimeout(() => { $('copy-invite').textContent = 'Copy invite link'; }, 1800);
  });
  $('copy-code').addEventListener('click', async () => {
    if (!S.code) return;
    await bridge.copy(S.code);
    $('copy-code').textContent = 'Copied ✓';
    setTimeout(() => { $('copy-code').textContent = 'Copy code only'; }, 1500);
  });
  $('return-game').addEventListener('click', () => bridge.minimize());
  $('change-source').addEventListener('click', openSourceDialog);

  // Draws a sample mark on the player's own screen (overlay check).
  $('test-draw').addEventListener('click', () => {
    const id = `test${Date.now().toString(36)}`;
    const color = '#ffd23f';
    const pts = [];
    const aspect = S.native ? S.native.h / S.native.w : 9 / 16; // keep it a circle
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push([0.5 + Math.cos(a) * 0.16 * aspect, 0.5 + Math.sin(a) * 0.16]);
    }
    bridge.draw({ t: 'start', id, x: pts[0][0], y: pts[0][1], c: color, h: markSeconds() });
    pts.slice(1).forEach((p, i) => setTimeout(() => bridge.draw({ t: 'move', id, x: p[0], y: p[1] }), 12 * (i + 1)));
    setTimeout(() => {
      bridge.draw({ t: 'end', id });
      bridge.draw({ t: 'ping', x: 0.5, y: 0.5, c: color });
    }, 12 * pts.length + 20);
    if (bridge.overlayToast) bridge.overlayToast('Test: this is how your friend\'s marks look');
    log('test drawing sent to overlay');
  });

  // First-run walkthrough
  let slide = 0;
  function showSlide(n) {
    slide = n;
    document.querySelectorAll('#welcome .slide').forEach((el) => { el.hidden = Number(el.dataset.slide) !== n; });
    document.querySelectorAll('#welcome .dot').forEach((d, i) => d.classList.toggle('on', i === n));
    $('welcome-next').textContent = n === 2 ? "Let's go" : 'Next →';
  }
  function openWelcome() { showSlide(0); if (!$('welcome').open) $('welcome').showModal(); }
  function closeWelcome() { store.set('app.onboarded', true); $('welcome').close(); }
  $('welcome-next').addEventListener('click', () => (slide < 2 ? showSlide(slide + 1) : closeWelcome()));
  $('welcome-skip').addEventListener('click', closeWelcome);
  $('open-welcome').addEventListener('click', () => { if ($('settings').open) $('settings').close(); openWelcome(); });
  S.maybeWelcome = () => { if (!store.get('app.onboarded', false)) openWelcome(); };
  $('restart-stream').addEventListener('click', async () => {
    if (!S.source) return;
    const b = $('restart-stream');
    b.disabled = true;
    log('manual stream restart');
    setStatus($('share-status'), 'Restarting stream…', 'busy');
    try {
      if (S.conn && S.conn.open) {
        await restartVideo('manual restart', { kind: 'manual', freshCapture: true, force: true });
      } else {
        lastRestart = 0;
        await restartCapture('manual restart');
      }
      setStatus($('share-status'), S.conn && S.conn.open ? `Stream restarted. ${S.friend || 'Your friend'} is still connected.` : 'Stream restarted. Waiting for your friend…', 'good');
    } finally {
      setTimeout(() => { b.disabled = false; }, 3000);
    }
  });
  if (bridge.onLog) bridge.onLog((line) => log(line));
  // Player: tell the friend whether each mark actually appeared.
  if (bridge.onReceipt) {
    bridge.onReceipt((state) => {
      if (state !== 'shown') log(`mark not shown: ${state}`);
      if (S.conn && S.conn.open) S.conn.send({ t: 'receipt', state });
    });
  }
  $('dialog-refresh').addEventListener('click', openSourceDialog);
  $('dialog-cancel').addEventListener('click', () => $('source-dialog').close());
  if (bridge.onOverlayTrack) {
    bridge.onOverlayTrack(({ state, detail }) => {
      const prev = S.trackState;
      S.trackState = state;
      if (prev === 'minimized' && (state === 'tracking' || state === 'background')) {
        // Windows often stops capture of a minimized fullscreen game for good.
        lastRestart = 0;
        later(700, () => restartCapture('game window restored'));
      }
      const msgs = {
        tracking: 'Drawings follow the game window.',
        screen: 'Drawings show on top of this screen.',
        minimized: 'Game window is minimized. Drawings are hidden until it comes back.',
        background: 'Another app is in front of the game. Drawings still show on top of the game area.',
        closed: 'The shared window was closed.',
        untracked: "Can't track this window's position, so drawings may be misaligned. Share the whole screen if they are.",
      };
      $('track-note').textContent = msgs[state] || '';
      log(`overlay: ${state}${detail ? ` (${detail})` : ''}`);
    });
  }
  $('sound').checked = (() => { try { return localStorage.getItem('app.sound') !== 'false'; } catch { return true; } })();
  $('sound').addEventListener('change', () => { try { localStorage.setItem('app.sound', String($('sound').checked)); } catch { /* ignore */ } });
  if (bridge.onToggleSound) bridge.onToggleSound(() => { setTimeout(() => { try { $('sound').checked = localStorage.getItem('app.sound') !== 'false'; } catch { /* ignore */ } }, 150); });
  if (bridge.onOverlayHidden) bridge.onOverlayHidden((hidden) => { $('overlay-hidden').hidden = !hidden; log(`overlay ${hidden ? 'hidden' : 'shown'} by hotkey`); });
  $('join-form').addEventListener('submit', (ev) => { ev.preventDefault(); joinFriend($('join-code').value); });
  $('join-code').addEventListener('input', () => {
    const el = $('join-code');
    const v = normalizeCode(el.value);
    if (el.value !== v) el.value = v;
  });
  $('join-back').addEventListener('click', () => { teardown(); show('step-role'); });
  $('end').addEventListener('click', () => endSession(''));

  // details
  async function buildDetails() {
    const lines = [
      `${NAME} ${S.info.version} · ${S.info.platform}/${S.info.arch}`,
      `Role: ${S.role || 'none'} · signaling: ${S.peer ? (S.peer.disconnected ? 'disconnected' : 'connected') : 'not started'}`,
      `Drawing link: ${S.conn ? (S.conn.open ? 'open' : 'not open') : 'none'}${S.conn && S.conn.peerConnection ? ` (ICE ${S.conn.peerConnection.iceConnectionState})` : ''}${S.lastHeard && S.conn ? ` · last heard ${Math.round((Date.now() - S.lastHeard) / 1000)} s ago` : ''}${S.peerHb ? ' · heartbeat on' : ''}${S.relinking ? ' · reconnecting' : ''} · video: ${S.call ? (S.call.open ? 'open' : 'pending') : 'none'}`,
      `Relay only: ${store.get('app.relayOnly', false)} · custom TURN: ${store.get('app.turn', null) ? 'yes' : 'no'}`,
    ];
    const routeLine = async (label, pc) => {
      if (!pc) return;
      const r = await describeRoute(pc);
      lines.push(`${label}: ICE ${pc.iceConnectionState} · route: ${r ? `${r.label} (${r.local} → ${r.remote}, rtt ${r.rtt}ms)` : 'none yet'}`);
    };
    await routeLine('Video', S.call && S.call.peerConnection);
    await routeLine('Drawings', S.conn && S.conn.peerConnection);
    lines.push('', ...S.log.slice(-120));
    return lines.join('\n');
  }
  $('open-details').addEventListener('click', async () => {
    if ($('settings').open) $('settings').close();
    $('details-text').textContent = await buildDetails();
    $('details').showModal();
  });
  $('copy-details').addEventListener('click', async () => {
    await bridge.copy(await buildDetails());
    $('copy-details').textContent = 'Copied ✓';
    setTimeout(() => { $('copy-details').textContent = 'Copy details'; }, 1500);
  });
  $('details-close').addEventListener('click', () => $('details').close());
  $('details-copy').addEventListener('click', () => bridge.copy($('details-text').textContent));

  // settings
  $('open-settings').addEventListener('click', () => {
    const t = store.get('app.turn', {}) || {};
    $('turn-url').value = t.url || '';
    $('turn-user').value = t.user || '';
    $('turn-pass').value = t.pass || '';
    $('relay-only').checked = !!store.get('app.relayOnly', false);
    $('settings-name').value = S.name;
    $('settings-update').textContent = '';
    $('mark-seconds').value = String(markSeconds());
    $('mark-seconds-value').textContent = `${markSeconds()} s`;
    S.pendingAvatar = S.avatar;
    window.Profile.picker($('avatar-picker-settings'), () => S.pendingAvatar, (a) => { S.pendingAvatar = a; });
    $('settings').showModal();
  });
  $('settings-cancel').addEventListener('click', () => $('settings').close());
  $('mark-seconds').addEventListener('input', () => { $('mark-seconds-value').textContent = `${$('mark-seconds').value} s`; });
  $('settings-save').addEventListener('click', () => {
    const url = $('turn-url').value.trim();
    store.set('app.turn', url ? { url, user: $('turn-user').value.trim(), pass: $('turn-pass').value } : null);
    store.set('app.relayOnly', $('relay-only').checked);
    const n = $('settings-name').value.trim().slice(0, 24);
    const before = JSON.stringify([S.name, S.avatar]);
    if (n) { S.name = n; store.set('app.name', n); $('name').value = n; }
    if (S.pendingAvatar) { S.avatar = S.pendingAvatar; store.set('app.avatar', S.avatar); }
    const profileChanged = JSON.stringify([S.name, S.avatar]) !== before;
    if (profileChanged) bumpProfile();
    store.set('app.markSeconds', Number($('mark-seconds').value) || 3);
    renderChips();
    if (profileChanged) sendCtl(myProfileMsg());
    $('settings').close();
    log(profileChanged ? 'settings saved; profile sent to friend' : 'settings saved');
  });

  // Avatar: saved one, else a random built-in (saved so it stays the same).
  S.profileVer = store.get('app.profileVer', 0) || Date.now();
  S.avatar = window.Profile.sanitize(store.get('app.avatar', null));
  if (!S.avatar) { S.avatar = window.Profile.randomDefault(); store.set('app.avatar', S.avatar); }
  window.Profile.picker($('avatar-picker-name'), () => S.avatar, (a) => { S.avatar = a; store.set('app.avatar', a); bumpProfile(); renderChips(); sendCtl(myProfileMsg()); });

  // Product name everywhere in the page comes from brand.json.
  document.title = NAME;
  document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = NAME; });

  initQualityControls();

  // ---------- incoming invite links ----------
  let pendingInviteCode = null;
  function handleInvite(code) {
    log(`invite link opened for ${code}`);
    const busy = !S.ended && (S.role === 'share' || (S.role === 'join' && S.conn && S.conn.open));
    if (busy) {
      const bar = $('update-bar');
      bar.hidden = false; bar.classList.remove('bad');
      $('update-btn').hidden = true;
      $('update-text').textContent = `Got an invite (${code}). End your current session first, then click the link again.`;
      return;
    }
    if (!S.name) {
      pendingInviteCode = code;
      show('step-name');
      $('name').focus();
      return;
    }
    show('step-join');
    $('join-code').value = code;
    joinFriend(code);
  }
  if (bridge.onInvite) bridge.onInvite(handleInvite);

  // ---------- updates ----------
  function showUpdate(u) {
    const bar = $('update-bar');
    const btn = $('update-btn');
    bar.classList.remove('bad');
    if (!u) return;
    if (u.error) {
      bar.hidden = false; bar.classList.add('bad');
      $('update-text').textContent = `Update problem: ${u.error}`;
      btn.hidden = true;
      return;
    }
    if (u.progress) {
      bar.hidden = false; btn.hidden = true;
      const p = u.progress;
      if (p.stage === 'restart') { saveResume(); tellPeerUpdating(); }
      $('update-text').textContent = p.stage === 'download' ? `Downloading v${u.latest}… ${Math.round(p.progress * 100)}%`
        : p.stage === 'unpack' ? `Installing v${u.latest}…` : `Restarting into v${u.latest}…`;
      return;
    }
    if (u.available) {
      bar.hidden = false; btn.hidden = false; btn.disabled = false;
      $('update-text').textContent = `${NAME} v${u.latest} is available (you have v${u.current}).${S.ended ? '' : ' Your session reconnects by itself after the update.'}`;
      return;
    }
    if (u.enabled === false) {
      bar.hidden = true;
    } else if (u.missingAsset) {
      bar.hidden = false; btn.hidden = true;
      $('update-text').textContent = `v${u.latest} is out, but not for this computer yet (${u.missingAsset} missing).`;
    } else {
      bar.hidden = true;
    }
  }
  if (bridge.onUpdate) bridge.onUpdate(showUpdate);
  $('update-dismiss').addEventListener('click', () => { $('update-bar').hidden = true; });
  $('check-updates').addEventListener('click', async () => {
    const st = $('settings-update');
    st.textContent = 'Checking…';
    $('check-updates').disabled = true;
    try {
      const u = await bridge.checkUpdate();
      if (!u || u.error) st.textContent = `Couldn't check: ${(u && u.error) || 'no answer'}`;
      else if (u.enabled === false) st.textContent = 'Updates are off in this build.';
      else if (u.available) st.textContent = `Version ${u.latest} is available. Use the "Update now" button at the top.`;
      else if (u.missingAsset) st.textContent = `Version ${u.latest} is out, but not for this computer yet.`;
      else st.textContent = `You're up to date (v${u.current}).`;
    } catch (e) {
      st.textContent = `Couldn't check: ${e.message || e}`;
    } finally {
      $('check-updates').disabled = false;
    }
  });

  // Remember the session so the new version can pick it back up.
  function saveResume() {
    if (S.ended || !S.code || !S.role) { try { localStorage.removeItem('app.resume'); } catch { /* ignore */ } return; }
    const src = S.source ? { id: S.source.id, name: S.source.name, kind: S.source.kind, displayId: S.source.displayId } : null;
    store.set('app.resume', { role: S.role, code: S.code, source: src, friend: S.friend, at: Date.now() });
    log(`saved session (${S.role} ${S.code}) to resume after the update`);
  }
  let toldPeerUpdating = false;
  function tellPeerUpdating() {
    if (toldPeerUpdating) return;
    toldPeerUpdating = true;
    try { if (S.conn && S.conn.open) S.conn.send({ t: 'updating' }); } catch { /* ignore */ }
  }
  $('update-btn').addEventListener('click', async () => {
    $('update-btn').disabled = true;
    log('installing update');
    saveResume();
    const r = await bridge.installUpdate();
    if (r && !r.ok) { try { localStorage.removeItem('app.resume'); } catch { /* ignore */ } showUpdate({ error: r.error }); }
  });

  // After an update restart: pick the session back up (same code, same window).
  async function resumeSession() {
    const r = store.get('app.resume', null);
    try { localStorage.removeItem('app.resume'); } catch { /* ignore */ }
    if (!r || !r.code || Date.now() - (r.at || 0) > 3 * 60 * 1000) return false;
    log(`resuming ${r.role} session ${r.code} after update`);
    if (r.role === 'join') {
      show('step-join');
      $('join-code').value = r.code;
      joinFriend(r.code, { rejoinUntil: Date.now() + 120000, friend: r.friend });
      return true;
    }
    if (r.role === 'share') {
      let res = null;
      try { res = await bridge.listSources(); } catch { /* ignore */ }
      const list = (res && res.sources) || [];
      const want = r.source || {};
      const src = list.find((x) => x.id === want.id)
        || list.find((x) => x.kind === want.kind && x.name === want.name)
        || (want.kind === 'screen' ? list.find((x) => x.kind === 'screen') : null);
      if (!src) {
        log('could not find the shared window after the update');
        show('step-pick');
        loadSources();
        return true;
      }
      await startSharing(src, { code: r.code });
      setStatus($('share-status'), `Updated. Waiting for ${r.friend || 'your friend'} to reconnect…`, 'busy');
      return true;
    }
    return false;
  }

  // boot
  (async () => {
    try { S.info = await bridge.info(); } catch { /* ignore */ }
    $('version').textContent = `${NAME} v${S.info.version}`;
    log(`started v${S.info.version} on ${S.info.platform}/${S.info.arch}`);
    show(S.name ? 'step-role' : 'step-name');
    if (S.name && await resumeSession()) return;
    if (S.name) setTimeout(() => { if (!$('step-join').hidden || !S.maybeWelcome) return; S.maybeWelcome(); }, 600);
    if (!S.name) $('name').focus();
  })();
  window.addEventListener('beforeunload', teardown);

  window.__app = S; // for tests
})();
