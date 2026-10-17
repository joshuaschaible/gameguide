// Runs on the Windows build machine before packaging. Proves the updater's
// hidden helper launch works: starts a .cmd script with no window (the same
// way the updater does) that uses the same console tools as the real swap
// script, then checks it finished. Fails the release if it doesn't.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const native = require('../app/native.js');

if (process.platform !== 'win32') { console.log('not Windows, skipping'); process.exit(0); }
if (!native.available()) { console.error('native module failed to load:', native.error()); process.exit(1); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gg check '));
const src = path.join(work, 'from');
const dst = path.join(work, 'to');
fs.mkdirSync(src);
fs.mkdirSync(dst);
fs.writeFileSync(path.join(src, 'new.txt'), 'new');
fs.writeFileSync(path.join(dst, 'old.txt'), 'old');
const done = path.join(work, 'done.txt');
const script = path.join(work, 'swap test.cmd');
fs.writeFileSync(script, [
  '@echo off',
  `tasklist /FI "PID eq ${process.pid}" 2>NUL | find "${process.pid}" >NUL`,
  'if errorlevel 1 ( echo noparent> "%~dp0done.txt" & exit /b 1 )',
  'ping -n 2 127.0.0.1 >NUL',
  `robocopy "${src}" "${dst}" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >NUL`,
  `echo ok> "${done}"`,
].join('\r\n'));

const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const pid = native.runHidden(cmd, `"${cmd}" /d /s /c ""${script}""`, work);
console.log('helper pid', pid);

const until = Date.now() + 20000;
(function wait() {
  if (fs.existsSync(done)) {
    const out = fs.readFileSync(done, 'utf8').trim();
    const mirrored = fs.existsSync(path.join(dst, 'new.txt')) && !fs.existsSync(path.join(dst, 'old.txt'));
    console.log('helper said:', out, '| mirrored:', mirrored);
    if (out !== 'ok' || !mirrored) process.exit(1);
    console.log('hidden helper launch OK');
    process.exit(0);
  }
  if (Date.now() > until) { console.error('helper never finished'); process.exit(1); }
  setTimeout(wait, 250);
})();
