// The updater state machine (UPDATE in app/machines.js) in real Electron,
// against a fake GitHub on localhost (GG_UPDATE_API):
//  - one install at a time,
//  - a check during an install neither asks GitHub nor re-offers "Update now",
//  - a broken download ends in "failed" (never a half-installed app),
//  - the next check offers the update again.
// The download is garbage on purpose, so nothing is ever unpacked or swapped.
//   node test/update-race.cjs        (Linux: xvfb-run -a node test/update-race.cjs)
const { _electron } = require('playwright');
const http = require('http');
const path = require('path');
const reporter = require('./report.cjs');
const r = reporter('Updater state machine (fake GitHub)');
const { check, note } = r;

const SIZE = 400000;
let releaseHits = 0;
const srv = http.createServer((req, res) => {
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(req.url)) {
    releaseHits++;
    const base = `http://127.0.0.1:${srv.address().port}`;
    const asset = (name) => ({ name, browser_download_url: `${base}/dl/${name}`, size: SIZE });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v99.0.0', body: 'test release', html_url: base, assets: ['Game-Guide-Windows-v99.0.0.zip', 'Game-Guide-Mac-v99.0.0.zip'].map(asset) }));
    return;
  }
  if (req.url.startsWith('/dl/')) {
    // ~2.5 s of download, then the bytes are not a zip.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SIZE) });
    let sent = 0;
    const t = setInterval(() => {
      const chunk = Buffer.alloc(SIZE / 10, 7);
      res.write(chunk);
      sent += chunk.length;
      if (sent >= SIZE) { clearInterval(t); res.end(); }
    }, 250);
    req.on('close', () => clearInterval(t));
    return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(__dirname, '..', 'app')],
    env: { ...process.env, GG_UPDATE_API: `http://127.0.0.1:${srv.address().port}` },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { window.__upd = []; window.bridge.onUpdate((u) => window.__upd.push(u.state)); });
  const state = () => app.evaluate(() => global.__gg.machines.update.state);

  const u1 = await win.evaluate(() => window.bridge.checkUpdate());
  check('check finds the newer version', u1.state === 'available' && u1.latest === '99.0.0', JSON.stringify({ state: u1.state, latest: u1.latest }));
  await win.evaluate(() => { localStorage.setItem('app.onboarded', 'true'); const d = document.getElementById('welcome'); if (d.open) d.close(); });
  check('the bar offers "Update now"', await win.evaluate(() => !document.getElementById('update-bar').hidden && !document.getElementById('update-btn').hidden));

  await win.click('#update-btn'); // the real button, like a player would
  await win.waitForTimeout(700);
  check('install starts downloading', await state() === 'downloading', await state());
  const second = await win.evaluate(() => window.bridge.installUpdate());
  check('a second install is refused while one runs', second && second.ok === false && /already/i.test(second.error), JSON.stringify(second));
  const hits = releaseHits;
  const mid = await win.evaluate(() => window.bridge.checkUpdate());
  check('a check during the install neither asks GitHub nor re-offers', mid.state === 'downloading' && releaseHits === hits, `state ${mid.state}, GitHub asked ${releaseHits - hits}x`);
  await win.waitForTimeout(300);
  check('the bar shows progress, not "Update now"', await win.evaluate(() => document.getElementById('update-btn').hidden && /Downloading/.test(document.getElementById('update-text').textContent)),
    await win.evaluate(() => document.getElementById('update-text').textContent));

  const failed = await win.waitForFunction(() => document.getElementById('update-bar').classList.contains('bad'), null, { timeout: 20000 }).then(() => true, () => false);
  check('a broken download ends in "failed"', failed && await state() === 'failed', await state());
  check('the bar explains the problem', await win.evaluate(() => /Update problem/.test(document.getElementById('update-text').textContent)),
    await win.evaluate(() => document.getElementById('update-text').textContent.slice(0, 120)));
  check('nothing resumes after a failed install', await win.evaluate(() => localStorage.getItem('app.resume') === null));

  const again = await win.evaluate(() => window.bridge.checkUpdate());
  check('the next check offers the update again', again.state === 'available');
  const seen = await win.evaluate(() => window.__upd);
  note('statuses pushed to the page', seen.filter((x, i) => x !== seen[i - 1]).join(' > '));
  const during = seen.slice(seen.indexOf('downloading'), seen.indexOf('failed'));
  check('"available" is never pushed while installing', seen.includes('downloading') && !during.includes('available'), during.filter((x, i) => x !== during[i - 1]).join(' > '));
  const hist = await app.evaluate(() => global.__gg.machines.update.snapshot(40).history.filter((h) => !h.ignored).map((h) => h.to));
  note('update machine path', hist.filter((x, i) => x !== hist[i - 1]).join(' > '));

  await app.close().catch(() => {});
  srv.close();
  r.finish();
})().catch((e) => { check('test ran to the end', false, String(e && e.message || e).split('\n')[0].slice(0, 300)); srv.close(); r.finish(); });
