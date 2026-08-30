import type { PeerChannels } from "./peer";
import {
  HEADER_BYTES,
  decodeHeader,
  encodeHeader,
  type FileMeta,
  type PeerControl,
} from "./protocol";
import { MAX_FILE_BYTES, createSink, type FileSink } from "./sink";

/** How much of the source file to pull into memory at a time before framing it. */
const READ_BLOCK_BYTES = 4 * 1024 * 1024;

/** Backpressure: stop feeding SCTP above the high mark, resume at the low mark. */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const LOW_WATER_BYTES = 1 * 1024 * 1024;

const ACK_INTERVAL_BYTES = 512 * 1024;
const ACK_INTERVAL_MS = 250;

export type TransferStatus = "pending" | "active" | "paused" | "done" | "cancelled" | "error";
export type Direction = "send" | "receive";

export interface TransferView {
  id: string;
  name: string;
  size: number;
  mime: string;
  transferred: number;
  status: TransferStatus;
  direction: Direction;
  error?: string;
  downloadUrl?: string;
  startedAt: number;
  updatedAt: number;
}

export interface TextMessage {
  id: string;
  body: string;
  at: number;
  mine: boolean;
}

interface OutgoingTransfer {
  meta: FileMeta;
  file: File;
  batchId: string;
  sent: number;
  acked: number;
  status: TransferStatus;
  error?: string;
  startedAt: number;
  updatedAt: number;
  /** Set when the channels dropped: the sender must not resume until the receiver reports its offset. */
  awaitingResume: boolean;
  resumeGate?: () => void;
}

interface IncomingTransfer {
  meta: FileMeta;
  sink: FileSink;
  received: number;
  status: TransferStatus;
  error?: string;
  downloadUrl?: string;
  startedAt: number;
  updatedAt: number;
  lastAckAt: number;
  lastAckBytes: number;
}

export interface TransferCallbacks {
  sendControl(msg: PeerControl): boolean;
  onChange(): void;
  onText(msg: TextMessage): void;
}

export class TransferEngine {
  private channels: PeerChannels | null = null;
  private attachWaiters: Array<() => void> = [];
  private nextWireId = 1;

  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly incoming = new Map<string, IncomingTransfer>();
  /** Binary frames carry the compact wire id, so incoming frames resolve through this. */
  private readonly wireIndex = new Map<number, string>();

  constructor(private readonly callbacks: TransferCallbacks) {}

  attach(channels: PeerChannels): void {
    this.channels = channels;
    channels.data.bufferedAmountLowThreshold = LOW_WATER_BYTES;

    const waiters = this.attachWaiters;
    this.attachWaiters = [];
    for (const wake of waiters) wake();

    // Tell the sender where each interrupted file should pick up again.
    const offsets: Record<string, number> = {};
    for (const [id, transfer] of this.incoming) {
      if (transfer.status === "active" || transfer.status === "paused") {
        transfer.status = "active";
        offsets[id] = transfer.received;
      }
    }
    if (Object.keys(offsets).length > 0) this.callbacks.sendControl({ t: "resume", offsets });

    this.callbacks.onChange();
  }

  detach(): void {
    this.channels = null;
    for (const transfer of this.outgoing.values()) {
      if (transfer.status === "active") {
        transfer.status = "paused";
        transfer.awaitingResume = true;
      }
    }
    for (const transfer of this.incoming.values()) {
      if (transfer.status === "active") transfer.status = "paused";
    }
    this.callbacks.onChange();
  }

  reset(): void {
    this.channels = null;
    for (const transfer of this.incoming.values()) {
      if (transfer.downloadUrl) URL.revokeObjectURL(transfer.downloadUrl);
    }
    this.outgoing.clear();
    this.incoming.clear();
    this.wireIndex.clear();
    this.attachWaiters = [];
    this.callbacks.onChange();
  }

  snapshotOutgoing(): TransferView[] {
    return [...this.outgoing.entries()].map(([id, t]) => ({
      id,
      name: t.meta.name,
      size: t.meta.size,
      mime: t.meta.mime,
      transferred: t.sent,
      status: t.status,
      direction: "send" as const,
      error: t.error,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
    }));
  }

  snapshotIncoming(): TransferView[] {
    return [...this.incoming.entries()].map(([id, t]) => ({
      id,
      name: t.meta.name,
      size: t.meta.size,
      mime: t.meta.mime,
      transferred: t.received,
      status: t.status,
      direction: "receive" as const,
      error: t.error,
      downloadUrl: t.downloadUrl,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
    }));
  }

  sendFiles(files: File[]): string | null {
    const accepted = files.filter((file) => file.size <= MAX_FILE_BYTES);
    const rejected = files.length - accepted.length;
    if (accepted.length === 0) {
      return rejected > 0 ? `Files above ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB are not supported yet.` : null;
    }

    const batchId = randomId();
    const now = Date.now();
    const metas: FileMeta[] = accepted.map((file) => ({
      id: randomId(),
      wireId: this.nextWireId++,
      name: file.name,
      size: file.size,
      mime: file.type,
    }));

    metas.forEach((meta, index) => {
      this.outgoing.set(meta.id, {
        meta,
        file: accepted[index],
        batchId,
        sent: 0,
        acked: 0,
        status: "pending",
        startedAt: now,
        updatedAt: now,
        awaitingResume: false,
      });
    });

    this.callbacks.sendControl({ t: "offer", batchId, files: metas });
    this.callbacks.onChange();
    return rejected > 0
      ? `${rejected} file(s) skipped: over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`
      : null;
  }

  sendText(body: string): void {
    const msg = { id: randomId(), body, at: Date.now() };
    if (!this.callbacks.sendControl({ t: "text", ...msg })) return;
    this.callbacks.onText({ ...msg, mine: true });
  }

  cancel(fileId: string): void {
    const outgoing = this.outgoing.get(fileId);
    if (outgoing && outgoing.status !== "done") {
      outgoing.status = "cancelled";
      outgoing.updatedAt = Date.now();
      outgoing.resumeGate?.();
      this.callbacks.sendControl({ t: "cancel", fileId, reason: "sender cancelled" });
    }

    const incoming = this.incoming.get(fileId);
    if (incoming && incoming.status !== "done") {
      incoming.status = "cancelled";
      incoming.updatedAt = Date.now();
      void incoming.sink.abort();
      this.callbacks.sendControl({ t: "cancel", fileId, reason: "receiver cancelled" });
    }

    this.callbacks.onChange();
  }

  handleControl(raw: string): void {
    let msg: PeerControl;
    try {
      msg = JSON.parse(raw) as PeerControl;
    } catch {
      return;
    }

    switch (msg.t) {
      case "offer":
        this.onOffer(msg.batchId, msg.files);
        break;
      case "accept":
        void this.onAccept(msg.batchId, msg.offsets);
        break;
      case "ack":
        this.onAck(msg.fileId, msg.received);
        break;
      case "done":
        this.onRemoteDone(msg.fileId);
        break;
      case "cancel":
        this.onRemoteCancel(msg.fileId, msg.reason);
        break;
      case "resume":
        this.onResume(msg.offsets);
        break;
      case "text":
        this.callbacks.onText({ id: msg.id, body: msg.body, at: msg.at, mine: false });
        break;
      default:
        break;
    }
  }

  handleFrame(frame: ArrayBuffer): void {
    const header = decodeHeader(frame);
    if (!header) return;

    const fileId = this.wireIndex.get(header.wireId);
    if (!fileId) return;

    const transfer = this.incoming.get(fileId);
    if (!transfer || transfer.status === "cancelled" || transfer.status === "done") return;

    const payload = new Uint8Array(frame, HEADER_BYTES);

    // The channel is ordered and reliable, so bytes arrive contiguously and a single
    // watermark is a valid resume point. A rewind only happens right after a resume,
    // where the overlap is data we already hold.
    const skip = transfer.received - header.offset;
    if (skip < 0) {
      this.failIncoming(transfer, fileId, "stream gap");
      return;
    }
    if (skip >= payload.byteLength) return;

    const slice = payload.subarray(skip);
    transfer.status = "active";
    transfer.received += slice.byteLength;
    transfer.updatedAt = Date.now();

    void transfer.sink.write(slice).catch(() => this.failIncoming(transfer, fileId, "write failed"));

    if (transfer.received >= transfer.meta.size) {
      void this.completeIncoming(fileId, transfer);
    } else {
      this.maybeAck(fileId, transfer);
    }

    this.callbacks.onChange();
  }

  private onOffer(batchId: string, files: FileMeta[]): void {
    const now = Date.now();
    const offsets: Record<string, number> = {};

    for (const meta of files) {
      const existing = this.incoming.get(meta.id);
      if (existing) {
        offsets[meta.id] = existing.received;
        continue;
      }
      this.incoming.set(meta.id, {
        meta,
        sink: createSink(),
        received: 0,
        status: "active",
        startedAt: now,
        updatedAt: now,
        lastAckAt: 0,
        lastAckBytes: 0,
      });
      this.wireIndex.set(meta.wireId, meta.id);
      offsets[meta.id] = 0;
    }

    this.callbacks.sendControl({ t: "accept", batchId, offsets });
    this.callbacks.onChange();
  }

  private async onAccept(batchId: string, offsets: Record<string, number>): Promise<void> {
    const queue = [...this.outgoing.entries()].filter(
      ([, t]) => t.batchId === batchId && t.status === "pending",
    );

    for (const [fileId, transfer] of queue) {
      transfer.sent = offsets[fileId] ?? 0;
      transfer.acked = transfer.sent;
      transfer.status = "active";
      await this.pump(transfer);
    }
  }

  /** Read through a call so narrowing does not survive the awaits in `pump`. */
  private stopped(transfer: OutgoingTransfer): boolean {
    return transfer.status === "cancelled" || transfer.status === "error";
  }

  private async pump(transfer: OutgoingTransfer): Promise<void> {
    while (transfer.sent < transfer.meta.size) {
      if (this.stopped(transfer)) return;

      const channels = await this.waitForChannels();
      if (transfer.awaitingResume) {
        await this.waitForResume(transfer);
        if (this.stopped(transfer)) return;
        continue;
      }

      const blockEnd = Math.min(transfer.sent + READ_BLOCK_BYTES, transfer.meta.size);
      let block: ArrayBuffer;
      try {
        block = await transfer.file.slice(transfer.sent, blockEnd).arrayBuffer();
      } catch {
        transfer.status = "error";
        transfer.error = "could not read the file";
        this.callbacks.onChange();
        return;
      }

      const blockStart = transfer.sent;
      let cursor = 0;

      while (cursor < block.byteLength) {
        if (this.stopped(transfer)) return;
        if (!this.channels || transfer.awaitingResume) break;

        await this.waitForDrain(channels);
        if (!this.channels || transfer.awaitingResume) break;

        const size = Math.min(channels.maxPayload, block.byteLength - cursor);
        const frame = new Uint8Array(HEADER_BYTES + size);
        encodeHeader(frame, transfer.meta.wireId, blockStart + cursor);
        frame.set(new Uint8Array(block, cursor, size), HEADER_BYTES);

        try {
          channels.data.send(frame.buffer as ArrayBuffer);
        } catch {
          break;
        }

        cursor += size;
        transfer.sent = blockStart + cursor;
        transfer.updatedAt = Date.now();
        this.callbacks.onChange();
      }
    }
  }

  private async waitForChannels(): Promise<PeerChannels> {
    if (this.channels) return this.channels;
    await new Promise<void>((resolve) => this.attachWaiters.push(resolve));
    // attach() woke us, so channels are set unless the session was torn down.
    if (!this.channels) throw new Error("channels unavailable");
    return this.channels;
  }

  private async waitForResume(transfer: OutgoingTransfer): Promise<void> {
    await new Promise<void>((resolve) => {
      transfer.resumeGate = resolve;
    });
    transfer.resumeGate = undefined;
  }

  private async waitForDrain(channels: PeerChannels): Promise<void> {
    if (channels.data.bufferedAmount <= HIGH_WATER_BYTES) return;
    await new Promise<void>((resolve) => {
      const onLow = () => {
        channels.data.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channels.data.addEventListener("bufferedamountlow", onLow);
    });
  }

  private onResume(offsets: Record<string, number>): void {
    for (const [fileId, transfer] of this.outgoing) {
      if (transfer.status !== "paused" && !transfer.awaitingResume) continue;

      const offset = offsets[fileId];
      if (offset === undefined) {
        // The receiver no longer knows about this file (it reloaded); stop sending it.
        transfer.status = "cancelled";
        transfer.error = "the other device lost this transfer";
      } else {
        transfer.sent = offset;
        transfer.acked = offset;
        transfer.status = "active";
      }

      transfer.awaitingResume = false;
      transfer.updatedAt = Date.now();
      transfer.resumeGate?.();
    }
    this.callbacks.onChange();
  }

  private onAck(fileId: string, received: number): void {
    const transfer = this.outgoing.get(fileId);
    if (!transfer) return;
    transfer.acked = Math.max(transfer.acked, received);
  }

  private onRemoteDone(fileId: string): void {
    const transfer = this.outgoing.get(fileId);
    if (!transfer) return;
    transfer.status = "done";
    transfer.sent = transfer.meta.size;
    transfer.acked = transfer.meta.size;
    transfer.updatedAt = Date.now();
    this.callbacks.onChange();
  }

  private onRemoteCancel(fileId: string, reason: string): void {
    const outgoing = this.outgoing.get(fileId);
    if (outgoing && outgoing.status !== "done") {
      outgoing.status = "cancelled";
      outgoing.error = reason;
      outgoing.resumeGate?.();
    }
    const incoming = this.incoming.get(fileId);
    if (incoming && incoming.status !== "done") {
      incoming.status = "cancelled";
      incoming.error = reason;
      void incoming.sink.abort();
    }
    this.callbacks.onChange();
  }

  private maybeAck(fileId: string, transfer: IncomingTransfer): void {
    const now = Date.now();
    const grown = transfer.received - transfer.lastAckBytes >= ACK_INTERVAL_BYTES;
    const stale = now - transfer.lastAckAt >= ACK_INTERVAL_MS;
    if (!grown && !stale) return;

    transfer.lastAckAt = now;
    transfer.lastAckBytes = transfer.received;
    this.callbacks.sendControl({ t: "ack", fileId, received: transfer.received });
  }

  private async completeIncoming(fileId: string, transfer: IncomingTransfer): Promise<void> {
    try {
      const blob = await transfer.sink.finish(transfer.meta.mime);
      transfer.downloadUrl = URL.createObjectURL(blob);
      transfer.status = "done";
      transfer.updatedAt = Date.now();
      this.callbacks.sendControl({ t: "done", fileId });
    } catch {
      this.failIncoming(transfer, fileId, "could not assemble the file");
    }
    this.callbacks.onChange();
  }

  private failIncoming(transfer: IncomingTransfer, fileId: string, reason: string): void {
    transfer.status = "error";
    transfer.error = reason;
    transfer.updatedAt = Date.now();
    void transfer.sink.abort();
    this.callbacks.sendControl({ t: "cancel", fileId, reason });
    this.callbacks.onChange();
  }
}

export function randomId(): string {
  return crypto.randomUUID().slice(0, 8);
}
