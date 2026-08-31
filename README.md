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

**Received files stream to disk**, not into tab memory: a dedicated worker writes each
chunk into the origin-private filesystem through a sync access handle, which is the one
OPFS write path available on every target (Chrome 102, Chrome Android 109, Firefox 111,
Safari and iOS Safari 15.2). The limit is 1 GB per file, dropping to 256 MB only where
OPFS is unusable, such as Safari private browsing. The receiving side refuses a file it
does not have room for, since only it can see its own storage.

**Anonymous connection counts** are recorded so the TURN question can be settled with
evidence: one record per session saying whether a direct connection worked and whether
it was made over a local network or punched through NAT. No addresses, no timestamps
beyond the day, no session identifiers, nothing tied to a person. The totals are public
at `/api/stats`.

**A received file stays available until it is saved.** It sits in the origin-private
filesystem, and its row survives a reload, a dropped connection, and the session going
quiet — the download link is rebuilt from the file on disk. Backgrounding a phone
mid-transfer no longer costs you the file.

**A receiver can reload mid-transfer and carry on.** The bytes are already on disk, and
the transfer's metadata rides along in `sessionStorage`, so a reloaded page reopens the
file, asks it how many bytes actually arrived, and tells the sender where to pick up.
The byte count is read from the file rather than remembered, so it cannot drift.
Verified by reloading the receiver 19 MB into a 128 MB transfer: it finished byte-exact.

**A sender cannot resume across its own reload, ever.** A browser will not let a page
re-read a file the user picked before a reload, so that side has to re-pick it. That is
a platform rule, not a gap to close, so the reloaded sender tells the other side to stop
waiting instead of leaving a row stuck at a percentage.

Known gaps, all scheduled:
- **No TURN server.** If both devices sit behind strict NATs the connection fails with
  a message suggesting the same Wi-Fi. The counts above are what will decide whether
  paying for a relay is warranted.
- **`showSaveFilePicker()` is not used yet.** On Chromium desktop and Chrome Android it
  would let a large file stream straight to the user's chosen location instead of being
  handed over as a blob afterwards. Safari and Firefox have no picker, so the blob path
  has to exist regardless.
- No PWA install, no i18n toggle yet — both scheduled after M1.

See `PLAN.md` for the full roadmap and the decisions behind it.

## Licence

MIT.
