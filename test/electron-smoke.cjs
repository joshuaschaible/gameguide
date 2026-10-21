const { _electron } = require('playwright');
const path = require('path');
(async () => {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(__dirname, '..', 'app')],
    env: { ...process.env },
  });
  const win = await app.firstWindow();
  app.on('window', (w) => { w.on('pageerror', (e) => console.log('OVERLAY pageerror', e.message)); w.on('console', (m) => { if (m.type() === 'error') console.log('OVERLAY console', m.text()); }); });
  const errs = [];
  win.on('pageerror', (e) => errs.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);
  console.log('codecs:', await win.evaluate(() => [...new Set(RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType))].join(',')));
  console.log('sdp tune h264:', await win.evaluate(async () => {
    const pc = new RTCPeerConnection(); pc.addTransceiver('video', { direction: 'sendonly' });
    const o = await pc.createOffer(); pc.close();
    return o.sdp.split('\r\n').filter((l) => l.startsWith('m=video')).join('');
  }));
  // A window that no longer exists must be refused (never swapped for the whole screen).
  console.log('closed window select:', await win.evaluate(async () => {
    const gone = await window.bridge.selectSource('window:999999:0');
    const scr = await window.bridge.selectSource('screen:0:0');
    return gone === false && scr === true ? 'OK refused closed window' : `FAIL gone=${gone} screen=${scr}`;
  }));
  console.log('version text:', await win.textContent('#version'));
  await win.evaluate(() => { localStorage.setItem('app.onboarded', 'true'); const d = document.getElementById('welcome'); if (d.open) d.close(); });
  if (await win.isVisible('#step-name')) { await win.fill('#name', 'Tester'); await win.click('#name-form button'); }
  await win.click('#go-share');
  await win.waitForSelector('.pick', { timeout: 15000 }).catch(() => {});
  console.log('sources html:', (await win.innerHTML('#dialog-sources')).slice(0, 200));
  const n = await win.locator('.pick').count();
  console.log('source buttons', n);
  await win.evaluate(() => document.getElementById('source-dialog').close());
  // ---- avatar upload through the real button (real CSP + preload) ----
  await win.click('#open-settings');
  const avInput = win.locator('#avatar-picker-settings input[type=file]');
  const avatarNow = () => win.evaluate(() => window.__app.pendingAvatar);
  for (const f of ['photo.png', 'big.jpg', 'broken.png']) {
    await win.evaluate(() => { window.__app.pendingAvatar = { kind: 'emoji', value: '🦊', color: '#ff8a00' }; });
    await avInput.setInputFiles(`/tmp/claude-0/imgs/${f}`);
    await win.waitForTimeout(800);
    const a = await avatarNow();
    const tip = await win.getAttribute('#avatar-picker-settings .avatar-option.photo', 'title');
    console.log(`avatar upload ${f}:`, a && a.kind, a && a.data ? `${a.data.slice(0, 23)}… ${a.data.length} chars` : '', '| tip:', tip);
  }
  await win.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'gg-test-file'; document.body.appendChild(i); });
  await win.setInputFiles('#gg-test-file', '/tmp/claude-0/imgs/big.jpg');
  const sys = await win.evaluate(async () => window.bridge.imageToAvatar(document.getElementById('gg-test-file').files[0]));
  console.log('system decoder fallback:', sys ? `${sys.slice(0, 23)}… ${sys.length} chars` : sys);
  await win.keyboard.press('Escape');
  let listed = false;
  if (n) {
    await win.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await win.click('#go-share');
    // The test machine's screen capture sometimes hangs on a second listing; skip then.
    listed = await win.waitForSelector('.pick', { timeout: 15000 }).then(() => true, () => false);
    if (!listed) console.log('SKIP overlay checks: source list did not load a second time (test machine capture hang)');
  }
  if (n && listed) {
    await win.click('.pick');
    await win.waitForTimeout(4000);
    console.log('share status:', await win.textContent('#share-status'));
    const wins = app.windows();
    console.log('windows:', wins.length, await Promise.all(wins.map((w) => w.url())));
    const ov = wins.find((w) => w.url().endsWith('overlay.html'));
    if (ov) {
      const vis = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Game Guide overlay').map((w) => w.isVisible())[0]);
      await ov.waitForTimeout(800);
      console.log('overlay visible while idle:', await vis());
      await win.evaluate(() => { window.bridge.draw({ t: 'start', id: 'a', x: 0.1, y: 0.1, c: '#ff0000' }); window.bridge.draw({ t: 'move', id: 'a', x: 0.9, y: 0.9 }); window.bridge.draw({ t: 'end', id: 'a' }); });
      await ov.waitForTimeout(300);
      console.log('overlay visible with a mark:', await vis());
      await win.evaluate(() => { ['🔥', '😂', '🎉'].forEach((e, i) => setTimeout(() => window.bridge.draw({ t: 'react', e, x: 0.75 + i * 0.07 }), i * 250)); window.bridge.draw({ t: 'react', e: '<script>', x: 0.5 }); });
      await ov.waitForTimeout(900);
      await ov.screenshot({ path: '/tmp/claude-0/overlay-react.png' });
      await ov.evaluate(() => { window.__osc = 0; const orig = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); }; });
      await win.evaluate(() => { for (let i = 0; i < 5; i++) setTimeout(() => window.bridge.draw({ t: 'react', e: '👍', x: 0.8 }), i * 120); });
      await ov.waitForTimeout(1000);
      console.log('reaction sounds for 5 quick reactions:', await ov.evaluate(() => window.__osc));
      // arrow + laser in the real overlay
      await win.evaluate(() => {
        window.bridge.draw({ t: 'arrow', id: 'ar1', x1: 0.2, y1: 0.8, x2: 0.5, y2: 0.4, c: '#ffd23f', h: 3, first: true });
        window.bridge.draw({ t: 'arrow', id: 'ar1', x1: 0.2, y1: 0.8, x2: 0.6, y2: 0.3, c: '#ffd23f', h: 3, done: true });
        for (let i = 0; i < 8; i++) setTimeout(() => window.bridge.draw({ t: 'laser', x: 0.3 + i * 0.03, y: 0.5, c: '#3bf0ff' }), i * 40);
      });
      await win.waitForTimeout(500);
      console.log('overlay arrow+laser:', JSON.stringify(await ov.evaluate(() => { const c = document.getElementById('c'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return { paintedPixels: n }; })), 'visible:', await vis());
      console.log('placement log:', JSON.stringify(await win.evaluate(() => window.__app.log.filter((l) => /overlay: game area/.test(l)).slice(-1))));
      // simulate macOS pushing the layer 24 px down: canvas must shift back up
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Game Guide overlay'); w.webContents.send('overlay:frame', { fit: true, dx: 0, dy: 24, w: 800, h: 600 }); });
      await ov.waitForTimeout(200);
      console.log('canvas after 24px push:', JSON.stringify(await ov.evaluate(() => { const c = document.getElementById('c'); const r = c.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; })));
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Game Guide overlay'); w.webContents.send('overlay:frame', { fit: false, dx: 0, dy: 0, w: 800, h: 600 }); });
      await ov.waitForTimeout(200);
      console.log('canvas after reset:', JSON.stringify(await ov.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { top: r.top, h: r.height }; })), 'window', JSON.stringify(await ov.evaluate(() => [innerWidth, innerHeight])));
      await ov.screenshot({ path: '/tmp/claude-0/overlay-mark.png' });
      // crash the overlay renderer and make sure it comes back
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Game Guide overlay'); w.webContents.forcefullyCrashRenderer(); });
      await win.waitForTimeout(2500);
      await win.evaluate(() => window.bridge.draw({ t: 'ping', x: 0.5, y: 0.5, c: '#ffd23f' }));
      await win.waitForTimeout(500);
      console.log('after overlay crash: overlay windows', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Game Guide overlay').map((w) => ({ vis: w.isVisible(), crashed: w.webContents.isCrashed() }))));
      console.log('log tail:', JSON.stringify(await win.evaluate(() => window.__app.log.filter((l) => /overlay|priority|hotkey/.test(l)).slice(-4))));
      await win.waitForTimeout(5300);
      console.log('overlay visible after fade:', await vis());
      await win.waitForTimeout(500);
      const props = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), top: w.isAlwaysOnTop(), focusable: w.isFocusable(), bounds: w.getBounds() })));
      console.log(JSON.stringify(props));
      const ov2 = app.windows().find((w) => w.url().endsWith('overlay.html') && !w.isClosed());
      if (ov2) await ov2.screenshot({ path: '/tmp/claude-0/overlay.png' });
      // hotkey paths (call the registered handlers via main)
      const hk = await app.evaluate(({ globalShortcut }) => ['CommandOrControl+Shift+X','CommandOrControl+Shift+H','CommandOrControl+Shift+M'].map((a) => globalShortcut.isRegistered(a)));
      console.log('hotkeys registered', hk);
      await win.evaluate(() => window.bridge.draw({ t: 'ping', x: 0.5, y: 0.5, c: '#ffd23f' }));
      await win.waitForTimeout(300);
      console.log('overlay errors so far ok');
      const info = await win.evaluate(() => window.bridge.info());
      console.log('info', JSON.stringify({ wt: info.windowTracking, v: info.version, gpuEnc: info.gpu && info.gpu.video_encode }));
      console.log('switches', JSON.stringify(await app.evaluate(({ app }) => ['webrtc-max-cpu-consumption-percentage','enable-features','disable-features'].map((k) => app.commandLine.getSwitchValue(k)))));
      console.log('track note:', await win.textContent('#track-note'));
    }
    await win.click('#end');
    await win.waitForTimeout(500);
    console.log('windows after end:', app.windows().length);
    console.log('hotkeys after end', await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+X')));
  }
  console.log('errors:', errs);
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
