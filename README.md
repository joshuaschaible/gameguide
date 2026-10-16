# Game Guide

Share your game with a friend. They watch and draw; their marks show up on top of your game and fade after 4 seconds.

Standalone desktop app for Windows and macOS (Apple Silicon). No accounts, no game hooking: it captures a window or screen, like a screen share.

## Download

Get the latest from [Releases](../../releases/latest):

- **Windows:** `Game-Guide-Windows-v<version>.zip` → Extract All → run `Game Guide\Game Guide.exe` (SmartScreen: More info → Run anyway).
- **Mac:** `Game-Guide-Mac-v<version>.zip` → open it, right-click `Game Guide.app` → Open.

After that the app updates itself: when a new release is out it shows **Update available**.

## How it works

- The player shares a game window or a screen and sends an invite link (or a 6-character code).
- Pairing goes through the free PeerJS service; video and drawings then flow directly between the two computers (WebRTC, encrypted), with a free relay as a fallback.
- Drawings appear in a transparent, click-through overlay on the player's game, only while marks are visible.
- Stalls, alt-tab, recreated game windows and dropped video recover automatically.

## Develop

```sh
npm run setup
npm start          # run from source
npm test           # two-app end-to-end test (local PeerJS server)
npm run package    # Mac arm64 + Windows x64 into dist/
```

The product name, link scheme, app ID and GitHub repo live in `app/brand.json`; change them there to rename.

## Releasing

Bump `version` in `app/package.json`, commit, build with `npm run package`, sign the Mac app, zip both as `Game-Guide-Windows-v<version>.zip` / `Game-Guide-Mac-v<version>.zip`, and publish a GitHub release tagged `v<version>` with those two files. Installed copies pick it up within a couple of minutes.

`.github/workflows/release.yml` can do all of this on GitHub's machines (run it from the Actions tab); once the signing secrets below are added it can be switched to run on every pushed tag. The Mac build is signed with a self-signed certificate stored in the `MAC_SIGN_CERT` / `MAC_SIGN_KEY` repo secrets so macOS keeps its permissions across updates.

The invite page (`site/join/`) is published to GitHub Pages by `.github/workflows/pages.yml`.

Plans for multiplayer and hosting: [docs/multiplayer-and-relay-plan.md](docs/multiplayer-and-relay-plan.md).
