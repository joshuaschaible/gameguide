'use strict';
// Finds where a captured app window is on screen, so the drawing overlay can
// sit exactly on top of it. Read-only OS queries; nothing touches the game.
//   Windows: user32 / dwmapi via koffi
//   macOS:   CoreGraphics CGWindowListCopyWindowInfo via koffi
// Every function fails soft (returns null) so the app still works without it.

let impl = null;
let loadError = null;

function loadWin() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwm = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('GG_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hWnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)');
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ GG_RECT *rect)');
  const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hWnd, uint32_t flags)');
  const DwmGetWindowAttribute = dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hWnd, uint32_t attr, _Out_ GG_RECT *value, uint32_t size)');
  const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const GA_ROOT = 2;

  const kernel32 = koffi.load('kernel32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
  const SetPriorityClass = kernel32.func('bool __stdcall SetPriorityClass(void *h, uint32_t cls)');
  let D3DKMTSetProcessSchedulingPriorityClass = null;
  try {
    D3DKMTSetProcessSchedulingPriorityClass = gdi32.func('int32 __stdcall D3DKMTSetProcessSchedulingPriorityClass(void *h, int32 prio)');
  } catch { /* older Windows */ }
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)');
  const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)');
  const PROCESS_SET_INFORMATION = 0x0200;
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const ABOVE_NORMAL_PRIORITY_CLASS = 0x8000;
  const GPU_PRIO = { HIGH: 4, ABOVE_NORMAL: 3 };
  // Windows 11 "EcoQoS": background apps get parked on efficiency cores at low
  // clocks. With a heavy game (Star Citizen) that starves capture/encoding/
  // networking for seconds. Opt our processes out (full speed, normal timers).
  let SetProcessInformation = null;
  try {
    koffi.struct('GG_POWER_THROTTLING', { Version: 'uint32', ControlMask: 'uint32', StateMask: 'uint32' });
    SetProcessInformation = kernel32.func('int32 __stdcall SetProcessInformation(void *h, int32 cls, GG_POWER_THROTTLING *info, uint32_t size)');
  } catch { /* older Windows */ }
  const ProcessPowerThrottling = 4;
  const THROTTLE_EXECUTION_SPEED = 0x1;
  const THROTTLE_IGNORE_TIMER_RESOLUTION = 0x4;
  function fullSpeed(h) {
    if (!SetProcessInformation) return 'eco n/a';
    const ok = SetProcessInformation(h, ProcessPowerThrottling,
      { Version: 1, ControlMask: THROTTLE_EXECUTION_SPEED | THROTTLE_IGNORE_TIMER_RESOLUTION, StateMask: 0 }, 12);
    return ok ? 'eco off' : 'eco unchanged';
  }

  // Starting a helper with no console window at all. Node's spawn can't do this
  // for detached processes (windowsHide is ignored and every console tool the
  // script runs pops up its own black window), so we call CreateProcessW
  // ourselves with CREATE_NO_WINDOW. The helper gets a hidden console that the
  // tools it runs share, and it isn't tied to our lifetime.
  let runHidden = null;
  try {
    const STARTUPINFOW = koffi.struct('GG_STARTUPINFOW', {
      cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
      dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
      dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32',
      wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *',
      hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
    });
    koffi.struct('GG_PROCESS_INFORMATION', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' });
    const CreateProcessW = kernel32.func('int32 __stdcall CreateProcessW(const char16_t *app, const char16_t *cmdLine, void *procAttrs, void *threadAttrs, int32 inherit, uint32_t flags, void *env, const char16_t *cwd, GG_STARTUPINFOW *si, _Out_ GG_PROCESS_INFORMATION *pi)');
    const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');
    const CREATE_NO_WINDOW = 0x08000000;
    const CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const STARTF_USESHOWWINDOW = 0x1;

    runHidden = function runHidden(exe, cmdLine, cwd) {
      const si = {
        cb: koffi.sizeof(STARTUPINFOW), lpReserved: null, lpDesktop: null, lpTitle: null,
        dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
        dwFlags: STARTF_USESHOWWINDOW, wShowWindow: 0 /* SW_HIDE */, cbReserved2: 0, lpReserved2: null,
        hStdInput: null, hStdOutput: null, hStdError: null,
      };
      let lastErr = 0;
      // Try to leave any job object we were started in (so the helper outlives
      // us), and fall back if that job doesn't allow it.
      for (const extra of [CREATE_BREAKAWAY_FROM_JOB, 0]) {
        const pi = {};
        if (CreateProcessW(exe, cmdLine, null, null, 0, CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | extra, null, cwd || null, si, pi)) {
          CloseHandle(pi.hThread);
          CloseHandle(pi.hProcess);
          return pi.dwProcessId;
        }
        lastErr = GetLastError();
      }
      throw new Error(`CreateProcessW failed (error ${lastErr})`);
    };
  } catch { /* leave runHidden null; updater falls back to spawn */ }

  function exeForWindow(hwnd) {
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!pid[0]) return '';
    const h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid[0]);
    if (!h) return '';
    try {
      const buf = new Uint16Array(1024);
      const size = [1024];
      if (!QueryFullProcessImageNameW(h, 0, buf, size)) return '';
      return String.fromCharCode(...buf.subarray(0, size[0]));
    } finally { CloseHandle(h); }
  }

  return {
    runHidden,
    // Where a window is and which program owns it (used to guess the game).
    meta(id) {
      const h = Number(id);
      if (!h || !IsWindow(h)) return null;
      const r = {};
      let ok = DwmGetWindowAttribute(h, 9, r, 16) === 0;
      if (!ok) ok = GetWindowRect(h, r);
      return {
        physical: true,
        rect: ok ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null,
        exe: exeForWindow(h),
      };
    },
    // Same trick OBS uses: give our capture/encode processes GPU priority so a
    // game maxing out the GPU doesn't starve the stream. HIGH needs admin.
    // fullSpeedOnly: just opt out of power throttling, leave priorities alone.
    boost(pid, fullSpeedOnly) {
      const h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!h) return 'open failed';
      try {
        const eco = fullSpeed(h);
        if (fullSpeedOnly) return eco;
        const cpu = `${SetPriorityClass(h, ABOVE_NORMAL_PRIORITY_CLASS) ? 'cpu above-normal' : 'cpu unchanged'}, ${eco}`;
        let gpu = 'gpu unchanged';
        if (D3DKMTSetProcessSchedulingPriorityClass) {
          if (D3DKMTSetProcessSchedulingPriorityClass(h, GPU_PRIO.HIGH) === 0) gpu = 'gpu high';
          else if (D3DKMTSetProcessSchedulingPriorityClass(h, GPU_PRIO.ABOVE_NORMAL) === 0) gpu = 'gpu above-normal';
        }
        return `${cpu}, ${gpu}`;
      } finally { CloseHandle(h); }
    },
    // Returns physical-pixel rect of the visible window frame (what Windows capture records).
    info(id) {
      const h = Number(id);
      if (!h || !IsWindow(h)) return { exists: false };
      const r = {};
      let ok = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0;
      if (!ok) ok = GetWindowRect(h, r);
      if (!ok) return { exists: true, visible: false };
      const fg = Number(GetForegroundWindow());
      const fgRoot = fg ? Number(GetAncestor(fg, GA_ROOT)) : 0;
      const fgOwner = fg ? Number(GetAncestor(fg, 3 /* GA_ROOTOWNER */)) : 0;
      return {
        exists: true,
        visible: IsWindowVisible(h) && !IsIconic(h),
        foreground: fg === h || fgRoot === h || fgOwner === h,
        foregroundId: fgRoot || fg,
        physical: true,
        rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top },
      };
    },
  };
}

function loadMac() {
  const koffi = require('koffi');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CGPoint = koffi.struct('GG_CGPoint', { x: 'double', y: 'double' });
  const CGSize = koffi.struct('GG_CGSize', { width: 'double', height: 'double' });
  koffi.struct('GG_CGRect', { origin: CGPoint, size: CGSize });
  const CGWindowListCopyWindowInfo = cg.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)');
  const CGRectMakeWithDictionaryRepresentation = cg.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ GG_CGRect *rect)');
  const CFArrayGetCount = cf.func('long CFArrayGetCount(void *arr)');
  const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *arr, long idx)');
  const CFDictionaryGetValue = cf.func('void *CFDictionaryGetValue(void *dict, void *key)');
  const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32_t enc)');
  const CFBooleanGetValue = cf.func('bool CFBooleanGetValue(void *b)');
  const CFNumberGetValue = cf.func('bool CFNumberGetValue(void *n, int type, _Out_ int64_t *out)');
  const CFRelease = cf.func('void CFRelease(void *obj)');
  const UTF8 = 0x08000100;
  const kBounds = CFStringCreateWithCString(null, 'kCGWindowBounds', UTF8);
  const kOnscreen = CFStringCreateWithCString(null, 'kCGWindowIsOnscreen', UTF8);
  const kNumber = CFStringCreateWithCString(null, 'kCGWindowNumber', UTF8);
  const kLayer = CFStringCreateWithCString(null, 'kCGWindowLayer', UTF8);
  const kOwner = CFStringCreateWithCString(null, 'kCGWindowOwnerName', UTF8);
  const CFStringGetCString = cf.func('bool CFStringGetCString(void *s, _Out_ uint8_t *buf, long size, uint32_t enc)');
  const kCFNumberSInt64Type = 4;
  const OPT_INCLUDING_WINDOW = 1 << 3;
  const OPT_ON_SCREEN_ONLY = 1 << 0;
  const OPT_EXCLUDE_DESKTOP = 1 << 4;

  function frontmostNormalWindow() {
    // First on-screen, layer-0 window in front-to-back order = what the user is looking at.
    const arr = CGWindowListCopyWindowInfo(OPT_ON_SCREEN_ONLY | OPT_EXCLUDE_DESKTOP, 0);
    if (!arr) return 0;
    try {
      const n = CFArrayGetCount(arr);
      for (let i = 0; i < n; i++) {
        const d = CFArrayGetValueAtIndex(arr, i);
        const layer = [0n]; const num = [0n];
        const lv = CFDictionaryGetValue(d, kLayer);
        if (!lv || !CFNumberGetValue(lv, kCFNumberSInt64Type, layer) || Number(layer[0]) !== 0) continue;
        const nv = CFDictionaryGetValue(d, kNumber);
        if (nv && CFNumberGetValue(nv, kCFNumberSInt64Type, num)) return Number(num[0]);
      }
    } finally { CFRelease(arr); }
    return 0;
  }

  return {
    meta(id) {
      const wid = Number(id);
      if (!wid) return null;
      const arr = CGWindowListCopyWindowInfo(OPT_INCLUDING_WINDOW, wid);
      if (!arr) return null;
      try {
        if (CFArrayGetCount(arr) < 1) return null;
        const d = CFArrayGetValueAtIndex(arr, 0);
        const b = CFDictionaryGetValue(d, kBounds);
        const r = {};
        const okRect = b && CGRectMakeWithDictionaryRepresentation(b, r);
        let owner = '';
        const o = CFDictionaryGetValue(d, kOwner);
        if (o) {
          const buf = new Uint8Array(512);
          if (CFStringGetCString(o, buf, 512, UTF8)) owner = Buffer.from(buf.subarray(0, buf.indexOf(0))).toString('utf8');
        }
        return {
          physical: false,
          rect: okRect ? { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height } : null,
          exe: owner,
        };
      } finally { CFRelease(arr); }
    },
    // Returns rect in global points (same space as Electron's screen API).
    info(id, ignoreIds) {
      const wid = Number(id);
      if (!wid) return { exists: false };
      const arr = CGWindowListCopyWindowInfo(OPT_INCLUDING_WINDOW, wid);
      if (!arr) return { exists: false };
      try {
        if (CFArrayGetCount(arr) < 1) return { exists: false };
        const d = CFArrayGetValueAtIndex(arr, 0);
        const b = CFDictionaryGetValue(d, kBounds);
        const r = {};
        if (!b || !CGRectMakeWithDictionaryRepresentation(b, r)) return { exists: true, visible: false };
        const on = CFDictionaryGetValue(d, kOnscreen);
        const visible = on ? CFBooleanGetValue(on) : false;
        const raw = frontmostNormalWindow();
        let front = raw;
        if (ignoreIds && ignoreIds.includes(front)) front = wid; // our own windows don't count
        return {
          exists: true,
          visible,
          foreground: front === wid,
          foregroundId: front,
          foregroundRaw: raw,
          physical: false,
          rect: { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height },
        };
      } finally { CFRelease(arr); }
    },
  };
}

function get() {
  if (impl || loadError) return impl;
  try {
    if (process.platform === 'win32') impl = loadWin();
    else if (process.platform === 'darwin') impl = loadMac();
    else loadError = new Error('unsupported platform');
  } catch (e) {
    loadError = e;
    impl = null;
  }
  return impl;
}

module.exports = {
  available() { return !!get(); },
  error() { get(); return loadError ? String(loadError.message || loadError) : null; },
  boost(pid, fullSpeedOnly) {
    const i = get();
    if (!i || !i.boost) return 'not supported';
    try { return i.boost(pid, fullSpeedOnly); } catch (e) { return `failed: ${e.message}`; }
  },
  // Windows only: start a program with no window. Returns its pid. Throws if
  // unavailable so callers can fall back to child_process.spawn.
  runHidden(exe, cmdLine, cwd) {
    const i = get();
    if (!i || !i.runHidden) throw new Error(loadError ? String(loadError.message || loadError) : 'not supported');
    return i.runHidden(exe, cmdLine, cwd);
  },
  windowMeta(id) {
    const i = get();
    if (!i || !i.meta) return null;
    try { return i.meta(id); } catch { return null; }
  },
  windowInfo(id, ignoreIds) {
    const i = get();
    if (!i) return null;
    try { return i.info(id, ignoreIds); } catch (e) { return null; }
  },
};
