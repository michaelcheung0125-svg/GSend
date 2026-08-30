# GSend

Send files and text straight from one browser to another. Pair two devices with a
4-digit code, then transfer over a direct WebRTC connection — the files never touch
a server.

> The domain is not registered yet (see `PLAN.md` §6).

## How it works

```
Browser A  ──WebSocket──►  Cloudflare Worker  ◄──WebSocket──  Browser B
   │         (4-digit code, SDP + ICE only)                       │
   └──────────────── WebRTC DataChannel (the actual bytes) ───────┘
```

1. **A** opens a session. The Worker reserves a random 4-digit code, valid for 60 seconds.
2. **B** enters the code or scans the QR. The code is burned on first use.
3. The two browsers exchange SDP and ICE candidates through the Worker and hole-punch
   a direct connection. The server never sees file content.
4. **A** sees "a device connected" and presses **Approve**. Only then does anything move.
5. Both sides can then send files and text until either closes the page.

The server's only job is introductions. It stores a session's keys and expiry in a
Durable Object and nothing else — no accounts, no database, no file storage, no logs
of what was sent.

## Security model

A 4-digit code is only 10,000 possibilities, so it is protected by four things at once:

- the code expires 60 seconds after it is created;
- it is burned the moment one device joins, so a guesser gets "already used";
- joins are rate limited per IP (12 attempts per minute);
- nothing transfers until the sender explicitly approves the device that joined.

Resuming after a network drop uses a 256-bit session key, not the code.

## Running it locally

```bash
npm install
npm run dev      # http://localhost:5173 — runs the app and the Worker together
```

Open the page in two browser windows to test a transfer against yourself.

Other commands:

```bash
npm run check    # TypeScript across the app, the Worker and the Vite config
npm run build    # production build into dist/
npm run deploy   # build, then deploy the Worker + static assets to Cloudflare
npm run cf-typegen  # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

### 中文快速開始

1. `npm install` 安裝套件(只需一次)。
2. `npm run dev`,瀏覽器開 `http://localhost:5173`。
3. 開兩個視窗:一邊按 **Start a session** 拿到 4 位數字碼,另一邊輸入該碼。
4. 第一個視窗按 **Approve**,兩邊就能互傳檔案和文字。
5. 要上線時執行 `npm run deploy`(需要先 `npx wrangler login`)。

## Deploying

First time only:

```bash
npx wrangler login
npm run deploy
```

The Worker serves both the static site and the `/api/ws` signalling endpoint from one
origin, so there is nothing else to host. Durable Objects run on Cloudflare's free plan
(they are declared as SQLite-backed classes in `wrangler.jsonc`).

## Layout

| Path | What lives there |
| --- | --- |
| `worker/index.ts` | Routes `/api/ws`, allocates codes, rate limits joins |
| `worker/session-room.ts` | One Durable Object per code: pairing, relaying SDP/ICE, expiry |
| `worker/join-guard.ts` | Per-IP token bucket against code brute-forcing |
| `shared/protocol.ts` | Message types shared by the browser and the Worker |
| `src/core/peer.ts` | RTCPeerConnection, perfect negotiation, data channels |
| `src/core/transfer.ts` | Chunked file transfer, backpressure, acks, resume |
| `src/core/client.ts` | Session state machine the UI subscribes to |
| `src/ui/` | React screens |

## Current status (M1)

Working and verified browser-to-browser: code pairing, QR deep links, the approval
gate, file transfer in both directions (byte-exact at 32 MB), the text channel,
per-file progress and cancel, and the join error paths. Verified on real devices over
a real network, not just two tabs on one machine.

**Reconnection** survives a page reload on either side: session credentials live in
`sessionStorage`, each page load carries an instance id so a peer can tell a network
blip (keep the connection, restart ICE) from a reload (rebuild the connection), and
the client retries for the same five minutes the server keeps the room open. Mobile
Safari needs this because it closes the signalling socket and suspends WebRTC when a
tab goes to the background, and a bfcache restore does not reliably report it.

Known gaps, all scheduled:

- **File size is capped at 256 MB (200 MB on Safari)** because received bytes are held
  in memory. M2 swaps in streaming sinks (File System Access on Chromium desktop, OPFS
  elsewhere) to reach the 1 GB target.
- **A transfer in flight when a peer reloads is cancelled, not resumed.** The receiver's
  buffered bytes die with the page, so both halves stop with a message. Resume across a
  reload needs the streaming sinks above; resume across a network blip already works.
- **No TURN server.** If both devices sit behind strict NATs the connection fails with
  a message suggesting the same Wi-Fi. M2/M3 measure how often that actually happens
  before deciding whether to pay for a relay.
- No PWA install, no i18n toggle yet — both scheduled after M1.

See `PLAN.md` for the full roadmap and the decisions behind it.

## Licence

MIT.
