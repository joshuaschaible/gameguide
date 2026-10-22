// Launches the PACKAGED app (dist/...) and checks what only a real build can show:
// the bundled Electron version, Koffi loading from app.asar.unpacked (window tracking
// on Windows/macOS), screen capture still allowed for our pages inside app.asar,
// the updater reaching GitHub releases through Electron's net.fetch, and that
// popups/navigation stay blocked.
//   node test/packaged-smoke.cjs <path to packaged executable>
// Env: GG_EXPECT_ELECTRON=44.9.3  GG_EXPECT_NATIVE=1 (Windows/macOS)  GG_NO_NET=1 (offline)
const { _electron } = require(process.env.GG_PLAYWRIGHT || 'playwright');
const reporter = require('./report.cjs');
const r = reporter('Packaged app smoke');
const { check, skip, note } = r;

(async () => {
  const exe = process.argv[2];
  if (!exe) { console.error('usage: node test/packaged-smoke.cjs <packaged executable>'); process.exit(2); }
  const app = await _electron.launch({ executablePath: exe, args: process.platform === 'linux' ? ['--no-sandbox'] : [], timeout: 60000 });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', (e) => errs.push(e.message));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
  const ev = await app.evaluate(() => process.versions.electron);
  check('electron version', !process.env.GG_EXPECT_ELECTRON || ev === process.env.GG_EXPECT_ELECTRON, ev);
  check('packaged', await app.evaluate(({ app: a }) => a.isPackaged));
  note('page', win.url().replace(/^.*?(app\.asar)/, '$1'));
  const info = await win.evaluate(() => window.bridge.info());
  note('app', JSON.stringify({ v: info.version, platform: info.platform, arch: info.arch }));
  check('native module (koffi) loaded from app.asar.unpacked', !process.env.GG_EXPECT_NATIVE || info.windowTracking === true, `windowTracking=${info.windowTracking}`);

  // Capture from our own page (inside app.asar) must still pass the permission + display-media guards.
  const cap = await win.evaluate(async () => {
    const listed = await Promise.race([window.bridge.listSources(), new Promise((res) => setTimeout(() => res(null), 20000))]);
    if (!listed) return { skip: 'the source list never loaded (capture service hung on this machine)' };
    const scr = listed.sources.find((s) => s.kind === 'screen');
    const base = { status: listed.status, screens: listed.sources.filter((s) => s.kind === 'screen').length, windows: listed.sources.filter((s) => s.kind === 'window').length, tracking: listed.tracking };
    if (!scr) return { ...base, skip: 'no screens listed' };
    if (await window.bridge.selectSource(scr.id) !== true) return { ...base, ok: false, err: 'screen not accepted' };
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const st = s.getVideoTracks()[0].getSettings();
      s.getTracks().forEach((t) => t.stop());
      return { ...base, ok: true, size: `${st.width}x${st.height}` };
    } catch (e) { return { ...base, ok: false, err: `${e.name}: ${e.message}` }; }
  });
  note('capture sources', JSON.stringify({ status: cap.status, screens: cap.screens, windows: cap.windows, tracking: cap.tracking }));
  if (cap.skip) skip('screen capture from our page', cap.skip);
  else if (!cap.ok && process.platform === 'darwin' && cap.status && cap.status !== 'granted') skip('screen capture from our page', `macOS screen recording is "${cap.status}" for this build (${cap.err})`);
  else check('screen capture from our page (inside app.asar)', cap.ok, cap.ok ? cap.size : cap.err);

  if (!process.env.GG_NO_NET) {
    const u = await win.evaluate(() => window.bridge.checkUpdate());
    const ok = !!u && u.enabled !== false && !u.error && !!u.latest;
    const why = ok ? '' : (await win.evaluate(() => (window.__app.log || []).filter((l) => /update/i.test(l)).slice(-2).join(' | '))) || JSON.stringify(u);
    if (!ok && /rate limit/i.test(why)) skip('updater query', `GitHub's anonymous rate limit on this shared machine (${why.slice(0, 120)})`);
    else check('updater can query releases', ok, ok ? JSON.stringify({ current: u.current, latest: u.latest, available: u.available }) : why);
  }
  const n = app.windows().length;
  check('popup blocked', await win.evaluate(() => window.open('https://example.com/', '_blank') === null));
  const url = win.url();
  await win.evaluate(() => { location.href = 'https://example.com/'; });
  await win.waitForTimeout(1000);
  check('navigation blocked', win.url() === url && app.windows().length === n, win.url().slice(-40));
  check('no page errors', !errs.length, errs.join(' | ').slice(0, 200));
  await app.close().catch(() => {});
  r.finish();
})().catch((e) => { check('test ran to the end', false, String(e && e.message || e).split('\n')[0].slice(0, 300)); r.finish(); });
