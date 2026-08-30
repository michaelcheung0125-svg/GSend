import {
  ERROR_TEXT,
  isValidCode,
  type Role,
  type ServerMessage,
} from "../../shared/protocol";
import { PeerLink, type PeerChannels, type PeerState } from "./peer";
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
  connection: PeerState;
  approval: Approval;
  channelsOpen: boolean;
  outgoing: TransferView[];
  incoming: TransferView[];
  texts: TextMessage[];
  notice: string | null;
  error: string | null;
}

const MAX_RECONNECT_ATTEMPTS = 8;
const PROGRESS_THROTTLE_MS = 40;

interface Credentials {
  code: string;
  sessionKey: string;
  role: Role;
}

export class GSendClient {
  private readonly signaling: Signaling;
  private readonly transfer: TransferEngine;
  private peer: PeerLink | null = null;

  private phase: Phase = "idle";
  private role: Role | null = null;
  private credentials: Credentials | null = null;
  private joinExpiresAt: number | null = null;
  private peerPresent = false;
  private connection: PeerState = "new";
  private approval: Approval = "pending";
  private channelsOpen = false;
  private texts: TextMessage[] = [];
  private notice: string | null = null;
  private error: string | null = null;

  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;

  private listeners = new Set<() => void>();
  /** Built at the end of the constructor, once the engines it reads from exist. */
  private snapshot!: Snapshot;

  constructor() {
    this.signaling = new Signaling({
      onOpen: () => {
        this.reconnectAttempt = 0;
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
    });

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
      this.error = "Enter the 4 digits shown on the other device.";
      this.emitNow();
      return;
    }
    this.resetSession();
    this.phase = "joining";
    this.role = "guest";
    this.emitNow();
    this.signaling.connect({ role: "guest", code });
  }

  approve(): void {
    if (this.role !== "host" || this.approval !== "pending") return;
    this.peer?.sendControl(JSON.stringify({ t: "approve" }));
    this.approval = "granted";
    this.phase = "active";
    this.emitNow();
  }

  reject(): void {
    if (this.role !== "host") return;
    this.peer?.sendControl(JSON.stringify({ t: "reject" }));
    this.end("You declined the connection.");
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
    this.signaling.send({ t: "bye" });
    this.end(null);
  }

  // --- signalling ----------------------------------------------------------

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "hello":
        this.onHello(msg);
        break;

      case "peer-joined":
        this.peerPresent = true;
        this.phase = "pairing";
        this.startPeer();
        this.emitNow();
        break;

      case "peer-resumed":
        this.peerPresent = true;
        this.startPeer();
        this.peer?.restart();
        this.emitNow();
        break;

      case "peer-left":
        this.peerPresent = false;
        if (this.phase === "active" || this.phase === "pairing") {
          this.connection = "reconnecting";
        }
        this.emitNow();
        break;

      case "signal":
        void this.peer?.handleSignal(msg.data);
        break;

      case "code-expired":
        this.end("Nobody joined in time. Start a new session.");
        break;

      case "closed":
        this.end(`Session closed: ${msg.reason}`);
        break;

      case "error":
        this.closedByUser = true;
        this.error = ERROR_TEXT[msg.code] ?? msg.message;
        this.phase = this.phase === "joining" ? "idle" : "ended";
        this.emitNow();
        break;
    }
  }

  private onHello(msg: Extract<ServerMessage, { t: "hello" }>): void {
    this.role = msg.role;
    this.credentials = { code: msg.code, sessionKey: msg.sessionKey, role: msg.role };
    this.joinExpiresAt = msg.joinExpiresAt;
    this.peerPresent = msg.peerPresent;
    this.error = null;

    if (msg.role === "host") {
      this.phase = msg.peerPresent ? "pairing" : "hosting";
    } else {
      this.phase = "pairing";
    }

    if (msg.peerPresent) this.startPeer();
    this.emitNow();
  }

  private onSignalingClosed(code: number): void {
    if (this.closedByUser || this.phase === "idle" || this.phase === "ended") return;

    // 4000-range closes are deliberate refusals; the error message already arrived.
    if (code >= 4000 && code < 4100) return;

    if (!this.credentials || this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.end("Lost the connection to the server.");
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 15_000);
    this.reconnectAttempt += 1;
    this.connection = "reconnecting";
    this.emitNow();

    this.reconnectTimer = setTimeout(() => {
      const creds = this.credentials;
      if (!creds) return;
      this.signaling.connect({
        role: "resume",
        code: creds.code,
        key: creds.sessionKey,
        as: creds.role,
      });
    }, delay);
  }

  // --- peer ----------------------------------------------------------------

  private startPeer(): void {
    if (this.peer || !this.role) return;

    this.peer = new PeerLink(this.role, {
      onSignal: (data) => this.signaling.send({ t: "signal", data }),
      onState: (state) => {
        this.connection = state;
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
    });

    this.peer.start();
  }

  private onChannels(channels: PeerChannels): void {
    this.channelsOpen = true;
    this.transfer.attach(channels);

    // The guest cannot do anything until the host presses Approve (PLAN.md §2).
    if (this.approval === "granted") this.phase = "active";
    else this.phase = "pairing";

    this.emitNow();
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
      this.emitNow();
      return;
    }

    if (msg.t === "reject") {
      this.end("The other device declined the connection.");
      return;
    }

    // Nothing else is honoured until the session is unlocked.
    if (this.approval !== "granted") return;
    this.transfer.handleControl(raw);
  }

  // --- lifecycle -----------------------------------------------------------

  private end(reason: string | null): void {
    this.phase = "ended";
    this.error = reason;
    this.peerPresent = false;
    this.channelsOpen = false;
    this.peer?.close();
    this.peer = null;
    this.signaling.close();
    this.transfer.detach();
    this.clearTimers();
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

    this.role = null;
    this.credentials = null;
    this.joinExpiresAt = null;
    this.peerPresent = false;
    this.connection = "new";
    this.approval = "pending";
    this.channelsOpen = false;
    this.texts = [];
    this.notice = null;
    this.error = null;
    this.closedByUser = false;
    this.reconnectAttempt = 0;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.reconnectTimer = null;
    this.progressTimer = null;
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
      connection: this.connection,
      approval: this.approval,
      channelsOpen: this.channelsOpen,
      outgoing: this.transfer.snapshotOutgoing(),
      incoming: this.transfer.snapshotIncoming(),
      texts: this.texts,
      notice: this.notice,
      error: this.error,
    };
  }
}
