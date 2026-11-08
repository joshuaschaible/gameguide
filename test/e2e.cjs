// Two Chromium pages: player shares a fake "screen" (animated canvas), friend joins by code,
// draws, and we verify the strokes reach the player's overlay channel.
const { chromium } = require('playwright');
const { PeerServer } = require('peer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const reporter = require('./report.cjs');
const r = reporter('End-to-end (two app pages)');
const { check, note } = r;
const has = (list, re) => (list || []).some((l) => re.test(l));
const phase = (pg) => pg.evaluate(() => window.__app.phase);

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
  await player.waitForSelector('.picker:not(.loading) .pick:not(.skel)');
  await player.hover('.pick:not(.skel)');
  await player.waitForTimeout(250);
  await player.screenshot({ path: '/tmp/claude-0/ui-picker.png' });
  await player.click('.picker-gear[title="Stream quality"]');
  await player.screenshot({ path: '/tmp/claude-0/ui-picker-quality.png' });
  await player.click('.pick:not(.skel)');
  await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
  const code = await player.textContent('#code');
  await player.screenshot({ path: '/tmp/claude-0/ui-share-waiting.png' });
  note('code', code);
  check('player phase: host.waiting', await phase(player) === 'host.waiting');
  check('invite + shown while waiting for a friend', await player.evaluate(() => !document.getElementById('invite-wrap').hidden));
  await player.click('#invite-btn');
  await player.waitForTimeout(200);
  await player.screenshot({ path: '/tmp/claude-0/ui-share-invite.png', clip: { x: 500, y: 0, width: 700, height: 280 } });
  await player.keyboard.press('Escape');
  await player.click('#copy-code');
  check('copy code copies the code', await player.evaluate(() => window.__copied) === code);

  // wrong code first
  await friend.click('#go-join');
  await friend.fill('#join-code', 'zzzz22');
  await friend.click('#join-btn');
  await friend.waitForFunction(() => document.getElementById('join-status').classList.contains('bad'), null, { timeout: 15000 });
  const wrong = await friend.textContent('#join-status');
  check('wrong code explains nobody is sharing', /No one is sharing/.test(wrong), wrong);

  await friend.fill('#join-code', code.toLowerCase().slice(0, 3) + '-' + code.slice(3));
  await friend.click('#join-btn');
  await friend.waitForSelector('#step-watch:not([hidden])', { timeout: 30000 });
  await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 15000 });
  const fv = await friend.evaluate(() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]);
  check('friend gets the window video (1280x720)', fv[0] === 1280 && fv[1] === 720, JSON.stringify(fv));
  const ps0 = await player.textContent('#share-status');
  check('player status says connected', /Connected/.test(ps0), ps0);
  check('phases: player host.live, friend viewer.watching', await phase(player) === 'host.live' && await phase(friend) === 'viewer.watching');
  await player.waitForTimeout(500);
  const chips = (pg) => pg.evaluate(() => [...document.querySelectorAll('#people-menu .person')].map((c) => `${c.querySelector('.you-tag') ? 'you' : 'peer'}:${c.querySelector('.person-name').firstChild.textContent}:${c.querySelector('.avatar img') ? 'photo' : c.querySelector('.avatar').textContent}`));
  const pc0 = await chips(player); const fc0 = await chips(friend);
  check('player sees friend in people list', pc0.includes('you:Joshua:photo') && pc0.includes('peer:Saturn:🐺'), JSON.stringify(pc0));
  check('friend sees player in people list', fc0.includes('you:Saturn:🐺') && fc0.includes('peer:Joshua:photo'), JSON.stringify(fc0));
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
  const sig = [await friend.evaluate(() => window.__app.sigLevel), await player.evaluate(() => window.__app.sigLevel)];
  check('signal level shown on both sides', sig.every((x) => ['good', 'ok', 'poor'].includes(x)), JSON.stringify(sig));
  await friend.keyboard.press('Escape');
  await player.screenshot({ path: '/tmp/claude-0/ui-share.png' });
  // streamer preview: plays while the app is in front, pauses in the background
  const pv = () => player.evaluate(() => { const v = document.getElementById('preview-video'); return { shown: !document.getElementById('preview').hidden, playing: !v.paused && !!v.srcObject, w: v.videoWidth, pausedLabel: !document.getElementById('preview-paused').hidden }; });
  await player.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
  await player.waitForTimeout(600);
  const pv1 = await pv();
  check('streamer preview plays while the app is in front', pv1.playing && !pv1.pausedLabel, JSON.stringify(pv1));
  await player.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  await player.waitForTimeout(300);
  const pv2 = await pv();
  check('streamer preview pauses in the background', !pv2.playing && pv2.pausedLabel, JSON.stringify(pv2));
  await player.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
  await player.waitForTimeout(400);
  const pv3 = await pv();
  check('streamer preview resumes in front', pv3.playing && !pv3.pausedLabel, JSON.stringify(pv3));
  await player.screenshot({ path: '/tmp/claude-0/ui-share-preview.png' });
  await player.click('#preview-toggle');
  await player.waitForTimeout(300);
  const po = await player.evaluate(() => ({ placeholder: !document.getElementById('preview-off').hidden, decoding: !!document.getElementById('preview-video').srcObject }));
  check('preview off stops decoding', po.placeholder && !po.decoding, JSON.stringify(po));
  await player.screenshot({ path: '/tmp/claude-0/ui-preview-off.png' });
  await player.click('#preview-show');
  await player.waitForTimeout(1200);
  const pon = await player.evaluate(() => ({ placeholder: !document.getElementById('preview-off').hidden, decoding: !!document.getElementById('preview-video').srcObject }));
  check('preview back on decodes again', !pon.placeholder && pon.decoding, JSON.stringify(pon));
  // connection panel (structured) + my account menu + end confirmation
  await player.click('#conn-btn');
  await player.waitForTimeout(2300);
  await player.screenshot({ path: '/tmp/claude-0/ui-conn-panel.png', clip: { x: 760, y: 0, width: 440, height: 420 } });
  const rows = await player.evaluate(() => [...document.querySelectorAll('#conn-grid dt')].map((d) => d.textContent));
  check('connection panel lists video details', rows.includes('Video') && rows.includes('Encoder'), JSON.stringify(rows));
  await player.keyboard.press('Escape');
  await player.click('#me-btn');
  await player.waitForTimeout(200);
  await player.screenshot({ path: '/tmp/claude-0/ui-me-menu.png', clip: { x: 800, y: 0, width: 400, height: 260 } });
  await player.keyboard.press('Escape');
  await player.click('#end');
  await player.waitForTimeout(200);
  const ec = await player.evaluate(() => [document.getElementById('end-confirm').open, document.getElementById('end-text').textContent]);
  check('end asks for confirmation naming the friend', ec[0] === true && /Saturn/.test(ec[1]), JSON.stringify(ec));
  await player.screenshot({ path: '/tmp/claude-0/ui-end-confirm.png' });
  await player.click('#end-cancel');
  check('still sharing after cancel', await player.evaluate(() => !window.__app.ended && !!window.__app.call));
  check('invite + hidden once friend is in', await player.evaluate(() => document.getElementById('invite-wrap').hidden));
  await friend.mouse.move(10, 400);
  await friend.hover('#conn-btn');
  await friend.waitForTimeout(450);
  const tip = await friend.evaluate(() => ({ shown: !document.getElementById('tip').hidden, text: document.getElementById('tip').textContent }));
  check('custom tooltip on icon buttons', tip.shown && /Connection/.test(tip.text), JSON.stringify(tip));
  await friend.screenshot({ path: '/tmp/claude-0/ui-tooltip.png', clip: { x: 800, y: 0, width: 400, height: 110 } });
  await friend.hover('#people-btn');
  await friend.waitForTimeout(250);
  await friend.screenshot({ path: '/tmp/claude-0/ui-avatars-hover.png', clip: { x: 860, y: 0, width: 160, height: 60 } });
  await friend.mouse.move(600, 400);
  await friend.click('#react-btn');
  await friend.click('#color-btn');
  const dd1 = await friend.evaluate(() => [document.getElementById('react-menu').hidden, document.getElementById('color-menu').classList.contains('open')]);
  check('one dropdown at a time (react -> color)', dd1[0] && dd1[1], JSON.stringify(dd1));
  await friend.click('#react-btn');
  const dd2 = await friend.evaluate(() => [!document.getElementById('react-menu').hidden, document.getElementById('color-menu').classList.contains('open')]);
  check('one dropdown at a time (color -> react)', dd2[0] && !dd2[1], JSON.stringify(dd2));
  await friend.keyboard.press('Escape');
  await friend.click('#color-btn');
  await friend.waitForTimeout(200);
  await friend.screenshot({ path: '/tmp/claude-0/ui-colors.png', clip: { x: 0, y: 0, width: 600, height: 200 } });
  await friend.click('#color-menu .swatch[data-color="#3bf0ff"]');
  const cp = await friend.evaluate(() => [document.getElementById('color-menu').classList.contains('open'), getComputedStyle(document.getElementById('color-current')).backgroundColor, document.getElementById('color-name').textContent]);
  check('color pick closes the menu and shows the color', !cp[0] && cp[1] === 'rgb(59, 240, 255)', JSON.stringify(cp));
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
  const ar = await player.evaluate(() => { const a = window.__drawn.filter((m) => m.t === 'arrow'); return { msgs: a.length, first: a.filter((m) => m.first).length, done: a.filter((m) => m.done).length }; });
  check('arrow reaches the player (one first, one done)', ar.msgs >= 2 && ar.first === 1 && ar.done === 1, JSON.stringify(ar));
  await friend.screenshot({ path: '/tmp/claude-0/ui-arrow.png' });
  // ---- laser pointer: no click, just move ----
  await friend.keyboard.press('l');
  check('L picks the Cursor tool', await friend.textContent('#tool-name') === 'Cursor');
  for (let i = 0; i <= 12; i++) { await friend.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * 0.4); await friend.waitForTimeout(40); }
  await player.waitForTimeout(300);
  const lz = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'laser' && !m.off).length);
  check('cursor (laser) moves reach the player', lz >= 5, `${lz} moves`);
  await friend.screenshot({ path: '/tmp/claude-0/ui-laser.png' });
  await friend.mouse.move(box.x - 20, box.y + 10);
  await player.waitForTimeout(300);
  check('cursor turns off when leaving the video', await player.evaluate(() => { const l = window.__drawn.filter((m) => m.t === 'laser'); return !!(l.length && l[l.length - 1].off); }));
  // ---- zoom: wheel in at the center, then a ping lands where it should ----
  await friend.keyboard.press('o');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await friend.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) { await friend.mouse.wheel(0, -120); await friend.waitForTimeout(30); }
  const zl = await friend.textContent('#zoom-level');
  check('wheel zooms in and shows the zoom pill', Number(zl.replace('%', '')) > 100 && await friend.evaluate(() => !document.getElementById('zoom-pill').hidden), zl);
  await player.evaluate(() => { window.__drawn = []; });
  await friend.mouse.click(cx + 100, cy);
  await player.waitForTimeout(400);
  const pz = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'ping').map((m) => [m.x, m.y]));
  const z = await friend.evaluate(() => Number(document.getElementById('zoom-level').textContent.replace('%', '')) / 100);
  check('ping while zoomed lands right of center, same height', pz.length === 1 && pz[0][0] > 0.5 && pz[0][0] < 0.6 && Math.abs(pz[0][1] - 0.5) < 0.01, `${JSON.stringify(pz)} at zoom ${z}`);
  await friend.screenshot({ path: '/tmp/claude-0/ui-zoom.png' });
  await friend.click('#zoom-reset');
  check('zoom reset hides the pill', await friend.evaluate(() => document.getElementById('zoom-pill').hidden));
  await friend.keyboard.press('p');
  // mark duration: friend sets 7 s, draws; the player's overlay receives h:7
  await friend.evaluate(() => localStorage.setItem('app.markSeconds', '7'));
  await friend.click('#tool-btn'); await friend.click('.tool-opt[data-tool=pen]');
  await friend.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await friend.mouse.down(); await friend.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25); await friend.mouse.up();
  await friend.waitForTimeout(400);
  const hs = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'start').map((m) => m.h));
  check('mark duration setting travels with the mark', hs[hs.length - 1] === 7, JSON.stringify(hs));
  // fade timing in the renderer: h=1 -> gone after ~1.7 s, default -> still there
  const fade = await friend.evaluate(async () => {
    const c = document.createElement('canvas'); c.style.cssText = 'width:200px;height:100px'; document.body.appendChild(c);
    const m = new window.Marks(c);
    m.apply({ t: 'start', id: 'a', x: 0.1, y: 0.1, c: '#ff0000', h: 1 }); m.apply({ t: 'end', id: 'a' });
    m.apply({ t: 'start', id: 'b', x: 0.5, y: 0.5, c: '#00ff00' }); m.apply({ t: 'end', id: 'b' });
    await new Promise((r) => setTimeout(r, 2000));
    const left = [...m.strokes.keys()];
    c.remove();
    return { leftAfter2s: left };
  });
  check('marks fade on their own timer', JSON.stringify(fade.leftAfter2s) === '["b"]', JSON.stringify(fade));
  await friend.evaluate(() => localStorage.removeItem('app.markSeconds'));
  const rc = await friend.evaluate(() => document.getElementById('receipt').textContent);
  check('receipt confirms the mark was shown', /Shown on Joshua/.test(rc), rc);
  await player.evaluate(() => { window.__rcState = 'hidden'; });
  await friend.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await friend.waitForTimeout(600);
  const rch = await friend.evaluate(() => document.getElementById('receipt').textContent);
  check('receipt explains hidden drawings', /hid drawings/.test(rch), rch);
  await player.evaluate(() => { window.__rcState = 'shown'; });
  await friend.screenshot({ path: '/tmp/claude-0/friend.png' });
  const drawn = await player.evaluate(() => window.__drawn);
  const types = [...new Set(drawn.map((d) => d.t))];
  // (arrow + cursor were checked above; the log was cleared at the zoom step)
  check('player overlay got strokes and pings', ['start', 'move', 'end', 'ping'].every((t) => types.includes(t)), types.join(','));
  await player.screenshot({ path: '/tmp/claude-0/player.png' });

  // details dialog
  await friend.waitForTimeout(5000);
  const ws = await friend.textContent('#watch-status');
  check('friend status names the player and shows stats', /^Watching Joshua · \d+×\d+/.test(ws), ws);
  const qs = await player.textContent('#q-stats');
  check('player sees sending stats', /^Sending: \d+×\d+/.test(qs), qs);
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
  const q720 = await player.evaluate(() => JSON.parse(localStorage.getItem('app.quality') || '{}'));
  check('quality change from the picker is saved', q720.res === '720' && q720.fps === 30, JSON.stringify(q720));
  check('player pipeline readout', /^Frames per second: captured/.test(await player.textContent('#q-pipe')));
  check('source label + overlay target follow the window', await player.textContent('#source-name') === 'WARDOGS' && await player.evaluate(() => window.__overlay && window.__overlay.id === 'window:111:0'));
  const vs = await friend.evaluate(() => [!document.getElementById('viewing').hidden, document.getElementById('viewing-name').textContent]);
  check('viewer sees what is shared', vs[0] && vs[1] === 'WARDOGS', JSON.stringify(vs));
  // switch to whole screen mid-stream
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .pick:not(.skel)');
  await player.click('#dialog-sources [data-tab=screen]');
  await player.locator('#dialog-sources .pick:not(.skel)').nth(0).click();
  await player.waitForTimeout(5000);
  const sw = await player.textContent('#share-status');
  check('switching source mid-stream', await player.textContent('#source-name') === 'Whole screen' && /Now sharing "Whole screen"/.test(sw), sw);
  const fv2 = await friend.evaluate(() => document.getElementById('video').videoHeight);
  check('friend video follows the switch (720p setting from above)', fv2 === 720, String(fv2));
  check('overlay moves to the screen', await player.evaluate(() => window.__overlay && window.__overlay.kind === 'screen'));
  check('viewer label follows the switch', await friend.textContent('#viewing-name') === 'Whole screen'); await friend.screenshot({ path: '/tmp/claude-0/ui-viewer-bar.png', clip: { x: 0, y: 0, width: 1200, height: 60 } });
  // a still game screen (no new frames for 14 s): not a freeze, nothing should flash or rebuild
  const friendLogBefore = await friend.evaluate(() => window.__app.log.length);
  const playerLogBefore = await player.evaluate(() => window.__app.log.length);
  await player.evaluate(() => clearInterval(window.__fake));
  let pausedSeen = false;
  for (let i = 0; i < 14; i++) { await friend.waitForTimeout(1000); if (await friend.evaluate(() => !document.getElementById('freeze').hidden)) pausedSeen = true; }
  const still = {
    friendSawPaused: pausedSeen,
    rebuildAsked: await friend.evaluate((n) => window.__app.log.slice(n).filter((l) => /asked player to rebuild/.test(l)).length, friendLogBefore),
    captureRestarted: await player.evaluate((n) => window.__app.log.slice(n).filter((l) => /restarting capture/.test(l)).length, playerLogBefore),
  };
  check('a still game screen is not treated as a freeze', !still.friendSawPaused && !still.rebuildAsked && !still.captureRestarted, JSON.stringify(still));
  // switch back to the game window, then simulate the game recreating its window
  await player.click('#change-source');
  await player.waitForSelector('#dialog-sources .pick:not(.skel)');
  await player.click('#dialog-sources [data-tab=window]');
  await player.locator('#dialog-sources .pick:not(.skel)').nth(0).click();
  await player.waitForTimeout(2500);
  await player.evaluate(() => window.__app.stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await player.waitForTimeout(3000);
  const ra = await player.evaluate(() => window.__app.log.filter((l) => /reattach/.test(l)));
  check('a recreated game window is found again', has(ra, /found "WARDOGS" again/) && await player.textContent('#source-name') === 'WARDOGS', JSON.stringify(ra.slice(-1)));
  // kill the video path on the player (simulates a hung encoder / dead video connection)
  await player.evaluate(async () => { const pc = window.__app.call.peerConnection; const snd = pc.getSenders().find((x) => x.track); await snd.replaceTrack(null); });
  await friend.waitForTimeout(9000);
  const vd = await player.evaluate(() => window.__app.log.filter((l) => /rebuilding video|friend reports/.test(l)));
  check('dead video path gets rebuilt', vd.length > 0, JSON.stringify(vd.slice(-1)));
  check('friend watching after video rebuild', /^Watching Joshua/.test(await friend.textContent('#watch-status')));
  // simulate the network dropping the video twice: must rebuild, cap bitrate, and NOT switch codec
  for (let i = 0; i < 2; i++) {
    await player.waitForFunction(() => window.__app.call && window.__app.call.peerConnection, null, { timeout: 20000 });
    await player.evaluate(() => { window.__app.lastSendMbps = 9; const pc = window.__app.call.peerConnection; Object.defineProperty(pc, 'iceConnectionState', { get: () => 'failed', configurable: true }); pc.dispatchEvent(new Event('iceconnectionstatechange')); });
    await player.waitForTimeout(13000);
  }
  const nd = await player.evaluate(() => window.__app.log.filter((l) => /network dropped|capping|switching codec/.test(l)));
  const cap = await player.evaluate(() => [window.__app.netCapMbps, window.__app.codecOverride]);
  check('network drops cap the bitrate, codec stays', has(nd, /capping this session/) && !has(nd, /switching codec/) && cap[0] >= 3 && cap[1] === null, JSON.stringify(cap));
  // manual refresh button
  await friend.waitForTimeout(11000);
  await friend.click('#conn-btn');
  await friend.click('#refresh-video');
  await friend.waitForTimeout(5000);
  const rf = await player.evaluate(() => window.__app.log.filter((l) => /friend reports no video/.test(l)));
  check('refresh button asks the player to rebuild', has(rf, /refresh button/), JSON.stringify(rf.slice(-1)));
  check('friend watching after refresh', /^Watching Joshua/.test(await friend.textContent('#watch-status')));
  // ---- network change: pairing service lost on both sides, then video dies ----
  await friend.evaluate(() => window.__app.peer.disconnect());
  await player.evaluate(() => window.__app.peer.disconnect());
  await friend.waitForTimeout(6000);
  check('pairing service reconnects on both sides', await friend.evaluate(() => !window.__app.peer.disconnected) && await player.evaluate(() => !window.__app.peer.disconnected));
  const t1 = Date.now();
  await friend.evaluate(() => window.__app.call.peerConnection.close());
  const rj = await friend.waitForFunction(() => /rejoining the session/.test(window.__app.log.join('\n')), null, { timeout: 45000 }).then(() => true, () => false);
  const back = await friend.waitForFunction(() => !document.getElementById('step-watch').hidden && document.getElementById('video').videoWidth > 0 && window.__app.call && window.__app.call.peerConnection.connectionState === 'connected', null, { timeout: 40000 }).then(() => true, () => false);
  check('dead video makes the viewer rejoin by itself', rj && back, `after ${Math.round((Date.now() - t1) / 1000)} s`);
  await friend.waitForTimeout(3000);
  // ---- emoji reactions ----
  await friend.click('#react-btn');
  check('react menu opens with emoji', await friend.evaluate(() => !document.getElementById('react-menu').hidden) && await friend.locator('#react-menu button').count() >= 6);
  await friend.click('#react-menu button:nth-child(4)');
  await friend.waitForTimeout(250);
  await friend.screenshot({ path: '/tmp/claude-0/react-friend.png' });
  await friend.keyboard.press('Escape');
  await friend.locator('#video').click({ position: { x: 5, y: 5 }, trial: true }).catch(() => {});
  await friend.keyboard.press('2');
  await friend.waitForTimeout(600);
  const reacts = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'react').map((m) => `${m.e}@${m.x}`));
  check('reactions reach the player (click + number key)', reacts.length >= 2, JSON.stringify(reacts));
  check('Esc closes the react menu', await friend.evaluate(() => document.getElementById('react-menu').hidden));
  for (let i = 0; i < 10; i++) await friend.keyboard.press('1');
  await friend.waitForTimeout(500);
  const flood = await player.evaluate(() => window.__drawn.filter((m) => m.t === 'react' && m.e === '👍').length);
  check('reaction flood limit (10 presses)', flood >= 1 && flood <= 6, String(flood));
  // ---- profile changes during a session reach the other side ----
  const peerAv = (pg) => pg.evaluate(() => window.__app.peerProfile && window.__app.peerProfile.avatar && (window.__app.peerProfile.avatar.value || window.__app.peerProfile.avatar.kind));
  // friend changes avatar in Settings and saves
  await friend.click('#me-btn');
  await friend.click('#open-profile');
  await friend.click('#avatar-picker-settings .avatar-option[data-value="🐙"]');
  await friend.screenshot({ path: '/tmp/claude-0/ui-profile.png' });
  await friend.click('#profile-save');
  await player.waitForTimeout(1200);
  check('profile change reaches the other side', await peerAv(player) === '🐙');
  // player's update message is lost; heartbeat version check must catch it
  await player.evaluate(() => { window.__app.avatar = { kind: 'emoji', value: '🦄', color: '#b26bff' }; window.__app.profileVer = Date.now(); });
  await friend.waitForFunction(() => window.__app.peerProfile && window.__app.peerProfile.avatar && window.__app.peerProfile.avatar.value === '🦄', null, { timeout: 8000 }).catch(() => {});
  check('lost profile message healed by the heartbeat', await peerAv(friend) === '🦄');
  // ---- never send more than 4K (hardware H.264 limit) ----
  const capc = await player.evaluate(async () => {
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
  });
  check('never sends more than 4K', JSON.stringify(capc.constraints) === '[[3840,2160]]', JSON.stringify(capc));
  // ---- drawing link dies, video keeps going (seen on Macs) ----
  const drawBox = await friend.locator('#draw').boundingBox();
  const drawAt = async (fx, fy) => {
    await friend.click('#tool-btn'); await friend.click('.tool-opt[data-tool=pen]');
    await friend.mouse.move(drawBox.x + drawBox.width * fx, drawBox.y + drawBox.height * fy);
    await friend.mouse.down(); await friend.mouse.move(drawBox.x + drawBox.width * (fx + 0.05), drawBox.y + drawBox.height * fy); await friend.mouse.up();
  };
  const starts = () => player.evaluate(() => window.__drawn.filter((m) => m.t === 'start').length);
  check('heartbeats on both sides', await friend.evaluate(() => window.__app.peerHb) && await player.evaluate(() => window.__app.peerHb));
  // second drawing path inside the video connection
  check('second drawing path inside the video connection', await friend.evaluate(() => !!(window.__app.drawDc && window.__app.drawDc.readyState === 'open')) && await player.evaluate(() => !!(window.__app.drawDc && window.__app.drawDc.readyState === 'open')));
  let n0 = await starts();
  await drawAt(0.3, 0.6);
  await friend.waitForTimeout(600);
  const dup = (await starts()) - n0;
  check('mark sent on both paths arrives once', dup === 1, String(dup));
  // drawing link silently dead (friend's sends vanish): mark must still arrive right away
  await friend.evaluate(() => { window.__realSend = window.__app.conn.send.bind(window.__app.conn); window.__app.conn.send = () => {}; });
  n0 = await starts();
  const t0 = Date.now();
  await drawAt(0.35, 0.65);
  await player.waitForFunction((n) => window.__drawn.filter((m) => m.t === 'start').length > n, n0, { timeout: 5000 }).catch(() => {});
  check('drawing link dead: mark arrives via the video path', (await starts()) - n0 === 1, `${Date.now() - t0} ms`);
  await friend.evaluate(() => { window.__app.conn.send = window.__realSend; });
  const callBefore = await player.evaluate(() => { window.__callRef = window.__app.call; return !!window.__callRef; });
  // 1) silent death: the player stops answering on the drawing link
  await player.evaluate(() => { window.__app.conn.send = () => {}; });
  await friend.waitForTimeout(9000);
  let before = await starts();
  await friend.waitForFunction(() => window.__app.conn && window.__app.conn.open && !window.__app.relinking, null, { timeout: 15000 });
  await drawAt(0.4, 0.4);
  await friend.waitForTimeout(800);
  const ql = await friend.evaluate(() => window.__app.log.filter((l) => /drawing link/.test(l)));
  check('quiet drawing link is rebuilt', has(ql, /drawing link quiet/) && has(ql, /drawing link rebuilt/), JSON.stringify(ql.slice(-2)));
  check('mark arrives after the quiet-link rebuild', (await starts()) > before);
  check('video call kept through the drawing-link rebuild', callBefore && await player.evaluate(() => window.__app.call === window.__callRef));
  check('friend phase went through relinking and back', await friend.evaluate(() => {
    const h = window.__app.machines.session.snapshot(40).history.filter((x) => !x.ignored).map((x) => x.to);
    return h.includes('viewer.relinking') && h[h.length - 1] === 'viewer.watching';
  }));
  // 2) hard death: the drawing link's network connection is torn down
  before = await starts();
  await friend.evaluate(() => window.__app.conn.peerConnection.close());
  await friend.waitForTimeout(1500);
  await friend.waitForFunction(() => window.__app.conn && window.__app.conn.open && !window.__app.relinking, null, { timeout: 20000 });
  await drawAt(0.5, 0.3);
  await friend.waitForTimeout(800);
  check('closed drawing link is rebuilt, mark arrives', (await starts()) > before);
  check('friend still watching after the closed-link rebuild', await friend.evaluate(() => !document.getElementById('step-watch').hidden));
  check('player did not drop the viewer', !(await player.evaluate(() => window.__app.log.slice(-15).some((l) => /viewer left/.test(l)))));
  await player.waitForTimeout(3000);
  await player.click('#conn-btn');
  await player.click('#conn-restart');
  await player.waitForTimeout(5000);
  const rs = await player.textContent('#share-status');
  check('restart stream from the connection panel', /Stream restarted/.test(rs), rs);
  // pairing service drops while friend is connected: no scary error
  await player.evaluate(() => { const p = window.__app.peer; p.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' })); });
  await player.waitForTimeout(300);
  const sigStatus = await player.textContent('#share-status');
  check('pairing service drop while connected shows no scary error', !/online/i.test(sigStatus), sigStatus);
  await friend.click('#conn-btn');
  await friend.click('#conn-details');
  await friend.waitForTimeout(500);
  const det = await friend.textContent('#details-text');
  check('Copy details describes the session', /Role: join/.test(det) && /Drawing link: open/.test(det) && /State: session: viewer\.watching/.test(det), det.split('\n').slice(0, 3).join(' / '));
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
  const pu = await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0 && window.__app.log.some((l) => /video stream received/.test(l)) && window.__app.awaitReturn === null, null, { timeout: 60000 }).then(() => true, () => false);
  await friend.waitForTimeout(1500);
  check('player update: same code after restart', await player.textContent('#code') === codeBefore, `${codeBefore} -> ${await player.textContent('#code')}`);
  check('player update: friend rejoins by itself', pu && /^Watching/.test(await friend.textContent('#watch-status')));
  // --- friend updates: friend restarts and rejoins by itself ---
  await friend.evaluate(() => {
    const S = window.__app;
    localStorage.setItem('app.resume', JSON.stringify({ role: 'join', code: S.code, friend: S.friend, at: Date.now() }));
    S.conn.send({ t: 'updating' });
  });
  await friend.waitForTimeout(300);
  await friend.reload();
  const fu = await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 60000 }).then(() => true, () => false);
  await friend.waitForTimeout(1500);
  check('friend update: friend rejoins by itself', fu && /^Watching/.test(await friend.textContent('#watch-status')));

  // player ends -> friend sees ended
  await player.click('#end'); await player.click('#end-yes');
  await friend.waitForFunction(() => /ended the session/.test(document.getElementById('join-status').textContent), null, { timeout: 15000 });
  check('player ends: friend is told', /ended the session/.test(await friend.textContent('#join-status')));
  check('player ends: back to the start screen, no End button', await player.evaluate(() => !document.getElementById('step-role').hidden && document.getElementById('end').hidden));
  check('friend after end: no End button', await friend.evaluate(() => document.getElementById('end').hidden));
  check('phases after the player ends: both idle', await phase(player) === 'idle' && await phase(friend) === 'idle');

  // reshare and rejoin works
  await player.click('#go-share');
  await player.click('.pick:not(.skel)');
  await player.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('code').textContent), null, { timeout: 15000 });
  const code2 = await player.textContent('#code');
  await friend.fill('#join-code', `Join my session: https://x.github.io/gameguide/join/?code=${code2.toLowerCase()} or type ${code2}`);
  check('pasting a whole invite extracts the code', await friend.inputValue('#join-code') === code2);
  await friend.screenshot({ path: '/tmp/claude-0/ui-join-otp.png' });
  await friend.click('#join-btn');
  check('reshare + rejoin works', await friend.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 30000 }).then(() => true, () => false), code2);
  // friend ends -> player waits again
  await friend.click('#end'); await friend.click('#end-yes');
  const left = await player.waitForFunction(() => /left/.test(document.getElementById('share-status').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  check('friend leaves: player waits for someone new', left && await player.evaluate(() => !document.getElementById('invite-wrap').hidden && !document.getElementById('end').hidden), await player.textContent('#share-status'));
  check('friend leaves: phases host.waiting / idle', await phase(player) === 'host.waiting' && await phase(friend) === 'idle');

  // Expected noise: the wrong-code lookup and torn-down test connections.
  const real = errors.filter((e) => !/PeerJS|WebSocket|Refused to connect to 'data:/.test(e));
  check('no page errors', !real.length, real.slice(0, 3).join(' | '));
  await browser.close();
  srv.close(); ps.close && ps.close();
  r.finish();
})().catch((e) => { check('test ran to the end', false, String(e && e.message || e).split('\n')[0].slice(0, 300)); r.finish(); });
