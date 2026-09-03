# GSend

Send files and text straight from one browser to another. Pick what to send, hand over
a 4-digit code, and the other device receives it the moment it enters the code — over a
direct WebRTC connection, so the files never touch a server.

Live at **[gsend.cc](https://gsend.cc)**.

## How it works

```
Browser A  ──WebSocket──►  Cloudflare Worker  ◄──WebSocket──  Browser B
   │         (4-digit code, SDP + ICE only)                       │
   └──────────────── WebRTC DataChannel (the actual bytes) ───────┘
```

1. **A** picks the files or text to send, then asks for a code. The Worker reserves a
   random 4-digit code, valid for 60 seconds.
2. **B** enters the code or scans the QR, choosing a folder to receive into on the same
   click. The code is burned on first use.
3. The two browsers exchange SDP and ICE candidates through the Worker and hole-punch
   a direct connection. The server never sees file content.
4. The queue starts moving as soon as the data channel opens — no second confirmation.
   **A** sees the device arrive and can stop the session at any point.
5. Both sides stay connected and can keep sending files and text until either closes
   the page.

The server's only job is introductions. It stores a session's keys and expiry in a
Durable Object and nothing else — no accounts, no database, no file storage, no logs
of what was sent.

## Security model

A 4-digit code is only 10,000 possibilities, so it is protected by three things at once:

- the code expires 60 seconds after it is created;
- it is burned the moment one device joins, so a guesser gets "already used";
- joins are rate limited per IP (12 attempts per minute).

There is deliberately no approval step: the point of the flow is that entering the code
is enough to start receiving. That trades away a fourth protection, so the sender is
told the instant a device is through and can stop the session mid-transfer from the
same screen. A guesser who lands inside the 60-second window gets what is queued, which
is the cost of the shorter path; a distributed attacker with enough addresses to cover
10,000 codes in a minute is the case this does not defend against.

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
3. 開兩個視窗:一邊拖進檔案後按 **產生數字碼**,另一邊輸入該碼按 **加入並接收**。
4. 加入時會跳出資料夾選擇器(Chromium 桌面版);選好之後檔案就會直接寫進去,
   不需要再按同意。兩邊接著可以繼續互傳檔案和文字。
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
| `src/core/sink.ts` | Where received bytes land: the person's own folder, OPFS, or memory |
| `src/core/opfs-worker.ts` | Owns the filesystem handles off the main thread |
| `src/ui/` | React screens |
| `public/` | Manifest, icons, service worker, privacy page |
| `scripts/make-icons.mjs` | Regenerates the icon PNGs (`npm run icons`) |

## Current status

Working and verified browser-to-browser: staging files before the code exists, code
pairing, QR deep links, file transfer in both directions (byte-exact at 32 MB), the text
channel, per-file progress and cancel, and the join error paths. Verified on real
devices over a real network, not just two tabs on one machine.

**Reconnection** survives a page reload on either side: session credentials live in
`sessionStorage`, each page load carries an instance id so a peer can tell a network
blip (keep the connection, restart ICE) from a reload (rebuild the connection), and
the client retries for the same five minutes the server keeps the room open. Mobile
Safari needs this because it closes the signalling socket and suspends WebRTC when a
tab goes to the background, and a bfcache restore does not reliably report it.

**Received files stream to disk**, not into tab memory, and there is no fixed size
ceiling. Where the File System Access API exists (Chromium desktop), the receiver picks
a folder on the click that joins — that click is the user activation the picker needs,
and it cannot be deferred until the file list arrives — and every chunk is written
straight into the destination file. Nothing is buffered on the way, so the limit is free
disk space and a finished file is already saved. The trade is that those writes are
committed by the browser only when the stream closes: a dropped connection is survivable
because the stream outlives it, but a page reload is not, so a half-received file on that
path is not offered for resume.

Everywhere else the bytes go to the origin-private filesystem through a dedicated worker
and a sync access handle, which is the one OPFS write path available on every target
(Chrome 102, Chrome Android 109, Firefox 111, Safari and iOS Safari 15.2). That path is
quota-bound, so the per-file ceiling is derived from what the origin actually reports
rather than hard-coded — several GB on a typical desktop — falling to 256 MB only where
OPFS is unusable, such as Safari private browsing. Either way the receiving side is the
one that refuses a file it has no room for, since only it can see its own storage.

**Anonymous connection counts** are recorded so the TURN question can be settled with
evidence: one record per session saying whether a direct connection worked and whether
it was made over a local network or punched through NAT. No addresses, no timestamps
beyond the day, no session identifiers, nothing tied to a person. The totals are public
at `/api/stats`.

**A received file stays available until it is saved.** On the browser-storage path it
sits in the origin-private filesystem, and its row survives a reload, a dropped
connection, and the session going quiet — the download link is rebuilt from the file on
disk. Backgrounding a phone mid-transfer no longer costs you the file. On the
direct-to-disk path there is nothing to keep available: the file is already where it was
asked to go, and the row says so instead of offering a save button.

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
Sharing to GSend opens a session and shows the code straight away, with the shared files
already queued — the same path the landing screen now takes, since a share is a
statement of intent and should not land on an empty screen. Chromium only: Safari has no
share target.

**A relay for the connections STUN cannot make.** Mobile carriers put customers behind
carrier-grade NAT, where hole punching simply cannot work, so phone-to-desktop across
networks used to fail outright. Cloudflare Realtime TURN now covers those cases. The first
attempt runs without the relay at all; if nothing has connected within a few seconds —
or ICE fails outright — the relay is added to the same connection and ICE restarted.
Direct pairs keep being checked and still win when they exist, so a session that can go
direct never spends relay traffic, and one that cannot connects a few seconds later
over TURN, including TURN over TLS on port 443 for networks that block UDP entirely.
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
