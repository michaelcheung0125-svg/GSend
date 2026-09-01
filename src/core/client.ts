import {
  RESUME_GRACE_MS,
  isValidCode,
  type ConnectionOutcome,
  type ConnectionPath,
  type IceServer,
  type Role,
  type ServerErrorCode,
  type ServerMessage,
} from "../../shared/protocol";
import type { Message } from "../i18n/strings";
import { PeerLink, STUN_ONLY, type PeerChannels, type PeerState } from "./peer";
import { clearSession, loadSession, saveSession } from "./session-store";
import { Signaling } from "./signaling";
import { TransferEngine, type TextMessage, type TransferView } from "./transfer";

export type Phase =
  | "idle"
  | "creating"
  | "hosting"
  | "joining"
  | "pairing"
  | "active"
  | "ended";

export type Approval = "pending" | "granted" | "rejected";

export interface Snapshot {
  phase: Phase;
  role: Role | null;
  code: string | null;
  joinExpiresAt: number | null;
  shareUrl: string | null;
  peerPresent: boolean;
  /** When the other device dropped off, so the UI can explain the wait. */
  peerAbsentSince: number | null;
  connection: PeerState;
  approval: Approval;
  channelsOpen: boolean;
  outgoing: TransferView[];
  incoming: TransferView[];
  texts: TextMessage[];
  /** Files handed over by the share sheet, waiting for a peer to connect. */
  pendingShare: { files: number; text: boolean } | null;
  notice: Message | null;
  error: Message | null;
}

const PROGRESS_THROTTLE_MS = 40;
const MAX_RECONNECT_DELAY_MS = 15_000;
/** ICE restarts often recover, so a failure only counts once it stops recovering. */
const FAILURE_CONFIRM_MS = 15_000;
/** Never hold a connection back waiting for relay credentials that may not arrive. */
const ICE_REQUEST_TIMEOUT_MS = 3_000;
/**
 * ICE keeps checking after the channels open and can settle on a better pair than the
 * one that happened to validate first, so the path is read once it has stopped moving.
 * Reading it immediately reports a race, not a route.
 */
const PATH_SETTLE_MS = 5_000;
/**
 * How long a direct-only attempt gets before the relay is brought in. ICE priority
 * makes relay lowest-ranked, but rank only orders pairs that finish checking together
 * — in practice a relay pair often validates first and then keeps the connection for
 * its whole life. Measured between two tabs on one machine, every session went through
 * the relay despite an obvious direct path. Withholding the relay until a *failure* was
 * tried and reverted: ICE can sit in "checking" indefinitely without ever failing. A
 * deadline is the only trigger that actually fires, so the first attempt runs without
 * relay servers and this timer brings them into the same connection if nothing has
 * opened in time. Direct connections have measured 1–3 s; this leaves headroom.
 */
const RELAY_AFTER_MS = 6_000;

interface Credentials {
  code: string;
  sessionKey: string;
  role: Role;
}

/** Sent over the signalling relay so each side can tell a blip from a reload. */
interface InstanceAnnouncement {
  instance: string;
}

export class GSendClient {
  private readonly signaling: Signaling;
  private readonly transfer: TransferEngine;
  private peer: PeerLink | null = null;

  /**
   * Identifies this page load. A peer that comes back with a different id has a brand
   * new RTCPeerConnection, so our half of the old one can never be revived.
   */
  private readonly instanceId = crypto.randomUUID();
  private remoteInstance: string | null = null;

  private phase: Phase = "idle";
  private role: Role | null = null;
  private credentials: Credentials | null = null;
  private joinExpiresAt: number | null = null;
  private peerPresent = false;
  private peerAbsentSince: number | null = null;
  private connection: PeerState = "new";
  private approval: Approval = "pending";
  private channelsOpen = false;
  private texts: TextMessage[] = [];
  private pendingFiles: File[] = [];
  private pendingText: string | null = null;
  private notice: Message | null = null;
  private error: Message | null = null;

  private closedByUser = false;
  private reconnectAttempt = 0;
  /** Retry until this moment, matching how long the server keeps the room. */
  private reconnectDeadline: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private peerTimer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private failureTimer: ReturnType<typeof setTimeout> | null = null;
  private statReported = false;
  private iceServersPromise: Promise<IceServer[]> | null = null;
  private resolveIceServers: ((servers: IceServer[]) => void) | null = null;
  private startingPeer = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private escalateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Everything the server offered, relay included, kept for escalation. */
  private iceServersFull: IceServer[] | null = null;
  /** Once true, every connection this session builds starts with the relay in play. */
  private relayNeeded = false;

  private listeners = new Set<() => void>();
  /** Built at the end of the constructor, once the engines it reads from exist. */
  private snapshot!: Snapshot;

  constructor() {
    this.signaling = new Signaling({
      onOpen: () => {
        this.reconnectAttempt = 0;
        this.reconnectDeadline = null;
      },
      onMessage: (msg) => this.onServerMessage(msg),
      onClose: (code) => this.onSignalingClosed(code),
    });

    this.transfer = new TransferEngine({
      sendControl: (msg) => this.peer?.sendControl(JSON.stringify(msg)) ?? false,
      onChange: () => this.emitSoon(),
      onText: (msg) => {
        this.texts = [...this.texts, msg];
        this.emitNow();
      },
      onTransfersChanged: () => this.persist(),
    });

    this.installLifecycleHandlers();
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  // --- commands ------------------------------------------------------------

  host(): void {
    this.resetSession();
    this.phase = "creating";
    this.role = "host";
    this.emitNow();
    this.signaling.connect({ role: "host" });
  }

  join(code: string): void {
    if (!isValidCode(code)) {
      this.error = { key: "error.badCode" };
      this.emitNow();
      return;
    }
    this.resetSession();
    this.phase = "joining";
    this.role = "guest";
    this.emitNow();
    this.signaling.connect({ role: "guest", code });
  }

  /** Rejoin the room this tab was in before it reloaded. */
  restore(): boolean {
    const stored = loadSession();
    if (!stored) return false;

    this.resetSession();
    this.role = stored.role;
    this.credentials = {
      code: stored.code,
      sessionKey: stored.sessionKey,
      role: stored.role,
    };
    this.approval = stored.approved ? "granted" : "pending";
    this.phase = "pairing";
    this.reconnectDeadline = Date.now() + RESUME_GRACE_MS;
    this.persist();
    this.emitNow();

    // Reopen the partly received files before reconnecting: the offsets we report on
    // attach come from those files, and an empty report tells the sender to give up.
    void this.transfer
      .restore(stored.incoming, stored.outgoing)
      .finally(() => this.resumeSignaling());

    return true;
  }

  /**
   * Take files from the system share sheet. Sharing to GSend is a statement of intent,
   * so an idle app opens a session immediately and shows the code; the files then go
   * the moment the other device is approved.
   */
  stageShared(files: File[], text: string | null): void {
    if (this.phase === "idle") this.host();

    // Set after host(), which resets the session and would otherwise clear these.
    this.pendingFiles = files;
    this.pendingText = text;
    this.flushPendingShare();
    this.emitNow();
  }

  private flushPendingShare(): void {
    if (this.approval !== "granted") return;

    if (this.pendingFiles.length > 0) {
      this.notice = this.transfer.sendFiles(this.pendingFiles);
      this.pendingFiles = [];
    }
    if (this.pendingText !== null) {
      this.transfer.sendText(this.pendingText);
      this.pendingText = null;
    }
  }

  approve(): void {
    if (this.role !== "host" || this.approval !== "pending") return;
    this.peer?.sendControl(JSON.stringify({ t: "approve" }));
    this.approval = "granted";
    this.phase = "active";
    this.persist();
    this.flushPendingShare();
    this.emitNow();
  }

  reject(): void {
    if (this.role !== "host") return;
    this.peer?.sendControl(JSON.stringify({ t: "reject" }));
    this.end({ key: "error.declinedByYou" });
  }

  sendFiles(files: File[]): void {
    if (this.approval !== "granted") return;
    this.notice = this.transfer.sendFiles(files);
    this.emitNow();
  }

  sendText(body: string): void {
    const trimmed = body.trim();
    if (!trimmed || this.approval !== "granted") return;
    this.transfer.sendText(trimmed);
  }

  cancelTransfer(fileId: string): void {
    this.transfer.cancel(fileId);
  }

  dismissNotice(): void {
    this.notice = null;
    this.emitNow();
  }

  leave(): void {
    this.closedByUser = true;
    this.reportGiveUp();
    this.signaling.send({ t: "bye" });
    this.end(null);
  }

  /**
   * Someone waiting on a connection that never arrives gives up long before ICE admits
   * defeat, so without this the failures that matter most never reach the counters —
   * which is exactly the number the TURN decision rests on.
   */
  private reportGiveUp(): void {
    if (this.statReported) return;
    if (this.channelsOpen) {
      // Connected, but ended before the settle timer fired; the path is still worth
      // recording even if it had not fully quiesced.
      void this.reportStat("connected");
      return;
    }
    if (this.phase !== "pairing" && this.phase !== "joining") return;
    this.statReported = true;
    // Sent directly rather than through reportStat, whose await would land after the
    // socket has already been closed by end().
    this.signaling.send({ t: "stat", outcome: "failed", path: "unknown" });
  }

  // --- signalling ----------------------------------------------------------

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "hello":
        this.onHello(msg);
        break;

      case "peer-joined":
      case "peer-resumed":
        this.peerPresent = true;
        this.clearPeerAbsence();
        if (this.phase === "hosting") this.phase = "pairing";
        this.announceInstance();
        this.emitNow();
        break;

      case "peer-left":
        this.onPeerLeft();
        break;

      case "signal":
        this.onSignal(msg.data);
        break;

      case "ice":
        this.deliverIceServers(msg.iceServers);
        break;

      case "code-expired":
        this.end({ key: "error.nobodyJoined" });
        break;

      case "closed":
        this.end({ key: msg.reason === "peer-left" ? "error.peerEnded" : "error.sessionIdle" });
        break;

      case "error":
        this.onServerError(msg.code);
        break;
    }
  }

  private onHello(msg: Extract<ServerMessage, { t: "hello" }>): void {
    this.role = msg.role;
    this.credentials = { code: msg.code, sessionKey: msg.sessionKey, role: msg.role };
    this.joinExpiresAt = msg.joinExpiresAt;
    this.peerPresent = msg.peerPresent;
    this.error = null;
    this.persist();

    // A signalling reconnect says nothing about the peer connection, which usually
    // outlives it. Knocking an approved, connected session back to "pairing" here hid
    // the transfer list while bytes were still arriving underneath it.
    const established = this.approval === "granted" && this.channelsOpen;
    if (established) {
      this.phase = "active";
      // The bar was left saying "Reconnecting" by the signalling drop even though the
      // peer connection carrying the bytes never went anywhere.
      this.connection = "connected";
    } else if (msg.role === "host") {
      this.phase = msg.peerPresent ? "pairing" : "hosting";
    } else {
      this.phase = "pairing";
    }

    // Warm the credentials now so a peer arriving later does not wait on them.
    void this.requestIceServers();

    if (msg.peerPresent) {
      this.clearPeerAbsence();
      // Announced before any offer so the peer can rebuild first if we are new to it.
      this.announceInstance();
      void this.startPeer();
    }

    this.emitNow();
  }

  private onServerError(code: ServerErrorCode): void {
    const wasPaired = this.phase === "active" || this.phase === "pairing";
    const expired = code === "code_not_found" || code === "bad_key" || code === "session_full";

    this.closedByUser = true;
    // Mid-session these all mean the same thing to a person: the room is gone.
    this.error = wasPaired && expired
      ? { key: "error.expiredWhileAway" }
      : { key: `server.${code}` as const };
    this.phase = this.phase === "joining" ? "idle" : "ended";
    clearSession();
    this.emitNow();
  }

  private onSignalingClosed(code: number): void {
    if (this.closedByUser || this.phase === "idle" || this.phase === "ended") return;

    // 4000-range closes are deliberate refusals; the error message already arrived.
    if (code >= 4000 && code < 4100) return;

    if (!this.credentials) {
      this.end({ key: "error.serverLost" });
      return;
    }

    const now = Date.now();
    if (this.reconnectDeadline === null) this.reconnectDeadline = now + RESUME_GRACE_MS;
    if (now >= this.reconnectDeadline) {
      this.end({ key: "error.serverLost" });
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt += 1;
    this.connection = "reconnecting";
    this.emitNow();

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.resumeSignaling(), delay);
  }

  private resumeSignaling(): void {
    const creds = this.credentials;
    if (!creds) return;
    this.signaling.connect({
      role: "resume",
      code: creds.code,
      key: creds.sessionKey,
      as: creds.role,
    });
  }

  // --- peer identity -------------------------------------------------------

  private requestIceServers(): Promise<IceServer[]> {
    if (this.iceServersPromise) return this.iceServersPromise;

    this.iceServersPromise = new Promise<IceServer[]>((resolve) => {
      this.resolveIceServers = resolve;
      this.signaling.send({ t: "ice" });
      setTimeout(() => this.deliverIceServers(STUN_ONLY), ICE_REQUEST_TIMEOUT_MS);
    });
    return this.iceServersPromise;
  }

  private deliverIceServers(servers: IceServer[]): void {
    // Only the first delivery counts. The request has a fallback timeout that offers
    // STUN alone, and without this guard a slow-but-successful reply was overwritten
    // by that fallback — leaving escalation convinced there was no relay to add.
    const resolve = this.resolveIceServers;
    if (!resolve) return;
    this.resolveIceServers = null;

    const resolved = servers.length > 0 ? servers : STUN_ONLY;
    this.iceServersFull = resolved;
    resolve(resolved);
  }

  private announceInstance(): void {
    this.signaling.send({ t: "signal", data: { instance: this.instanceId } });
  }

  private onSignal(data: unknown): void {
    const announcement = data as Partial<InstanceAnnouncement> | null;
    if (announcement && typeof announcement.instance === "string") {
      this.onRemoteInstance(announcement.instance);
      return;
    }
    void this.peer?.handleSignal(data);
  }

  private onRemoteInstance(id: string): void {
    const previous = this.remoteInstance;
    this.remoteInstance = id;
    this.peerPresent = true;
    this.clearPeerAbsence();
    if (this.phase === "hosting") this.phase = "pairing";

    if (previous !== null && previous !== id) {
      // The peer reloaded. Its DTLS identity changed, so ICE restart cannot revive
      // our data channels — the whole connection has to be built again.
      this.rebuildPeer();
    } else {
      this.revivePeer();
    }

    this.emitNow();
  }

  /**
   * The peer is reachable again but our channels are not. An ICE restart is enough for
   * a connection that is merely struggling; one that has actually closed can only be
   * replaced, and leaving it be is what strands a session on "Connecting" forever.
   */
  private revivePeer(): void {
    if (!this.peer) {
      void this.startPeer();
      return;
    }
    if (this.channelsOpen) return;
    if (this.connection === "closed" || this.connection === "failed") this.rebuildPeer();
    else this.peer.restart();
  }

  private onPeerLeft(): void {
    this.peerPresent = false;
    this.peerAbsentSince = Date.now();
    if (this.phase === "active" || this.phase === "pairing") this.connection = "reconnecting";

    if (this.peerTimer) clearTimeout(this.peerTimer);
    this.peerTimer = setTimeout(() => {
      this.peerTimer = null;
      if (this.peerPresent) return;
      this.end({ key: "error.peerGone" });
    }, RESUME_GRACE_MS);

    this.emitNow();
  }

  private clearPeerAbsence(): void {
    this.peerAbsentSince = null;
    if (this.peerTimer) {
      clearTimeout(this.peerTimer);
      this.peerTimer = null;
    }
  }

  // --- peer ----------------------------------------------------------------

  /**
   * Relay credentials come from the server, so this waits for them — but only briefly.
   * A connection that could have worked over STUN must not be blocked by a relay it may
   * never need.
   */
  private async startPeer(): Promise<void> {
    if (this.peer || this.startingPeer || !this.role) return;
    this.startingPeer = true;

    let iceServers: IceServer[];
    try {
      iceServers = await this.requestIceServers();
    } finally {
      this.startingPeer = false;
    }

    if (this.peer || !this.role) return;

    const forceRelay = isRelayForced();
    if (forceRelay) this.relayNeeded = true;
    if (!this.relayNeeded) iceServers = withoutRelay(iceServers);

    this.peer = new PeerLink(this.role, iceServers, {
      onSignal: (data) => this.signaling.send({ t: "signal", data }),
      onState: (state) => {
        this.connection = state;
        if (state === "failed") {
          // A definitive failure needs no deadline; bring the relay in at once.
          this.engageRelay();
          this.scheduleFailureStat();
        }
        this.emitNow();
      },
      onChannels: (channels) => this.onChannels(channels),
      onChannelsLost: () => {
        this.channelsOpen = false;
        this.transfer.detach();
        this.emitNow();
      },
      onControlMessage: (raw) => this.onPeerControl(raw),
      onDataFrame: (frame) => {
        if (this.approval !== "granted") return;
        this.transfer.handleFrame(frame);
      },
    }, forceRelay);

    this.peer.start();
    this.armRelayDeadline();
  }

  private armRelayDeadline(): void {
    if (this.relayNeeded || this.escalateTimer) return;
    this.escalateTimer = setTimeout(() => {
      this.escalateTimer = null;
      if (!this.channelsOpen) this.engageRelay();
    }, RELAY_AFTER_MS);
  }

  /**
   * The direct attempt has had its chance; add the relay to the running connection.
   * Direct pairs keep being checked and still win when they work, so this widens the
   * search rather than redirecting it.
   */
  private engageRelay(): void {
    if (this.relayNeeded) return;

    const full = this.iceServersFull;
    if (!full || full.length === withoutRelay(full).length) return;

    this.relayNeeded = true;
    this.clearEscalateTimer();
    if (!this.peer || this.channelsOpen) return;

    // Rebuild only for a browser whose setConfiguration cannot do it in place; the
    // rebuilt peer starts with the full list because relayNeeded is already set.
    if (!this.peer.escalate(full)) this.rebuildPeer();
  }

  private clearEscalateTimer(): void {
    if (this.escalateTimer) clearTimeout(this.escalateTimer);
    this.escalateTimer = null;
  }

  private rebuildPeer(): void {
    this.peer?.close();
    this.peer = null;
    this.channelsOpen = false;
    this.connection = "connecting";
    // Detached explicitly: the discarded link no longer reports its own closure, and
    // without this the sender would keep its old send offsets instead of waiting for
    // the peer to say where to pick up.
    this.transfer.detach();
    // Transfers are not abandoned here. The reloaded peer reopens its files and reports
    // where to resume; anything it could not recover it cancels explicitly.
    void this.startPeer();
  }

  private onChannels(channels: PeerChannels): void {
    this.channelsOpen = true;
    this.clearEscalateTimer();
    // Open channels are proof the peer is here, whatever the signalling said earlier.
    this.clearPeerAbsence();
    this.peerPresent = true;
    this.transfer.attach(channels);

    if (this.failureTimer) {
      clearTimeout(this.failureTimer);
      this.failureTimer = null;
    }
    if (!this.statReported && !this.settleTimer) {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        void this.reportStat("connected");
      }, PATH_SETTLE_MS);
    }

    // The guest cannot do anything until the host presses Approve (PLAN.md §2).
    this.phase = this.approval === "granted" ? "active" : "pairing";
    this.emitNow();
  }

  // --- connection metrics --------------------------------------------------

  private scheduleFailureStat(): void {
    if (this.statReported || this.failureTimer) return;
    this.failureTimer = setTimeout(() => {
      this.failureTimer = null;
      if (this.channelsOpen) return;
      void this.reportStat("failed");
    }, FAILURE_CONFIRM_MS);
  }

  /**
   * One anonymous count per session: did a direct connection work, and over what kind
   * of path. Nothing identifying is sent, and the server keeps only daily totals.
   */
  private async reportStat(outcome: ConnectionOutcome): Promise<void> {
    if (this.statReported) return;
    this.statReported = true;

    let path: ConnectionPath = "unknown";
    if (outcome === "connected" && this.peer) path = await this.peer.describePath();
    this.signaling.send({ t: "stat", outcome, path });
  }

  private onPeerControl(raw: string): void {
    let msg: { t?: string };
    try {
      msg = JSON.parse(raw) as { t?: string };
    } catch {
      return;
    }

    if (msg.t === "approve") {
      this.approval = "granted";
      this.phase = "active";
      this.persist();
      this.flushPendingShare();
      this.emitNow();
      return;
    }

    if (msg.t === "reject") {
      this.end({ key: "error.declinedByPeer" });
      return;
    }

    // Nothing else is honoured until the session is unlocked.
    if (this.approval !== "granted") return;
    this.transfer.handleControl(raw);
  }

  // --- page lifecycle ------------------------------------------------------

  private installLifecycleHandlers(): void {
    if (typeof window === "undefined") return;

    const wake = () => this.checkHealth();

    // A bfcache restore resumes a page that was frozen mid-session.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) wake();
    });
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
    });
    window.addEventListener("pagehide", () => this.persist());
  }

  /**
   * Mobile Safari closes the signalling socket and suspends WebRTC when a tab goes to
   * the background, and a bfcache restore does not reliably deliver the close event,
   * so the page can come back believing it is still connected. Probe rather than trust.
   */
  private checkHealth(): void {
    if (!this.credentials) return;
    if (this.phase === "idle" || this.phase === "ended" || this.phase === "creating") return;

    if (!this.signaling.isOpen) {
      this.clearReconnectTimer();
      this.reconnectAttempt = 0;
      this.reconnectDeadline = Date.now() + RESUME_GRACE_MS;
      this.connection = "reconnecting";
      this.emitNow();
      this.resumeSignaling();
      return;
    }

    this.revivePeer();
  }

  // --- lifecycle -----------------------------------------------------------

  private end(reason: Message | null): void {
    this.phase = "ended";
    this.error = reason;
    this.peerPresent = false;
    this.channelsOpen = false;
    this.peer?.close();
    this.peer = null;
    this.signaling.close();
    this.transfer.detach();
    this.clearTimers();
    clearSession();
    this.emitNow();
  }

  reset(): void {
    this.resetSession();
    this.phase = "idle";
    this.emitNow();
  }

  private resetSession(): void {
    this.clearTimers();
    this.peer?.close();
    this.peer = null;
    this.signaling.close();
    this.transfer.reset();
    clearSession();

    this.role = null;
    this.credentials = null;
    this.remoteInstance = null;
    this.joinExpiresAt = null;
    this.peerPresent = false;
    this.peerAbsentSince = null;
    this.connection = "new";
    this.approval = "pending";
    this.channelsOpen = false;
    this.texts = [];
    this.pendingFiles = [];
    this.pendingText = null;
    this.notice = null;
    this.error = null;
    this.closedByUser = false;
    this.reconnectAttempt = 0;
    this.reconnectDeadline = null;
    this.statReported = false;
    this.iceServersPromise = null;
    this.resolveIceServers = null;
    this.iceServersFull = null;
    this.relayNeeded = false;
    this.startingPeer = false;
  }

  private persist(): void {
    if (!this.credentials) return;
    if (this.phase === "idle" || this.phase === "ended") return;
    saveSession({
      code: this.credentials.code,
      sessionKey: this.credentials.sessionKey,
      role: this.credentials.role,
      approved: this.approval === "granted",
      incoming: this.transfer.persistableIncoming(),
      outgoing: this.transfer.persistableOutgoing(),
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    if (this.peerTimer) clearTimeout(this.peerTimer);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    if (this.failureTimer) clearTimeout(this.failureTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.clearEscalateTimer();
    this.settleTimer = null;
    this.peerTimer = null;
    this.progressTimer = null;
    this.failureTimer = null;
  }

  // --- store ---------------------------------------------------------------

  /** Structural changes render immediately. */
  private emitNow(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }

  /** Byte-level progress fires per frame, so it is coalesced. */
  private emitSoon(): void {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.snapshot = this.build();
      for (const listener of this.listeners) listener();
    }, PROGRESS_THROTTLE_MS);
  }

  private build(): Snapshot {
    return {
      phase: this.phase,
      role: this.role,
      code: this.credentials?.code ?? null,
      joinExpiresAt: this.joinExpiresAt,
      shareUrl: this.credentials ? `${location.origin}/?c=${this.credentials.code}` : null,
      peerPresent: this.peerPresent,
      peerAbsentSince: this.peerAbsentSince,
      connection: this.connection,
      approval: this.approval,
      channelsOpen: this.channelsOpen,
      outgoing: this.transfer.snapshotOutgoing(),
      incoming: this.transfer.snapshotIncoming(),
      texts: this.texts,
      pendingShare:
        this.pendingFiles.length > 0 || this.pendingText
          ? { files: this.pendingFiles.length, text: this.pendingText !== null }
          : null,
      notice: this.notice,
      error: this.error,
    };
  }
}

/** STUN entries only; anything offering a turn: or turns: URL is dropped. */
function withoutRelay(servers: IceServer[]): IceServer[] {
  return servers.filter((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return !urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
  });
}

/** Debug switch: ?relay=force proves the relay path works on a given network. */
function isRelayForced(): boolean {
  try {
    return new URLSearchParams(location.search).get("relay") === "force";
  } catch {
    return false;
  }
}
