// Session edge cases, two Chromium pages over a local pairing server:
//  (A) viewer goes silent on every path, (B) viewer's goodbye only arrives on the video path,
//  (C) player ends while the capture is still starting.
const { chromium } = require('playwright');
const { PeerServer } = require('peer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'app', 'renderer');
const srv = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const stub = (name) => `
  localStorage.setItem('app.signal', JSON.stringify({host:'127.0.0.1', port:9000, path:'/', secure:false}));
  localStorage.setItem('app.ice', '[]');
  localStorage.setItem('app.onboarded', 'true');
  if (${JSON.stringify(name)} === 'Joshua') {
    // a real 1x1 PNG as a "photo" avatar
    localStorage.setItem('app.avatar', JSON.stringify({ kind: 'photo', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }));
  } else {
    localStorage.setItem('app.avatar', JSON.stringify({ kind: 'emoji', value: '🐺', color: '#5b6b8c' }));
  }
  localStorage.setItem('app.name', JSON.stringify(${JSON.stringify(name)}));
  window.__drawn = [];
  window.bridge = {
    brand: { name: 'Game Guide', id: 'gameguide' },
    listSources: async () => ({ status:'granted', tracking:true, sources:[
      {kind:'window', id:'window:111:0', name:'WARDOGS', displayId:'', thumb:'data:image/gif;base64,R0lGODlhAQABAAAAACw=', icon:''},
      {kind:'screen', id:'screen:1:0', name:'Whole screen', displayId:'1', thumb:'data:image/gif;base64,R0lGODlhAQABAAAAACw=', icon:''}] }),
    selectSource: async (id) => { window.__sel = id; return true; },
    openOverlay: async (t) => { window.__overlay = t; window.__overlayOpen = true; return true; },
    closeOverlay: async () => { window.__overlayOpen = false; return true; },
    draw: (m) => { window.__drawn.push(m); if ((m.t === 'start' || m.t === 'ping') && window.__rc) window.__rc(window.__rcState || 'shown'); },
    onReceipt: (fn) => { window.__rc = fn; },
    onDraw: () => {},
    copy: async (t) => { window.__copied = t; return true; },
    paste: async () => '',
    info: async () => ({ version:'1.0.0-test', platform:'linux', arch:'x64' }),
    minimize: async () => true,
    openScreenSettings: async () => true,
  };
  navigator.mediaDevices.getDisplayMedia = async () => {
    if (window.__slowCapture) await new Promise((r) => setTimeout(r, window.__slowCapture));
    const isWin = String(window.__sel || '').startsWith('window:');
    const c = document.createElement('canvas'); c.width = isWin ? 1280 : 1920; c.height = isWin ? 720 : 1080;
    const x = c.getContext('2d'); let f = 0;
    window.__fake = setInterval(() => { x.fillStyle = '#204'; x.fillRect(0,0,c.width,c.height); x.fillStyle='#0f0'; x.fillRect((f++*8)%c.width, 300, 80, 80); }, 33);
    const s = c.captureStream(30);
    window.__lastStream = s;
    return s;
  };
`;

const reporter = require('./report.cjs');
const rep = reporter('Session edge cases');
const { check } = rep;

(async () => {
  await new Promise((r) => srv.listen(8123, r));
  const ps = PeerServer({ port: 9000, path: '/', host: '127.0.0.1' });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const mk = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(stub(name));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
    await p.goto('http://127.0.0.1:8123/index.html');
    return p;
  };
  const join = async (player, friend) => {
    await player.click('#go-share'); await player.waitForSelector('.picker:not(.loading) .pick:not(.skel)'); await player.click('.pick:not(.skel)');
    await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
    const code = await player.textContent('#code');
    await friend.click('#go-join'); await friend.fill('#join-code', code); await friend.click('#join-btn');
    await friend.waitForSelector('#step-watch:not([hidden])', { timeout: 30000 });
    await player.waitForFunction(() => window.__app.peerProfile && window.__app.peerHb, null, { timeout: 15000 });
  };
  const people = (p) => p.evaluate(() => document.querySelectorAll('#chips .avatar').length);

  // A: friend goes silent on every path without closing anything
  {
    const player = await mk('Joshua'); await player.evaluate(() => localStorage.setItem('app.friendGoneMs', '6000')); await player.reload();
    const friend = await mk('Saturn');
    await join(player, friend);
    check('A: friend shows in the player\'s stack', await people(player) === 1);
    await friend.evaluate(() => {
      const S = window.__app; clearInterval(S.hbTimer);
      if (S.conn) S.conn.send = () => {};
      if (S.drawDc) S.drawDc.send = () => {};
      window.__silent = true;
    });
    const t0 = Date.now();
    const goneA = await player.waitForFunction(() => document.getElementById('people').hidden, null, { timeout: 20000 }).then(() => true, () => false);
    const secsA = Math.round((Date.now() - t0) / 1000);
    check('A: silent friend is dropped', goneA && await people(player) === 0, `${secsA} s`);
    check('A: video call closed', await player.evaluate(() => !window.__app.call));
    check('A: player status says the friend left', /left/.test(await player.textContent('#share-status')));
    check('A: invite + button is back', await player.evaluate(() => !document.getElementById('invite-wrap').hidden));
    check('A: player phase back to waiting', await player.evaluate(() => window.__app.phase) === 'host.waiting');
    await player.context().close(); await friend.context().close();
  }
  // B: drawing link already dead, friend clicks End session -> goodbye arrives on the video path
  {
    const player = await mk('Joshua');
    const friend = await mk('Saturn');
    await join(player, friend);
    await friend.waitForFunction(() => window.__app.drawDc && window.__app.drawDc.readyState === 'open', null, { timeout: 15000 });
    await friend.evaluate(() => { const S = window.__app; if (S.conn) S.conn.send = () => {}; });
    const t0 = Date.now();
    await friend.click('#end'); await friend.click('#end-yes');
    const goneB = await player.waitForFunction(() => document.getElementById('people').hidden, null, { timeout: 20000 }).then(() => true, () => false);
    const secsB = (Date.now() - t0) / 1000;
    check('B: goodbye on the video path is noticed quickly', goneB && secsB < 5, `${secsB.toFixed(1)} s`);
    check('B: player status says the friend left', /left/.test(await player.textContent('#share-status')));
    check('B: session phases', await player.evaluate(() => window.__app.phase) === 'host.waiting' && await friend.evaluate(() => window.__app.phase) === 'idle');
    await player.context().close(); await friend.context().close();
  }
  // C: player clicks End while the capture is still starting (slow permission prompt):
  //    no overlay may open afterwards and the capture must stop.
  {
    const player = await mk('Joshua');
    await player.evaluate(() => { window.__slowCapture = 1500; });
    await player.click('#go-share'); await player.waitForSelector('.picker:not(.loading) .pick:not(.skel)'); await player.click('.pick:not(.skel)');
    await player.waitForTimeout(300);
    const mid = await player.evaluate(() => ({ phase: window.__app.phase, end: !document.getElementById('end').hidden }));
    check('C: End is offered while the capture starts', mid.phase === 'host.capturing' && mid.end, JSON.stringify(mid));
    await player.click('#end'); await player.click('#end-yes');
    await player.waitForTimeout(2500);
    const after = await player.evaluate(() => ({
      phase: window.__app.phase,
      overlayOpen: !!window.__overlayOpen,
      liveTracks: window.__lastStream ? window.__lastStream.getTracks().filter((t) => t.readyState === 'live').length : -1,
      home: !document.getElementById('step-role').hidden,
    }));
    check('C: nothing keeps running after End', after.phase === 'idle' && !after.overlayOpen && after.liveTracks === 0 && after.home, JSON.stringify(after));
    await player.evaluate(() => { window.__slowCapture = 0; });
    await player.click('#go-share'); await player.waitForSelector('.picker:not(.loading) .pick:not(.skel)'); await player.click('.pick:not(.skel)');
    const ok = await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 }).then(() => true, () => false);
    check('C: sharing again right after works', ok && await player.evaluate(() => window.__app.phase === 'host.waiting' && window.__overlayOpen === true));
    await player.context().close();
  }
  const real = errors.filter((e) => !/PeerJS|WebSocket|Refused to connect to 'data:/.test(e));
  check('no page errors', !real.length, real.slice(0, 3).join(' | '));
  await browser.close(); srv.close(); ps.close && ps.close();
  rep.finish();
})().catch((e) => { check('test ran to the end', false, String(e && e.message || e).split('\n')[0].slice(0, 300)); rep.finish(); });
