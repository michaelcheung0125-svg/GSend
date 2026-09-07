/**
 * Wire protocol between the browser app and the Cloudflare Worker signalling server.
 * Shared by `worker/` and `src/` so both sides cannot drift apart.
 */

export const CODE_LENGTH = 4;

/** How long a freshly created code stays joinable (PLAN.md §2). */
export const CODE_TTL_MS = 60_000;

/**
 * How long a paired session is kept alive with no sockets attached.
 * This is what makes resume-after-network-switch possible: the code is long gone,
 * but the session (and its keys) survive for this window.
 */
export const RESUME_GRACE_MS = 5 * 60_000;

/** A paired session with no traffic at all is reaped after this long. */
export const SESSION_IDLE_MS = 60 * 60_000;

/** Brute-force guard for the 4-digit code, per client IP. */
export const JOIN_ATTEMPT_LIMIT = 12;
export const JOIN_ATTEMPT_WINDOW_MS = 60_000;

/** Signalling payloads are SDP and ICE candidates only; anything larger is abuse. */
export const MAX_SIGNAL_BYTES = 64 * 1024;

// --- paired devices ---------------------------------------------------------

/**
 * How long one derived rendezvous name stays in use. Deriving it once and for all
 * would hand the server a permanent identifier for a person's set of devices; rotating
 * it means the name says nothing beyond "these sockets belong together right now".
 *
 * The window is long because devices only agree by having roughly the same clock, and
 * short because that is the whole point. Six hours is far more than browser clock skew
 * and far less than a useful tracking horizon.
 */
export const GROUP_WINDOW_MS = 6 * 60 * 60_000;

/** Domain separator, so the derived name can never collide with another use of the key. */
export const RENDEZVOUS_LABEL = "gsend-rendezvous-v1:";

/** A rendezvous room holds one person's devices, not a crowd. */
export const MAX_GROUP_DEVICES = 8;

/** Rendezvous names are a full HMAC-SHA256 in hex; device ids are a truncated hash. */
export function isRendezvousName(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

export function isDeviceId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id);
}

/** Who else is in the rendezvous room. Identity is proved peer to peer, not here. */
export interface GroupPeer {
  id: string;
}

export type GroupServerMessage =
  /** Sent on arrival: everyone already in the room. */
  | { t: "group"; self: string; peers: GroupPeer[] }
  | { t: "joined"; peer: GroupPeer }
  | { t: "left"; peer: string }
  | { t: "from"; peer: string; data: unknown }
  | { t: "ice"; iceServers: IceServer[] }
  | { t: "error"; code: ServerErrorCode; message: string };

export type GroupClientMessage =
  | { t: "to"; peer: string; data: unknown }
  | { t: "ice" };

export type Role = "host" | "guest";

export type ServerErrorCode =
  | "code_not_found"
  | "code_expired"
  | "session_full"
  | "bad_key"
  | "rate_limited"
  | "no_capacity"
  | "bad_request";

/** Why a room shut down, as a code so each side can phrase it in its own language. */
export type ClosedReason = "peer-left" | "idle";

export type ServerMessage =
  | {
      t: "hello";
      role: Role;
      code: string;
      sessionKey: string;
      joinExpiresAt: number;
      peerPresent: boolean;
    }
  | { t: "peer-joined" }
  | { t: "peer-left" }
  | { t: "peer-resumed" }
  | { t: "signal"; data: unknown }
  | { t: "ice"; iceServers: IceServer[] }
  | { t: "code-expired" }
  | { t: "closed"; reason: ClosedReason }
  | { t: "error"; code: ServerErrorCode; message: string };

export type ConnectionOutcome = "connected" | "failed";

/**
 * How the two browsers ended up talking. `lan` means both candidates were local, so
 * the devices were on the same network; `internet` means hole punching across NATs
 * actually worked. The ratio of these to `failed` is the evidence for whether this
 * project ever needs to pay for a TURN relay (PLAN.md §3.2).
 */
export type ConnectionPath = "lan" | "internet" | "relay" | "unknown";

/** What a browser needs to hand to RTCPeerConnection. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ClientMessage =
  | { t: "signal"; data: unknown }
  /** Ask the room for relay credentials; the socket is already authenticated. */
  | { t: "ice" }
  | { t: "stat"; outcome: ConnectionOutcome; path: ConnectionPath }
  | { t: "bye" };

export interface DayCounts {
  connectedLan: number;
  connectedInternet: number;
  /** Hole punching failed and the bytes went through the relay — the billable case. */
  connectedRelay: number;
  connectedUnknown: number;
  failed: number;
}

export const EMPTY_DAY: DayCounts = {
  connectedLan: 0,
  connectedInternet: 0,
  connectedRelay: 0,
  connectedUnknown: 0,
  failed: 0,
};

export function isValidCode(code: string): boolean {
  return new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code);
}

export const ERROR_TEXT: Record<ServerErrorCode, string> = {
  code_not_found: "That code does not exist. Check the digits and try again.",
  code_expired: "That code has expired. Ask for a fresh one.",
  session_full: "That code has already been used by another device.",
  bad_key: "This session could not be resumed.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  no_capacity: "The server is busy right now. Try again in a moment.",
  bad_request: "Malformed request.",
};
