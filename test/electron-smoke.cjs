// Real-Electron smoke test (runs the app from source):
// security guards, capture through the display-media handler, the overlay
// (marks, arrow, cursor, crash recovery, fade), hotkeys, avatar upload, clipboard.
//   node test/electron-smoke.cjs        (Linux: xvfb-run -a node test/electron-smoke.cjs)
// Env: GG_EXPECT_ELECTRON=44.9.3  GG_EXPECT_NATIVE=1 (Windows/macOS)  GG_NO_NET=1 (offline)
const { _electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reporter = require('./report.cjs');
const IMGS = process.env.GG_TEST_IMGS || path.join(__dirname, 'fixtures'); // avatar upload test images
const SHOTS = process.env.GG_SHOTS || path.join(os.tmpdir(), 'gg-smoke');
const r = reporter('Electron smoke (from source)');
const { check, skip, note } = r;

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
  const appLog = (re) => win.evaluate((src) => (window.__app.log || []).filter((l) => new RegExp(src).test(l)), re.source);

  // ---- runtime ----
  const ev = await app.evaluate(() => process.versions.electron);
  check('electron version', !process.env.GG_EXPECT_ELECTRON || ev === process.env.GG_EXPECT_ELECTRON, `${ev}, node ${await app.evaluate(() => process.versions.node)}, chrome ${await app.evaluate(() => process.versions.chrome)}`);
  note('video codecs', await win.evaluate(() => [...new Set(RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType.replace('video/', '')))].join(',')));
  const info0 = await win.evaluate(() => window.bridge.info());
  // Windows/macOS: the Koffi native module must load inside this Electron (window tracking, EcoQoS, hidden updater helper).
  check('native module (koffi) loaded', !process.env.GG_EXPECT_NATIVE || info0.windowTracking === true, `windowTracking=${info0.windowTracking}`);
  if (!process.env.GG_NO_NET) {
    const u = await win.evaluate(() => window.bridge.checkUpdate());
    if (u && u.enabled === false) skip('updater query', 'updates are off when running from source (covered by test/packaged-smoke.cjs)');
    else check('updater can query releases', !!u && !u.error && u.latest !== undefined, JSON.stringify(u).slice(0, 160));
  }

  // ---- capture source selection: a closed window is refused, never swapped for the whole screen ----
  const gone = await win.evaluate(() => window.bridge.selectSource('window:999999:0'));
  check('closed window refused (no whole-screen fallback)', gone === false, `selectSource=${gone}`);
  check('screen source accepted', await win.evaluate(() => window.bridge.selectSource('screen:0:0')) === true);

  // ---- security guards ----
  const before = app.windows().length;
  check('popup blocked (window.open)', await win.evaluate(() => window.open('https://example.com/', '_blank') === null));
  await win.evaluate(() => { const a = document.createElement('a'); a.href = 'https://example.com/'; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove(); });
  await win.waitForTimeout(400);
  check('no popup window opened (target=_blank link)', app.windows().length === before, `${app.windows().length} windows`);
  await win.evaluate(() => window.bridge.copy('gg-clip-check-44'));
  check('clipboard roundtrip (async clipboard)', await win.evaluate(() => window.bridge.paste()) === 'gg-clip-check-44');
  // A page we didn't ship (a file:// page outside app/renderer) must not get screen capture,
  // even right after the player picked a source above.
  const foreign = path.join(os.tmpdir(), `gg-foreign-${process.pid}.html`);
  fs.writeFileSync(foreign, '<!doctype html><title>not ours</title><p>not ours</p>');
  const foreignRes = await app.evaluate(async ({ BrowserWindow }, file) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await w.loadFile(file);
      const js = `(async () => {
        const out = { secure: isSecureContext };
        try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); out.capture = 'GOT STREAM'; } catch (e) { out.capture = 'denied: ' + e.name; }
        try { out.perm = (await navigator.permissions.query({ name: 'camera' })).state; } catch (e) { out.perm = 'error: ' + e.name; }
        out.popup = window.open('https://example.com/') === null ? 'blocked' : 'OPENED';
        return out;
      })()`;
      return await w.webContents.executeJavaScript(js, true);
    } finally { w.destroy(); }
  }, foreign);
  fs.rmSync(foreign, { force: true });
  check('screen capture denied to a page we did not ship', foreignRes.secure === true && /^denied/.test(foreignRes.capture), JSON.stringify(foreignRes));
  check('permission checks denied to a page we did not ship', foreignRes.perm === 'denied', `camera=${foreignRes.perm}`);
  check('popup blocked on a page we did not ship', foreignRes.popup === 'blocked');
  note('version text', await win.textContent('#version'));

  // ---- avatar upload through the real button (real CSP + preload) ----
  await win.evaluate(() => { localStorage.setItem('app.onboarded', 'true'); const d = document.getElementById('welcome'); if (d.open) d.close(); });
  if (await win.isVisible('#step-name')) { await win.fill('#name', 'Tester'); await win.click('#name-form button'); }
  await win.click('#me-btn');
  await win.click('#open-profile');
  const avInput = win.locator('#avatar-picker-settings input[type=file]');
  const want = { 'photo.png': 'photo', 'big.jpg': 'photo', 'broken.png': 'emoji' };
  for (const f of Object.keys(want)) {
    await win.evaluate(() => { window.__app.pendingAvatar = { kind: 'emoji', value: '🦊', color: '#ff8a00' }; });
    await avInput.setInputFiles(path.join(IMGS, f));
    await win.waitForTimeout(800);
    const a = await win.evaluate(() => window.__app.pendingAvatar);
    const ok = a && a.kind === want[f] && (want[f] !== 'photo' || /^data:image\/(jpeg|png|webp);base64,/.test(a.data));
    check(`avatar upload ${f} -> ${want[f]}`, ok, a && a.data ? `${a.data.length} chars` : a && a.kind);
  }
  await win.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'gg-test-file'; document.body.appendChild(i); });
  await win.setInputFiles('#gg-test-file', path.join(IMGS, 'big.jpg'));
  const sys = await win.evaluate(async () => window.bridge.imageToAvatar(document.getElementById('gg-test-file').files[0]));
  check('system image decoder fallback', typeof sys === 'string' && sys.startsWith('data:image/'), sys ? `${sys.length} chars` : String(sys));
  await win.keyboard.press('Escape');
  await win.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));

  // ---- share: one source listing, pick a screen, real capture through our display-media handler ----
  await win.click('#go-share');
  const listed = await win.waitForSelector('.picker:not(.loading), .picker-none', { timeout: 20000 }).then(() => true, () => false);
  const listLine = (await appLog(/sources: \d/)).slice(-1)[0] || '';
  note('source listing', listLine || 'no reply');
  const perm = (listLine.match(/screen permission: ([\w-]+)/) || [])[1];
  const counts = await win.evaluate(() => ({ picks: document.querySelectorAll('.pick:not(.skel)').length }));
  let shared = false;
  if (!listed) skip('capture + overlay', 'the source list never loaded (capture service hung on this machine)');
  else if (!counts.picks) skip('capture + overlay', `no sources to share (${listLine})`);
  else {
    if (await win.locator('[data-tab="screen"]').count()) await win.click('[data-tab="screen"]');
    const screens = await win.locator('.pick:not(.skel)').count();
    if (!screens) await win.click('[data-tab="window"]');
    note('picked', `${screens ? 'screen' : 'window'}: ${await win.getAttribute('.pick:not(.skel)', 'title')}`);
    await win.click('.pick:not(.skel)');
    const track = await win.waitForFunction(() => { const t = window.__app.stream && window.__app.stream.getVideoTracks()[0]; return t && t.readyState === 'live' && t.getSettings(); }, null, { timeout: 15000 }).then((h) => h.jsonValue(), () => null);
    const status = await win.textContent('#share-status');
    if (!track && process.platform === 'darwin' && perm && perm !== 'granted') skip('capture + overlay', `macOS screen recording is "${perm}" on this machine (${status})`);
    else {
      shared = check('capture starts (our page, display-media handler)', !!track, track ? `${track.width}x${track.height} @${Math.round(track.frameRate || 0)}fps` : status);
    }
  }
  if (shared) {
    await win.waitForTimeout(1500);
    const ovWin = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Game Guide overlay').map((w) => ({ vis: w.isVisible(), crashed: w.webContents.isCrashed(), top: w.isAlwaysOnTop(), focusable: w.isFocusable() })));
    const vis = async () => { const o = await ovWin(); return o.length ? o[0].vis : null; };
    const ov = app.windows().find((w) => w.url().endsWith('overlay.html'));
    check('overlay window created for the share', !!ov);
    if (ov) {
      check('overlay off screen while idle', await vis() === false);
      await win.evaluate(() => { window.bridge.draw({ t: 'start', id: 'a', x: 0.1, y: 0.1, c: '#ff0000' }); window.bridge.draw({ t: 'move', id: 'a', x: 0.9, y: 0.9 }); window.bridge.draw({ t: 'end', id: 'a' }); });
      await ov.waitForTimeout(400);
      check('overlay shows with a mark', await vis() === true);
      const o0 = (await ovWin())[0];
      check('overlay is always-on-top and not focusable', o0 && o0.top === true && o0.focusable === false, JSON.stringify(o0));
      await win.evaluate(() => { ['🔥', '😂', '🎉'].forEach((e, i) => setTimeout(() => window.bridge.draw({ t: 'react', e, x: 0.75 + i * 0.07 }), i * 250)); window.bridge.draw({ t: 'react', e: '<script>', x: 0.5 }); });
      await ov.waitForTimeout(900);
      await ov.screenshot({ path: path.join(SHOTS, 'overlay-react.png') });
      await ov.evaluate(() => { window.__osc = 0; const orig = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); }; });
      await win.evaluate(() => { for (let i = 0; i < 5; i++) setTimeout(() => window.bridge.draw({ t: 'react', e: '👍', x: 0.8 }), i * 120); });
      await ov.waitForTimeout(1000);
      note('reaction sounds for 5 quick reactions', await ov.evaluate(() => window.__osc));
      await win.evaluate(() => {
        window.bridge.draw({ t: 'arrow', id: 'ar1', x1: 0.2, y1: 0.8, x2: 0.5, y2: 0.4, c: '#ffd23f', h: 3, first: true });
        window.bridge.draw({ t: 'arrow', id: 'ar1', x1: 0.2, y1: 0.8, x2: 0.6, y2: 0.3, c: '#ffd23f', h: 3, done: true });
        for (let i = 0; i < 8; i++) setTimeout(() => window.bridge.draw({ t: 'laser', x: 0.3 + i * 0.03, y: 0.5, c: '#3bf0ff' }), i * 40);
      });
      await win.waitForTimeout(500);
      const px = await ov.evaluate(() => { const c = document.getElementById('c'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
      check('overlay paints marks, arrow and cursor', px > 0, `${px} painted pixels`);
      note('overlay placement', (await appLog(/overlay: game area/)).slice(-1)[0] || 'none logged');
      // macOS can push the layer below the menu bar: the canvas must shift back by the same amount.
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Game Guide overlay'); w.webContents.send('overlay:frame', { fit: true, dx: 0, dy: 24, w: 800, h: 600 }); });
      await ov.waitForTimeout(200);
      const pushed = await ov.evaluate(() => { const b = document.getElementById('c').getBoundingClientRect(); return { top: b.top, w: b.width, h: b.height }; });
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Game Guide overlay'); w.webContents.send('overlay:frame', { fit: false, dx: 0, dy: 0, w: 800, h: 600 }); });
      await ov.waitForTimeout(200);
      const reset = await ov.evaluate(() => document.getElementById('c').getBoundingClientRect().top);
      check('overlay corrects a system-moved layer', pushed.top === -24 && pushed.w === 800 && pushed.h === 600 && reset === 0, JSON.stringify({ pushed, reset }));
      await ov.screenshot({ path: path.join(SHOTS, 'overlay-mark.png') });
      // Crash the overlay renderer: it must come back and draw again.
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Game Guide overlay'); w.webContents.forcefullyCrashRenderer(); });
      await win.waitForTimeout(2500);
      await win.evaluate(() => window.bridge.draw({ t: 'ping', x: 0.5, y: 0.5, c: '#ffd23f' }));
      await win.waitForTimeout(500);
      const after = await ovWin();
      check('overlay recovers after a renderer crash', after.length === 1 && !after[0].crashed && after[0].vis === true, JSON.stringify(after));
      await win.waitForTimeout(5800);
      check('overlay leaves the screen after marks fade', await vis() === false);
      const hk = await app.evaluate(({ globalShortcut }) => ['CommandOrControl+Shift+X', 'CommandOrControl+Shift+H', 'CommandOrControl+Shift+M'].map((a) => globalShortcut.isRegistered(a)));
      check('hotkeys registered while sharing', hk.every(Boolean), JSON.stringify(hk));
      note('track note', await win.textContent('#track-note'));
    }
    await win.click('#end');
    await win.click('#end-yes');
    await win.waitForTimeout(800);
    check('ending closes the overlay', (await ovWin()).length === 0, `${app.windows().length} windows`);
    check('hotkeys released after ending', await app.evaluate(({ globalShortcut }) => !globalShortcut.isRegistered('CommandOrControl+Shift+X')));
  }

  // Last, because Playwright keeps waiting on a navigation that we block.
  const pageUrl = win.url();
  const nWin = app.windows().length;
  await win.evaluate(() => { location.href = 'https://example.com/'; });
  await win.waitForTimeout(800);
  await win.evaluate(() => { location.href = 'file:///etc/hostname'; });
  await win.waitForTimeout(800);
  check('navigation away from our pages blocked', win.url() === pageUrl && app.windows().length === nWin, win.url().replace(/^.*\/renderer\//, 'renderer/'));
  const real = errs.filter((e) => !/PeerJS|WebSocket connection|Lost connection|Establishing a tunnel/.test(e));
  check('no page errors', !real.length, real.join(' | ').slice(0, 200));
  await app.close().catch(() => {});
  r.finish();
})().catch((e) => { check('test ran to the end', false, String(e && e.message || e).split('\n')[0].slice(0, 300)); r.finish(); });
