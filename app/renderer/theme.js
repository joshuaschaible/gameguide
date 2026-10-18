// Applies the color theme before the page paints (no dark/light flash).
// 'system' follows the OS setting and updates live when it changes.
(function () {
  'use strict';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function pref() {
    try { const v = JSON.parse(localStorage.getItem('app.theme')); return ['dark', 'light', 'system'].includes(v) ? v : 'system'; } catch { return 'system'; }
  }
  function apply(mode) {
    const m = mode || pref();
    const resolved = m === 'system' ? (mq.matches ? 'dark' : 'light') : m;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = m;
    try { if (window.bridge && window.bridge.setTheme) window.bridge.setTheme(m, resolved === 'dark' ? '#313338' : '#ffffff'); } catch { /* ignore */ }
    return resolved;
  }
  mq.addEventListener('change', () => { if (pref() === 'system') apply('system'); });
  window.Theme = {
    get: pref,
    set(mode) { try { localStorage.setItem('app.theme', JSON.stringify(mode)); } catch { /* ignore */ } return apply(mode); },
    apply,
  };
  apply();
})();
