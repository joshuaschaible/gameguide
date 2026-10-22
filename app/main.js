'use strict';
// Main process. Product name, link scheme and IDs come from brand.json.
// - main window
// - capture source listing (app windows + screens) and selection
// - transparent click-through overlay that sits on the captured game window or
//   screen and shows the friend's marks
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen,
  session, systemPreferences, shell, clipboard, globalShortcut, nativeImage, nativeTheme,
} = require('electron');
const path = require('path');
const native = require('./native');
const updater = require('./updater');
const BRAND = require('./brand.json');
const SCHEME = BRAND.id; // invite links: <id>://join/ABC123

let mainWin = null;
let overlayWin = null;
let selectedSourceId = null;
let trackTimer = null;
let overlayHidden = false;     // hidden by the player's hotkey
let target = null;             // { kind: 'screen'|'window', sourceId, windowId, displayId }
let lastTrackState = '';
let overlayActive = false;     // marks or a toast are on screen right now
let lastZ = 0;                 // last time we re-claimed the top of the z-order
let boostLog = [];

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// ---------- Chromium flags ----------
// The overlay plays a short sound when a mark arrives; no click is needed first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep capturing/encoding at full speed while a fullscreen game covers our window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
// Chromium caps desktop capture at 50% of a CPU core and silently lowers the
// capture frame rate when capturing takes longer. That turns 60 fps into ~10.
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
// Hardware video encoding and the modern Windows capture path.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', [
  'MediaFoundationH264Encoding',
  'AllowWgcScreenCapturer',
  'AllowWgcWindowCapturer',
].join(','));

// ---------- security: windows only ever show our own bundled pages ----------
// Both windows load local files from ./renderer and never need to go anywhere
// else. Block everything that could put other content in them: link/page
// navigation (including a file or link dropped onto the window), redirects,
// sub-frame navigation, popups (window.open / target=_blank) and <webview>.
// Permissions (screen capture, clipboard) are only granted to those pages.
const { pathToFileURL } = require('url');
const APP_PAGES = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href;
const isAppPage = (url) => {
  try { const u = new URL(String(url)); return u.protocol === 'file:' && u.href.startsWith(APP_PAGES); } catch { return false; }
};
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    console.warn('blocked popup:', String(url).slice(0, 200));
    return { action: 'deny' };
  });
  const guard = (ev, url) => {
    if (isAppPage(url)) return;
    ev.preventDefault();
    console.warn('blocked navigation:', String(url).slice(0, 200));
  };
  contents.on('will-navigate', guard);
  contents.on('will-frame-navigate', (ev) => guard(ev, ev.url));
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

// ---------- invite links (<scheme>://join/ABC123) ----------
// Only one copy runs at a time; a clicked invite link is handed to it.
let pendingInvite = null;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function parseInvite(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== `${SCHEME}:`) return null;
    const raw = u.searchParams.get('code') || u.pathname.replace(/\//g, '') || '';
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return code.length === 6 ? code : null;
  } catch { return null; }
}

function deliverInvite(url) {
  const code = parseInvite(url);
  if (!code) return;
  pendingInvite = code;
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    if (!mainWin.webContents.isLoading()) flushInvite();
  }
}

function flushInvite() {
  if (!pendingInvite || !mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('invite:join', pendingInvite);
  pendingInvite = null;
}

app.on('open-url', (e, url) => { e.preventDefault(); deliverInvite(url); }); // macOS
app.on('second-instance', (_e, argv) => {                                     // Windows
  const url = argv.find((a) => String(a).startsWith(`${SCHEME}:`));
  if (url) deliverInvite(url);
  else if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
});
{
  const url = process.argv.find((a) => String(a).startsWith(`${SCHEME}:`));
  if (url) pendingInvite = parseInvite(url);
}

// ---------- main window ----------

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#313338' : '#ffffff',
    title: BRAND.name,
    // Windows/Linux window + taskbar icon (the Mac Dock uses the app bundle's .icns)
    icon: isMac ? undefined : path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep streaming while the player is in-game
    },
  });
  mainWin.on('page-title-updated', (e) => e.preventDefault());
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.webContents.on('did-finish-load', () => setTimeout(flushInvite, 300));
  mainWin.on('closed', () => {
    mainWin = null;
    closeOverlay();
    app.quit();
  });
}

// Native ids of our own windows (so clicking our app doesn't hide the overlay).
function ourWindowIds() {
  const ids = [];
  for (const w of [mainWin, overlayWin]) {
    if (!w || w.isDestroyed()) continue;
    try {
      if (isWin) {
        const buf = w.getNativeWindowHandle();
        ids.push(Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0)));
      } else {
        const m = /^window:(\d+):/.exec(w.getMediaSourceId());
        if (m) ids.push(Number(m[1]));
      }
    } catch { /* ignore */ }
  }
  return ids;
}

// ---------- capture sources ----------

function windowIdFromSourceId(id) {
  const m = /^window:(\d+):/.exec(String(id || ''));
  return m ? m[1] : null;
}

// ---- guessing which window is the game ----
// Programs that are almost never the game someone wants to share.
const NOT_GAMES = /(^|[\\/])(chrome|google chrome|microsoft edge|visual studio code|activity monitor|msedge|firefox|brave|opera|safari|arc|discord|discordptb|slack|teams|ms-teams|zoom|explorer|finder|code|cursor|spotify|steam|steamwebhelper|epicgameslauncher|eadesktop|battle\.net|riotclientservices|galaxyclient|obs64|obs|notepad|winword|excel|powerpnt|outlook|onenote|figma|framer|whatsapp|telegram|signal|messages|mail|terminal|windowsterminal|cmd|powershell|systemsettings|system settings|textedit|preview|claude|nvidia app|nvcontainer|medal)(\.exe|\.app)?$/i;
// Folders where games usually live.
const GAME_DIRS = /steamapps[\\/]common|[\\/]epic games[\\/]|riot games|[\\/]xboxgames[\\/]|windowsapps[\\/].*(microsoft\.|xbox)|[\\/]ea games[\\/]|ubisoft game launcher[\\/]games|battle\.net[\\/]|gog galaxy[\\/]games|[\\/]games[\\/]/i;

function gameScore(src, displays) {
  const wid = windowIdFromSourceId(src.id);
  const meta = wid ? native.windowMeta(wid) : null;
  let score = 0;
  const exe = (meta && meta.exe) || '';
  const base = exe.split(/[\\/]/).pop() || '';
  if (exe && NOT_GAMES.test(base)) score -= 10;
  if (exe && GAME_DIRS.test(exe)) score += 4;
  if (meta && meta.rect) {
    let r = meta.rect;
    if (meta.physical && isWin) r = screen.screenToDipRect(null, r);
    // Covers a whole display (fullscreen / borderless game)?
    const full = displays.some((d) => Math.abs(d.bounds.x - r.x) <= 2 && Math.abs(d.bounds.y - r.y) <= 2
      && Math.abs(d.bounds.width - r.width) <= 4 && Math.abs(d.bounds.height - r.height) <= 4);
    if (full) score += 3;
    else if (r.width >= 1280 && r.height >= 720) score += 1;
  }
  return { score, exe: base };
}

async function listSources() {
  const status = isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 640, height: 360 }, // big previews, like Discord's picker
      fetchWindowIcons: true,
    });
  } catch (err) {
    return { status, error: String(err && err.message || err), sources: [] };
  }
  const displays = screen.getAllDisplays();
  const ours = new Set(ourWindowIds().map(String));
  let screenIdx = 0;
  const out = [];
  for (const s of sources) {
    const isScreen = s.id.startsWith('screen:');
    const thumb = s.thumbnail && !s.thumbnail.isEmpty() ? `data:image/jpeg;base64,${s.thumbnail.toJPEG(82).toString('base64')}` : '';
    if (isScreen) {
      screenIdx += 1;
      const d = displays.find((x) => String(x.id) === String(s.display_id));
      out.push({
        kind: 'screen',
        id: s.id,
        name: 'Whole screen', // numbered below once all screens are known
        // Main monitor first, then the others left to right (then top to bottom).
        order: d ? [d.id === screen.getPrimaryDisplay().id ? -1e9 : d.bounds.x, d.bounds.y] : [1e9 + screenIdx, 0],
        displayId: s.display_id || '',
        thumb,
        icon: '',
      });
    } else {
      const wid = windowIdFromSourceId(s.id);
      if (!s.name || s.name === BRAND.name || s.name === `${BRAND.name} overlay` || ours.has(String(wid))) continue;
      if (!thumb) continue; // invisible helper windows
      const g = gameScore(s, displays);
      out.push({
        kind: 'window',
        id: s.id,
        name: s.name,
        displayId: '',
        thumb,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
        score: g.score,
        app: g.exe,
      });
    }
  }
  // Most likely game first; mark it if we're fairly confident.
  const wins = out.filter((x) => x.kind === 'window').sort((a, b) => b.score - a.score);
  if (wins.length && wins[0].score >= 3) wins[0].likelyGame = true;
  // Several monitors: main monitor = "Screen 1", the rest "Screen 2"… left to right.
  const screensOut = out.filter((x) => x.kind === 'screen')
    .sort((a, b) => (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]));
  if (screensOut.length > 1) screensOut.forEach((x, i) => { x.name = `Screen ${i + 1}`; });
  screensOut.forEach((x) => { delete x.order; });
  const sorted = wins.concat(screensOut);
  return { status, tracking: native.available(), trackingError: native.error(), sources: sorted };
}

function displayFor(displayId) {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
}

// ---------- overlay ----------

function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return;
  const b = screen.getPrimaryDisplay().bounds;
  overlayWin = new BrowserWindow({
    ...b,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWin.setTitle(`${BRAND.name} overlay`);
  overlayWin.on('page-title-updated', (e) => e.preventDefault());
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  // Mac: join every Space, including the separate Space a fullscreen game runs in.
  joinAllSpaces();
  // Keep the overlay out of the captured video so the friend never sees doubled marks.
  overlayWin.setContentProtection(true);
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  overlayActive = false;
  const recover = (why) => {
    sendLog(`overlay ${why}, recreating it`);
    const w = overlayWin;
    overlayWin = null;
    overlayActive = false;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
    if (target) { ensureOverlay(); track(); }
  };
  overlayWin.webContents.on('render-process-gone', (_e, d) => recover(`crashed (${d && d.reason})`));
  overlayWin.webContents.on('unresponsive', () => recover('stopped responding'));
}

// skipTransformProcessType: without it, Electron briefly turns the whole app
// into a background-only process on every call, which removes Game Guide from
// the Dock and Cmd+Tab (it looked closed). The overlay is a 'panel' window,
// which floats over fullscreen apps without that switch.
function joinAllSpaces() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch { /* ignore */ }
  ensureInDock();
}
// Safety net: if anything left the app background-only, bring it back.
function ensureInDock() {
  if (!isMac || !app.dock) return;
  try { if (typeof app.dock.isVisible === 'function' && !app.dock.isVisible()) app.dock.show(); } catch { /* ignore */ }
}

function sendLog(line) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('app:log', line);
}

function openOverlay(t) {
  target = {
    kind: t && t.kind === 'window' ? 'window' : 'screen',
    sourceId: t && t.id,
    windowId: t && t.kind === 'window' ? windowIdFromSourceId(t.id) : null,
    displayId: t && t.displayId,
  };
  overlayHidden = false;
  lastTrackState = '';
  ensureOverlay();
  setTimeout(boostProcesses, 1500);
  setTimeout(boostProcesses, 8000); // GPU/capture helpers can start late
  clearInterval(trackTimer);
  trackTimer = setInterval(track, target.kind === 'window' ? (isWin ? 200 : 400) : (isWin ? 400 : 1500));
  track();
  registerHotkeys();
}

function reportTrack(state, detail) {
  if (state === lastTrackState) return;
  lastTrackState = state;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('overlay:track', { state, detail });
}

// Only puts the overlay on screen while marks are visible. An always-present
// transparent window over a fullscreen game makes Windows composite every game
// frame, which costs the game (and the stream) a lot of frames.
function placeOverlay(bounds) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (!overlayActive) { hideOverlay(); return; }
  const cur = overlayWin.getBounds();
  if (cur.x !== bounds.x || cur.y !== bounds.y || cur.width !== bounds.width || cur.height !== bounds.height) {
    overlayWin.setBounds(bounds);
  }
  const now = Date.now();
  if (!overlayWin.isVisible()) {
    overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    if (isWin) overlayWin.moveTop();
    if (isMac) joinAllSpaces();
    lastZ = now;
  } else if (now - lastZ > 1000) {
    // Re-claim the top spot occasionally, not constantly.
    overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    if (isWin) overlayWin.moveTop();
    lastZ = now;
  }
  correctOverlayFrame(bounds);
}

// macOS may refuse to put a window where we ask (typically pushing it below
// the menu bar). Then every mark would land that much lower. Measure where the
// overlay really is and have it draw shifted back by the difference.
let lastFrameKey = '';
let lastPlaceLog = '';
function correctOverlayFrame(want) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const got = overlayWin.getBounds();
  const frame = { dx: got.x - want.x, dy: got.y - want.y, w: want.width, h: want.height };
  if (Math.abs(frame.dx) <= 1 && Math.abs(frame.dy) <= 1) { frame.dx = 0; frame.dy = 0; }
  // Also correct when the system shrank it (marks would get squashed).
  frame.fit = !!(frame.dx || frame.dy || Math.abs(got.width - want.width) > 2 || Math.abs(got.height - want.height) > 2);
  const key = `${frame.fit},${frame.dx},${frame.dy},${frame.w},${frame.h}`;
  if (key !== lastFrameKey) {
    lastFrameKey = key;
    overlayWin.webContents.send('overlay:frame', frame);
  }
  const placeLog = `${want.x},${want.y} ${want.width}x${want.height} -> ${got.x},${got.y} ${got.width}x${got.height}`;
  if (placeLog !== lastPlaceLog) {
    lastPlaceLog = placeLog;
    sendLog(`overlay: game area ${want.x},${want.y} ${want.width}x${want.height}; drawing layer at ${got.x},${got.y} ${got.width}x${got.height}${frame.fit ? ` (system moved/resized it by ${frame.dx},${frame.dy}; marks corrected)` : ''}`);
  }
}

let lastBoostLog = '';
function boostProcesses() {
  if (!isWin) return;
  const out = [];
  for (const m of app.getAppMetrics()) {
    const relevant = ['Browser', 'GPU', 'Tab'].includes(m.type)
      || (m.type === 'Utility' && /video_capture|audio|network/i.test(m.serviceName || m.name || ''));
    // Every process of ours runs at full speed; the important ones also get priority.
    out.push(`${m.type}${m.serviceName ? `(${m.serviceName.split('.')[0]})` : ''} ${m.pid}: ${native.boost(m.pid, !relevant)}`);
  }
  boostLog = out;
  const line = out.join('; ');
  if (line !== lastBoostLog && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('app:log', `priority: ${line}`);
  lastBoostLog = line;
}
// New helper processes appear when video is rebuilt; re-apply now and then.
setInterval(() => { if (target) boostProcesses(); }, 60000);

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide();
}

// Runs on a timer: keep the overlay exactly on the captured window/screen and on top.
let lastIdleCheck = 0;
let focusOnly = false; // set from the player's stream settings
function track() {
  if (!overlayWin || overlayWin.isDestroyed() || !target) return;
  if (overlayHidden) { hideOverlay(); return; }
  if (!overlayActive) {
    // Nothing to draw: keep the overlay off screen and only check the
    // game window occasionally (for the status line).
    hideOverlay();
    const now = Date.now();
    if (now - lastIdleCheck < 1500) return;
    lastIdleCheck = now;
  }

  if (target.kind === 'screen') {
    placeOverlay(displayFor(target.displayId).bounds);
    reportTrack('screen');
    return;
  }

  const info = native.windowInfo(target.windowId, ourWindowIds());
  if (!info) {
    // Window tracking unavailable: best effort, cover the primary display.
    placeOverlay(screen.getPrimaryDisplay().bounds);
    reportTrack('untracked', native.error());
    return;
  }
  if (!info.exists) { hideOverlay(); reportTrack('closed'); return; }
  if (!info.visible) { hideOverlay(); reportTrack('minimized'); return; }
  const ours = ourWindowIds();
  // Marks always show while the game window is open (even if another app is in
  // front): hiding on "background" made marks silently disappear for some games.
  const bg = !info.foreground && !ours.includes(info.foregroundId);
  // Opt-in: only show marks while the shared window itself is the active one
  // (not while another app, or Game Guide, is in front).
  if (focusOnly) {
    const fgId = info.foregroundRaw !== undefined ? info.foregroundRaw : info.foregroundId;
    const inGame = info.foreground && !ours.includes(fgId);
    if (!inGame) { hideOverlay(); reportTrack('away'); return; }
  }

  let r = info.rect;
  if (info.physical && isWin) r = screen.screenToDipRect(null, r);
  const bounds = {
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)),
  };
  placeOverlay(bounds);
  reportTrack(bg ? 'background' : 'tracking');
}

// In-game hotkeys (work while the game has focus, even fullscreen).
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const tryReg = (accel, fn) => {
    try { if (!globalShortcut.register(accel, fn)) console.warn('hotkey taken:', accel); } catch (e) { console.warn(e); }
  };
  tryReg('CommandOrControl+Shift+X', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:draw', { t: 'clear', local: true });
  });
  tryReg('CommandOrControl+Shift+H', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayHidden = !overlayHidden;
    sendLog(`hotkey: drawings ${overlayHidden ? 'hidden' : 'shown'}`);
    if (mainWin) mainWin.webContents.send('overlay:hidden', overlayHidden);
    // Show a toast either way so a stray key press is never silent.
    const hiding = overlayHidden;
    overlayHidden = false;
    overlayWin.webContents.send('overlay:toast', hiding ? 'Drawings hidden (Ctrl/Cmd+Shift+H to show)' : 'Drawings on');
    if (hiding) setTimeout(() => { overlayHidden = true; track(); }, 2200);
  });
  tryReg('CommandOrControl+Shift+M', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:toggleSound');
    if (mainWin) mainWin.webContents.send('overlay:toggleSound');
  });
}

function closeOverlay() {
  globalShortcut.unregisterAll();
  clearInterval(trackTimer);
  trackTimer = null;
  target = null;
  overlayActive = false;
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
  ensureInDock();
}

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  if (!gotLock) return;
  // getDisplayMedia() in the renderer is answered with the source the player picked.
  session.defaultSession.setDisplayMediaRequestHandler(async (req, callback) => {
    // Only our own pages may capture (a page we didn't ship never gets the game).
    if (!isAppPage(req && req.frame && req.frame.url)) { console.warn('blocked screen capture request'); return callback({}); }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      // Never swap in a different source on our own: if the chosen window is
      // gone (game closed), fail, and the app asks the player what to share.
      // Only a screen falls back to a screen (ids can change when displays do).
      const src = sources.find((s) => s.id === selectedSourceId)
        || (String(selectedSourceId).startsWith('screen:') ? sources.find((s) => s.id.startsWith('screen:')) : null);
      if (!src) return callback({});
      callback({ video: src });
    } catch {
      callback({});
    }
  });
  // Only our own pages may capture the screen or write the clipboard.
  const allowed = ['media', 'display-capture', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL());
    cb(allowed.includes(permission) && isAppPage(url));
  });
  // Checks: unchanged for our pages (no check handler used to mean "allowed"), denied for anything else.
  session.defaultSession.setPermissionCheckHandler((wc, _permission, origin, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || origin;
    return isAppPage(url);
  });

  // Theme: drives the native title bar color and the window background.
  ipcMain.on('theme:set', (_e, mode, bg) => {
    if (['system', 'dark', 'light'].includes(mode)) nativeTheme.themeSource = mode;
    if (mainWin && !mainWin.isDestroyed() && /^#[0-9a-f]{6}$/i.test(bg)) mainWin.setBackgroundColor(bg);
  });
  ipcMain.on('brand:get', (e) => { e.returnValue = { name: BRAND.name, id: BRAND.id }; });
  ipcMain.handle('sources:list', () => listSources());
  // Returns false when that window no longer exists (e.g. the game closed),
  // so the app never calls capture for it (an empty capture reply can crash).
  ipcMain.handle('sources:select', async (_e, id) => {
    selectedSourceId = String(id);
    if (selectedSourceId.startsWith('screen:')) return true;
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      return sources.some((s) => s.id === selectedSourceId);
    } catch { return true; }
  });
  ipcMain.handle('overlay:open', (_e, t) => { openOverlay(t); return true; });
  ipcMain.handle('overlay:close', () => { closeOverlay(); return true; });
  ipcMain.on('overlay:draw', (_e, msg) => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const isNew = msg && (msg.t === 'start' || msg.t === 'ping' || msg.t === 'react' || (msg.t === 'arrow' && msg.first));
    const shows = isNew || (msg && (msg.t === 'arrow' || (msg.t === 'laser' && !msg.off)));
    if (shows && !overlayActive) {
      overlayActive = true; // show right away; the overlay confirms/denies shortly
      track();
    }
    overlayWin.webContents.send('overlay:draw', msg);
    if (isNew && msg.t !== 'react' && mainWin && !mainWin.isDestroyed()) {
      // Receipt for the friend: did this mark actually make it onto the screen?
      let state = 'shown';
      if (overlayHidden) state = 'hidden';
      else if (lastTrackState === 'minimized' || lastTrackState === 'closed' || lastTrackState === 'away') state = lastTrackState;
      else if (!overlayWin.isVisible()) state = 'not-visible';
      mainWin.webContents.send('overlay:receipt', state);
    }
  });
  ipcMain.on('overlay:toast-req', (_e, text) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:toast', String(text).slice(0, 120));
  });
  ipcMain.on('overlay:focusOnly', (_e, on) => { focusOnly = !!on; lastTrackState = null; track(); });
    ipcMain.on('overlay:active', (_e, active) => {
    overlayActive = !!active;
    track();
  });
  // Avatar fallback: decode a picture with the system (macOS reads HEIC), crop
  // to a square and shrink to 96 px. Only image files; returns a small JPEG.
  ipcMain.handle('image:avatar', (_e, p) => {
    try {
      const file = String(p || '');
      if (!/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i.test(file)) return null;
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      const side = Math.min(width, height);
      const sq = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
        .resize({ width: 96, height: 96, quality: 'good' });
      return `data:image/jpeg;base64,${sq.toJPEG(82).toString('base64')}`;
    } catch { return null; }
  });
  // Electron 44+: clipboard read/write are async.
  ipcMain.handle('clipboard:write', async (_e, text) => { await clipboard.writeText(String(text)); return true; });
  ipcMain.handle('clipboard:read', async () => clipboard.readText());
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    windowTracking: native.available(),
    updates: updater.enabled() ? `${BRAND.github.owner}/${BRAND.github.repo}` : 'off',
    inviteBase: updater.inviteBase(),
    downloadUrl: updater.downloadPage(),
    priority: boostLog,
    gpu: app.getGPUFeatureStatus(),
  }));
  ipcMain.handle('app:minimize', () => { if (mainWin) mainWin.minimize(); return true; });
  ipcMain.handle('app:openScreenSettings', () => {
    if (isMac) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  });

  // ---- updates ----
  let lastUpdate = null;
  const pushUpdate = (u) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:status', u); };
  const checkUpdates = async (manual) => {
    try {
      lastUpdate = await updater.check();
      if (lastUpdate.available || manual) pushUpdate(lastUpdate);
    } catch (e) {
      if (manual) pushUpdate({ error: String(e.message || e) });
      sendLog(`update check failed: ${e.message || e}`);
    }
    return lastUpdate;
  };
  ipcMain.handle('update:check', () => checkUpdates(true));
  ipcMain.handle('update:install', async () => {
    if (!lastUpdate || !lastUpdate.available) await checkUpdates(true);
    if (!lastUpdate || !lastUpdate.available) return { ok: false, error: 'No update available.' };
    try {
      await updater.install(lastUpdate, (p) => pushUpdate({ ...lastUpdate, progress: p }));
      return { ok: true };
    } catch (e) {
      sendLog(`update failed: ${e.message || e}`);
      return { ok: false, error: String(e.message || e) };
    }
  });

  if (app.isPackaged) {
    try { app.setAsDefaultProtocolClient(SCHEME); } catch { /* ignore */ }
  }
  createMainWindow();
  // Check soon after launch, every 2 minutes while running, and whenever the
  // window comes back into focus (at most every 30 s), so a fix pushed
  // mid-test shows up within a couple of minutes.
  const UPDATE_INTERVAL_MS = 2 * 60 * 1000;
  let lastCheck = 0;
  const maybeCheck = (minGap) => {
    if (Date.now() - lastCheck < minGap) return;
    lastCheck = Date.now();
    checkUpdates(false);
  };
  mainWin.webContents.once('did-finish-load', () => {
    // What the update helper did last time (Windows), so it shows in Copy details.
    const swapLog = updater.takeUpdateLog();
    if (swapLog) setTimeout(() => swapLog.split(/\r?\n/).filter(Boolean).forEach((l) => sendLog(`update helper: ${l.trim()}`)), 1500);
    setTimeout(() => maybeCheck(0), 2500);
    setInterval(() => maybeCheck(UPDATE_INTERVAL_MS - 5000), UPDATE_INTERVAL_MS);
  });
  mainWin.on('focus', () => maybeCheck(30 * 1000));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
