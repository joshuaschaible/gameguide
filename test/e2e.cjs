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
  await player.waitForSelector('.pick:not(.skel)');
  await player.hover('.pick:not(.skel)');
  await player.waitForTimeout(250);
  await player.screenshot({ path: '/tmp/claude-0/ui-picker.png' });
  await player.click('.picker-gear[title="Stream quality"]');
  await player.screenshot({ path: '/tmp/claude-0/ui-picker-quality.png' });
  await player.click('.pick:not(.skel)');
  await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
  const code = await player.textContent('#code');
  await player.screenshot({ path: '/tmp/claude-0/ui-share-waiting.png' });
  console.log('code', code);
  console.log('invite + shown while waiting:', await player.evaluate(() => !document.getElementById('invite-wrap').hidden));
  await player.click('#invite-btn');
  await player.waitForTimeout(200);
  await player.screenshot({ path: '/tmp/claude-0/ui-share-invite.png', clip: { x: 500, y: 0, width: 700, height: 280 } });
  await player.keyboard.press('Escape');
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
  const chips = (pg) => pg.evaluate(() => [...document.querySelectorAll('#people-menu .person')].map((c) => `${c.querySelector('.you-tag') ? 'you' : 'peer'}:${c.querySelector('.person-name').firstChild.textContent}:${c.querySelector('.avatar img') ? 'photo' : c.querySelector('.avatar').textContent}`));
  console.log('player chips:', JSON.stringify(await chips(player)));
  console.log('friend chips:', JSON.stringify(await chips(friend)));
  await player.screenshot({ path: '/tmp/claude-0/chips-player.png', clip: { x: 0, y: 0, width: 1200, height: 70 } });
  // UI screenshots: header, people menu, connection menu, share page
  await friend.waitForTimeout(4500);
  await friend.screenshot({ path: '/tmp/claude-0/ui-watch.png' });
  await friend.hover('#people-btn');
  await friend.waitForTimeout(200);
  await friend.screenshot({ path: '/tmp/claude-0/ui-people.png', clip: { x: 700, y: 0, width: 500, height: 260 } });
  await friend.mouse.move(600, 500);
  await friend.click('#conn-btn');
  await friend.waitForTimeout(300);
  await friend.screenshot({ path: '/tmp/claude-0/ui-conn.png', clip: { x: 700, y: 0, width: 500, height: 300 } });
  console.log('signal level (friend, player):', await friend.evaluate(() => window.__app.sigLevel), await player.evaluate(() => window.__app.sigLevel));
  await friend.keyboard.press('Escape');
  await player.screenshot({ path: '/tmp/claude-0/ui-share.png' });
  // streamer preview: plays while the app is in front, pauses in the background
  const pv = () => player.evaluate(() => { const v = document.getElementById('preview-video'); return { shown: !document.getElementById('preview').hidden, playing: !v.paused && !!v.srcObject, w: v.videoWidth, pausedLabel: !document.getElementById('preview-paused').hidden }; });
  await player.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
  await player.waitForTimeout(600);
  console.log('preview in front:', JSON.stringify(await pv()));
  await player.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await player.waitForTimeout(300);
  console.log('preview in background:', JSON.stringify(await pv()));
  await player.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
  await player.waitForTimeout(400);
  console.log('preview back in front:', JSON.stringify(await pv()));
  await player.screenshot({ path: '/tmp/claude-0/ui-share-preview.png' });
  await player.click('#preview-toggle');
  await player.waitForTimeout(300);
  console.log('preview off:', JSON.stringify(await player.evaluate(() => ({ placeholder: !document.getElementById('preview-off').hidden, decoding: !!document.getElementById('preview-video').srcObject }))));
  await player.screenshot({ path: '/tmp/claude-0/ui-preview-off.png' });
  await player.click('#preview-show');
  await player.waitForTimeout(1200);
  console.log('preview back on:', JSON.stringify(await player.evaluate(() => ({ placeholder: !document.getElementById('preview-off').hidden, decoding: !!document.getElementById('preview-video').srcObject }))));
  // connection panel (structured) + my account menu + end confirmation
  await player.click('#conn-btn');
  await player.waitForTimeout(2300);
  await player.screenshot({ path: '/tmp/claude-0/ui-conn-panel.png', clip: { x: 760, y: 0, width: 440, height: 420 } });
  console.log('conn rows:', JSON.stringify(await player.evaluate(() => [...document.querySelectorAll('#conn-grid dt')].map((d) => d.textContent))));
  await player.keyboard.press('Escape');
  await player.click('#me-btn');
  await player.waitForTimeout(200);
  await player.screenshot({ path: '/tmp/claude-0/ui-me-menu.png', clip: { x: 800, y: 0, width: 400, height: 260 } });
  await player.keyboard.press('Escape');
  await player.click('#end');
  await player.waitForTimeout(200);
  console.log('end confirm:', await player.evaluate(() => [document.getElementById('end-confirm').open, document.getElementById('end-text').textContent]));
  await player.screenshot({ path: '/tmp/claude-0/ui-end-confirm.png' });
  await player.click('#end-cancel');
  console.log('still sharing after cancel:', await player.evaluate(() => !window.__app.ended && !!window.__app.call));
  console.log('invite + hidden once friend is in:', await player.evaluate(() => document.getElementById('invite-wrap').hidden));
  await friend.mouse.move(10, 400);
  await friend.hover('#conn-btn');
  await friend.waitForTimeout(450);
  console.log('tooltip:', JSON.stringify(await friend.evaluate(() => ({ shown: !document.getElementById('tip').hidden, text: document.getElementById('tip').textContent, nativeTitle: document.getElementById('open-settings').getAttribute('title') }))));
  await friend.screenshot({ path: '/tmp/claude-0/ui-tooltip.png', clip: { x: 800, y: 0, width: 400, height: 110 } });
  await friend.hover('#people-btn');
  await friend.waitForTimeout(250);
  await friend.screenshot({ path: '/tmp/claude-0/ui-avatars-hover.png', clip: { x: 860, y: 0, width: 160, height: 60 } });
  await friend.mouse.move(600, 400);
  await friend.click('#react-btn');
  await friend.click('#color-btn');
  console.log('one dropdown at a time (react->color):', await friend.evaluate(() => [document.getElementById('react-menu').hidden, document.getElementById('color-menu').classList.contains('open')]));
  await friend.click('#react-btn');
  console.log('one dropdown at a time (color->react):', await friend.evaluate(() => [!document.getElementById('react-menu').hidden, document.getElementById('color-menu').classList.contains('open')]));
  await friend.keyboard.press('Escape');
  await friend.click('#color-btn');
  await friend.waitForTimeout(200);
  await friend.screenshot({ path: '/tmp/claude-0/ui-colors.png', clip: { x: 0, y: 0, width: 600, height: 200 } });
  await friend.click('#color-menu .swatch[data-color="#3bf0ff"]');
  console.log('color pick:', await friend.evaluate(() => [window.__app && document.getElementById('color-menu').classList.contains('open'), getComputedStyle(document.getElementById('color-current')).backgroundColor]));
  await friend.click('#color-btn');
  await friend.click('#color-menu .swatch[data-color="#ff3b6b"]');

  // draw a stroke + ping + clear
  const box = await friend.locator('#draw').boundingBox();
  await friend.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await friend.mouse.down();
  for (let i = 1; i <= 10; i++) await friend.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * 0.5);
  await friend.mouse.up();
  await friend.click('#tool-btn'); await friend.click('.tool-opt[data-tool=ping]');
  await friend.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await friend.waitForTimeout(800);
  // ---- arrow tool ----
  await friend.click('#tool-btn');
  await friend.screenshot({ path: '/tmp/claude-0/ui-tool-menu.png', clip: { x: 300, y: 0, width: 600, height: 230 } });
  await friend.click('.tool-opt[data-tool=arrow]');
  await friend.evaluate(() => { window.__arrowBefore = 0; });
  await friend.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.7);
  await friend.mouse.down();
  for (let i = 1; i <= 8; i++) { await friend.mouse.move(box.x + box.width * (0.2 + i * 0.04), box.y + box.height * (0.7 - i * 0.03)); await friend.waitForTimeout(40); }
  await friend.mouse.up();
  await player.waitForTimeout(400);
  console.log('arrow on player:', JSON.stringify(await player.evaluate(() => { const a = window.__drawn.filter((m) => m.t === 'arrow'); return { msgs: a.length, first: a.filter((m) => m.first).length, done: a.filter((m) => m.done).length, end: a.length ? [a[a.length - 1].x2, a[a.length - 1].y2] : null }; })));
  await friend.screenshot({ path: '/tmp/claude-0/ui-arrow.png' });
  // ---- laser pointer: no click, just move ----
  await friend.keyboard.press('l');
  console.log('tool after L:', await friend.textContent('#tool-name'));
  for (let i = 0; i <= 12; i++) { await friend.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * 0.4); await friend.waitForTimeout(40); }
  await player.waitForTimeout(300);
  console.log('laser on player:', JSON.stringify(await player.evaluate(() => { const l = window.__drawn.filter((m) => m.t === 'laser'); return { moves: l.filter((m) => !m.off).length, last: l.length ? [l[l.length - 1].x, l[l.length - 1].y] : null }; })));
  await friend.screenshot({ path: '/tmp/claude-0/ui-laser.png' });
  await friend.mouse.move(box.x - 20, box.y + 10);
  await player.waitForTimeout(300);
  console.log('laser off when leaving:', await player.evaluate(() => { const l = window.__drawn.filter((m) => m.t === 'laser'); return !!(l.length && l[l.length - 1].off); }));
  // ---- zoom: wheel in at the center, then a ping lands where it should ----
  await friend.keyboard.press('o');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await friend.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) { await friend.mouse.wheel(0, -120); await friend.waitForTimeout(30); }
  console.log('zoom:', await friend.textContent('#zoom-level'), 'pill shown:', await friend.evaluate(() => !document.getElementById('zoom-pill').hidden));
  await player.evaluate(() => { window.__drawn = []; });
  await friend.mouse.click(cx + 100, cy);
  await player.waitForTimeout(400);
  const pz = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'ping').map((m) => [m.x, m.y]));
  const z = await friend.evaluate(() => Number(document.getElementById('zoom-level').textContent.replace('%', '')) / 100);
  console.log('ping while zoomed', JSON.stringify(pz), 'zoom', z);
  await friend.screenshot({ path: '/tmp/claude-0/ui-zoom.png' });
  await friend.click('#zoom-reset');
  console.log('zoom reset:', await friend.evaluate(() => document.getElementById('zoom-pill').hidden));
  await friend.keyboard.press('p');
  // mark duration: friend sets 7 s, draws; the player's overlay receives h:7
  await friend.evaluate(() => localStorage.setItem('app.markSeconds', '7'));
  await friend.click('#tool-btn'); await friend.click('.tool-opt[data-tool=pen]');
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
  // video settings now live in the source picker's quality panel
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .pick:not(.skel)');
  await player.click('.picker-gear[title="Stream quality"]');
  await player.screenshot({ path: '/tmp/claude-0/ui-picker-settings.png' });
  await player.locator('.picker-quality select').nth(0).selectOption('720');
  await player.locator('.picker-quality select').nth(1).selectOption('30');
  await player.click('.picker-cancel');
  await player.waitForTimeout(4500);
  console.log('player stats after 720p30:', await player.textContent('#q-stats'));
  console.log('friend after 720p30:', await friend.textContent('#watch-status'));
  console.log('player pipeline:', await player.textContent('#q-pipe'));
  console.log('source label:', await player.textContent('#source-name'), 'overlay target', JSON.stringify(await player.evaluate(() => window.__overlay)));
  console.log('viewer sees source:', await friend.evaluate(() => [!document.getElementById('viewing').hidden, document.getElementById('viewing-name').textContent]));
  // switch to whole screen mid-stream
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .pick:not(.skel)');
  await player.click('#dialog-sources [data-tab=screen]');
  await player.locator('#dialog-sources .pick:not(.skel)').nth(0).click();
  await player.waitForTimeout(5000);
  console.log('after switch, player:', await player.textContent('#source-name'), '|', await player.textContent('#share-status'));
  console.log('after switch, friend video', await friend.evaluate(() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]), await friend.textContent('#watch-status'));
  console.log('overlay target now', JSON.stringify(await player.evaluate(() => window.__overlay)));
  console.log('viewer sees source after switch:', await friend.textContent('#viewing-name')); await friend.screenshot({ path: '/tmp/claude-0/ui-viewer-bar.png', clip: { x: 0, y: 0, width: 1200, height: 60 } });
  // a still game screen (no new frames for 14 s): not a freeze, nothing should flash or rebuild
  const friendLogBefore = await friend.evaluate(() => window.__app.log.length);
  const playerLogBefore = await player.evaluate(() => window.__app.log.length);
  await player.evaluate(() => clearInterval(window.__fake));
  let pausedSeen = false;
  for (let i = 0; i < 14; i++) { await friend.waitForTimeout(1000); if (await friend.evaluate(() => !document.getElementById('freeze').hidden)) pausedSeen = true; }
  console.log('still screen:', JSON.stringify({
    friendSawPaused: pausedSeen,
    rebuildAsked: await friend.evaluate((n) => window.__app.log.slice(n).filter((l) => /asked player to rebuild/.test(l)).length, friendLogBefore),
    captureRestarted: await player.evaluate((n) => window.__app.log.slice(n).filter((l) => /restarting capture/.test(l)).length, playerLogBefore),
    stageHint: await player.textContent('#q-hint'),
  }));
  // switch back to the game window, then simulate the game recreating its window
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .pick:not(.skel)');
  await player.click('#dialog-sources [data-tab=window]');
  await player.locator('#dialog-sources .pick:not(.skel)').nth(0).click();
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
  await friend.click('#conn-btn');
  await friend.click('#refresh-video');
  await friend.waitForTimeout(5000);
  console.log('after refresh button (player log tail):', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /rebuild|refresh|friend reports/.test(l)).slice(-2))));
  console.log('friend after refresh:', await friend.textContent('#watch-status'));
  // ---- network change: pairing service lost on both sides, then video dies ----
  await friend.evaluate(() => window.__app.peer.disconnect());
  await player.evaluate(() => window.__app.peer.disconnect());
  await friend.waitForTimeout(6000);
  console.log('signaling back:', await friend.evaluate(() => !window.__app.peer.disconnected), await player.evaluate(() => !window.__app.peer.disconnected),
    JSON.stringify(await friend.evaluate(() => window.__app.log.filter((l) => /pairing service/.test(l)).slice(-2))));
  const t1 = Date.now();
  await friend.evaluate(() => window.__app.call.peerConnection.close());
  await friend.waitForFunction(() => /rejoining the session/.test(window.__app.log.join('\n')), null, { timeout: 45000 }).catch(() => {});
  await friend.waitForFunction(() => !document.getElementById('step-watch').hidden && document.getElementById('video').videoWidth > 0 && window.__app.call && window.__app.call.peerConnection.connectionState === 'connected', null, { timeout: 40000 }).catch(() => {});
  console.log('dead video -> auto rejoin:', JSON.stringify(await friend.evaluate(() => window.__app.log.filter((l) => /rejoining|video stream received/.test(l)).slice(-2))), 'watching again:', await friend.evaluate(() => !document.getElementById('step-watch').hidden), 'after', Math.round((Date.now() - t1) / 1000), 's');
  await friend.waitForTimeout(3000);
  // ---- emoji reactions ----
  await friend.click('#react-btn');
  console.log('react menu open:', await friend.evaluate(() => !document.getElementById('react-menu').hidden), 'items', await friend.locator('#react-menu button').count());
  await friend.click('#react-menu button:nth-child(4)');
  await friend.waitForTimeout(250);
  await friend.screenshot({ path: '/tmp/claude-0/react-friend.png' });
  await friend.keyboard.press('Escape');
  await friend.locator('#video').click({ position: { x: 5, y: 5 }, trial: true }).catch(() => {});
  await friend.keyboard.press('2');
  await friend.waitForTimeout(600);
  const reacts = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'react').map((m) => `${m.e}@${m.x}`));
  console.log('player got reactions:', JSON.stringify(reacts), '| menu closed after Esc:', await friend.evaluate(() => document.getElementById('react-menu').hidden));
  for (let i = 0; i < 10; i++) await friend.keyboard.press('1');
  await friend.waitForTimeout(500);
  console.log('flood limit (10 presses):', await player.evaluate(() => window.__drawn.filter((m) => m.t === 'react' && m.e === '👍').length));
  // ---- profile changes during a session reach the other side ----
  const peerAv = (pg) => pg.evaluate(() => window.__app.peerProfile && window.__app.peerProfile.avatar && (window.__app.peerProfile.avatar.value || window.__app.peerProfile.avatar.kind));
  // friend changes avatar in Settings and saves
  await friend.click('#me-btn');
  await friend.click('#open-profile');
  await friend.click('#avatar-picker-settings .avatar-option[data-value="🐙"]');
  await friend.screenshot({ path: '/tmp/claude-0/ui-profile.png' });
  await friend.click('#profile-save');
  await player.waitForTimeout(1200);
  console.log('profile sync friend->player (settings save):', await peerAv(player));
  // player's update message is lost; heartbeat version check must catch it
  await player.evaluate(() => { window.__app.avatar = { kind: 'emoji', value: '🦄', color: '#b26bff' }; window.__app.profileVer = Date.now(); });
  await friend.waitForFunction(() => window.__app.peerProfile && window.__app.peerProfile.avatar && window.__app.peerProfile.avatar.value === '🦄', null, { timeout: 8000 }).catch(() => {});
  console.log('profile sync player->friend (message lost, healed by heartbeat):', await peerAv(friend));
  console.log('friend chips now:', JSON.stringify(await chips(friend)));
  // ---- never send more than 4K (hardware H.264 limit) ----
  console.log('send cap check:', JSON.stringify(await player.evaluate(async () => {
    const S = window.__app;
    const tr = S.stream.getVideoTracks()[0];
    const keep = S.native;
    S.native = { w: 5120, h: 2880 };
    localStorage.setItem('app.quality', JSON.stringify({ res: 'native', fps: 30, mbps: 12, prefer: 'balanced', codec: 'h264' }));
    const seen = [];
    const orig = tr.applyConstraints.bind(tr);
    tr.applyConstraints = async (c) => { seen.push([c.width.max, c.height.max]); return orig(c); };
    document.getElementById('q-res').value = 'native';
    document.getElementById('q-res').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 300));
    tr.applyConstraints = orig;
    S.native = keep;
    return { constraints: seen };
  })));
  // ---- drawing link dies, video keeps going (seen on Macs) ----
  const drawBox = await friend.locator('#draw').boundingBox();
  const drawAt = async (fx, fy) => {
    await friend.click('#tool-btn'); await friend.click('.tool-opt[data-tool=pen]');
    await friend.mouse.move(drawBox.x + drawBox.width * fx, drawBox.y + drawBox.height * fy);
    await friend.mouse.down(); await friend.mouse.move(drawBox.x + drawBox.width * (fx + 0.05), drawBox.y + drawBox.height * fy); await friend.mouse.up();
  };
  const starts = () => player.evaluate(() => window.__drawn.filter((m) => m.t === 'start').length);
  console.log('heartbeat seen:', await friend.evaluate(() => window.__app.peerHb), await player.evaluate(() => window.__app.peerHb));
  // second drawing path inside the video connection
  console.log('video-path drawing channel open:', await friend.evaluate(() => !!(window.__app.drawDc && window.__app.drawDc.readyState === 'open')), await player.evaluate(() => !!(window.__app.drawDc && window.__app.drawDc.readyState === 'open')));
  let n0 = await starts();
  await drawAt(0.3, 0.6);
  await friend.waitForTimeout(600);
  console.log('both paths up: starts added =', (await starts()) - n0, '(want 1, no duplicates)');
  // drawing link silently dead (friend's sends vanish): mark must still arrive right away
  await friend.evaluate(() => { window.__realSend = window.__app.conn.send.bind(window.__app.conn); window.__app.conn.send = () => {}; });
  n0 = await starts();
  const t0 = Date.now();
  await drawAt(0.35, 0.65);
  await player.waitForFunction((n) => window.__drawn.filter((m) => m.t === 'start').length > n, n0, { timeout: 5000 }).catch(() => {});
  console.log('drawing link dead: mark arrived via video path:', (await starts()) - n0 === 1, 'in', Date.now() - t0, 'ms');
  await friend.evaluate(() => { window.__app.conn.send = window.__realSend; });
  const callBefore = await player.evaluate(() => { window.__callRef = window.__app.call; return !!window.__callRef; });
  // 1) silent death: the player stops answering on the drawing link
  await player.evaluate(() => { window.__app.conn.send = () => {}; });
  await friend.waitForTimeout(9000);
  let before = await starts();
  await friend.waitForFunction(() => window.__app.conn && window.__app.conn.open && !window.__app.relinking, null, { timeout: 15000 });
  await drawAt(0.4, 0.4);
  await friend.waitForTimeout(800);
  console.log('quiet link relink:', JSON.stringify(await friend.evaluate(() => window.__app.log.filter((l) => /drawing link/.test(l)).slice(-3))),
    '| mark arrived after relink:', (await starts()) > before,
    '| same video call kept:', callBefore && await player.evaluate(() => window.__app.call === window.__callRef));
  // 2) hard death: the drawing link's network connection is torn down
  before = await starts();
  await friend.evaluate(() => window.__app.conn.peerConnection.close());
  await friend.waitForTimeout(1500);
  await friend.waitForFunction(() => window.__app.conn && window.__app.conn.open && !window.__app.relinking, null, { timeout: 20000 });
  await drawAt(0.5, 0.3);
  await friend.waitForTimeout(800);
  console.log('closed link relink:', JSON.stringify(await friend.evaluate(() => window.__app.log.filter((l) => /drawing link/.test(l)).slice(-2))),
    '| player:', JSON.stringify(await player.evaluate(() => window.__app.log.filter((l) => /drawing link|viewer left/.test(l)).slice(-3))),
    '| mark arrived:', (await starts()) > before,
    '| friend still watching:', await friend.evaluate(() => !document.getElementById('step-watch').hidden));
  await player.waitForTimeout(3000);
  await player.click('#conn-btn');
  await player.click('#conn-restart');
  await player.waitForTimeout(5000);
  console.log('player restart-stream:', await player.textContent('#share-status'), '| friend:', await friend.textContent('#watch-status'));
  // pairing service drops while friend is connected: no scary error
  await player.evaluate(() => { const p = window.__app.peer; p.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' })); });
  await player.waitForTimeout(300);
  const sigStatus = await player.textContent('#share-status');
  console.log('signaling drop while connected:', sigStatus, '|', /online/i.test(sigStatus) ? 'FAIL shows error' : 'OK');
  console.log('friend after auto-restart:', await friend.textContent('#watch-status'), JSON.stringify(await friend.evaluate(() => [document.getElementById('freeze').hidden, document.getElementById('freeze').textContent])));
  console.log('friend banner during stall:', JSON.stringify(await friend.evaluate(() => [document.getElementById('freeze').hidden, document.getElementById('freeze').textContent])));
  await friend.click('#conn-btn');
  await friend.click('#conn-details');
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
  await player.click('#end'); await player.click('#end-yes');
  await friend.waitForFunction(() => /ended the session/.test(document.getElementById('join-status').textContent), null, { timeout: 15000 });
  console.log('friend after end:', await friend.textContent('#join-status'));

  // reshare and rejoin works
  await player.click('#go-share');
  await player.click('.pick:not(.skel)');
  await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
  const code2 = await player.textContent('#code');
  await friend.fill('#join-code', `Join my session: https://x.github.io/gameguide/join/?code=${code2.toLowerCase()} or type ${code2}`);
  console.log('otp paste ->', await friend.inputValue('#join-code'), JSON.stringify(await friend.evaluate(() => [...document.querySelectorAll('#join-otp .otp-cells span')].map((c) => c.textContent).join(''))));
  await friend.screenshot({ path: '/tmp/claude-0/ui-join-otp.png' });
  await friend.click('#join-btn');
  await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 30000 });
  console.log('rejoin OK with', code2);
  // friend ends -> player waits again
  await friend.click('#end'); await friend.click('#end-yes');
  await player.waitForFunction(() => /left/.test(document.getElementById('share-status').textContent), null, { timeout: 15000 });
  console.log('player after friend left:', await player.textContent('#share-status'));

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  srv.close(); ps.close && ps.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
