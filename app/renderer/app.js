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

  // ---------- icons (sprite in index.html) ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }
  function iconText(el, name, text, after) {
    el.replaceChildren();
    if (after) el.append(document.createTextNode(text), icon(name));
    else el.append(icon(name), document.createTextNode(text));
  }
  // Briefly shows "✓ Copied" on a button, then puts its label back.
  function flashCopied(btn, text, ms) {
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    iconText(btn, 'check', text || 'Copied');
    clearTimeout(btn._flash);
    btn._flash = setTimeout(() => { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }, ms || 1500);
  }

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
  const STEPS = ['step-name', 'step-role', 'step-share', 'step-join', 'step-watch'];
  function show(id) {
    for (const s of STEPS) $(s).hidden = s !== id;
    $('end').hidden = !['step-share', 'step-watch'].includes(id) && !(id === 'step-join' && !S.ended);
    $('tools').hidden = id !== 'step-watch';
    $('share-tools').hidden = id !== 'step-share';
    updateInviteBtn();
    $('preview-toggle').hidden = id !== 'step-share';
    document.body.classList.toggle('watching', id === 'step-watch' || id === 'step-share');
    if (id !== 'step-watch' && $('react-menu')) $('react-menu').hidden = true;
    renderChips();
    updateConn();
    showViewing();
    document.body.classList.toggle('viewer-mode', id === 'step-watch');
    // Viewer: the streamer's avatar sits left of what they're sharing.
    if (id === 'step-watch') { if ($('people').parentElement.id !== 'viewer-left') $('viewer-left').insertBefore($('people'), $('viewing')); }
    else if ($('people').parentElement.id === 'viewer-left') $('invite-wrap').before($('people'));
    if (S.previewReady) updatePreview();
  }
  // Who's here: overlapping avatars; hover or click shows a list with names,
  // who is streaming/watching, and which one is you.
  // The "+" next to the avatars: invite someone. Only while nobody has joined.
  function updateInviteBtn() {
    const friendIn = !!(S.peerProfile || (S.conn && S.conn.open));
    const show = S.role === 'share' && !S.ended && !$('step-share').hidden && !friendIn;
    $('invite-wrap').hidden = !show;
    if (!show) { $('invite-menu').classList.remove('open'); $('invite-btn').setAttribute('aria-expanded', 'false'); }
  }

  function renderChips() {
    const stack = $('chips');
    const menu = $('people-menu');
    stack.innerHTML = '';
    menu.innerHTML = '';
    const people = [];
    if (S.name) people.push({ name: S.name, avatar: S.avatar, you: true, role: S.role === 'share' ? 'Streaming' : S.role === 'join' ? 'Watching' : '' });
    if (S.peerProfile) people.push({ name: S.peerProfile.name, avatar: S.peerProfile.avatar, you: false, role: S.role === 'share' ? 'Watching' : 'Streaming' });
    const others = people.filter((p) => !p.you);
    $('people').hidden = !others.length;
    // my avatar = the account menu button (top right)
    $('me-avatar').replaceChildren(window.Profile.render(S.avatar, S.name, 30));
    $('me-head-avatar').replaceChildren(window.Profile.render(S.avatar, S.name, 36));
    $('me-head-name').textContent = S.name || 'You';
    $('me-btn').title = S.name ? `${S.name} (you)` : 'You';
    updateInviteBtn();
    if (S.role === 'share') renderLiveCard();
    // In the stack you are always in front (leftmost, on top); others behind.
    others.forEach((p, i, arr) => {
      const av = window.Profile.render(p.avatar, p.name, 28);
      av.classList.add('stacked');
      av.style.zIndex = String(arr.length - i);
      stack.appendChild(av);
    });
    $('people-btn').title = people.map((p) => (p.you ? `${p.name} (you)` : p.name)).join(', ');
    const head = document.createElement('div');
    head.className = 'pop-title';
    head.textContent = people.length > 1 ? 'In this session' : 'You';
    menu.appendChild(head);
    for (const p of people) {
      const row = document.createElement('div');
      row.className = 'person';
      row.appendChild(window.Profile.render(p.avatar, p.name, 32));
      const txt = document.createElement('div');
      txt.className = 'person-text';
      const n = document.createElement('div');
      n.className = 'person-name';
      n.textContent = p.name;
      if (p.you) {
        const you = document.createElement('span');
        you.className = 'you-tag';
        you.textContent = 'You';
        n.appendChild(you);
      }
      txt.appendChild(n);
      if (p.role && (S.peerProfile || S.role)) {
        const r = document.createElement('div');
        r.className = 'person-role';
        r.textContent = p.role;
        txt.appendChild(r);
      }
      row.appendChild(txt);
      menu.appendChild(row);
    }
  }
  // The 6-character code, one box per character (blank boxes while waiting).
  function setCodeBoxes(code) {
    const chars = String(code || '').split('');
    for (const el of [$('code'), $('code-mini')]) {
      el.innerHTML = '';
      el.classList.add('otp-display');
      for (let i = 0; i < 6; i++) {
        const c = document.createElement('span');
        c.className = chars[i] ? 'otp-cell' : 'otp-cell empty';
        c.textContent = chars[i] || '·';
        el.appendChild(c);
      }
    }
  }

  // Sharing screen has two states: waiting (one big invite action) and live
  // (compact card with who's watching).
  function setShareLive(live) {
    const el = $('step-share');
    el.classList.toggle('live', !!live);
    el.classList.toggle('waiting', !live);
    document.body.classList.toggle('share-live', !!live);
    renderLiveCard();
  }
  function renderLiveCard() {
    const box = $('live-who');
    if (!box) return;
    box.innerHTML = '';
    const name = (S.peerProfile && S.peerProfile.name) || S.friend || 'Your friend';
    box.appendChild(window.Profile.render(S.peerProfile && S.peerProfile.avatar, name, 44));
    const t = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'live-name';
    n.textContent = `${name} is watching`;
    const sub = document.createElement('div');
    sub.className = 'live-sub';
    sub.textContent = 'They can draw and react on top of your game.';
    t.appendChild(n);
    t.appendChild(sub);
    box.appendChild(t);
  }

  // pv = profile version; changes whenever my name/avatar changes, so the
  // other side can tell (from heartbeats) that its copy is out of date.
  function myProfileMsg() {
    const m = { t: 'hello', name: S.name, avatar: S.avatar, pv: S.profileVer };
    // The streamer also says what it's sharing, so the viewer can show it.
    if (S.role === 'share' && S.source) m.src = { name: String(S.source.name || '').slice(0, 80), kind: S.source.kind };
    return m;
  }
  function showViewing() {
    const src = S.role === 'join' && S.peerSource;
    const on = !!src && !$('step-watch').hidden;
    $('viewing').hidden = !on;
    if (on) $('viewing-name').textContent = src.name || (src.kind === 'screen' ? 'Whole screen' : 'Shared window');
  }
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
    if (msg.src && typeof msg.src === 'object') {
      S.peerSource = { name: String(msg.src.name || '').slice(0, 80) || 'Shared window', kind: msg.src.kind === 'screen' ? 'screen' : 'window' };
      showViewing();
    }
    if (changed) log(`friend updated their profile (${name})`);
    renderChips();
  }

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = `${el.classList.contains('stage-note') ? 'stage-note ' : ''}status ${kind || ''}`.trim();
    if (el.id === 'share-status') statusToast(text, kind);
  }
  // Events while streaming (friend joined/left, game closed, restart…) show as a
  // short toast instead of a line of text sitting over the video.
  let lastToastText = '';
  let lastToastAt = 0;
  function statusToast(text, kind) {
    if (!text || S.role !== 'share' || $('step-share').hidden) return;
    if (/^(Waiting for your friend to enter|Getting your code|Starting capture)/.test(text) || / found you\. Connecting/.test(text)) return; // covered elsewhere / about to be replaced
    if (/^Connected \(/.test(text)) return; // route detail for an already-announced join
    const now = Date.now();
    if (text === lastToastText && now - lastToastAt < 10000) return;
    lastToastText = text;
    lastToastAt = now;
    toast(text, kind);
  }
  function toast(text, kind) {
    const box = $('toasts');
    const t = document.createElement('div');
    t.className = `toast ${kind || ''}`.trim();
    t.setAttribute('role', 'status');
    t.textContent = text;
    box.appendChild(t);
    while (box.children.length > 2) box.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'bad' ? 7000 : 4000);
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
    clearInterval(S.sigTimer);
    S.videoDownSince = null;
    stopHeartbeat();
    clearTimeout(S.relinkTimer);
    S.relinking = false;
    S.relinkTries = 0;
    S.peerHb = false;
    S.awaitRelink = null;
    S.native = null;
    // Say goodbye on both paths (so the other side ends right away instead of
    // trying to rebuild the link, even if one path is already dead), then close
    // everything a moment later so the goodbye gets out first.
    const conn = S.conn;
    const peer = S.peer;
    const call = S.call;
    let bye = false;
    try { if (conn && conn.open) { conn.send({ t: 'bye' }); bye = true; } } catch { /* ignore */ }
    try { if (S.drawDc && S.drawDc.readyState === 'open') { S.drawDc.send(JSON.stringify({ t: 'bye' })); bye = true; } } catch { /* ignore */ }
    const finish = () => {
      try { call && call.close(); } catch { /* ignore */ }
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
    S.peerSource = null;
    S.connRows = null;
    try { resetZoom(); } catch { /* not set up yet */ }
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
  // Defaults scale with the computer: fewer cores / less memory -> lighter
  // stream, so the game keeps its frame rate. Settings always win.
  const CORES = navigator.hardwareConcurrency || 8;
  const MEM_GB = navigator.deviceMemory || 8; // Chromium reports up to 8
  const LOW_SPEC = CORES <= 4 || MEM_GB <= 4;
  const MID_SPEC = !LOW_SPEC && CORES <= 6;
  const QUALITY_DEFAULTS = LOW_SPEC ? { res: '720', fps: 30, mbps: 6, prefer: 'balanced', codec: 'h264' }
    : MID_SPEC ? { res: '1080', fps: 30, mbps: 8, prefer: 'balanced', codec: 'h264' }
      : { res: '1080', fps: 60, mbps: 12, prefer: 'balanced', codec: 'h264' };
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
  // Round trip and packet loss of the video connection (for the signal icon).
  async function readNet(pc, dir) {
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let rtt = null; let lost = null; let recv = null; let fraction = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
        if (dir === 'inbound-rtp' && r.type === 'inbound-rtp' && r.kind === 'video') { lost = r.packetsLost; recv = r.packetsReceived; }
        if (dir === 'outbound-rtp' && r.type === 'remote-inbound-rtp' && r.kind === 'video' && r.fractionLost != null) fraction = r.fractionLost;
      });
      if (fraction == null && lost != null && recv != null) {
        const p = S.netPrev || { lost, recv };
        const dl = lost - p.lost; const dr = recv - p.recv;
        fraction = dl + dr > 0 ? Math.max(0, dl / (dl + dr)) : 0;
        S.netPrev = { lost, recv };
      }
      return { rtt, loss: fraction };
    } catch { return null; }
  }
  // good / ok / poor from the network itself (a still game picture is not a bad signal).
  function signalLevel(state, net, extra) {
    if (state !== 'connected') return 'poor';
    const rtt = net && net.rtt; const loss = net && net.loss;
    if ((loss != null && loss > 0.05) || (rtt != null && rtt > 300)) return 'poor';
    if ((loss != null && loss > 0.01) || (rtt != null && rtt > 120) || (extra && extra.limited)) return 'ok';
    return 'good';
  }
  const LEVEL_TEXT = { good: 'Good', ok: 'Fair', poor: 'Poor', none: 'Not connected' };
  function setSignal(level, detail) {
    S.sigLevel = level;
    S.sigDetail = detail || '';
    const b = $('conn-btn');
    // A lasting video problem turns a "good" icon yellow, so it's noticed without flashing text.
    const shown = level === 'good' && S.role === 'share' && connIssueText() ? 'ok' : level;
    b.classList.remove('sig-good', 'sig-ok', 'sig-poor', 'sig-none', 'has-issue');
    b.classList.add(`sig-${shown}`);
    if (S.role === 'share' && connIssueText()) b.classList.add('has-issue');
    const t = `Connection: ${LEVEL_TEXT[shown]}${S.role === 'share' && connIssueText() ? ' (click for details)' : ''}`;
    if (b.dataset.tip !== undefined) b.dataset.tip = t; else b.title = t;
    if (!$('conn-menu').classList.contains('open')) return;
    fillConnMenu();
  }
  function fillConnMenu() {
    const raw = S.sigLevel || 'none';
    const lv = raw === 'good' && S.role === 'share' && connIssueText() ? 'ok' : raw; // match the icon
    $('conn-level').textContent = LEVEL_TEXT[lv];
    $('conn-level').className = `conn-level lv-${lv}`;
    const problem = S.role === 'share' ? connIssueText() : '';
    $('conn-issue').hidden = !problem;
    $('conn-issue-text').textContent = problem;
    const grid = $('conn-grid');
    grid.replaceChildren();
    const rows = S.connRows && S.connRows.length ? S.connRows : [['Video', 'Starting…']];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      grid.append(dt, dd);
    }
    $('refresh-video').hidden = S.role !== 'join';
    $('conn-restart').hidden = S.role !== 'share';
  }
  // Connection button: visible while a friend is connected.
  function updateConn() {
    const live = !S.ended && (S.role === 'join' ? !$('step-watch').hidden : S.role === 'share' && !!S.call);
    $('conn').hidden = !live;
    if (!live) { $('conn-menu').classList.remove('open'); setSignal('none'); }
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
  // Structured rows for the connection panel.
  const TRACK_SHORT = { tracking: 'Following the game window', screen: 'On top of the screen', background: 'Game is behind another app', minimized: 'Hidden (game minimized)', away: 'Hidden (you\'re not in the game)', closed: 'Shared window closed', untracked: 'Position unknown' };
  function connRows(v, net, route, extra) {
    const rows = [];
    if (v && v.w) rows.push(['Video', `${v.w}×${v.h} · ${r0(v.fps)} fps`]);
    if (extra && extra.shown != null) rows.push([S.role === 'share' ? 'Friend sees' : 'Showing', `${r0(extra.shown)} fps`]);
    if (v && v.mbps != null) rows.push(['Bitrate', `${v.mbps.toFixed(1)} Mbps`]);
    if (v && v.codec) rows.push([S.role === 'share' ? 'Encoder' : 'Decoder', `${v.codec}${v.hw === true ? ' · hardware' : v.hw === false ? ' · software' : ''}`]);
    if (route) rows.push(['Route', route.label.charAt(0).toUpperCase() + route.label.slice(1)]);
    if (net && net.rtt != null) rows.push(['Ping', `${Math.round(net.rtt)} ms`]);
    if (net && net.loss != null) rows.push(['Packet loss', `${(net.loss * 100).toFixed(1)}%`]);
    if (S.role === 'share' && TRACK_SHORT[S.trackState]) rows.push(['Drawings', TRACK_SHORT[S.trackState]]);
    return rows;
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
  // Only problems we can detect reliably AND the player can act on. (Frame-rate
  // based hints were dropped: a still game screen legitimately produces ~1 new
  // frame a second, so they fired constantly for nothing.)
  function bottleneck(v) {
    if (!v) return null;
    const busyEncoder = v.captureFps != null && v.captureFps >= 10 && v.encodedFps != null && v.encodedFps < v.captureFps * 0.7;
    if (v.limit === 'cpu' || (busyEncoder && v.hw === false)) {
      return { key: 'cpu', text: "Your computer can't keep up with this video quality. Lower the resolution or switch to 30 fps in stream settings." };
    }
    if (v.limit === 'bandwidth') {
      return { key: 'bandwidth', text: 'Your internet upload is the limit, so your friend gets lower quality. Lower the resolution, or use a network cable.' };
    }
    return null;
  }
  // A problem must last 10 s before it shows, and then stays at least 10 s.
  const issue = { key: null, since: 0, shownAt: 0, text: '' };
  function trackIssue(found) {
    const now = Date.now();
    if (found && found.key === issue.key) {
      if (!issue.text && now - issue.since >= 10000) { issue.text = found.text; issue.shownAt = now; log(`video issue: ${found.key}`); updateIssue(); }
      return;
    }
    if (issue.text && now - issue.shownAt < 10000) return; // keep it up long enough to read
    const had = !!issue.text;
    issue.key = found ? found.key : null;
    issue.since = now;
    issue.text = '';
    if (had) updateIssue();
  }
  function connIssueText() { return issue.text || (S.netCapMbps ? `The connection kept dropping, so quality is capped at ${S.netCapMbps} Mbps for this session. Change "Max quality" in stream settings to reset it.` : ''); }
  function updateIssue() {
    if (S.sigLevel) setSignal(S.sigLevel, S.sigDetail);
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
        const netS = await readNet(pc, 'outbound-rtp');
        S.connRows = connRows(v, netS, routeCache, { shown: viewer ? viewer.shown : null });
        setSignal(signalLevel(pc.connectionState, netS, { limited: v && v.limit === 'bandwidth' }),
          netS ? `Round trip ${netS.rtt != null ? Math.round(netS.rtt) : '–'} ms · loss ${netS.loss != null ? (netS.loss * 100).toFixed(1) : '–'}%` : '');
        updateConn();
        $('q-pipe').textContent = pipeline(v, viewer);
        trackIssue(bottleneck(v));
        // Still game screens produce no new frames, so "no frames" alone is
        // not a problem. Only if the game is the active window and nothing
        // arrives for 20 s, quietly re-grab it (at most every 3 minutes).
        if (cf >= 10 && S.trackState === 'tracking' && Date.now() - (S.lastStillFix || 0) > 180000) {
          S.lastStillFix = Date.now();
          restartCapture(`no new frames for ${cf * 2}s while the game is in front`);
        } else if (f >= 2 && cf === 0) {
          // Frames come in but none go out: the encoder is stuck. Fix silently.
          restartVideo(`encoder/sending stalled ${f * 2}s, capture ok`, { kind: 'encoder' });
        }
        if (cf === 3 || f === 3) log(`player: ${cf >= 3 ? 'no new frames from the game (still screen, or capture stalled)' : 'video sending stalled'}, limit: ${v && v.limit}`);
        if (n % 5 === 0 && v) log(`stats: ${fmtStats(v, routeCache)} | ${pipeline(v, viewer)} | limit ${v.limit} | encoder ${v.encoder}`);
        if (S.conn && S.conn.open) {
          // every 2 s, so the friend knows a still picture is just a still game screen
          S.conn.send({ t: 'stat', cap: cf >= 2, send: f >= 3, limit: v ? v.limit : '' });
        }
      } else if (S.role === 'join') {
        const v = await readVideoStats(pc, 'inbound-rtp');
        const f = freeze.check('recv', v && v.frames);
        if (f === 0 && S.playerStat && S.playerStat.restarting) S.playerStat.restarting = false;
        const shown = rate('shown', S.framesShown, performance.now());
        $('watch-status').textContent = `Watching ${S.friend || 'your friend'} · ${fmtStats(v, routeCache)}${shown != null ? ` · showing ${r0(shown)} fps` : ''}`;
        const netV = await readNet(pc, 'inbound-rtp');
        S.connRows = connRows(v, netV, routeCache, { shown });
        setSignal(signalLevel(pc.connectionState, netV),
          netV ? `Round trip ${netV.rtt != null ? Math.round(netV.rtt) : '–'} ms · loss ${netV.loss != null ? (netV.loss * 100).toFixed(1) : '–'}%` : '');
        if (S.conn && S.conn.open && v) {
          S.conn.send({ t: 'vstat', recv: v.receivedFps, decoded: v.fps, shown, dropped: v.droppedFps, decoder: v.encoder });
        }
        // Video connection itself down (not just a still picture): if it
        // doesn't come back within 30 s, start the session over.
        const vstate = pc.connectionState;
        if (['failed', 'closed', 'disconnected'].includes(vstate)) {
          if (!S.videoDownSince) S.videoDownSince = Date.now();
          if (Date.now() - S.videoDownSince > 30000) { autoRejoin(`video connection ${vstate} for 30 s`); return; }
        } else S.videoDownSince = null;
        // The player's last report (every ~4 s): is their game producing frames, is video going out?
        const ps = S.playerStat && Date.now() - (S.playerStat.at || 0) < 9000 ? S.playerStat : {};
        // A still game screen sends no new frames: that's not a freeze. Only
        // treat it as one when the player says frames are being captured and sent.
        const stillPicture = ps.cap === true;
        let msg = '';
        if (f >= 5 && !stillPicture && S.conn && S.conn.open && (f === 5 || f % 8 === 0)) {
          // Frozen while drawings still work and the player is sending: ask them to rebuild video.
          S.conn.send({ t: 'need-video', why: `no frames ${f * 2}s` });
          log(`no frames for ${f * 2}s, asked player to rebuild video`);
        }
        if (ps.restarting) msg = `${S.friend || 'Your friend'}'s video is restarting…`;
        else if (f >= 3 && !stillPicture) {
          msg = routeCache && routeCache.kind === 'relay' ? 'Video paused: the connection is too slow. Waiting…' : 'Video paused: waiting for the connection…';
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
    // a saved value that isn't one of the choices still shows (instead of a blank box)
    if (![...$('q-mbps').options].some((o) => o.value === String(q.mbps))) $('q-mbps').add(new Option(`${q.mbps} Mbps`, String(q.mbps)));
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
          toast('Applying… the video blinks for a second.');
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
  async function renderSources(box, onPick, opts) {
    opts = opts || {};
    // Skeleton in the same shape as the real picker, so the modal doesn't jump.
    if (!box.querySelector('.picker')) {
      box.innerHTML = `<div class="picker loading" aria-busy="true"><div class="picker-tabs"><button type="button" class="on" disabled>Applications</button><button type="button" disabled>Entire Screen</button></div><div class="picker-grid">${'<div class="pick skel"><span class="pick-shot"></span><span class="pick-meta"><span class="skel-line"></span></span></div>'.repeat(4)}</div><div class="picker-foot"><div class="picker-sum"><span class="skel-line w40"></span><span class="skel-line w60"></span></div></div></div>`;
    } else {
      box.querySelector('.picker').classList.add('loading'); // refresh: keep the layout, dim it
    }
    let res;
    try { res = await bridge.listSources(); } catch (e) { res = { sources: [], error: String(e) }; }
    log(`sources: ${res.sources.length}, screen permission: ${res.status}, window tracking: ${res.tracking}${res.trackingError ? ` (${res.trackingError})` : ''}${res.error ? `, error: ${res.error}` : ''}`);
    const permProblem = res.status && res.status !== 'granted' && res.status !== 'not-determined';
    box.innerHTML = '';
    if (!res.sources.length) {
      box.innerHTML = `<p class="note picker-none">Nothing to share found. If you are on a Mac, allow Screen Recording for ${NAME}, then quit and reopen the app.</p>`;
      return { permProblem: true };
    }
    // Discord-style picker: tabs, big previews, quality summary at the bottom.
    const tabs = [
      { key: 'window', label: 'Applications', icon: 'app-window', items: res.sources.filter((x) => x.kind === 'window') },
      { key: 'screen', label: 'Entire Screen', icon: 'monitor', items: res.sources.filter((x) => x.kind === 'screen') },
    ];
    let tab = S.pickerTab && tabs.find((t) => t.key === S.pickerTab && t.items.length) ? S.pickerTab : (tabs[0].items.length ? 'window' : 'screen');
    const wrap = document.createElement('div');
    wrap.className = 'picker';
    const bar = document.createElement('div');
    bar.className = 'picker-tabs';
    bar.setAttribute('role', 'tablist');
    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    const drawGrid = () => {
      grid.replaceChildren();
      bar.querySelectorAll('button').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      const t = tabs.find((x) => x.key === tab);
      if (!t.items.length) {
        const p = document.createElement('p');
        p.className = 'note picker-empty';
        p.textContent = tab === 'window' ? 'No open apps found. Open your game, then click Refresh.' : 'No screens found.';
        grid.appendChild(p);
        return;
      }
      for (const src of t.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = src.likelyGame ? 'pick likely-game' : 'pick';
        b.title = src.name;
        const shot = document.createElement('span');
        shot.className = 'pick-shot';
        if (src.thumb) {
          const img = document.createElement('img');
          img.alt = '';
          img.src = src.thumb;
          shot.appendChild(img);
        }
        if (src.likelyGame) {
          const tag = document.createElement('span');
          tag.className = 'likely';
          iconText(tag, 'star', 'Looks like your game');
          shot.appendChild(tag);
        }
        const go = document.createElement('span');
        go.className = 'pick-go';
        go.textContent = src.kind === 'screen' ? 'Share Screen' : 'Share Window';
        shot.appendChild(go);
        b.appendChild(shot);
        const label = document.createElement('span');
        label.className = 'pick-meta';
        if (src.icon) {
          const ic = document.createElement('img');
          ic.className = 'src-icon';
          ic.alt = '';
          ic.src = src.icon;
          label.appendChild(ic);
        } else {
          label.appendChild(icon(src.kind === 'screen' ? 'monitor' : 'app-window'));
        }
        const name = document.createElement('span');
        name.className = 'pick-name';
        name.textContent = src.name;
        label.appendChild(name);
        b.appendChild(label);
        b.addEventListener('click', () => onPick(src));
        grid.appendChild(b);
      }
    };
    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tab = t.key;
      b.setAttribute('role', 'tab');
      b.append(icon(t.icon), document.createTextNode(t.label));
      b.addEventListener('click', () => { tab = t.key; S.pickerTab = tab; drawGrid(); });
      bar.appendChild(b);
    }
    // Footer: current quality, gear to change it right here.
    const foot = document.createElement('div');
    foot.className = 'picker-foot';
    const sum = document.createElement('div');
    sum.className = 'picker-sum';
    const sumTitle = document.createElement('strong');
    const sumLine = document.createElement('span');
    sum.append(sumTitle, sumLine);
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'icon-btn picker-gear';
    gear.title = 'Stream quality';
    gear.setAttribute('aria-expanded', 'false');
    gear.appendChild(icon('gear'));
    const qbox = document.createElement('div');
    qbox.className = 'picker-quality';
    qbox.hidden = true;
    const mkSel = (labelText, srcId) => {
      const l = document.createElement('label');
      l.textContent = labelText;
      const sel = document.createElement('select');
      sel.innerHTML = $(srcId).innerHTML;
      sel.value = $(srcId).value;
      sel.addEventListener('change', () => {
        $(srcId).value = sel.value;
        $(srcId).dispatchEvent(new Event('change')); // same save path as stream settings
        paintSum();
      });
      l.appendChild(sel);
      return l;
    };
    qbox.append(mkSel('Resolution', 'q-res'), mkSel('Frame rate', 'q-fps'), mkSel('Max quality', 'q-mbps'), mkSel('When the network struggles', 'q-prefer'), mkSel('Video format', 'q-codec'));
    const paintSum = () => {
      const q = quality();
      const pref = { balanced: 'Balanced', sharp: 'Sharper video', smooth: 'Smoother video' }[q.prefer] || 'Balanced';
      const res = q.res === 'native' ? 'Native' : `${q.res}p`;
      sumTitle.textContent = 'Stream quality';
      sumLine.textContent = `${pref} · ${res} · ${q.fps}fps`;
    };
    gear.addEventListener('click', () => {
      qbox.hidden = !qbox.hidden;
      gear.setAttribute('aria-expanded', qbox.hidden ? 'false' : 'true');
    });
    paintSum();
    const right = document.createElement('div');
    right.className = 'picker-actions';
    if (opts.onRefresh) {
      const rf = document.createElement('button');
      rf.type = 'button';
      rf.className = 'icon-btn picker-gear';
      rf.title = 'Refresh the list';
      rf.appendChild(icon('refresh'));
      rf.addEventListener('click', opts.onRefresh);
      right.appendChild(rf);
    }
    right.appendChild(gear);
    if (opts.onCancel) {
      const cx = document.createElement('button');
      cx.type = 'button';
      cx.className = 'ghost picker-cancel';
      cx.textContent = 'Cancel';
      cx.addEventListener('click', opts.onCancel);
      right.appendChild(cx);
    }
    foot.append(sum, right);
    wrap.append(bar, grid, qbox, foot);
    box.appendChild(wrap);
    drawGrid();
    return { permProblem };
  }

  // Starts capturing one source. Returns the new stream (not yet in use).
  async function captureSource(source) {
    if (await bridge.selectSource(source.id) === false) {
      const e = new Error(`"${source.name}" is no longer open`); e.name = 'SourceGone'; throw e;
    }
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
    $('source-name').textContent = source.name;
    if (S.role === 'share') sendCtl(myProfileMsg()); // tell the viewer what's shared now
  }

  async function startSharing(source, opts) {
    teardown();
    S.ended = false;
    S.role = 'share';
    S.source = source;
    show('step-share');
    setCodeBoxes('');
    $('copy-code').disabled = true; $('copy-invite').disabled = true;
    $('share-title').textContent = 'Invite your friend';
    setShareLive(false);
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
    openSourceDialog('switch');
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
    drawLocal({ t: 'clear' });
    if (S.conn && S.conn.open) S.conn.send({ t: 'source', name: source.name });
    setStatus($('share-status'), S.conn && S.conn.open ? `Now sharing "${source.name}". ${S.friend || 'Your friend'} sees it.` : `Now sharing "${source.name}".`, 'good');
  }

  // One picker for both: starting to share, and switching mid-stream.
  let pickerMode = 'start';
  async function openSourceDialog(mode) {
    if (mode === 'start' || mode === 'switch') pickerMode = mode;
    const dlg = $('source-dialog');
    // Fresh open: skeleton (never stale thumbnails from last time). Refresh inside: keep layout.
    if (!dlg.open) { $('dialog-sources').innerHTML = ''; dlg.showModal(); }
    const r = await renderSources($('dialog-sources'), (src) => {
      dlg.close();
      if (pickerMode === 'start') startSharing(src); else switchSource(src);
    }, { onRefresh: () => openSourceDialog(), onCancel: () => dlg.close() });
    $('perm').hidden = !(r && r.permProblem);
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

    let registered = false;
    peer.on('open', () => {
      if (S.peer !== peer) return;
      // 'open' fires again after every reconnect to the pairing service:
      // only the first one is the start of sharing.
      if (registered) return;
      registered = true;
      log('host peer registered');
      setCodeBoxes(S.code);
      $('copy-code').disabled = false; $('copy-invite').disabled = false;
      setStatus($('share-status'), 'Waiting for your friend to enter the code…', 'busy');
    });
    peer.on('connection', (conn) => onViewerConnection(conn));
    keepSignaling(peer);
    peer.on('disconnected', () => {
      if (S.ended || S.peer !== peer) return;
      // Existing direct connections keep working; the keeper reconnects.
      log('signaling disconnected');
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
        if ((S.conn && S.conn.open) || S.awaitRelink || S.call) {
          // Friend is already connected directly; the pairing service only
          // matters for setting up new connections. Reconnect quietly.
          later(4000, () => { if (!S.ended && S.peer === peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch { /* ignore */ } } });
          return;
        }
        if (!S.conn) {
          setCodeBoxes('');
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

  // ---------- pairing service (signaling) connection ----------
  // New video connections are set up through the pairing service, so it must
  // stay connected for the whole session. Networks change (VPN on/off, Wi-Fi
  // switch): check every 2 s and reconnect, backing off up to ~12 s.
  function keepSignaling(peer) {
    clearInterval(S.sigTimer);
    let wait = 0;
    let tries = 0;
    peer.on('open', () => {
      if (tries) log('pairing service reconnected');
      tries = 0; wait = 0;
      // Clear a stale "Couldn't get online… Retrying" once we're back.
      const st = $('share-status');
      if (S.role === 'share' && st && /Retrying…$/.test(st.textContent)) {
        if ((S.conn && S.conn.open) || S.awaitRelink || S.call) setStatus(st, `Connected. ${(S.peerProfile && S.peerProfile.name) || 'Your friend'} can see your screen and draw on it.`, 'good');
        else if (S.code) setStatus(st, 'Waiting for your friend to enter the code…', 'busy');
      }
    });
    S.sigTimer = setInterval(() => {
      if (S.ended || S.peer !== peer || peer.destroyed) { clearInterval(S.sigTimer); return; }
      if (!peer.disconnected) return;
      if (wait > 0) { wait--; return; }
      tries++;
      log(`reconnecting to the pairing service (try ${tries})`);
      try { peer.reconnect(); } catch { /* ignore */ }
      wait = Math.min(5, tries);
    }, 2000);
  }

  // Viewer, last resort: start the session over with the same code (like
  // typing it in again). Used when the video connection stays down.
  function autoRejoin(why) {
    if (S.role !== 'join' || S.ended || S.autoRejoining || !S.code) return;
    S.autoRejoining = true;
    const code = S.code;
    const friend = S.friend;
    log(`${why}; rejoining the session`);
    teardown();
    show('step-join');
    $('join-code').value = code;
    $('end').hidden = false;
    setStatus($('join-status'), `Reconnecting to ${friend || 'your friend'}…`, 'busy');
    setTimeout(() => {
      S.autoRejoining = false;
      if ($('step-join').hidden || $('join-code').value !== code) return; // user left meanwhile
      joinFriend(code, { rejoinUntil: Date.now() + 90000, friend });
    }, 1500);
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
        if (S.role === 'share') S.lastHeardAny = Date.now();
        if (S.role === 'share' && DRAW_TYPES.includes(m.t)) { receiveDraw(m); return; }
        if (S.role === 'share' && m.t === 'bye') { friendSaidBye(); return; }
        handleCtl(m);
      };
    } catch (e) {
      log(`no drawing path inside the video connection (${e && e.message})`);
    }
  }
  const DRAW_TYPES = ['start', 'move', 'end', 'ping', 'clear', 'react', 'arrow', 'laser'];

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
    if (typeof m.q !== 'number' || !m.s) { drawLocal(m); return; } // older friend
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
      drawLocal(plain);
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
      S.lastHeard = S.lastHeardAny = Date.now();
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
      setShareLive(true);
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
      S.lastHeard = S.lastHeardAny = Date.now();
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

  // The friend ended on purpose: close out right away (the link's own "closed"
  // event can be slow or never come), unless they're back on a new link.
  function friendSaidBye() {
    if (S.conn) S.conn.byeReceived = true;
    const was = S.conn;
    later(1200, () => {
      if (S.role !== 'share' || S.ended) return;
      if ((S.conn && S.conn === was) || (!S.conn && (S.call || S.awaitRelink || S.peerProfile))) viewerGone();
    });
  }
  function hostData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (S.conn === conn) { S.lastHeard = Date.now(); S.lastHeardAny = S.lastHeard; }
    if (msg.t === 'hb') { S.peerHb = true; checkPeerPv(msg.pv); return; }
    if (msg.t === 'bye') { conn.byeReceived = true; if (S.conn === conn) friendSaidBye(); return; }
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
    setTimeout(updateConn, 0);
    S.drawDc = null;
    if (S.rx) clearTimeout(S.rx.timer);
    S.rx = null;
    S.awaitRelink = null;
    clearTimeout(S.relinkTimer);
    stopHeartbeat();
    S.peerHb = false;
    S.peerProfile = null;
    renderChips();
    drawLocal({ t: 'clear' });
    try { S.call && S.call.close(); } catch { /* ignore */ }
    S.call = null;
    S.conn = null;
    clearInterval(S.statsTimer);
    $('q-stats').textContent = '';
    $('q-hint').textContent = '';
    if (S.ended) return;
    $('share-title').textContent = 'Invite your friend';
    setShareLive(false);
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
  const FRIEND_GONE_MS = Number(store.get('app.friendGoneMs', 20000)) || 20000; // (tests shorten it)
  function startHeartbeat() {
    clearInterval(S.hbTimer);
    S.hbTimer = setInterval(() => {
      try { if (S.conn && S.conn.open) S.conn.send({ t: 'hb', pv: S.profileVer }); } catch { /* ignore */ }
      try { if (S.drawDc && S.drawDc.readyState === 'open') S.drawDc.send(JSON.stringify({ t: 'hb', pv: S.profileVer })); } catch { /* ignore */ }
      if (S.role === 'share' && S.conn && hostLinkDead() && !S.quietLogged) {
        S.quietLogged = true;
        log(`no word from friend on the drawing link for ${Math.round((Date.now() - S.lastHeard) / 1000)} s`);
      } else if (!hostLinkDead()) S.quietLogged = false;
      // Silent on every path for 20 s (app quit, laptop asleep, network gone):
      // they're not coming back on this connection. Stop streaming to nobody.
      if (S.role === 'share' && !S.ended && S.peerHb && !S.peerUpdating && (S.conn || S.awaitRelink || S.call)) {
        const quiet = Date.now() - (S.lastHeardAny || S.lastHeard || Date.now());
        if (quiet > FRIEND_GONE_MS) {
          log(`no word from friend on any path for ${Math.round(quiet / 1000)} s; treating them as gone`);
          viewerGone();
        }
      }
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
      updateIssue(); // shown on the connection icon + menu
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
        if (msg.t === 'stat') { S.playerStat = Object.assign(S.playerStat || {}, msg, { at: Date.now() }); return; }
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

    let lookedUp = false;
    peer.on('open', () => {
      if (S.peer !== peer) return;
      // 'open' fires again after every reconnect to the pairing service:
      // only the first one starts the join (a second join would be refused).
      if (lookedUp) return;
      lookedUp = true;
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

    keepSignaling(peer);
    peer.on('disconnected', () => {
      if (S.ended || S.peer !== peer) return;
      log('signaling disconnected');
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
      shown: `Shown on ${who}'s screen`,
      hidden: `Not shown: ${who} hid drawings (Ctrl/Cmd+Shift+H)`,
      minimized: `Not shown: ${who}'s game is minimized`,
      away: `Not shown: ${who} is in another app right now`,
      closed: `Not shown: ${who}'s shared window closed`,
      'not-visible': `Couldn't show it on ${who}'s screen`,
    }[state] || '';
    if (!text) return;
    const el = $('receipt');
    iconText(el, state === 'shown' ? 'check' : 'alert', text);
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

  // Viewer zoom: view = scale z + offset (tx, ty) in canvas px. The video gets
  // the same CSS transform, and every mark maps through contentRect(), so marks
  // still land on the right spot of the streamer's screen.
  const view = { z: 1, tx: 0, ty: 0 };
  function contentRect() {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;
    const x = (cw - w) / 2;
    const y = (ch - h) / 2;
    return { x: x * view.z + view.tx, y: y * view.z + view.ty, w: w * view.z, h: h * view.z, z: view.z };
  }
  function applyView() {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    view.z = Math.min(4, Math.max(1, view.z));
    // keep the zoomed picture covering the stage (no empty gaps when panning)
    view.tx = Math.min(0, Math.max(cw - cw * view.z, view.tx));
    view.ty = Math.min(0, Math.max(ch - ch * view.z, view.ty));
    if (view.z === 1) { view.tx = 0; view.ty = 0; }
    video.style.transformOrigin = '0 0';
    video.style.transform = view.z === 1 ? '' : `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
    $('zoom-pill').hidden = view.z === 1;
    $('zoom-level').textContent = `${Math.round(view.z * 100)}%`;
    if (localMarks.active) localMarks._wake();
  }
  function zoomAt(cx, cy, z) {
    const nz = Math.min(4, Math.max(1, z));
    view.tx = cx - (cx - view.tx) * (nz / view.z);
    view.ty = cy - (cy - view.ty) * (nz / view.z);
    view.z = nz;
    applyView();
  }
  function resetZoom() { view.z = 1; view.tx = 0; view.ty = 0; applyView(); }
  const localMarks = new window.Marks(canvas, contentRect, { laserDelay: 0 }); // your own pointer: no delay

  // ---------- streamer preview ----------
  // The player sees their stream like the friend does, marks included. To save
  // resources it pauses whenever this app is not in front (playing the game,
  // minimized, another app focused) and picks up again when they come back.
  const pVideo = $('preview-video');
  const pCanvas = $('preview-draw');
  function fitRect(v, c) {
    return () => {
      const cw = c.clientWidth; const ch = c.clientHeight;
      const vw = v.videoWidth || 16; const vh = v.videoHeight || 9;
      const k = Math.min(cw / vw, ch / vh);
      return { x: (cw - vw * k) / 2, y: (ch - vh * k) / 2, w: vw * k, h: vh * k };
    };
  }
  const previewMarks = new window.Marks(pCanvas, fitRect(pVideo, pCanvas));
  function drawLocal(m) {
    bridge.draw(m);
    if (S.role === 'share' && !previewOff) previewMarks.apply(m);
  }
  // Streamer can turn the preview off entirely: no decoding, no mark drawing.
  let previewOff = !!store.get('app.previewOff', false);
  function setPreviewOff(off) {
    previewOff = !!off;
    store.set('app.previewOff', previewOff);
    const b = $('preview-toggle');
    b.setAttribute('aria-pressed', previewOff ? 'true' : 'false');
    b.dataset.tip = previewOff ? 'Show my stream preview' : 'Hide my stream preview (saves resources)';
    b.removeAttribute('title');
    b.querySelector('use').setAttribute('href', previewOff ? '#i-eye-slash' : '#i-eye');
    if (previewOff) previewMarks.apply({ t: 'clear' });
    log(`stream preview ${previewOff ? 'hidden' : 'shown'}`);
    updatePreview();
  }
  function previewWanted() {
    return S.role === 'share' && !S.ended && !$('step-share').hidden && !!S.stream && !previewOff
      && document.visibilityState === 'visible' && document.hasFocus();
  }
  function updatePreview() {
    const has = S.role === 'share' && !S.ended && !!S.stream;
    $('preview-off').hidden = !(has && previewOff);
    $('preview-draw').hidden = previewOff;
    if (!has) { if (pVideo.srcObject) pVideo.srcObject = null; $('preview-paused').hidden = true; return; }
    if (previewOff) {
      if (pVideo.srcObject) { pVideo.pause(); pVideo.srcObject = null; } // stop decoding completely
      $('preview-paused').hidden = true;
      return;
    }
    if (previewWanted()) {
      if (pVideo.srcObject !== S.stream) pVideo.srcObject = S.stream;
      if (pVideo.paused) pVideo.play().catch(() => {});
      $('preview-paused').hidden = true;
    } else {
      if (!pVideo.paused) pVideo.pause();
      $('preview-paused').hidden = false;
    }
  }
  window.addEventListener('focus', updatePreview);
  window.addEventListener('blur', updatePreview);
  document.addEventListener('visibilitychange', updatePreview);
  setInterval(updatePreview, 1000); // picks up a new capture after Change source / Restart stream
  $('preview-toggle').addEventListener('click', () => setPreviewOff(!previewOff));
  $('preview-show').addEventListener('click', () => setPreviewOff(false));
  if (previewOff) setPreviewOff(true);
  S.previewReady = true;

  // ---------- join code: six boxes over one real input ----------
  // Paste works (a whole invite message too: the 6-character code is pulled out).
  function cleanJoinCode(raw) {
    const text = String(raw || '');
    if (!/[^A-Za-z0-9]/.test(text)) return normalizeCode(text).slice(0, 6); // typed or plain code
    // A pasted invite: code= in the link, then join/XXXXXX, then "code XXXXXX",
    // then the last 6-character word as a fallback.
    const tries = [/code=([A-Za-z0-9]{6})(?![A-Za-z0-9])/i, /join\/([A-Za-z0-9]{6})(?![A-Za-z0-9])/i, /code\s+([A-Za-z0-9]{6})(?![A-Za-z0-9])/i];
    for (const re of tries) { const m = text.match(re); if (m) return m[1].toUpperCase(); }
    const words = text.toUpperCase().match(/(?:^|[^A-Z0-9])[A-Z0-9]{6}(?=$|[^A-Z0-9])/g);
    if (words && words.length) return words[words.length - 1].replace(/[^A-Z0-9]/g, '');
    return normalizeCode(text).slice(0, 6);
  }
  function renderJoinCells() {
    const el = $('join-code');
    const v = el.value;
    const cells = document.querySelectorAll('#join-otp .otp-cells span');
    const focused = document.activeElement === el;
    cells.forEach((c, i) => {
      c.textContent = v[i] || '';
      c.classList.toggle('filled', !!v[i]);
      c.classList.toggle('active', focused && i === Math.min(v.length, 5));
    });
  }
  $('join-code').addEventListener('focus', renderJoinCells);
  $('join-code').addEventListener('blur', renderJoinCells);
  setInterval(() => { if (!$('step-join').hidden) renderJoinCells(); }, 200); // value set by code (invites, rejoin)

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

  const clamp01 = (v) => r4(Math.min(1, Math.max(0, v)));
  let pan = null;    // right/middle-drag (or Space+drag) moves a zoomed view
  let arrow = null;  // arrow being dragged: {id, x1, y1, x2, y2, sentAt}
  let laserAt = 0;   // last laser update sent
  let laserOn = false;
  let spaceDown = false;
  function laserOff() {
    if (!laserOn) return;
    laserOn = false;
    send({ t: 'laser', off: true });
  }
  function sendArrow(final) {
    if (!arrow) return;
    const now = Date.now();
    if (!final && now - arrow.sentAt < 33) return; // ~30 updates a second while dragging
    arrow.sentAt = now;
    const m = { t: 'arrow', id: arrow.id, x1: arrow.x1, y1: arrow.y1, x2: arrow.x2, y2: arrow.y2, c: drawState.color, h: markSeconds() };
    if (!arrow.sent) m.first = true;
    if (final) m.done = true;
    arrow.sent = true;
    send(m);
  }

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && spaceDown)) {
      if (view.z > 1) {
        canvas.setPointerCapture(ev.pointerId);
        pan = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty };
        canvas.classList.add('panning');
      }
      return;
    }
    if (ev.button !== 0) return;
    const p = norm(ev);
    if (!inside(p)) return;
    if (drawState.tool === 'laser') return; // the laser follows the mouse, no click needed
    if (drawState.tool === 'ping') {
      send({ t: 'ping', x: r4(p.x), y: r4(p.y), c: drawState.color });
      return;
    }
    canvas.setPointerCapture(ev.pointerId);
    if (drawState.tool === 'arrow') {
      arrow = { id: `a${Date.now().toString(36)}${(drawState.seq++).toString(36)}`, x1: r4(p.x), y1: r4(p.y), x2: r4(p.x), y2: r4(p.y), sentAt: 0, sent: false };
      return; // first send happens once it has some length
    }
    drawState.active = `s${Date.now().toString(36)}${(drawState.seq++).toString(36)}`;
    send({ t: 'start', id: drawState.active, x: r4(p.x), y: r4(p.y), c: drawState.color, h: markSeconds() });
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (pan) {
      view.tx = pan.tx + (ev.clientX - pan.x);
      view.ty = pan.ty + (ev.clientY - pan.y);
      applyView();
      return;
    }
    const p = norm(ev);
    if (drawState.tool === 'laser') {
      if (!inside(p)) { laserOff(); return; }
      const now = Date.now();
      if (now - laserAt < 15) return; // ~60 updates a second
      laserAt = now;
      laserOn = true;
      send({ t: 'laser', x: r4(p.x), y: r4(p.y), c: drawState.color, ts: Math.round(performance.now()) });
      return;
    }
    if (arrow) {
      arrow.x2 = clamp01(p.x);
      arrow.y2 = clamp01(p.y);
      const r = contentRect();
      if (Math.hypot((arrow.x2 - arrow.x1) * r.w, (arrow.y2 - arrow.y1) * r.h) > 6) sendArrow(false);
      return;
    }
    if (!drawState.active) return;
    send({ t: 'move', id: drawState.active, x: clamp01(p.x), y: clamp01(p.y) });
  });
  const stopStroke = () => {
    if (pan) { pan = null; canvas.classList.remove('panning'); return; }
    if (arrow) {
      if (arrow.sent) sendArrow(true); // a click with no drag draws nothing
      arrow = null;
      return;
    }
    if (!drawState.active) return;
    send({ t: 'end', id: drawState.active });
    drawState.active = null;
  };
  canvas.addEventListener('pointerup', stopStroke);
  canvas.addEventListener('pointercancel', stopStroke);
  canvas.addEventListener('pointerleave', () => { if (drawState.tool === 'laser') laserOff(); });
  window.addEventListener('blur', laserOff);

  // Zoom: mouse wheel / trackpad pinch over the stream, centered on the cursor.
  canvas.addEventListener('wheel', (ev) => {
    if ($('step-watch').hidden) return;
    ev.preventDefault();
    const b = canvas.getBoundingClientRect();
    const step = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
    zoomAt(ev.clientX - b.left, ev.clientY - b.top, view.z * step);
  }, { passive: false });
  $('zoom-reset').addEventListener('click', resetZoom);
  window.addEventListener('resize', () => applyView());
  document.addEventListener('keydown', (ev) => { if (ev.code === 'Space' && !$('step-watch').hidden && ev.target.tagName !== 'INPUT') { spaceDown = true; canvas.classList.toggle('can-pan', view.z > 1); } });
  document.addEventListener('keyup', (ev) => { if (ev.code === 'Space') { spaceDown = false; canvas.classList.remove('can-pan'); } });

  // One "Tool" dropdown: Draw (default), Arrow, Ping, Laser pointer.
  const TOOL_NAMES = { pen: 'Marker', arrow: 'Arrow', ping: 'Ping', laser: 'Cursor' };
  const TOOL_ICONS = { pen: 'pen', arrow: 'arrow', ping: 'pin', laser: 'laser' };
  function setTool(tool) {
    if (!TOOL_NAMES[tool]) tool = 'pen';
    if (drawState.tool === 'laser' && tool !== 'laser') laserOff();
    drawState.tool = tool;
    document.querySelectorAll('.tool-opt[data-tool]').forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $('tool-icon').replaceChildren(icon(TOOL_ICONS[tool]));
    $('tool-name').textContent = TOOL_NAMES[tool];
    canvas.dataset.tool = tool;
  }
  document.querySelectorAll('.tool-opt[data-tool]').forEach((b) => b.addEventListener('click', () => {
    setTool(b.dataset.tool);
    $('tool-menu').classList.remove('open');
    $('tool-btn').setAttribute('aria-expanded', 'false');
  }));
  setTool('pen');
  function setColor(color) {
    const presets = [...document.querySelectorAll('.swatch[data-color]')].map((x) => x.dataset.color.toLowerCase());
    color = String(color || '').toLowerCase();
    if (!presets.includes(color)) color = presets[0]; // older versions allowed any color
    drawState.color = color;
    store.set('app.color', color);
    document.querySelectorAll('.swatch[data-color]').forEach((x) => x.classList.toggle('active', x.dataset.color.toLowerCase() === color));
    $('color-current').style.setProperty('--c', color);
    // White/black would vanish into the bar in one of the themes: give just those a hairline.
    $('color-current').classList.toggle('light-swatch', color === '#ffffff');
    $('color-current').classList.toggle('dark-swatch', color === '#111111');
    const name = document.querySelector(`.swatch[data-color="${color}"]`);
    $('color-name').textContent = name ? name.title : 'Color';
    $('color-btn').title = 'Pick a color';
  }
  document.querySelectorAll('.swatch[data-color]').forEach((b) => b.addEventListener('click', () => {
    setColor(b.dataset.color);
    $('color-menu').classList.remove('open');
    $('color-btn').setAttribute('aria-expanded', 'false');
  }));
  setColor(drawState.color);
  $('clear').addEventListener('click', () => send({ t: 'clear' }));
  $('refresh-video').addEventListener('click', () => {
    if (S.peer && S.peer.disconnected && !S.peer.destroyed) {
      log('refresh: pairing service was disconnected, reconnecting first');
      try { S.peer.reconnect(); } catch { /* ignore */ }
    }
    if (!S.conn || !S.conn.open) { autoRejoin('refresh pressed with no connection'); return; }
    // If this refresh doesn't bring video back, start the session over.
    const pressedAt = Date.now();
    later(20000, () => {
      const pc = S.call && S.call.peerConnection;
      if (S.role === 'join' && !S.ended && (!pc || pc.connectionState !== 'connected') && Date.now() - pressedAt >= 19000) autoRejoin('refresh did not bring video back');
    });
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
  $('react-btn').addEventListener('click', (ev) => { ev.stopPropagation(); const open = $('react-menu').hidden; if (open) closeMenus(); setReactMenu(open); });
  document.addEventListener('click', (ev) => { if (!$('react-menu').hidden && !ev.target.closest('.react-wrap')) setReactMenu(false); });

  // ---------- stall detector ----------
  // If this app itself freezes (computer overloaded by a heavy game, power
  // saving), say so in the log: it explains video/drawing drop-outs.
  (() => {
    let last = performance.now();
    let worst = 0; let count = 0; let since = Date.now();
    setInterval(() => {
      const now = performance.now();
      const gap = now - last - 500;
      last = now;
      if (gap > 1000 && S.role && !S.ended) { count++; worst = Math.max(worst, gap); }
      if (count && Date.now() - since > 10000) {
        log(`this app was frozen ${count}x in the last ${Math.round((Date.now() - since) / 1000)} s (longest ${(worst / 1000).toFixed(1)} s): the computer is overloaded or power-saving`);
        count = 0; worst = 0; since = Date.now();
      } else if (!count) since = Date.now();
    }, 500);
  })();

  // ---------- header menus (people, connection) ----------
  const menus = [
    { btn: 'people-btn', menu: 'people-menu' },
    { btn: 'conn-btn', menu: 'conn-menu', onOpen: fillConnMenu },
    { btn: 'invite-btn', menu: 'invite-menu' },
    { btn: 'me-btn', menu: 'me-menu' },
    { btn: 'color-btn', menu: 'color-menu' },
    { btn: 'tool-btn', menu: 'tool-menu' },
  ];
  function closeMenus(except) {
    for (const m of menus) {
      if (m.menu === except) continue;
      $(m.menu).classList.remove('open');
      $(m.btn).setAttribute('aria-expanded', 'false');
    }
  }
  for (const m of menus) {
    $(m.btn).addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = !$(m.menu).classList.contains('open');
      closeMenus(m.menu);
      setReactMenu(false); // only one dropdown open at a time
      $(m.menu).classList.toggle('open', open);
      $(m.btn).setAttribute('aria-expanded', String(open));
      if (open && m.onOpen) m.onOpen();
    });
  }
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.pop-wrap')) closeMenus(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeMenus(); setReactMenu(false); } });
  setInterval(() => { if ($('conn-menu').classList.contains('open')) fillConnMenu(); }, 1000);
  $('conn-restart').addEventListener('click', () => { closeMenus(); $('restart-stream').click(); });
  $('conn-details').addEventListener('click', () => { closeMenus(); openDetails(); });

  document.addEventListener('keydown', (ev) => {
    if ($('step-watch').hidden || ev.target.tagName === 'INPUT') return;
    const k = ev.key.toLowerCase();
    if (k === 'm' || k === 'p') setTool('pen'); // M (P kept for old habits)
    if (k === 'a') setTool('arrow');
    if (k === 'o') setTool('ping');
    if (k === 'c' || k === 'l') setTool('laser'); // C (L kept for old habits)
    if (k === '0') resetZoom();
    if (k === 'e') send({ t: 'clear' });
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
  $('go-share').addEventListener('click', () => { $('role-note').hidden = true; openSourceDialog('start'); });
  $('go-join').addEventListener('click', () => {
    $('role-note').hidden = true;
    show('step-join');
    setStatus($('join-status'), '', '');
    $('join-btn').disabled = false;
    $('join-code').focus();
  });
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
    flashCopied($('copy-invite'), 'Copied! Paste it in Discord', 1800);
  });
  $('copy-code').addEventListener('click', async () => {
    if (!S.code) return;
    await bridge.copy(S.code);
    flashCopied($('copy-code'));
  });
  $('copy-invite-2').addEventListener('click', async () => {
    if (!S.code) return;
    await bridge.copy(inviteText(S.code));
    log('invite copied');
    flashCopied($('copy-invite-2'));
  });
  $('copy-code-2').addEventListener('click', async () => {
    if (!S.code) return;
    await bridge.copy(S.code);
    flashCopied($('copy-code-2'));
  });
  $('change-source').addEventListener('click', () => openSourceDialog('switch'));


  // First-run walkthrough
  let slide = 0;
  function showSlide(n) {
    slide = n;
    document.querySelectorAll('#welcome .slide').forEach((el) => { el.hidden = Number(el.dataset.slide) !== n; });
    document.querySelectorAll('#welcome .dot').forEach((d, i) => d.classList.toggle('on', i === n));
    if (n === 2) $('welcome-next').textContent = "Let's go";
    else iconText($('welcome-next'), 'arrow-right', 'Next', true);
  }
  function openWelcome() { showSlide(0); if (!$('welcome').open) $('welcome').showModal(); }
  function closeWelcome() { store.set('app.onboarded', true); $('welcome').close(); }
  $('welcome-next').addEventListener('click', () => (slide < 2 ? showSlide(slide + 1) : closeWelcome()));
  $('welcome-skip').addEventListener('click', closeWelcome);
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
  // Opt-in: drawings only while the shared game is the active window.
  $('focus-only').checked = !!store.get('app.focusOnly', false);
  if (bridge.setFocusOnly) bridge.setFocusOnly($('focus-only').checked);
  $('focus-only').addEventListener('change', () => {
    store.set('app.focusOnly', $('focus-only').checked);
    if (bridge.setFocusOnly) bridge.setFocusOnly($('focus-only').checked);
    log(`drawings only while the game is in front: ${$('focus-only').checked ? 'on' : 'off'}`);
  });
  // Click outside the picker closes it (like Discord).
  $('source-dialog').addEventListener('click', (e) => {
    if (e.target !== $('source-dialog')) return;
    const r = $('source-dialog').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('source-dialog').close();
  });
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
        away: "You're not in the game right now, so drawings are hidden until you go back to it.",
        closed: 'The shared window was closed.',
        untracked: "Can't track this window's position, so drawings may be misaligned. Share the whole screen if they are.",
      };
      $('track-note').textContent = msgs[state] || '';
      $('q-hint').textContent = state === 'minimized' ? 'Your game is minimized, so your friend sees a still picture. It continues when you go back to the game.' : '';
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
    const v = cleanJoinCode(el.value);
    if (el.value !== v) el.value = v;
    renderJoinCells();
  });
  $('join-back').addEventListener('click', () => { teardown(); show('step-role'); });
  // "Are you sure?" before ending (it disconnects the other person).
  $('end').addEventListener('click', () => {
    const who = (S.peerProfile && S.peerProfile.name) || S.friend;
    if (S.role === 'share') {
      $('end-title').textContent = 'End session?';
      $('end-text').textContent = who ? `${who} will be disconnected and your stream stops.` : 'Your stream stops and the invite code stops working.';
    } else {
      $('end-title').textContent = 'Leave session?';
      $('end-text').textContent = who ? `You'll stop watching ${who}.` : 'You\'ll stop watching.';
    }
    $('end-yes').textContent = S.role === 'share' ? 'End session' : 'Leave';
    $('end-confirm').showModal();
  });
  $('end-cancel').addEventListener('click', () => $('end-confirm').close());
  $('end-yes').addEventListener('click', () => { $('end-confirm').close(); endSession(''); });

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
  async function openDetails() {
    $('details-text').textContent = await buildDetails();
    $('details').showModal();
  }
  $('details-close').addEventListener('click', () => $('details').close());
  $('details-copy').addEventListener('click', async () => { await bridge.copy($('details-text').textContent); flashCopied($('details-copy')); });

  // settings
  $('open-profile').addEventListener('click', () => {
    closeMenus();
    $('settings-name').value = S.name;
    S.pendingAvatar = S.avatar;
    window.Profile.picker($('avatar-picker-settings'), () => S.pendingAvatar, (a) => { S.pendingAvatar = a; });
    $('profile').showModal();
  });
  $('profile-cancel').addEventListener('click', () => $('profile').close());
  $('profile-save').addEventListener('click', () => {
    const n = $('settings-name').value.trim().slice(0, 24);
    const before = JSON.stringify([S.name, S.avatar]);
    if (n) { S.name = n; store.set('app.name', n); $('name').value = n; }
    if (S.pendingAvatar) { S.avatar = S.pendingAvatar; store.set('app.avatar', S.avatar); }
    const changed = JSON.stringify([S.name, S.avatar]) !== before;
    if (changed) { bumpProfile(); sendCtl(myProfileMsg()); }
    renderChips();
    $('profile').close();
    log(changed ? 'profile saved; sent to friend' : 'profile unchanged');
  });
  $('open-settings').addEventListener('click', () => {
    closeMenus();
    const t = store.get('app.turn', {}) || {};
    $('turn-url').value = t.url || '';
    $('turn-user').value = t.user || '';
    $('turn-pass').value = t.pass || '';
    $('relay-only').checked = !!store.get('app.relayOnly', false);
    $('mark-seconds').value = String(markSeconds());
    $('mark-seconds-value').textContent = `${markSeconds()} s`;
    paintThemeSeg();
    $('settings').showModal();
  });
  $('settings-cancel').addEventListener('click', () => $('settings').close());
  $('mark-seconds').addEventListener('input', () => { $('mark-seconds-value').textContent = `${$('mark-seconds').value} s`; });
  // Theme: applies right away, like Discord.
  function paintThemeSeg() {
    const cur = window.Theme ? window.Theme.get() : 'system';
    document.querySelectorAll('#theme-seg [data-theme-opt]').forEach((b) => {
      const on = b.dataset.themeOpt === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  document.querySelectorAll('#theme-seg [data-theme-opt]').forEach((b) => b.addEventListener('click', () => {
    if (window.Theme) window.Theme.set(b.dataset.themeOpt);
    paintThemeSeg();
  }));
  paintThemeSeg();

  $('settings-save').addEventListener('click', () => {
    const url = $('turn-url').value.trim();
    store.set('app.turn', url ? { url, user: $('turn-user').value.trim(), pass: $('turn-pass').value } : null);
    store.set('app.relayOnly', $('relay-only').checked);
    store.set('app.markSeconds', Number($('mark-seconds').value) || 3);
    $('settings').close();
    log('settings saved');
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
    closeMenus();
    toast('Checking for updates…', 'busy');
    try {
      const u = await bridge.checkUpdate();
      if (!u || u.error) toast(`Couldn't check for updates: ${(u && u.error) || 'no answer'}`, 'bad');
      else if (u.enabled === false) toast('Updates are off in this build.');
      else if (u.available) toast(`Version ${u.latest} is available. Use "Update now" at the top.`);
      else if (u.missingAsset) toast(`Version ${u.latest} is out, but not for this computer yet.`);
      else toast(`You're up to date (v${u.current}).`);
    } catch (e) {
      toast(`Couldn't check for updates: ${e.message || e}`, 'bad');
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
        show('step-role');
        openSourceDialog('start');
        return true;
      }
      await startSharing(src, { code: r.code });
      setStatus($('share-status'), `Updated. Waiting for ${r.friend || 'your friend'} to reconnect…`, 'busy');
      return true;
    }
    return false;
  }

  // ---------- tooltips for icon-only buttons (instead of the slow native ones) ----------
  const TIP_SEL = '.icon-btn, .add-person, .picker-gear, .me-btn';
  const tipEl = $('tip');
  let tipFor = null;
  let tipTimer = null;
  function hideTip() { clearTimeout(tipTimer); tipEl.hidden = true; tipFor = null; }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest(TIP_SEL);
    if (!el) { if (tipFor) hideTip(); return; }
    if (el === tipFor) return;
    const t = el.getAttribute('title');
    if (t) { // take over the title so the native bubble never shows
      el.dataset.tip = t;
      el.removeAttribute('title');
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', t);
    }
    const text = el.dataset.tip;
    hideTip();
    if (!text) return;
    tipFor = el;
    tipTimer = setTimeout(() => {
      if (tipFor !== el || el.getAttribute('aria-expanded') === 'true') return;
      (el.closest('dialog') || document.body).appendChild(tipEl); // above modals too
      tipEl.textContent = text;
      tipEl.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tipEl.offsetWidth;
      const h = tipEl.offsetHeight;
      const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
      const below = r.bottom + 8 + h < innerHeight - 8;
      tipEl.style.left = `${Math.round(x)}px`;
      tipEl.style.top = `${Math.round(below ? r.bottom + 8 : r.top - h - 8)}px`;
    }, 250);
  });
  document.addEventListener('mousedown', hideTip, true);
  window.addEventListener('blur', hideTip);

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
