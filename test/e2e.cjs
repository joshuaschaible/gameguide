// Two Chromium pages: player shares a fake "screen" (animated canvas), friend joins by code,
// draws, and we verify the strokes reach the player's overlay channel.
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
    openOverlay: async (t) => { window.__overlay = t; return true; },
    closeOverlay: async () => true,
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
    const isWin = String(window.__sel || '').startsWith('window:');
    const c = document.createElement('canvas'); c.width = isWin ? 1280 : 1920; c.height = isWin ? 720 : 1080;
    const x = c.getContext('2d'); let f = 0;
    window.__fake = setInterval(() => { x.fillStyle = '#204'; x.fillRect(0,0,c.width,c.height); x.fillStyle='#0f0'; x.fillRect((f++*8)%c.width, 300, 80, 80); }, 33);
    return c.captureStream(30);
  };
`;

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
  const player = await mk('Joshua');
  const friend = await mk('Saturn');

  await player.click('#go-share');
  await player.click('.source');
  await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
  const code = await player.textContent('#code');
  console.log('code', code);
  await player.click('#copy-code');
  console.log('copied', await player.evaluate(() => window.__copied));

  // wrong code first
  await friend.click('#go-join');
  await friend.fill('#join-code', 'zzzz22');
  await friend.click('#join-btn');
  await friend.waitForFunction(() => document.getElementById('join-status').classList.contains('bad'), null, { timeout: 15000 });
  console.log('wrong code ->', await friend.textContent('#join-status'));

  await friend.fill('#join-code', code.toLowerCase().slice(0, 3) + '-' + code.slice(3));
  await friend.click('#join-btn');
  await friend.waitForSelector('#step-watch:not([hidden])', { timeout: 30000 });
  await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 15000 });
  console.log('friend video', await friend.evaluate(() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]));
  console.log('player status:', await player.textContent('#share-status'));
  await player.waitForTimeout(500);
  const chips = (pg) => pg.evaluate(() => [...document.querySelectorAll('#chips .chip')].map((c) => `${c.className}:${c.querySelector('.chip-name').textContent}:${c.querySelector('.avatar img') ? 'photo' : c.querySelector('.avatar').textContent}`));
  console.log('player chips:', JSON.stringify(await chips(player)));
  console.log('friend chips:', JSON.stringify(await chips(friend)));
  await player.screenshot({ path: '/tmp/claude-0/chips-player.png', clip: { x: 0, y: 0, width: 1200, height: 70 } });

  // draw a stroke + ping + clear
  const box = await friend.locator('#draw').boundingBox();
  await friend.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await friend.mouse.down();
  for (let i = 1; i <= 10; i++) await friend.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * 0.5);
  await friend.mouse.up();
  await friend.click('.tool[data-tool=ping]');
  await friend.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await friend.waitForTimeout(800);
  // mark duration: friend sets 7 s, draws; the player's overlay receives h:7
  await friend.evaluate(() => localStorage.setItem('app.markSeconds', '7'));
  await friend.click('.tool[data-tool=pen]');
  await friend.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await friend.mouse.down(); await friend.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25); await friend.mouse.up();
  await friend.waitForTimeout(400);
  console.log('mark duration sent:', JSON.stringify(await player.evaluate(() => window.__drawn.filter((m) => m.t === 'start').map((m) => m.h))));
  // fade timing in the renderer: h=1 -> gone after ~1.7 s, default -> still there
  console.log('fade timing:', JSON.stringify(await friend.evaluate(async () => {
    const c = document.createElement('canvas'); c.style.cssText = 'width:200px;height:100px'; document.body.appendChild(c);
    const m = new window.Marks(c);
    m.apply({ t: 'start', id: 'a', x: 0.1, y: 0.1, c: '#ff0000', h: 1 }); m.apply({ t: 'end', id: 'a' });
    m.apply({ t: 'start', id: 'b', x: 0.5, y: 0.5, c: '#00ff00' }); m.apply({ t: 'end', id: 'b' });
    await new Promise((r) => setTimeout(r, 2000));
    const left = [...m.strokes.keys()];
    c.remove();
    return { leftAfter2s: left };
  })));
  await friend.evaluate(() => localStorage.removeItem('app.markSeconds'));
  console.log('receipt after mark:', JSON.stringify(await friend.evaluate(() => [document.getElementById('receipt').hidden, document.getElementById('receipt').textContent])));
  await player.evaluate(() => { window.__rcState = 'hidden'; });
  await friend.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await friend.waitForTimeout(600);
  console.log('receipt when hidden:', JSON.stringify(await friend.evaluate(() => document.getElementById('receipt').textContent)));
  await player.evaluate(() => { window.__rcState = 'shown'; });
  await friend.screenshot({ path: '/tmp/claude-0/friend.png' });
  const drawn = await player.evaluate(() => window.__drawn);
  console.log('player overlay got', drawn.length, 'msgs; types', [...new Set(drawn.map((d) => d.t))].join(','), 'first', JSON.stringify(drawn[0]), 'ping', JSON.stringify(drawn.find((d) => d.t === 'ping')));
  await player.screenshot({ path: '/tmp/claude-0/player.png' });

  // details dialog
  await friend.waitForTimeout(5000);
  console.log('friend video after 6s', await friend.evaluate(() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]));
  console.log('watch status:', await friend.textContent('#watch-status'), 'friend=', await friend.evaluate(() => window.__app.friend), 'log hello?', await friend.evaluate(() => window.__app.log.filter((l) => /hello|said/.test(l)).join(' | ')));
  console.log('player stats:', await player.textContent('#q-stats'), '|', await player.textContent('#q-hint'));
  // live change: 720p / 30fps / vp9 setting
  await player.selectOption('#q-res', '720');
  await player.selectOption('#q-fps', '30');
  await player.waitForTimeout(4500);
  console.log('player stats after 720p30:', await player.textContent('#q-stats'));
  console.log('friend after 720p30:', await friend.textContent('#watch-status'));
  console.log('player pipeline:', await player.textContent('#q-pipe'));
  console.log('source label:', await player.textContent('#source-name'), 'overlay target', JSON.stringify(await player.evaluate(() => window.__overlay)));
  // switch to whole screen mid-stream
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .source');
  await player.locator('#dialog-sources .source').nth(1).click();
  await player.waitForTimeout(5000);
  console.log('after switch, player:', await player.textContent('#source-name'), '|', await player.textContent('#share-status'));
  console.log('after switch, friend video', await friend.evaluate(() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]), await friend.textContent('#watch-status'));
  console.log('overlay target now', JSON.stringify(await player.evaluate(() => window.__overlay)));
  // simulate a stalled capture (exclusive fullscreen)
  await player.evaluate(() => clearInterval(window.__fake));
  await player.waitForTimeout(7500);
  console.log('player hint during stall:', await player.textContent('#q-hint'));
  await player.waitForTimeout(6000);
  console.log('player log restart:', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /restart/.test(l)))));
  // switch back to the game window, then simulate the game recreating its window
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .source');
  await player.locator('#dialog-sources .source').nth(0).click();
  await player.waitForTimeout(2500);
  await player.evaluate(() => window.__app.stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await player.waitForTimeout(3000);
  console.log('reattach log:', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /ended|reattach|found/.test(l)))), '| source:', await player.textContent('#source-name'));
  // kill the video path on the player (simulates a hung encoder / dead video connection)
  await player.evaluate(async () => { const pc = window.__app.call.peerConnection; const snd = pc.getSenders().find((x) => x.track); await snd.replaceTrack(null); });
  await friend.waitForTimeout(9000);
  console.log('video-dead recovery log (player):', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /rebuild|stalled|friend reports/.test(l)))));
  console.log('friend after video rebuild:', await friend.textContent('#watch-status'));
  // simulate the network dropping the video twice: must rebuild, cap bitrate, and NOT switch codec
  for (let i = 0; i < 2; i++) {
    await player.waitForFunction(() => window.__app.call && window.__app.call.peerConnection, null, { timeout: 20000 });
    await player.evaluate(() => { window.__app.lastSendMbps = 9; const pc = window.__app.call.peerConnection; Object.defineProperty(pc, 'iceConnectionState', { get: () => 'failed', configurable: true }); pc.dispatchEvent(new Event('iceconnectionstatechange')); });
    await player.waitForTimeout(13000);
  }
  console.log('network-drop log:', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /network dropped|capping|switching codec|rebuilding video connection \(video/.test(l)))));
  console.log('after drops: cap', await player.evaluate(() => window.__app.netCapMbps), 'codecOverride', await player.evaluate(() => window.__app.codecOverride), '| friend:', await friend.textContent('#watch-status'));
  // manual refresh button
  await friend.waitForTimeout(11000);
  await friend.click('#refresh-video');
  await friend.waitForTimeout(5000);
  console.log('after refresh button (player log tail):', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /rebuild|refresh|friend reports/.test(l)).slice(-2))));
  console.log('friend after refresh:', await friend.textContent('#watch-status'));
  await player.waitForTimeout(3000);
  await player.click('#restart-stream');
  await player.waitForTimeout(5000);
  console.log('player restart-stream:', await player.textContent('#share-status'), '| friend:', await friend.textContent('#watch-status'));
  console.log('friend after auto-restart:', await friend.textContent('#watch-status'), JSON.stringify(await friend.evaluate(() => [document.getElementById('freeze').hidden, document.getElementById('freeze').textContent])));
  console.log('friend banner during stall:', JSON.stringify(await friend.evaluate(() => [document.getElementById('freeze').hidden, document.getElementById('freeze').textContent])));
  await friend.click('#open-settings');
  await friend.click('#open-details');
  await friend.waitForTimeout(500);
  console.log('--- friend details ---\n' + (await friend.textContent('#details-text')).split('\n').slice(0, 30).join('\n'));
  await friend.click('#details-close');

  // --- update while in a session: player restarts, friend rejoins by itself ---
  const codeBefore = await player.textContent('#code');
  await player.evaluate(() => {
    // what the app does on "Update now" -> restart stage
    const S = window.__app;
    localStorage.setItem('app.resume', JSON.stringify({ role: 'share', code: S.code, source: S.source, friend: S.friend, at: Date.now() }));
    S.conn.send({ t: 'updating' });
  });
  await player.waitForTimeout(500);
  await player.reload();                      // the "restart" into the new version
  await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0 && window.__app.log.some((l) => /video stream received/.test(l)) && window.__app.awaitReturn === null, null, { timeout: 60000 });
  await friend.waitForTimeout(1500);
  console.log('player update: code kept', codeBefore, '->', await player.textContent('#code'), '| friend:', await friend.textContent('#watch-status'));
  console.log('friend rejoin log:', JSON.stringify(await friend.evaluate(() => window.__app.log.filter((l) => /updating|rejoin|restarting/.test(l)).slice(-4))));
  // --- friend updates: friend restarts and rejoins by itself ---
  await friend.evaluate(() => {
    const S = window.__app;
    localStorage.setItem('app.resume', JSON.stringify({ role: 'join', code: S.code, friend: S.friend, at: Date.now() }));
    S.conn.send({ t: 'updating' });
  });
  await friend.waitForTimeout(300);
  await friend.reload();
  await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 60000 });
  await friend.waitForTimeout(1500);
  console.log('friend update: rejoined ->', await friend.textContent('#watch-status'), '| player:', await player.textContent('#share-status'));

  // player ends -> friend sees ended
  await player.click('#end');
  await friend.waitForFunction(() => /ended the session/.test(document.getElementById('join-status').textContent), null, { timeout: 15000 });
  console.log('friend after end:', await friend.textContent('#join-status'));

  // reshare and rejoin works
  await player.click('#go-share');
  await player.click('.source');
  await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
  const code2 = await player.textContent('#code');
  await friend.fill('#join-code', code2);
  await friend.click('#join-btn');
  await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 30000 });
  console.log('rejoin OK with', code2);
  // friend ends -> player waits again
  await friend.click('#end');
  await player.waitForFunction(() => /left/.test(document.getElementById('share-status').textContent), null, { timeout: 15000 });
  console.log('player after friend left:', await player.textContent('#share-status'));

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  srv.close(); ps.close && ps.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
