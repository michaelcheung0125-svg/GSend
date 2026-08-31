import type { ConnectionPath } from "../../shared/protocol";
import { HEADER_BYTES } from "./protocol";

interface StatEntry {
  type: string;
  /** candidate-pair */
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  /** transport */
  selectedCandidatePairId?: string;
  /** local/remote-candidate */
  candidateType?: string;
}

/** No TURN by design (PLAN.md §3.2): if hole punching fails we tell the user, not pay for relay. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * Conservative interop ceiling. Chrome advertises 256 KiB and Firefox far more,
 * but Safari has historically capped SCTP messages at 64 KiB.
 */
const MAX_PAYLOAD_BYTES = 60 * 1024;
const MIN_PAYLOAD_BYTES = 16 * 1024;

export type PeerState = "new" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";

export interface PeerChannels {
  control: RTCDataChannel;
  data: RTCDataChannel;
  maxPayload: number;
}

export interface PeerHandlers {
  onSignal(data: unknown): void;
  onState(state: PeerState): void;
  onChannels(channels: PeerChannels): void;
  onChannelsLost(): void;
  onControlMessage(raw: string): void;
  onDataFrame(frame: ArrayBuffer): void;
}

/**
 * Wraps one RTCPeerConnection using the "perfect negotiation" pattern, so glare
 * and ICE restarts are handled without the two sides needing to take turns.
 */
export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private data: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private announced = false;
  /**
   * Data channel close events can arrive well after close() returns. Once this link is
   * discarded its events must be ignored, or a stale close would tear down the
   * replacement connection that has already taken over.
   */
  private disposed = false;

  /** The impolite side wins offer collisions; the host also drives ICE restarts. */
  private readonly polite: boolean;

  constructor(
    private readonly role: "host" | "guest",
    private readonly handlers: PeerHandlers,
  ) {
    this.polite = role === "guest";
  }

  start(): void {
    if (this.pc) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    this.announced = false;

    pc.addEventListener("icecandidate", ({ candidate }) => {
      if (this.disposed || !candidate) return;
      this.handlers.onSignal({ candidate: candidate.toJSON() });
    });

    pc.addEventListener("negotiationneeded", () => {
      if (this.disposed) return;
      void this.negotiate();
    });

    pc.addEventListener("connectionstatechange", () => {
      if (this.disposed) return;
      switch (pc.connectionState) {
        case "connecting":
          this.handlers.onState("connecting");
          break;
        case "connected":
          this.handlers.onState("connected");
          break;
        case "disconnected":
          this.handlers.onState("reconnecting");
          break;
        case "failed":
          this.handlers.onState("failed");
          this.restart();
          break;
        case "closed":
          this.handlers.onState("closed");
          break;
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (!this.disposed && pc.iceConnectionState === "failed") this.restart();
    });

    if (this.role === "host") {
      // Only one side creates channels, otherwise both would negotiate duplicates.
      this.attachControl(pc.createDataChannel("ctrl", { ordered: true }));
      this.attachData(pc.createDataChannel("data", { ordered: true }));
    } else {
      pc.addEventListener("datachannel", ({ channel }) => {
        if (channel.label === "ctrl") this.attachControl(channel);
        if (channel.label === "data") this.attachData(channel);
      });
    }
  }

  async handleSignal(payload: unknown): Promise<void> {
    const pc = this.pc;
    if (!pc || typeof payload !== "object" || payload === null) return;

    const { description, candidate } = payload as {
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };

    try {
      if (description) {
        const collision =
          description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        await this.flushCandidates();

        if (description.type === "offer") {
          await pc.setLocalDescription();
          this.handlers.onSignal({ description: pc.localDescription?.toJSON() });
        }
      } else if (candidate) {
        // Candidates can outrun the description they belong to.
        if (!pc.remoteDescription) {
          this.pendingCandidates.push(candidate);
        } else {
          await pc.addIceCandidate(candidate);
        }
      }
    } catch (error) {
      if (!this.ignoreOffer) console.warn("[peer] signal failed", error);
    }
  }

  /** Called when signalling comes back after a drop; forces fresh ICE candidates. */
  restart(): void {
    if (this.role !== "host" || !this.pc) return;
    if (this.pc.connectionState === "closed") return;
    this.pc.restartIce();
  }

  /** Which kind of path the connection actually took, for the TURN decision. */
  async describePath(): Promise<ConnectionPath> {
    const pc = this.pc;
    if (!pc) return "unknown";

    try {
      const stats = await pc.getStats();
      const pair = selectedPair(stats);
      if (!pair) return "unknown";

      const local = stats.get(pair.localCandidateId ?? "") as StatEntry | undefined;
      const remote = stats.get(pair.remoteCandidateId ?? "") as StatEntry | undefined;
      if (!local?.candidateType || !remote?.candidateType) return "unknown";

      // Both ends local means the devices were already on the same network; anything
      // else means hole punching had to cross a NAT.
      return local.candidateType === "host" && remote.candidateType === "host"
        ? "lan"
        : "internet";
    } catch {
      return "unknown";
    }
  }

  sendControl(raw: string): boolean {
    if (this.control?.readyState !== "open") return false;
    this.control.send(raw);
    return true;
  }

  close(): void {
    this.disposed = true;
    this.control?.close();
    this.data?.close();
    this.pc?.close();
    this.control = null;
    this.data = null;
    this.pc = null;
    this.pendingCandidates = [];
  }

  private async negotiate(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      this.handlers.onSignal({ description: pc.localDescription?.toJSON() });
    } catch (error) {
      console.warn("[peer] negotiation failed", error);
    } finally {
      this.makingOffer = false;
    }
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc?.addIceCandidate(candidate);
      } catch {
        /* stale candidate from a previous negotiation */
      }
    }
  }

  private attachControl(channel: RTCDataChannel): void {
    this.control = channel;
    channel.addEventListener("message", (event) => {
      if (!this.disposed && typeof event.data === "string") {
        this.handlers.onControlMessage(event.data);
      }
    });
    channel.addEventListener("open", () => this.announceIfReady());
    channel.addEventListener("close", () => this.announceLost());
  }

  private attachData(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    this.data = channel;
    channel.addEventListener("message", (event) => {
      if (!this.disposed && event.data instanceof ArrayBuffer) {
        this.handlers.onDataFrame(event.data);
      }
    });
    channel.addEventListener("open", () => this.announceIfReady());
    channel.addEventListener("close", () => this.announceLost());
  }

  private announceIfReady(): void {
    if (this.disposed || this.announced) return;
    if (this.control?.readyState !== "open" || this.data?.readyState !== "open") return;

    this.announced = true;
    this.handlers.onChannels({
      control: this.control,
      data: this.data,
      maxPayload: this.resolvePayloadSize(),
    });
  }

  private announceLost(): void {
    if (this.disposed || !this.announced) return;
    this.announced = false;
    this.handlers.onChannelsLost();
  }

  private resolvePayloadSize(): number {
    const negotiated = this.pc?.sctp?.maxMessageSize ?? MAX_PAYLOAD_BYTES;
    const usable = Math.min(negotiated - HEADER_BYTES, MAX_PAYLOAD_BYTES);
    return Math.max(MIN_PAYLOAD_BYTES, usable);
  }
}

/**
 * Several pairs sit in "succeeded" at once, so picking an arbitrary one misreports the
 * path. Chrome names the live pair through the transport, Firefox flags it on the pair.
 */
function selectedPair(stats: RTCStatsReport): StatEntry | null {
  const pairs: StatEntry[] = [];
  let selectedId: string | undefined;

  stats.forEach((report: StatEntry) => {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      selectedId = report.selectedCandidatePairId;
    }
    if (report.type === "candidate-pair") pairs.push(report);
  });

  if (selectedId) {
    const byId = stats.get(selectedId) as StatEntry | undefined;
    if (byId) return byId;
  }

  return (
    pairs.find((p) => p.selected) ??
    pairs.find((p) => p.state === "succeeded" && p.nominated) ??
    null
  );
}
