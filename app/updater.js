'use strict';
// Self-updater for unsigned builds, using GitHub Releases.
//  1. check():   GET https://api.github.com/repos/<owner>/<repo>/releases/latest
//                newer tag than app.getVersion()? -> report the matching asset
//  2. install(): download the zip for this platform, unpack it next to the app,
//                hand off to a tiny script that waits for us to quit, swaps the
//                files in place and relaunches the new version.
// Release assets must be named (NAME = brand.json "name", spaces -> dashes):
//   <NAME>-Windows-v<version>.zip  (contains "<name>/<name>.exe ...")
//   <NAME>-Mac-v<version>.zip      (contains "<name>.app")
const { app, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const BRAND = require('./brand.json');
const CONFIG = BRAND.github || {};
const ASSET_PREFIX = BRAND.name.replace(/\s+/g, '-');
const UA = `${ASSET_PREFIX}-Updater`;

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function apiBase() {
  // GG_UPDATE_API lets tests point at a local fake GitHub.
  return process.env.GG_UPDATE_API || 'https://api.github.com';
}

function enabled() {
  if (!CONFIG.owner || !CONFIG.repo) return false;
  if (process.env.GG_UPDATE_API) return true;
  return app.isPackaged && (isMac || isWin);
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function assetName(version) {
  return `${ASSET_PREFIX}-${isMac ? 'Mac' : 'Windows'}-v${version}.zip`;
}

const cache = { etag: null, release: null };

async function check() {
  if (!enabled()) return { enabled: false, current: app.getVersion() };
  const url = `${apiBase()}/repos/${CONFIG.owner}/${CONFIG.repo}/releases/latest`;
  // ETag caching: unchanged answers come back as 304, which GitHub doesn't
  // count against the 60 checks/hour limit. That's what makes frequent checks safe.
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA };
  if (cache.etag && cache.release) headers['If-None-Match'] = cache.etag;
  const res = await net.fetch(url, { headers, cache: 'no-store' });
  let rel;
  if (res.status === 304 && cache.release) {
    rel = cache.release;
  } else {
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached, will retry later');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    rel = await res.json();
    cache.etag = res.headers.get('etag');
    cache.release = rel;
  }
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const current = app.getVersion();
  const out = { enabled: true, current, latest, notes: String(rel.body || '').slice(0, 2000), url: rel.html_url };
  if (!latest || cmpVersion(latest, current) <= 0) return { ...out, available: false };
  const asset = (rel.assets || []).find((a) => a.name === assetName(latest));
  if (!asset) return { ...out, available: false, missingAsset: assetName(latest) };
  return { ...out, available: true, asset: { name: asset.name, url: asset.browser_download_url, size: asset.size } };
}

async function download(asset, dest, onProgress) {
  const res = await net.fetch(asset.url, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    const now = Date.now();
    if (onProgress && now - lastReport > 200) { lastReport = now; onProgress(total ? got / total : 0); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (asset.size && got !== asset.size) throw new Error(`download incomplete (${got} of ${asset.size} bytes)`);
  if (onProgress) onProgress(1);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, _so, se) => (err ? reject(new Error(`${cmd} failed: ${se || err.message}`)) : resolve()));
  });
}

async function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (isMac) return run('/usr/bin/ditto', ['-x', '-k', zip, dir]); // keeps symlinks + signatures
  if (isWin) {
    try {
      return await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]);
    } catch {
      return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]);
    }
  }
  return run('unzip', ['-q', '-o', zip, '-d', dir]);
}

// Where the running app lives, and what in the zip replaces it.
function installTarget() {
  if (isMac) {
    // .../<name>.app/Contents/MacOS/<name> -> .../<name>.app
    const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
    return { current: bundle, fromZip: `${BRAND.name}.app` };
  }
  // ...\<name>\<name>.exe -> ...\<name>
  return { current: path.dirname(process.execPath), fromZip: BRAND.name };
}

function checkWritable(dir) {
  const parent = path.dirname(dir);
  const probe = path.join(parent, `.gg-write-test-${process.pid}`);
  try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); return true; } catch { return false; }
}

// Downloads and installs the update, then quits so the helper can swap files.
async function install(info, onProgress) {
  if (!info || !info.asset) throw new Error('no update to install');
  const target = installTarget();
  if (!checkWritable(target.current)) {
    throw new Error(`Can't write to ${path.dirname(target.current)}. Move ${BRAND.name} to a folder you own (e.g. Desktop) and try again.`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-update-'));
  const zip = path.join(work, info.asset.name);
  await download(info.asset, zip, (p) => onProgress && onProgress({ stage: 'download', progress: p }));
  if (onProgress) onProgress({ stage: 'unpack', progress: 1 });
  // Unpack in the temp folder (keeps Dropbox/OneDrive folders from syncing junk).
  const staging = path.join(work, 'unpacked');
  await unzip(zip, staging);
  const fresh = path.join(staging, target.fromZip);
  if (!fs.existsSync(fresh)) throw new Error(`update zip is missing "${target.fromZip}"`);
  if (onProgress) onProgress({ stage: 'restart', progress: 1 });
  launchSwapper(target.current, fresh, staging, work);
  setTimeout(() => app.exit(0), 300);
}

function launchSwapper(current, fresh, staging, work) {
  const pid = process.pid;
  if (isWin) {
    const exe = path.join(current, `${BRAND.name}.exe`);
    const script = path.join(work, 'swap.cmd');
    const q = (s) => `"${s}"`;
    fs.writeFileSync(script, [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL`,
      'if not errorlevel 1 ( ping -n 2 127.0.0.1 >NUL & goto wait )',
      'ping -n 2 127.0.0.1 >NUL',
      // Mirror the new build over the old folder (keeps the folder path the same).
      `robocopy ${q(fresh)} ${q(current)} /MIR /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >NUL`,
      `rmdir /S /Q ${q(staging)}`,
      `start "" ${q(exe)}`,
      `rmdir /S /Q ${q(work)}`,
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  // macOS (and Linux test runs): plain shell.
  const script = path.join(work, 'swap.sh');
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    'sleep 0.5',
    `rm -rf ${sq(current)}.old`,
    `mv ${sq(current)} ${sq(current)}.old && mv ${sq(fresh)} ${sq(current)} && rm -rf ${sq(current)}.old || { rm -rf ${sq(current)}; mv ${sq(current)}.old ${sq(current)}; }`,
    `rm -rf ${sq(staging)}`,
    isMac ? `/usr/bin/xattr -dr com.apple.quarantine ${sq(current)} 2>/dev/null` : 'true',
    isMac ? `/usr/bin/open ${sq(current)}` : `${sq(path.join(current, path.basename(process.execPath)))} >/dev/null 2>&1 &`,
    `rm -rf ${sq(work)}`,
  ].join('\n'));
  fs.chmodSync(script, 0o755);
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
}

// Invite page: brand.json "inviteBase" (custom domain later), else GitHub Pages.
function inviteBase() {
  if (BRAND.inviteBase) return BRAND.inviteBase;
  return CONFIG.owner ? `https://${CONFIG.owner.toLowerCase()}.github.io/${CONFIG.repo}/join/` : '';
}
function downloadPage() {
  return CONFIG.owner ? `https://github.com/${CONFIG.owner}/${CONFIG.repo}/releases/latest` : '';
}

module.exports = { check, install, enabled, cmpVersion, inviteBase, downloadPage, openReleasePage: (u) => shell.openExternal(u) };
