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
  console.log('version text:', await win.textContent('#version'));
  await win.evaluate(() => { localStorage.setItem('app.onboarded', 'true'); const d = document.getElementById('welcome'); if (d.open) d.close(); });
  if (await win.isVisible('#step-name')) { await win.fill('#name', 'Tester'); await win.click('#name-form button'); }
  await win.click('#go-share');
  await win.waitForSelector('.source', { timeout: 15000 }).catch(() => {});
  console.log('sources html:', (await win.innerHTML('#sources')).slice(0, 200));
  const n = await win.locator('.source').count();
  console.log('source buttons', n);
  if (n) {
    await win.click('.source');
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
