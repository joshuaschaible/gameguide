// Runs on the Windows build machine before packaging. Fails the release if
// the updater's file-swap helper doesn't work. It runs the real helper script
// (app/swapscript.js), started with no window exactly like the app does,
// against a fake "old app" process that refuses to close, and checks that the
// helper force-closes it, mirrors the new files, starts the new version and
// writes its log.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const native = require('../app/native.js');
const { windowsSwapScript, runCmdHidden } = require('../app/swapscript.js');
const BRAND = require('../app/brand.json');

if (process.platform !== 'win32') { console.log('not Windows, skipping'); process.exit(0); }
if (!native.available()) { console.error('native module failed to load:', native.error()); process.exit(1); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg check '));
const exeName = `${BRAND.name}.exe`;
const current = path.join(root, 'installed', BRAND.name); // path with spaces, like a real install
const work = path.join(root, 'work dir');
const staging = path.join(work, 'unpacked');
const fresh = path.join(staging, BRAND.name);
const log = path.join(root, 'update.log');
const marker = path.join(root, 'new-version-started.txt');
fs.mkdirSync(current, { recursive: true });
fs.mkdirSync(fresh, { recursive: true });
fs.writeFileSync(path.join(current, 'old-only.txt'), 'old');
fs.writeFileSync(path.join(fresh, 'new-only.txt'), 'new');
// The "new version": a harmless system exe under the app's name. A marker
// line added just before `start` shows the helper got that far.
fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(fresh, exeName));

// The stuck old app: a node process that ignores everything until killed.
const stuck = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
console.log('fake stuck app pid', stuck.pid);

fs.mkdirSync(work, { recursive: true });
const script = path.join(work, 'swap.cmd');
fs.writeFileSync(script, windowsSwapScript({ pid: stuck.pid, current, fresh, staging, work, exeName, log, waitSeconds: 4 })
  .replace('start "" ', `echo started> "${marker}"\r\nstart "" `));
const r = runCmdHidden(script, work, native);
console.log('helper', r);
if (!r.hidden) { console.error('hidden launch failed, fell back to spawn:', r.error); process.exit(1); }

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const until = Date.now() + 60000;
(function wait() {
  if (fs.existsSync(marker)) { setTimeout(finish, 2000); return; }
  if (Date.now() > until) {
    console.error('helper never finished. log so far:\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(none)'));
    try { stuck.kill(); } catch { /* ignore */ }
    process.exit(1);
  }
  setTimeout(wait, 250);
})();

function finish() {
  {
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    console.log('helper log:\n' + text);
    const checks = {
      stuckAppClosed: !alive(stuck.pid),
      forcedAfterTimeout: /force closing/.test(text),
      newFilesIn: fs.existsSync(path.join(current, 'new-only.txt')) && fs.existsSync(path.join(current, exeName)),
      oldFilesGone: !fs.existsSync(path.join(current, 'old-only.txt')),
      copyOk: /copy ok/.test(text),
      started: /starting new version/.test(text),
      cleanedUp: !fs.existsSync(work),
    };
    console.log(checks);
    if (Object.values(checks).every(Boolean)) { console.log('update helper OK'); process.exit(0); }
    process.exit(1);
  }
}
