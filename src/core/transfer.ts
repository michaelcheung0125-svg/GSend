import type { PeerChannels } from "./peer";
import {
  HEADER_BYTES,
  decodeHeader,
  encodeHeader,
  type FileMeta,
  type PeerControl,
} from "./protocol";
import type { StoredTransfer } from "./session-store";
import {
  canAccept,
  createCompletedSink,
  createSink,
  maxFileBytes,
  readCompleted,
  reopenSink,
  type FileSink,
} from "./sink";

/** How much of the source file to pull into memory at a time before framing it. */
const READ_BLOCK_BYTES = 4 * 1024 * 1024;

/** Backpressure: stop feeding SCTP above the high mark, resume at the low mark. */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const LOW_WATER_BYTES = 1 * 1024 * 1024;

const ACK_INTERVAL_BYTES = 512 * 1024;
const ACK_INTERVAL_MS = 250;
/** Backstop so a stalled channel can never hang the send loop indefinitely. */
const DRAIN_TIMEOUT_MS = 5_000;

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
  /** Fired when the set of in-flight transfers changes and is worth persisting. */
  onTransfersChanged(): void;
}

export class TransferEngine {
  private channels: PeerChannels | null = null;
  private attachWaiters: Array<() => void> = [];
  private nextWireId = 1;

  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly incoming = new Map<string, IncomingTransfer>();
  /** Binary frames carry the compact wire id, so incoming frames resolve through this. */
  private readonly wireIndex = new Map<number, string>();
  /** Sends that a reload destroyed; the peer is told to stop waiting once reattached. */
  private lostOutgoing: string[] = [];

  constructor(private readonly callbacks: TransferCallbacks) {}

  /**
   * Rebuild in-flight receives after a reload. The bytes are still in the
   * origin-private filesystem, so only the bookkeeping has to come back.
   */
  async restore(incoming: StoredTransfer[], lostOutgoing: string[]): Promise<void> {
    this.lostOutgoing = [...lostOutgoing];
    const now = Date.now();

    for (const stored of incoming) {
      const meta: FileMeta = {
        id: stored.id,
        wireId: stored.wireId,
        name: stored.name,
        size: stored.size,
        mime: stored.mime,
      };

      if (stored.done) {
        // Finished before the reload and never saved. The bytes are still on disk, so
        // put the row back with a working download rather than stranding the file.
        const blob = await readCompleted(stored.id, stored.mime);
        if (!blob) continue;
        this.incoming.set(stored.id, {
          meta,
          sink: createCompletedSink(),
          received: stored.size,
          status: "done",
          downloadUrl: URL.createObjectURL(blob),
          startedAt: now,
          updatedAt: now,
          lastAckAt: 0,
          lastAckBytes: 0,
        });
        continue;
      }

      const reopened = await reopenSink(stored.id);
      if (!reopened) continue;

      this.incoming.set(stored.id, {
        meta,
        sink: reopened.sink,
        received: Math.min(reopened.received, stored.size),
        status: "paused",
        startedAt: now,
        updatedAt: now,
        lastAckAt: 0,
        lastAckBytes: 0,
      });
      this.wireIndex.set(stored.wireId, stored.id);
      this.nextWireId = Math.max(this.nextWireId, stored.wireId + 1);
    }

    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
  }

  persistableIncoming(): StoredTransfer[] {
    const rows: StoredTransfer[] = [];
    for (const transfer of this.incoming.values()) {
      const inFlight = transfer.status === "active" || transfer.status === "paused";
      // Completed files are kept too: until the user saves one it exists only as a
      // download link, and a reload would otherwise lose a file that did arrive.
      if (!inFlight && transfer.status !== "done") continue;
      rows.push({
        id: transfer.meta.id,
        wireId: transfer.meta.wireId,
        name: transfer.meta.name,
        size: transfer.meta.size,
        mime: transfer.meta.mime,
        done: transfer.status === "done",
      });
    }
    return rows;
  }

  persistableOutgoing(): string[] {
    const ids: string[] = [];
    for (const [id, transfer] of this.outgoing) {
      if (transfer.status === "done" || transfer.status === "cancelled") continue;
      ids.push(id);
    }
    return ids;
  }

  attach(channels: PeerChannels): void {
    this.channels = channels;
    channels.data.bufferedAmountLowThreshold = LOW_WATER_BYTES;

    const waiters = this.attachWaiters;
    this.attachWaiters = [];
    for (const wake of waiters) wake();

    // Tell the sender where each interrupted file should pick up again. This is sent
    // even when empty: a sender waiting on resume needs the empty answer to learn that
    // the receiver no longer has the file, rather than waiting forever.
    const offsets: Record<string, number> = {};
    for (const [id, transfer] of this.incoming) {
      if (transfer.status === "active" || transfer.status === "paused") {
        transfer.status = "active";
        offsets[id] = transfer.received;
      }
    }
    this.callbacks.sendControl({ t: "resume", offsets });

    // A reload wiped these sends; the peer would otherwise hold a paused row forever.
    for (const fileId of this.lostOutgoing) {
      this.callbacks.sendControl({
        t: "cancel",
        fileId,
        reason: "the sender's page reloaded and cannot re-read the file",
      });
    }
    this.lostOutgoing = [];

    this.callbacks.onChange();
  }

  /** Both halves of every in-flight transfer are unrecoverable; stop them cleanly. */
  abortInFlight(reason: string): void {
    for (const transfer of this.outgoing.values()) {
      if (transfer.status === "done" || transfer.status === "cancelled") continue;
      transfer.status = "cancelled";
      transfer.error = reason;
      transfer.awaitingResume = false;
      transfer.updatedAt = Date.now();
      transfer.resumeGate?.();
    }

    for (const transfer of this.incoming.values()) {
      if (transfer.status === "done" || transfer.status === "cancelled") continue;
      transfer.status = "cancelled";
      transfer.error = reason;
      transfer.updatedAt = Date.now();
      this.wireIndex.delete(transfer.meta.wireId);
      void transfer.sink.abort();
    }

    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
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
    this.lostOutgoing = [];
    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
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
    const limit = maxFileBytes();
    const accepted = files.filter((file) => file.size <= limit);
    const rejected = files.length - accepted.length;
    if (accepted.length === 0) {
      return rejected > 0
        ? `Files above ${Math.round(limit / 1024 / 1024)} MB are not supported yet.`
        : null;
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
    this.callbacks.onTransfersChanged();
    return rejected > 0
      ? `${rejected} file(s) skipped: over the ${Math.round(limit / 1024 / 1024)} MB limit.`
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
      this.wireIndex.delete(incoming.meta.wireId);
      void incoming.sink.abort();
      this.callbacks.sendControl({ t: "cancel", fileId, reason: "receiver cancelled" });
    }

    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
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
        void this.onOffer(msg.batchId, msg.files);
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
    const writeAt = transfer.received;
    transfer.status = "active";
    transfer.received += slice.byteLength;
    transfer.updatedAt = Date.now();

    void transfer.sink
      .write(writeAt, slice)
      .catch(() => this.failIncoming(transfer, fileId, "could not write to storage"));

    if (transfer.received >= transfer.meta.size) {
      void this.completeIncoming(fileId, transfer);
    } else {
      this.maybeAck(fileId, transfer);
    }

    this.callbacks.onChange();
  }

  private async onOffer(batchId: string, files: FileMeta[]): Promise<void> {
    const now = Date.now();
    const offsets: Record<string, number> = {};

    for (const meta of files) {
      const existing = this.incoming.get(meta.id);
      if (existing) {
        offsets[meta.id] = existing.received;
        continue;
      }

      // Only this side knows how much room it has, so the refusal belongs here rather
      // than on the sender, which cannot see the receiving device's storage.
      if (!(await canAccept(meta.size))) {
        this.callbacks.sendControl({
          t: "cancel",
          fileId: meta.id,
          reason: "too large for the receiving device",
        });
        continue;
      }

      this.incoming.set(meta.id, {
        meta,
        sink: await createSink(meta.id),
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
    this.callbacks.onTransfersChanged();
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
        // Identity, not just presence: after a reconnect `this.channels` is a different
        // object and the one captured above is dead.
        if (this.channels !== channels || transfer.awaitingResume) break;

        await this.waitForDrain(channels);
        if (this.channels !== channels || transfer.awaitingResume) break;

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

  /** Waits out any number of reconnections rather than abandoning the transfer. */
  private async waitForChannels(): Promise<PeerChannels> {
    while (!this.channels) {
      await new Promise<void>((resolve) => this.attachWaiters.push(resolve));
    }
    return this.channels;
  }

  private async waitForResume(transfer: OutgoingTransfer): Promise<void> {
    await new Promise<void>((resolve) => {
      transfer.resumeGate = resolve;
    });
    transfer.resumeGate = undefined;
  }

  /**
   * A closed channel never fires `bufferedamountlow`, so waiting on that alone would
   * strand the pump on a connection that died mid-block. Closure wakes it too, and the
   * timeout is a backstop for anything neither event covers.
   */
  private async waitForDrain(channels: PeerChannels): Promise<void> {
    if (channels.data.readyState !== "open") return;
    if (channels.data.bufferedAmount <= HIGH_WATER_BYTES) return;

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        channels.data.removeEventListener("bufferedamountlow", done);
        channels.data.removeEventListener("close", done);
        channels.data.removeEventListener("error", done);
        resolve();
      };
      const timer = setTimeout(done, DRAIN_TIMEOUT_MS);
      channels.data.addEventListener("bufferedamountlow", done);
      channels.data.addEventListener("close", done);
      channels.data.addEventListener("error", done);
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
    this.callbacks.onTransfersChanged();
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
      this.wireIndex.delete(incoming.meta.wireId);
      void incoming.sink.abort();
    }
    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
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
      this.wireIndex.delete(transfer.meta.wireId);
      this.callbacks.sendControl({ t: "done", fileId });
    } catch {
      this.failIncoming(transfer, fileId, "could not assemble the file");
    }
    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
  }

  private failIncoming(transfer: IncomingTransfer, fileId: string, reason: string): void {
    transfer.status = "error";
    transfer.error = reason;
    transfer.updatedAt = Date.now();
    this.wireIndex.delete(transfer.meta.wireId);
    void transfer.sink.abort();
    this.callbacks.sendControl({ t: "cancel", fileId, reason });
    this.callbacks.onChange();
    this.callbacks.onTransfersChanged();
  }
}

export function randomId(): string {
  return crypto.randomUUID().slice(0, 8);
}
