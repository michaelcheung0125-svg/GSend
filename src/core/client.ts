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
import {
  chooseSaveDirectory,
  forgetSaveDirectory,
  restoreSaveDirectory,
  saveDirectoryName,
} from "./sink";
import { forgetDevice, forgetGroup, groupSecret, knownDevices, type KnownDevice } from "./devices";
import { GroupLink } from "./group";
import { Handshake } from "./handshake";
import { loadIdentity, renameDevice, type Identity } from "./identity";
import type { PeerControl } from "./protocol";
import { Signaling } from "./signaling";
import { TransferEngine, type TextMessage, type TransferView } from "./transfer";

/** How this session found its peer: someone typed a code, or the devices already knew each other. */
export type Mode = "code" | "group";

/** A device this one has been paired with, and whether it is reachable right now. */
export interface DeviceView {
  id: string;
  name: string;
  online: boolean;
}

export type Phase =
  | "idle"
  | "creating"
  | "hosting"
  | "joining"
  | "pairing"
  | "active"
  | "ended";

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
  /** True once this session brought the relay into play (billable path). */
  relayEngaged: boolean;
  channelsOpen: boolean;
  mode: Mode;
  /** This device's own name and id, once the browser has given us a durable store. */
  identity: { id: string; name: string } | null;
  /** Paired devices, with live presence from the rendezvous room. */
  devices: DeviceView[];
  /** Whether this device is currently findable by the others. */
  groupOnline: boolean;
  /** The paired device this session is talking to, when it came from the device list. */
  peerDevice: string | null;
  /** Whether the peer has proved which device it is. Required before anything moves in group mode. */
  verified: boolean;
  /** The folder incoming files are being written into, when one was chosen. */
  savingTo: string | null;
  /** When the other device came through, so the sender can see it happen. */
  peerJoinedAt: number | null;
  outgoing: TransferView[];
  incoming: TransferView[];
  texts: TextMessage[];
  /** Staged before the code was created, waiting for a peer to connect. */
  pendingShare: { files: number; bytes: number; text: boolean } | null;
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
  private readonly group: GroupLink;
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
  private channelsOpen = false;
  private peerJoinedAt: number | null = null;
  private mode: Mode = "code";
  private identity: Identity | null = null;
  private paired: KnownDevice[] = [];
  private presence = new Set<string>();
  private peerDevice: string | null = null;
  private handshake: Handshake | null = null;
  private verified = false;
  private woken = false;
  /** Kept so a group session can attach the engine once the peer has proved itself. */
  private openChannels: PeerChannels | null = null;
  /**
   * Signals that arrived before there was a connection to give them to. Building one
   * waits on relay credentials, and a device session starts building only *because* a
   * signal arrived — so the offer that opened it would otherwise be the one dropped,
   * and only the offering side creates channels, so nothing would ever follow it.
   */
  private pendingSignals: unknown[] = [];
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

    this.group = new GroupLink({
      onPresence: (peers) => {
        this.presence = new Set(peers);
        this.emitNow();
      },
      onSignal: (peer, data) => this.onGroupSignal(peer, data),
      onIce: (servers) => this.deliverIceServers(servers),
      onOffline: () => this.emitNow(),
    });

    this.installLifecycleHandlers();
    this.snapshot = this.build();
  }

  // --- paired devices ------------------------------------------------------

  /**
   * Load this device's identity and go online for the devices it already knows. Called
   * once at startup, before anything else: the device list is the first thing on screen
   * and joining the rendezvous room is what makes it true.
   */
  async wake(): Promise<void> {
    // Guarded here rather than by the caller: going online is about this client, not
    // about which entry path the page took, and a second call would only churn the socket.
    if (this.woken) return;
    this.woken = true;

    // A folder granted on an earlier visit means an incoming file needs no clicks at
    // all, which is the point of remembering a device in the first place.
    await restoreSaveDirectory();
    this.emitNow();

    this.identity = await loadIdentity();
    if (!this.identity) return;

    this.paired = await knownDevices();
    this.emitNow();
    await this.goOnline();
  }

  private async goOnline(): Promise<void> {
    if (!this.identity) return;
    const secret = await groupSecret();
    if (!secret) return;
    this.group.start(secret, this.identity.id);
  }

  private async refreshDevices(): Promise<void> {
    this.paired = await knownDevices();
    this.emitNow();
    // A pairing may have just created or changed the group, which is what the
    // rendezvous room is derived from, so the socket has to be pointed at the new one.
    this.group.stop();
    await this.goOnline();
  }

  async rename(name: string): Promise<void> {
    this.identity = await renameDevice(name);
    this.emitNow();
  }

  async unpair(id: string): Promise<void> {
    await forgetDevice(id);
    this.paired = await knownDevices();
    this.emitNow();
  }

  /** Leave the group entirely: stop being findable, and forget every paired device. */
  async unpairAll(): Promise<void> {
    this.group.stop();
    await forgetGroup();
    // Forgetting the devices means forgetting where their files were going, too.
    await forgetSaveDirectory();
    this.paired = [];
    this.presence.clear();
    this.emitNow();
  }

  /**
   * Open a session with a device from the list. No code is involved, so the peer has to
   * prove which device it is before anything moves; `verified` is what gates that.
   */
  connectToDevice(id: string, files: File[] = [], text: string | null = null): void {
    if (!this.identity) return;
    const device = this.paired.find((known) => known.id === id);
    if (!device || !this.presence.has(id)) return;

    this.resetSession();
    // Set after resetSession, which would otherwise clear them.
    this.pendingFiles = files;
    this.pendingText = text;
    this.mode = "group";
    this.peerDevice = id;
    // No host and guest here, so the tie is broken by id. Both sides read it the same
    // way, which is all perfect negotiation needs to settle offer collisions.
    this.role = this.identity.id < id ? "host" : "guest";
    this.phase = "pairing";
    this.peerPresent = true;
    this.emitNow();
    void this.startPeer();
  }

  /**
   * A signal arrived from a paired device. If this side is idle the other one is
   * calling, so answer it; otherwise ignore anything not from the peer already engaged.
   */
  private onGroupSignal(peer: string, data: unknown): void {
    if (this.peerDevice && this.peerDevice !== peer) return;

    if (!this.peerDevice) {
      if (!this.identity || !this.paired.some((known) => known.id === peer)) return;
      this.resetSession();
      this.mode = "group";
      this.peerDevice = peer;
      this.role = this.identity.id < peer ? "host" : "guest";
      this.phase = "pairing";
      this.peerPresent = true;
      this.emitNow();
      void this.startPeer();
    }

    this.onSignal(data);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  // --- commands ------------------------------------------------------------

  /**
   * Reserve a code for the files and text already picked. Choosing first and pairing
   * second is what lets the other device receive on arrival: by the time it joins, the
   * queue is known and the transfer can start the moment the channels open. Calling
   * this with nothing staged is still valid — it opens a session to receive into.
   */
  host(files: File[] = [], text: string | null = null): void {
    this.resetSession();
    this.phase = "creating";
    this.role = "host";
    // Set after resetSession, which would otherwise clear them.
    this.pendingFiles = files;
    this.pendingText = text;
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
   * so an idle app opens a session for them immediately and shows the code.
   */
  stageShared(files: File[], text: string | null): void {
    if (this.phase === "idle") {
      this.host(files, text);
      return;
    }
    this.pendingFiles = files;
    this.pendingText = text;
    this.flushPendingShare();
    this.emitNow();
  }

  /** The queue goes out as soon as there is something to carry it. */
  private flushPendingShare(): void {
    if (!this.channelsOpen || !this.trusted()) return;

    if (this.pendingFiles.length > 0) {
      this.transfer.sendFiles(this.pendingFiles);
      this.pendingFiles = [];
    }
    if (this.pendingText !== null) {
      this.transfer.sendText(this.pendingText);
      this.pendingText = null;
    }
  }

  sendFiles(files: File[]): void {
    if (!this.channelsOpen) {
      // Queued rather than dropped: the connection may still be coming up.
      this.pendingFiles = [...this.pendingFiles, ...files];
      this.emitNow();
      return;
    }
    this.transfer.sendFiles(files);
    this.emitNow();
  }

  sendText(body: string): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!this.channelsOpen) {
      this.pendingText = this.pendingText ? `${this.pendingText}
${trimmed}` : trimmed;
      this.emitNow();
      return;
    }
    this.transfer.sendText(trimmed);
  }

  /**
   * Pick where arriving files should be written. Must be called straight from a click:
   * the picker needs transient user activation. Files already in flight keep the sink
   * they started with; everything offered afterwards goes to the new folder.
   */
  async chooseFolder(): Promise<void> {
    const folder = await chooseSaveDirectory();
    if (folder) this.notice = null;
    this.emitNow();
  }

  /**
   * Raised on the receiving side when no folder was picked, so the person knows their
   * files are landing in browser storage with a ceiling on them.
   */
  noticeStorageFallback(size: string): void {
    this.notice = { key: "notice.noFolder", params: { size } };
    this.emitNow();
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
    // outlives it. Knocking a connected session back to "pairing" here hid the
    // transfer list while bytes were still arriving underneath it.
    const established = this.channelsOpen;
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

  /**
   * Signals reach the peer over whichever transport this session was built on: the
   * room named by a 4-digit code, or the rendezvous room the paired devices derive.
   * Everything above this line is identical either way.
   */
  private sendSignal(data: unknown): void {
    if (this.mode === "group") {
      if (this.peerDevice) this.group.send(this.peerDevice, data);
      return;
    }
    this.signaling.send({ t: "signal", data });
  }

  private requestIceServers(): Promise<IceServer[]> {
    if (this.iceServersPromise) return this.iceServersPromise;

    this.iceServersPromise = new Promise<IceServer[]>((resolve) => {
      this.resolveIceServers = resolve;
      if (this.mode === "group") this.group.requestIce();
      else this.signaling.send({ t: "ice" });
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
    this.sendSignal({ instance: this.instanceId });
  }

  private onSignal(data: unknown): void {
    const announcement = data as Partial<InstanceAnnouncement> | null;
    if (announcement && typeof announcement.instance === "string") {
      this.onRemoteInstance(announcement.instance);
      return;
    }
    if (!this.peer) {
      this.pendingSignals.push(data);
      return;
    }
    void this.peer.handleSignal(data);
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
      onSignal: (data) => this.sendSignal(data),
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
        this.openChannels = null;
        this.transfer.detach();
        this.emitNow();
      },
      onControlMessage: (raw) => this.onPeerControl(raw),
      onDataFrame: (frame) => {
        if (!this.trusted()) return;
        this.transfer.handleFrame(frame);
      },
    }, forceRelay);

    this.peer.start();

    const queued = this.pendingSignals;
    this.pendingSignals = [];
    for (const data of queued) void this.peer.handleSignal(data);

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
    this.openChannels = channels;
    // A group session holds the engine back until the peer has proved itself; a code
    // session has already been vouched for by the person who read out the digits.
    if (this.trusted()) this.transfer.attach(channels);
    this.startHandshake();

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

    // Open channels are the whole gate for a code session: whoever staged something
    // sends it here, and the other side is already receiving into the folder it picked.
    if (this.trusted()) {
      this.phase = "active";
      this.peerJoinedAt ??= Date.now();
      this.persist();
      this.flushPendingShare();
    }
    this.emitNow();
  }

  /** Whether this session may carry anything yet. */
  private trusted(): boolean {
    return this.mode === "code" || this.verified;
  }

  /**
   * Both sides announce themselves the moment the control channel is up. In a code
   * session this only records a pairing for next time and never blocks the transfer,
   * so a peer running an older build still works; in a group session it is the gate.
   */
  private startHandshake(): void {
    const identity = this.identity;
    if (!identity || this.handshake) return;

    this.handshake = new Handshake(identity, this.mode, {
      send: (msg) => this.peer?.sendControl(JSON.stringify(msg)),
      onVerified: ({ stranded }) => {
        this.verified = true;
        if (stranded > 0) this.notice = { key: "notice.regrouped", params: { count: stranded } };
        void this.refreshDevices();

        if (this.openChannels) this.transfer.attach(this.openChannels);
        this.phase = "active";
        this.peerJoinedAt ??= Date.now();
        this.flushPendingShare();
        this.emitNow();
      },
      onRejected: () => {
        // Only reachable in group mode, where an unproved peer has no business here.
        if (this.mode === "group") this.end({ key: "error.unknownDevice" });
      },
    });
    void this.handshake.begin();
  }

  private onPeerControl(raw: string): void {
    let msg: PeerControl;
    try {
      msg = JSON.parse(raw) as PeerControl;
    } catch {
      return;
    }
    if (this.handshake?.handle(msg)) return;
    if (!this.trusted()) return;
    this.transfer.handleControl(raw);
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
    this.channelsOpen = false;
    this.openChannels = null;
    this.pendingSignals = [];
    this.peerJoinedAt = null;
    this.mode = "code";
    this.peerDevice = null;
    this.handshake = null;
    this.verified = false;
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
      relayEngaged: this.relayNeeded,
      channelsOpen: this.channelsOpen,
      mode: this.mode,
      identity: this.identity ? { id: this.identity.id, name: this.identity.name } : null,
      devices: this.paired.map((device) => ({
        id: device.id,
        name: device.name,
        online: this.presence.has(device.id),
      })),
      groupOnline: this.group.online,
      peerDevice: this.peerDevice,
      verified: this.verified,
      savingTo: saveDirectoryName(),
      peerJoinedAt: this.peerJoinedAt,
      outgoing: this.transfer.snapshotOutgoing(),
      incoming: this.transfer.snapshotIncoming(),
      texts: this.texts,
      pendingShare:
        this.pendingFiles.length > 0 || this.pendingText
          ? {
              files: this.pendingFiles.length,
              bytes: this.pendingFiles.reduce((sum, file) => sum + file.size, 0),
              text: this.pendingText !== null,
            }
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
