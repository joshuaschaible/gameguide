'use strict';
/* The session lifecycle on one computer: which phase of sharing or watching
 * we're in. app.js runs it (window.__app.machines.session), test/unit checks
 * it, scripts/machines.mjs draws it into docs/state-machines.md.
 *
 * The phase is the single source of truth for "is a session on" (S.ended),
 * "is the drawing link being rebuilt" (S.relinking) and what the header shows
 * (End button, "+" invite). Connections themselves stay in S.peer/S.conn/S.call.
 *
 * Convention: change S.* first, then send the event, so anything that redraws
 * on the transition sees the finished change.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SESSION = {
    id: 'session',
    desc: 'One session on this computer: sharing (host.*) or watching (viewer.*).',
    initial: 'idle',
    on: { RESET: 'idle' }, // teardown(): from any phase
    states: {
      idle: {
        desc: 'No session: name, home or join screen.',
        on: { SHARE: 'host.capturing', JOIN: 'viewer.joining', REJOIN: 'viewer.rejoining' },
      },

      // ---- sharing ----
      'host.capturing': { desc: 'Source picked; starting the screen capture.', on: { CAPTURED: 'host.registering' } },
      'host.registering': { desc: 'Getting a code from the pairing service (keeps retrying while offline).', on: { REGISTERED: 'host.waiting' } },
      'host.waiting': {
        desc: 'Code shown; waiting for a friend to enter it.',
        on: { VIEWER_FOUND: 'host.connecting', OFFLINE: 'host.registering' },
      },
      'host.connecting': {
        desc: 'A friend found the code; opening the drawing link.',
        on: { LINK_OPEN: 'host.live', VIEWER_FOUND: 'host.connecting', LINK_TIMEOUT: 'host.waiting', VIEWER_GONE: 'host.waiting', OFFLINE: 'host.registering' },
      },
      'host.live': {
        desc: 'Friend is watching and can draw.',
        on: { LINK_LOST: 'host.relinking', RELINKED: 'host.live', VIEWER_FOUND: 'host.connecting', VIEWER_GONE: 'host.waiting' },
      },
      'host.relinking': {
        desc: 'Drawing link dropped; video stays up while the friend rebuilds it (up to 20 s).',
        on: { RELINKED: 'host.live', VIEWER_FOUND: 'host.connecting', VIEWER_GONE: 'host.waiting' },
      },

      // ---- watching ----
      'viewer.joining': {
        desc: 'Looking up the code and opening the drawing link.',
        on: { LINK_OPEN: 'viewer.awaitingVideo' },
      },
      'viewer.awaitingVideo': {
        desc: 'Drawing link open; waiting for the video.',
        on: { VIDEO: 'viewer.watching', RELINK: 'viewer.relinking' },
      },
      'viewer.watching': {
        desc: 'Video playing; marks go to the player.',
        on: { VIDEO: 'viewer.watching', RELINK: 'viewer.relinking' },
      },
      'viewer.relinking': {
        desc: 'Drawing link dropped; rebuilding it while the video keeps playing.',
        on: {
          RELINK: 'viewer.relinking', // another try
          VIDEO: 'viewer.relinking', // a rebuilt video call can arrive meanwhile
          RELINKED: [{ target: 'viewer.watching', when: (d) => !!(d && d.video) }, { target: 'viewer.awaitingVideo' }],
        },
      },
      'viewer.rejoining': {
        desc: 'Waiting a moment, then joining again with the same code (video stayed down, or the player is updating).',
        on: {}, // leaves through RESET: joinFriend() tears down, then sends JOIN
      },
    },
  };
  return { SESSION };
}));
