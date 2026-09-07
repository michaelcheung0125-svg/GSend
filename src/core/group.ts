/**
 * The socket that keeps this device findable by the ones it has been paired with.
 *
 * Unlike the code-based session, this connection is not tied to a transfer: it is open
 * whenever the page is, carrying nothing but presence and the signalling needed to
 * start a peer connection with one of the other devices. It reconnects on its own, and
 * it moves to a fresh room when the derived name's window rolls over.
 */
import type { GroupServerMessage, IceServer } from "../../shared/protocol";
import { rendezvousName, windowEndsAt } from "./devices";

export interface GroupHandlers {
  /** The full set of other devices currently in the room. */
  onPresence(peers: string[]): void;
  onSignal(peer: string, data: unknown): void;
  onIce(servers: IceServer[]): void;
  /** Raised when the socket cannot be kept up, so the interface can stop claiming to be online. */
  onOffline(): void;
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
/** Move to the next window slightly early, so both devices overlap rather than miss. */
const ROLLOVER_LEAD_MS = 5_000;

export class GroupLink {
  private socket: WebSocket | null = null;
  private secret: string | null = null;
  private device: string | null = null;
  private peers = new Set<string>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly handlers: GroupHandlers) {}

  get online(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get present(): string[] {
    return [...this.peers];
  }

  start(secret: string, device: string): void {
    this.secret = secret;
    this.device = device;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.peers.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "left the group");
    this.handlers.onPresence([]);
  }

  send(peer: string, data: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ t: "to", peer, data }));
  }

  requestIce(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ t: "ice" }));
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.secret || !this.device) return;
    this.clearTimers();

    let room: string;
    try {
      room = await rendezvousName(this.secret);
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({ role: "rendezvous", room, device: this.device });
    const socket = new WebSocket(`${scheme}//${location.host}/api/ws?${query.toString()}`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.scheduleRollover();
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        this.onMessage(JSON.parse(event.data) as GroupServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.peers.clear();
      this.handlers.onPresence([]);
      this.handlers.onOffline();
      this.scheduleRetry();
    });

    socket.addEventListener("error", () => {
      /* the close handler runs next and carries the outcome */
    });
  }

  private onMessage(msg: GroupServerMessage): void {
    switch (msg.t) {
      case "group":
        this.peers = new Set(msg.peers.map((peer) => peer.id));
        this.handlers.onPresence(this.present);
        break;
      case "joined":
        this.peers.add(msg.peer.id);
        this.handlers.onPresence(this.present);
        break;
      case "left":
        this.peers.delete(msg.peer);
        this.handlers.onPresence(this.present);
        break;
      case "from":
        this.handlers.onSignal(msg.peer, msg.data);
        break;
      case "ice":
        this.handlers.onIce(msg.iceServers);
        break;
      case "error":
        // Nothing here is recoverable by retrying immediately; back off like a drop.
        this.socket?.close();
        break;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(MIN_RETRY_MS * 2 ** this.attempt, MAX_RETRY_MS);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * The room name is only valid for its window, so the socket has to move before the
   * window ends. Reconnecting a few seconds early means both devices are briefly
   * reaching for the same next room rather than passing each other between two.
   */
  private scheduleRollover(): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    const delay = Math.max(1_000, windowEndsAt() - Date.now() - ROLLOVER_LEAD_MS);
    this.rolloverTimer = setTimeout(() => {
      this.rolloverTimer = null;
      const socket = this.socket;
      this.socket = null;
      socket?.close(1000, "window rolled");
      void this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    this.retryTimer = null;
    this.rolloverTimer = null;
  }
}
