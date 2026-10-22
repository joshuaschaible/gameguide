// Launches the PACKAGED app (dist/...) and checks what only a real build can show:
// the bundled Electron version, Koffi loading from app.asar.unpacked (window tracking
// on Windows/macOS), the updater reaching GitHub releases through Electron's net.fetch,
// and that popups/navigation stay blocked.
//   node test/packaged-smoke.cjs <path to packaged executable>
// Env: GG_EXPECT_ELECTRON=44.9.3  GG_EXPECT_NATIVE=1 (Windows/macOS)  GG_NO_NET=1 (offline)
const { _electron } = require(process.env.GG_PLAYWRIGHT || 'playwright');
(async () => {
  const exe = process.argv[2];
  if (!exe) { console.error('usage: node test/packaged-smoke.cjs <packaged executable>'); process.exit(2); }
  const fails = [];
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) fails.push(name); };
  const app = await _electron.launch({ executablePath: exe, args: process.platform === 'linux' ? ['--no-sandbox'] : [], timeout: 60000 });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', (e) => errs.push(e.message));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
  const ev = await app.evaluate(() => process.versions.electron);
  check('electron version', !process.env.GG_EXPECT_ELECTRON || ev === process.env.GG_EXPECT_ELECTRON, ev);
  check('packaged', await app.evaluate(({ app: a }) => a.isPackaged));
  const info = await win.evaluate(() => window.bridge.info());
  console.log('info:', JSON.stringify({ v: info.version, platform: info.platform, arch: info.arch, windowTracking: info.windowTracking }));
  check('native module (koffi) loaded', !process.env.GG_EXPECT_NATIVE || info.windowTracking === true, `windowTracking=${info.windowTracking}`);
  if (!process.env.GG_NO_NET) {
    const u = await win.evaluate(() => window.bridge.checkUpdate());
    const ok = !!u && u.enabled !== false && !u.error && !!u.latest;
    const why = ok ? '' : (await win.evaluate(() => (window.__app.log || []).filter((l) => /update/i.test(l)).slice(-2).join(' | '))) || JSON.stringify(u);
    if (!ok && /rate limit/i.test(why)) console.log(`SKIP updater query: GitHub's anonymous rate limit on this shared machine (${why.slice(0, 120)})`);
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
  if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
