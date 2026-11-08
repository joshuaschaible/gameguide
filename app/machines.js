'use strict';
// State machines that live in the main process. Plain data: main.js runs them,
// test/unit checks them, scripts/machines.mjs draws them into docs/state-machines.md.

// Player hotkey Ctrl/Cmd+Shift+H. Hiding shows a short toast first, so a stray
// key press is never silent; pressing again during the toast cancels the hide.
const DRAWINGS = {
  id: 'drawings',
  desc: "Player's hotkey (Ctrl/Cmd+Shift+H) that hides or shows the friend's marks on the game.",
  initial: 'shown',
  on: { RESET: 'shown' }, // new share or session end: always start visible, cancel a pending hide
  states: {
    shown: { desc: 'Marks appear on the game.', on: { TOGGLE: 'hiding' } },
    hiding: {
      desc: '"Drawings hidden" toast is on screen; marks hide when it ends.',
      after: { 2200: 'TIMEOUT' },
      on: { TOGGLE: 'shown', TIMEOUT: 'hidden' },
    },
    hidden: { desc: 'Marks are hidden until the hotkey is pressed again.', on: { TOGGLE: 'shown' } },
  },
};

// Self-update through GitHub Releases. One install at a time; background
// checks never interrupt (or flicker over) an install in progress.
const back = (state) => ({ target: state, when: (d) => !!d && d.prev === state });
const UPDATE = {
  id: 'update',
  desc: 'Self-update through GitHub Releases (check, download, unpack, restart).',
  initial: 'idle',
  states: {
    idle: { desc: 'Not checked yet (first check runs a few seconds after launch).', on: { CHECK: 'checking' } },
    checking: {
      desc: 'Asking GitHub for the latest release.',
      on: {
        FOUND: 'available',
        LATEST: 'current',
        NO_ASSET: 'noAsset',
        OFF: 'off',
        // A failed background check keeps what we already knew (an offer stays up).
        CHECK_FAILED: [back('available'), back('current'), back('noAsset'), { target: 'failed' }],
      },
    },
    off: { desc: 'Updates are off in this build (running from source, or no GitHub repo set).', on: {} },
    current: { desc: 'Up to date.', on: { CHECK: 'checking' } },
    available: { desc: 'A newer version is ready to install.', on: { CHECK: 'checking', INSTALL: 'downloading' } },
    noAsset: { desc: 'A newer version exists, but not for this computer yet.', on: { CHECK: 'checking' } },
    failed: { desc: 'The last check or install failed (the next check tries again).', on: { CHECK: 'checking' } },
    downloading: { desc: 'Downloading the new version.', on: { PROGRESS: 'downloading', UNPACK: 'installing', INSTALL_FAILED: 'failed' } },
    installing: { desc: 'Unpacking the new version.', on: { RESTART: 'restarting', INSTALL_FAILED: 'failed' } },
    restarting: { desc: 'The helper swaps the files and relaunches; this app exits.', on: {} },
  },
};

module.exports = { DRAWINGS, UPDATE };
