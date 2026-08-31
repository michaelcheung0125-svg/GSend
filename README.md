# GSend

Send files and text straight from one browser to another. Pair two devices with a
4-digit code, then transfer over a direct WebRTC connection — the files never touch
a server.

Live at **[gsend.cc](https://gsend.cc)**.

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
npm run icons       # regenerate the app icons after changing the artwork
```

### Enabling the relay (optional)

Without this the app works, but connections that need a relay will fail. Create a TURN
key under **Realtime → TURN** in the Cloudflare dashboard, then:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Cloudflare Realtime TURN includes 1,000 GB of relayed traffic per month, then charges
$0.05/GB. `/api/stats` reports how many sessions actually used the relay.

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
| `worker/turn.ts` | Mints short-lived relay credentials, STUN-only without a key |
| `shared/protocol.ts` | Message types shared by the browser and the Worker |
| `src/core/peer.ts` | RTCPeerConnection, perfect negotiation, data channels |
| `src/core/transfer.ts` | Chunked file transfer, backpressure, acks, resume |
| `src/core/client.ts` | Session state machine the UI subscribes to |
| `src/core/sink.ts` | OPFS streaming storage for received files |
| `src/core/opfs-worker.ts` | Owns the filesystem handles off the main thread |
| `src/ui/` | React screens |
| `public/` | Manifest, icons, service worker, privacy page |
| `scripts/make-icons.mjs` | Regenerates the icon PNGs (`npm run icons`) |

## Current status

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

**Installable.** A web app manifest and a small service worker make GSend addable to a
home screen or installed from the address bar. On iOS this matters beyond the icon: an
installed copy gets its own storage treatment instead of sharing Safari's, which is
where received files wait to be saved. The worker is deliberately narrow — documents
always come from the network, and only content-hashed build assets are served from
cache — so an installed copy can never get stuck on an old version.

**English and Traditional Chinese**, detected from the browser and switchable from the
header. Because the two devices may be reading different languages, a stopped transfer
travels as a code rather than a sentence and is phrased by whoever is looking at the
screen — cancel from an English device and the Chinese one says 傳送方已取消.

**Shareable from the system.** An installed copy appears in Android's share sheet.
Sharing to GSend opens a session and shows the code straight away, holding the files
until the other device is approved — a share is a statement of intent, so it should not
land on an empty screen. Chromium only: Safari has no share target.

**A relay for the connections STUN cannot make.** Mobile carriers put customers behind
carrier-grade NAT, where hole punching simply cannot work, so phone-to-desktop across
networks used to fail outright. Cloudflare Realtime TURN now covers those cases. Relay
candidates are the lowest-priority kind in ICE, so a session that can go direct still
does and costs nothing; only the ones that would otherwise have failed use the relay.
Credentials are minted per session by the Worker and never reach the browser as a key.
With no relay configured the app falls back to STUN alone and behaves exactly as before.

**A privacy page** at [/privacy](https://gsend.cc/privacy) sets out exactly what the
server handles, what it never receives, what stays on your device, and who else is
involved (the host, and the STUN servers that see an IP address during connection
setup). In English and Traditional Chinese.

Known gaps, all scheduled:
- **`showSaveFilePicker()` is not used yet.** On Chromium desktop and Chrome Android it
  would let a large file stream straight to the user's chosen location instead of being
  handed over as a blob afterwards. Safari and Firefox have no picker, so the blob path
  has to exist regardless.
- **Cancelling a large transfer takes a few seconds to reach the other side.** Control
  messages ride a separate channel, but they share one congestion-controlled transport
  with the bytes already queued, so a cancel waits behind them. The sender stops
  immediately; the receiver's row catches up shortly after.

See `PLAN.md` for the full roadmap and the decisions behind it.

## Licence

MIT.
