'use strict';
// The Windows update helper: a small .cmd script that waits for the old app to
// close, mirrors the new files over it, and starts the new version.
// Kept free of Electron so the release build can test it on a real Windows
// machine (scripts/check-windows.cjs).
const path = require('path');
const { spawn } = require('child_process');

// opts: { pid, current, fresh, staging, work, exeName, log, waitSeconds }
function windowsSwapScript(o) {
  const waitSeconds = o.waitSeconds || 20;
  const exe = path.join(o.current, o.exeName);
  const q = (s) => `"${s}"`;
  // Space before >> matters: "code 8>>" would redirect handle 8 instead of writing.
  // No parentheses in messages: they would end an if ( ... ) block early.
  const say = (msg) => `echo %date% %time% ${msg} >> ${q(o.log)}`;
  return [
    '@echo off',
    // Work from outside the temp folder, or Windows can't delete it at the end.
    `cd /d ${q(path.dirname(o.work))}`,
    `echo.> ${q(o.log)}`,
    say(`updating, waiting for old app pid ${o.pid} to close`),
    'set /a n=0',
    ':wait',
    `tasklist /FI "PID eq ${o.pid}" 2>NUL | find "${o.pid}" >NUL`,
    'if errorlevel 1 goto gone',
    'set /a n+=1',
    // Never wait forever: if the old app is stuck, close it ourselves.
    `if %n% GEQ ${waitSeconds} goto force`,
    'ping -n 2 127.0.0.1 >NUL',
    'goto wait',
    ':force',
    say(`old app still running after ${waitSeconds} s, force closing it`),
    `taskkill /F /T /PID ${o.pid} >NUL 2>&1`,
    ':gone',
    // Leftover helper processes (GPU, renderer) would keep files locked.
    `taskkill /F /IM ${q(o.exeName)} >NUL 2>&1`,
    'ping -n 2 127.0.0.1 >NUL',
    say('copying new files'),
    // Mirror the new build over the old folder (keeps the folder path the same).
    `robocopy ${q(o.fresh)} ${q(o.current)} /MIR /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >NUL`,
    `if errorlevel 8 ( ${say('copy had errors, robocopy code %errorlevel%')} ) else ( ${say('copy ok')} )`,
    `rmdir /S /Q ${q(o.staging)}`,
    say('starting new version'),
    // Start the new version in its own folder (not in the temp folder).
    `start "" /D ${q(o.current)} ${q(exe)}`,
    `rmdir /S /Q ${q(o.work)}`,
  ].join('\r\n');
}

// Runs a .cmd with no window at all (see native.js runHidden). Falls back to
// spawn, which works but can flash console windows.
function runCmdHidden(script, cwd, native) {
  const cmd = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  try {
    return { pid: native.runHidden(cmd, `"${cmd}" /d /s /c ""${script}""`, cwd), hidden: true };
  } catch (e) {
    const child = spawn(cmd, ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { pid: child.pid, hidden: false, error: e.message };
  }
}

module.exports = { windowsSwapScript, runCmdHidden };
