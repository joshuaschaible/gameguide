# Multiplayer & relay cost plan

As of 2026-10-16. Decision: stay peer-to-peer for now; this is the back-burner plan.

## Today (free)
1. Pairing: PeerJS's free public service (0.peerjs.com) matches the 6-character code.
2. Direct connection: video + drawings go straight between the two computers (WebRTC), encrypted end to end.
3. Backup connection: if a direct path is blocked, PeerJS's free TURN relay forwards the encrypted packets. It can't see or change the stream.

What third parties see: PeerJS sees when each app connects and its IP address, not the screen. On a direct connection the two players see each other's IP. The free services can be slow or go down. Only send codes / invite links to people you'd want watching.

## Option A: own relay (Cloudflare TURN), ~1 hour
1. Cloudflare dashboard > Realtime > create a TURN key (key ID + API token; long-term secret).
2. Small Cloudflare Worker (free plan: 100,000 requests/day) calls
   `POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers` with `{"ttl": 7200}` and returns short-lived credentials.
3. The app asks the Worker for credentials per session and uses them as the backup connection.
4. The key never ships in the app; credentials expire and can be revoked.

## Option B: multiplayer (Cloudflare Realtime SFU), a few days
1. Create a Realtime SFU app (app ID + secret).
2. The same Worker holds the secret, creates sessions, tracks rooms. Cloudflare runs the media server.
3. Streamer publishes once; each viewer subscribes. Streamer upload stays flat.
4. Drawings stay peer-to-peer, tagged with each viewer's name/avatar (chips already exist in 1.5.0).
5. Cap rooms at 4 viewers to start.

## Pricing (Cloudflare Realtime)
- $0.05 per GB sent out by Cloudflare (egress). Data sent in is free.
- First 1,000 GB each month free, shared by SFU and TURN (not separate allowances).
- Traffic between Cloudflare's TURN and SFU isn't charged twice.

| Quality setting | Data per viewer-hour | Free viewer-hours/month | Cost per viewer-hour after |
| --- | --- | --- | --- |
| Low (4 Mbps) | 1.8 GB | ~555 | $0.09 |
| Medium (8 Mbps) | 3.6 GB | ~277 | $0.18 |
| High (12 Mbps) | 5.4 GB | ~185 | $0.27 |
| Very high (20 Mbps) | 9.0 GB | ~111 | $0.45 |

Worst cases (the setting is a maximum). Example: 3 viewers x 2 h x 12 sessions at 8 Mbps = 72 viewer-hours = ~260 GB = $0.

## Keeping strangers from running up the bill
1. Direct (peer-to-peer) stays the default; Cloudflare only for sessions that need it.
2. No keys in the app; the Worker hands out credentials that expire (e.g. 2 h).
3. Worker limits: sessions per IP per hour, 4 viewers per room, max session length (e.g. 4 h).
4. Cloudflare usage notifications on.
5. Optional: Discord sign-in only for multiplayer rooms (real accounts, avatars); 1:1 stays sign-in free.

## Free multiplayer first
Peer-to-peer mesh: each viewer gets their own copy from the streamer, so upload grows with the room (3 viewers x 8 Mbps = ~24 Mbps up). Fine for 2-4 friends; move to the SFU past 4 or on slow uploads.

## Maybe-list
| Feature | Effort | Notes |
| --- | --- | --- |
| Multiplayer, names on marks | Medium | Peer-to-peer up to 4 first |
| Session chat bar | Small | Rides the drawing connection |
| Webcam | Medium | Separate from audio (video-only works, e.g. signing) |
| Voice | Medium-large | Echo control + mixing with game sound |
| Discord status | Small-medium | Status only or ask-to-join; never open joining |

Sources: https://developers.cloudflare.com/realtime/pricing/ ·
https://developers.cloudflare.com/realtime/turn/generate-credentials/ ·
https://developers.cloudflare.com/workers/platform/pricing/
