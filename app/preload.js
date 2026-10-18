'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  brand: ipcRenderer.sendSync('brand:get'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id) => ipcRenderer.invoke('sources:select', id),
  openOverlay: (target) => ipcRenderer.invoke('overlay:open', target),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  draw: (msg) => ipcRenderer.send('overlay:draw', msg),
  onDraw: (fn) => ipcRenderer.on('overlay:draw', (_e, msg) => fn(msg)),
  onOverlayHidden: (fn) => ipcRenderer.on('overlay:hidden', (_e, v) => fn(v)),
  onOverlayTrack: (fn) => ipcRenderer.on('overlay:track', (_e, v) => fn(v)),
  overlayActive: (active) => ipcRenderer.send('overlay:active', !!active),
  onToast: (fn) => ipcRenderer.on('overlay:toast', (_e, t) => fn(t)),
  onOverlayFrame: (fn) => ipcRenderer.on('overlay:frame', (_e, f) => fn(f)),
  // Avatar fallback for pictures the page can't decode (HEIC etc.).
  imageToAvatar: (file) => {
    try {
      const p = webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : '';
      return p ? ipcRenderer.invoke('image:avatar', p) : Promise.resolve(null);
    } catch { return Promise.resolve(null); }
  },
  onReceipt: (fn) => ipcRenderer.on('overlay:receipt', (_e, st) => fn(st)),
  onLog: (fn) => ipcRenderer.on('app:log', (_e, line) => fn(line)),
  onToggleSound: (fn) => ipcRenderer.on('overlay:toggleSound', () => fn()),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (fn) => ipcRenderer.on('update:status', (_e, u) => fn(u)),
  overlayToast: (text) => ipcRenderer.send('overlay:toast-req', String(text)),
  onInvite: (fn) => ipcRenderer.on('invite:join', (_e, code) => fn(code)),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  paste: () => ipcRenderer.invoke('clipboard:read'),
  info: () => ipcRenderer.invoke('app:info'),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  openScreenSettings: () => ipcRenderer.invoke('app:openScreenSettings'),
  setTheme: (mode, bg) => ipcRenderer.send('theme:set', String(mode), String(bg)),
});
